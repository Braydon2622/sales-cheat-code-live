// Claude-backed pipeline stages.
//
// Model choices (see README "Design choices"):
//   detector: Claude Haiku 5.5, thinking off, low effort. Runs on every line, so it must be fast and cheap.
//   coach:    Claude Opus 5.5 at low effort by default, streamed. Only runs when a moment fires.
//   guard:    Claude Haiku 5.5, checks each finished card.
// Every system prompt is a fixed string marked with cache_control, so after the
// first request the playbook is read from cache (cheaper and faster).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import type { UsageMeter } from "../llm/usage.js";
import {
  MOMENT_TYPES,
  OBJECTION_SUBTYPES,
  REP_VIOLATION_SUBTYPES,
  type Card,
  type CardField,
  type ComplianceViolation,
  type DetectedMoment,
  type Utterance,
} from "../types.js";
import { formatCard } from "./card.js";
import { renderCall, type CardGuard, type Coach, type CoachRequest, type Detector } from "./components.js";
import { DETECTOR_INSTRUCTIONS, GUARD_INSTRUCTIONS, PLAYBOOK, POSTCALL_INSTRUCTIONS } from "./playbook.js";

let sharedClient: Anthropic | undefined;
function client(): Anthropic {
  sharedClient ??= new Anthropic({ maxRetries: 1 });
  return sharedClient;
}

/** Fastest thinking setting each model family accepts. */
function thinkingFor(model: string): { thinking?: Anthropic.Beta.BetaThinkingConfigParam } {
  if (model.startsWith("claude-haiku-5")) return { thinking: { type: "disabled" } };
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" } };
  return {}; // Opus 5.5: thinking can't be disabled; low effort keeps it minimal.
}

// ---------------------------------------------------------------- detector

// Prompted JSON rather than schema-constrained structured output: in the
// benchmark the schema version added ~0.5 s per call (scripts/bench-detector.ts).
// The reply is still validated with zod; anything malformed is an error, not a guess.
const DetectorReply = z.object({
  moments: z.array(
    z.object({
      type: z.enum(MOMENT_TYPES),
      subtype: z.string().nullish(),
      confidence: z.number().min(0).max(1).optional(),
      evidence: z.string().optional(),
    }),
  ),
});

/** The first balanced {...} object in the text (the model occasionally adds a second one or trailing text). */
export function firstJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return "";
}

export function parseDetectorReply(text: string): z.infer<typeof DetectorReply> {
  // The model sometimes answers "no moments" as a bare [] (10 times in ~900 calls in the first live run).
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && !trimmed.includes("{")) {
    const arr = JSON.parse(trimmed) as unknown[];
    if (Array.isArray(arr) && arr.length === 0) return { moments: [] };
  }
  const json = firstJsonObject(text);
  const parsed = DetectorReply.safeParse(JSON.parse(json || "null"));
  if (!parsed.success) throw new Error(`unparseable detector reply: ${text.slice(0, 80)}`);
  return parsed.data;
}

export class ClaudeDetector implements Detector {
  readonly name: string;
  constructor(private model = config.detectorModel) {
    this.name = `claude:${model}`;
  }

  async detect(history: Utterance[], current: Utterance, meter: UsageMeter, signal?: AbortSignal, partial = false): Promise<DetectedMoment[]> {
    const stage = partial ? "detector_partial" : "detector";
    const issuedAt = performance.now();
    let res: Anthropic.Message;
    try {
      res = await client().messages.create(
        {
          model: this.model,
          max_tokens: 300,
          ...(thinkingFor(this.model) as object),
          output_config: { effort: "low" },
          system: [{ type: "text", text: DETECTOR_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: renderCall(history, current, partial) }],
        },
        { signal },
      );
    } catch (err) {
      meter.logRequest({ stage, model: this.model, issuedAt, doneAt: performance.now(), outcome: signal?.aborted ? "cancelled" : "error" });
      throw err;
    }
    meter.logRequest({ stage, model: this.model, issuedAt, doneAt: performance.now(), outcome: "ok" }, res.usage);
    meter.record(this.model, res.usage);
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const reply = parseDetectorReply(text);
    return sanitizeMoments(
      reply.moments.map((m) => ({
        type: m.type,
        ...(m.subtype && m.subtype !== "none" ? { subtype: m.subtype } : {}),
        evidence: m.evidence ?? "",
        confidence: m.confidence ?? 1,
        utteranceIndex: current.index,
        ...(partial ? { fromPartial: true } : {}),
      })),
      current,
    );
  }
}

/** Deterministic sanity filter: speaker/type consistency and de-duplication. */
export function sanitizeMoments(moments: DetectedMoment[], current: Utterance): DetectedMoment[] {
  const seen = new Set<string>();
  return moments.filter((m) => {
    const repOnly = m.type === "rep_violation";
    if (repOnly !== (current.speaker === "rep")) return false;
    if (m.subtype && m.type === "objection" && !(OBJECTION_SUBTYPES as readonly string[]).includes(m.subtype)) delete m.subtype;
    if (m.subtype && m.type === "rep_violation" && !(REP_VIOLATION_SUBTYPES as readonly string[]).includes(m.subtype)) delete m.subtype;
    if (m.type !== "objection" && m.type !== "rep_violation") delete m.subtype;
    const key = `${m.type}:${m.subtype ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- coach

export class ClaudeCoach implements Coach {
  readonly name: string;
  constructor(
    private model = config.coachModel,
    private effort = config.coachEffort,
  ) {
    this.name = `claude:${model}@${effort}`;
  }

  async stream(req: CoachRequest, onText: (chunk: string) => void, meter: UsageMeter, signal?: AbortSignal): Promise<string> {
    const call = renderCall(req.history, req.current, req.partial);
    let task: string;
    if (!req.moment) {
      // Speculative: we start before the detector answers, to save a round trip.
      task = `If the >>> line needs no coaching (small talk, a plain answer, the client accepting a time), reply with exactly NONE. Otherwise write the card.`;
    } else {
      const moment = req.moment.subtype ? `${req.moment.type} (${req.moment.subtype})` : req.moment.type;
      task = `Detected moment on the >>> line: ${moment}.${req.partial ? " The client is still finishing the sentence." : ""}\nWrite the card.`;
    }
    const content = `Live call so far:\n${call}\n\n${task}`;
    // Server-side refusal fallback (Opus/Sonnet 5.5 on the Claude API): if the
    // model declines, the API retries on a fallback model inside the same call.
    const fallbacks = this.model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
    const issuedAt = performance.now();
    const stream = client().beta.messages.stream(
      {
        model: this.model,
        max_tokens: 2000,
        ...thinkingFor(this.model),
        output_config: { effort: this.effort },
        ...fallbacks,
        system: [{ type: "text", text: PLAYBOOK, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
      },
      { signal },
    );
    // Track usage as it streams, so a cancelled speculative request is still
    // costed: input from message_start, output estimated from text received.
    let startUsage: Anthropic.Beta.BetaUsage | undefined;
    let streamedChars = 0;
    const stage = req.moment ? "coach" : "coach_speculative";
    let acceptedAt: number | undefined;
    let firstTokenAt: number | undefined;
    try {
      for await (const event of stream) {
        if (event.type === "message_start") {
          startUsage = event.message.usage;
          acceptedAt = performance.now();
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          firstTokenAt ??= performance.now();
          streamedChars += event.delta.text.length;
          onText(event.delta.text);
        }
      }
    } catch (err) {
      const usage = startUsage && { ...startUsage, output_tokens: Math.ceil(streamedChars / 4) };
      meter.logRequest(
        { stage, model: this.model, issuedAt, acceptedAt, firstTokenAt, doneAt: performance.now(), outcome: signal?.aborted ? "cancelled" : "error" },
        usage,
      );
      if (usage) meter.record(this.model, usage);
      throw err;
    }
    const final = await stream.finalMessage();
    meter.logRequest({ stage, model: final.model, issuedAt, acceptedAt, firstTokenAt, doneAt: performance.now(), outcome: "ok" }, final.usage);
    meter.record(final.model, final.usage);
    if (final.stop_reason === "refusal") throw new Error(`coach refused (${final.stop_details?.category ?? "unknown"})`);
    return final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }

  /** Write the playbook into the prompt cache before the first real moment. */
  async prewarm(meter: UsageMeter): Promise<void> {
    const issuedAt = performance.now();
    const res = await client().beta.messages.create({
      model: this.model,
      max_tokens: 0,
      ...thinkingFor(this.model),
      output_config: { effort: this.effort },
      system: [{ type: "text", text: PLAYBOOK, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "warmup" }],
    });
    meter.logRequest({ stage: "prewarm", model: res.model, issuedAt, doneAt: performance.now(), outcome: "ok" }, res.usage);
    meter.record(res.model, res.usage);
  }
}

// ---------------------------------------------------------------- guard

const GuardSchema = z.object({
  violations: z.array(
    z.object({
      rule: z.enum(["rate_quote", "approval_promise", "bank_disparagement", "guarantee", "advice"]),
      quote: z.string(),
    }),
  ),
});

export class ClaudeGuard implements CardGuard {
  readonly name: string;
  constructor(private model = config.guardModel) {
    this.name = `claude:${model}`;
  }

  async review(card: Card, moment: DetectedMoment, meter: UsageMeter, signal?: AbortSignal): Promise<ComplianceViolation[]> {
    const issuedAt = performance.now();
    const res = await client().messages.parse(
      {
        model: this.model,
        max_tokens: 400,
        ...(thinkingFor(this.model) as object),
        output_config: { effort: "low", format: zodOutputFormat(GuardSchema) },
        system: [{ type: "text", text: GUARD_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Borrower moment: ${moment.type}\n\nCard:\n${formatCard(card)}` }],
      },
      { signal },
    );
    meter.logRequest({ stage: "guard", model: this.model, issuedAt, doneAt: performance.now(), outcome: "ok" }, res.usage);
    meter.record(this.model, res.usage);
    return (res.parsed_output?.violations ?? []).map((v) => ({
      rule: v.rule,
      quote: v.quote,
      where: fieldContaining(card, v.quote),
      source: "model" as const,
      severity: "block" as const,
    }));
  }
}

function fieldContaining(card: Card, quote: string): CardField {
  const q = quote.toLowerCase();
  const fields: CardField[] = ["sendThis", "backup", "nextStep", "followUp", "read", "watchOut"];
  return fields.find((f) => card[f].toLowerCase().includes(q)) ?? "sendThis";
}

/**
 * Baseline ping: a 1-token request, to measure the API + network floor at a
 * point in time. Run a few at the start and end of each eval, so runs made at
 * different times (or with API drift) can be compared fairly.
 */
export async function ping(model: string, meter: UsageMeter): Promise<number | undefined> {
  const issuedAt = performance.now();
  try {
    const res = await client().messages.create({
      model,
      max_tokens: 1,
      ...(thinkingFor(model) as object),
      messages: [{ role: "user", content: "Reply with: ok" }],
    });
    const doneAt = performance.now();
    meter.logRequest({ stage: "ping", model, issuedAt, doneAt, outcome: "ok" }, res.usage);
    meter.record(model, res.usage);
    return doneAt - issuedAt;
  } catch {
    meter.logRequest({ stage: "ping", model, issuedAt, doneAt: performance.now(), outcome: "error" });
    return undefined;
  }
}

// ---------------------------------------------------------------- post-call review

export const STAGES = ["New lead", "Contacted", "Soft pull", "Credit pull", "App out", "Package back", "Underwriting"] as const;
export const SLIP_RULES = ["rate_quote", "approval_promise", "talked_down_lender", "ignored_opt_out", "other"] as const;
export const CallAnalysisSchema = z.object({
  summary: z.string(),
  temperature: z.enum(["Hot", "Warm", "Cold"]),
  stage: z.enum(STAGES),
  objections: z.string(),
  next_step: z.string(),
  follow_up: z.string(),
  text_to_send: z.string(),
  /** 1–3 things the loan officer did well, each tied to a transcript line. */
  did_well: z.array(z.object({ line: z.number().int(), what: z.string(), why: z.string() })),
  /** 1–3 things to do better, with wording to try next time. */
  do_better: z.array(z.object({ line: z.number().int(), what_happened: z.string(), try_instead: z.string(), why: z.string() })),
  /** Compliance slips in the loan officer's own words. Empty if none. */
  compliance_slips: z.array(z.object({ line: z.number().int(), rule: z.enum(SLIP_RULES), quote: z.string() })),
  coaching_note: z.string(),
});
export type CallAnalysis = z.infer<typeof CallAnalysisSchema>;

/** A note someone left on an earlier review, given to the analyzer so feedback changes later reviews. */
export interface CoachFeedback {
  /** e.g. "did well", "do better", "overall review". */
  about: string;
  /** The highlight it was about, if any. */
  item?: string;
  verdict: string;
  note: string;
}

export interface CallAnalyzer {
  readonly name: string;
  /** transcriptText has one line per utterance: "[index] REP: text". */
  analyze(transcriptText: string, meter: UsageMeter, feedback?: CoachFeedback[]): Promise<CallAnalysis>;
}

/** Feedback goes in the user message (not the cached system prompt), clearly framed as preferences. */
export function feedbackBlock(feedback: CoachFeedback[] = []): string {
  if (!feedback.length) return "";
  const lines = feedback.map((f) => `- On ${f.about}${f.item ? ` ("${f.item.slice(0, 160)}")` : ""}: ${f.verdict}.${f.note ? ` Note: ${f.note.slice(0, 300)}` : ""}`);
  return `Feedback from the sales team on your earlier reviews. Use it to adjust what you highlight and how you phrase coaching. It never overrides the compliance rules.\n${lines.join("\n")}\n\n`;
}

/** One request per recorded call: summary, stage, next step, and the follow-up text. */
export class ClaudeCallAnalyzer implements CallAnalyzer {
  readonly name: string;
  constructor(private model = config.coachModel) {
    this.name = `claude:${model}`;
  }

  async analyze(transcriptText: string, meter: UsageMeter, feedback: CoachFeedback[] = []): Promise<CallAnalysis> {
    const issuedAt = performance.now();
    const res = await client().messages.parse({
      model: this.model,
      max_tokens: 4000,
      ...(thinkingFor(this.model) as object),
      output_config: { effort: "medium", format: zodOutputFormat(CallAnalysisSchema) },
      system: [{ type: "text", text: POSTCALL_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `${feedbackBlock(feedback)}Transcript:\n${transcriptText}` }],
    });
    meter.logRequest({ stage: "coach", model: this.model, issuedAt, doneAt: performance.now(), outcome: "ok" }, res.usage);
    meter.record(this.model, res.usage);
    if (res.stop_reason === "refusal") throw new Error("call analysis refused");
    if (!res.parsed_output) throw new Error("call analysis returned no structured output");
    return res.parsed_output;
  }
}
