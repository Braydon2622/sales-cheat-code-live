// Post-call review: turns a recorded (already transcribed, already redacted)
// call into a short coaching report for the loan officer:
//   - highlights: 1–3 things they did well and 1–3 to do better, each tied to a line
//   - compliance slips in their own words (deterministic rules + the model)
//   - summary, stage, next step, and a rule-checked follow-up text
//
// One model request per call. The live pipeline's per-moment cards are built
// for split-second help *during* a call; after the call, a rep learns more from
// a few highlights than from a card for every moment.
import type { CallAnalysis, CallAnalyzer, CoachFeedback, MissCategory } from "../pipeline/claude.js";
import { callStats, type CallStats } from "./insights.js";
import { checkCard, checkCardLine, checkRepSpeech, hasTwoOptionClose, MAX_SPOKEN_CHARS } from "../pipeline/rules.js";
import { UsageMeter } from "../llm/usage.js";
import type { ComplianceViolation, Transcript } from "../types.js";

export const SAFE_FOLLOW_UP_TEXT = "Thanks for your time today! Does today at 4 or tomorrow at 10 work better for a quick follow-up on your home options?";

export interface FollowUpCheck {
  original: string;
  final: string;
  replaced: boolean;
  violations: ComplianceViolation[];
}

/** The playbook's text rules: block anything non-compliant; note style misses. */
export function checkFollowUpText(text: string): FollowUpCheck {
  const block = checkCardLine("sendThis", text);
  const style = checkCard({ sendThis: text }, "objection").filter((v) => v.severity === "style" && v.rule !== "two_option_close");
  const optOut = /removed you from our list/i.test(text);
  if (!optOut && !hasTwoOptionClose(text)) {
    style.push({ rule: "two_option_close", severity: "style", where: "sendThis", quote: text, source: "rules" });
  }
  if (text.length > MAX_SPOKEN_CHARS && !style.some((v) => v.rule === "over_300_chars")) {
    style.push({ rule: "over_300_chars", severity: "style", where: "sendThis", quote: `${text.length} chars`, source: "rules" });
  }
  const replaced = block.length > 0;
  return { original: text, final: replaced ? SAFE_FOLLOW_UP_TEXT : text, replaced, violations: [...block, ...style] };
}

export interface ReviewComponents {
  analyzer: CallAnalyzer;
}

export interface Highlight {
  /** Stable key for feedback: "w1".."w3" (did well), "b1".."b3" (do better). */
  key: string;
  line: number;
  time: string;
  speaker: "rep" | "client";
  /** The transcript line it points at (taken from the transcript, not the model). */
  quote: string;
  what: string;
  why: string;
  /** Do-better only: what kind of miss it was (counted across calls in Insights). */
  category?: MissCategory;
  /** Do-better only: wording to try next time, after the compliance rules. */
  tryInstead?: string;
  /** Rules the model's suggested wording broke (the wording is then withheld). */
  tryInsteadBlocked?: string[];
}

export interface Slip {
  line: number;
  time: string;
  text: string;
  rules: string[];
  /** "rules" if the deterministic rules caught it, else "model". */
  source: "rules" | "model";
}

export interface ReviewResult {
  transcript: Transcript;
  analysis?: CallAnalysis;
  didWell: Highlight[];
  doBetter: Highlight[];
  slips: Slip[];
  followUp?: FollowUpCheck;
  errors: string[];
  meter: UsageMeter;
}

export type ReviewProgress = (step: "analysis", done: number, total: number) => void;

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const WITHHELD = "(Suggested wording withheld: it broke a compliance rule.)";

/** The transcript as the analyzer sees it: "[index] REP: text". */
export function numberedTranscript(t: Transcript): string {
  return t.utterances.map((u) => `[${u.index}] ${u.speaker.toUpperCase()}: ${u.text}`).join("\n");
}

/** Ties the model's highlights to real transcript lines; drops any that point nowhere. */
export function buildHighlights(t: Transcript, a: CallAnalysis): { didWell: Highlight[]; doBetter: Highlight[] } {
  const at = (line: number) => t.utterances.find((u) => u.index === line);
  const didWell: Highlight[] = [];
  for (const h of a.did_well) {
    const u = at(h.line);
    if (!u || didWell.length >= 3) continue;
    didWell.push({ key: `w${didWell.length + 1}`, line: u.index, time: fmtTime(u.start), speaker: u.speaker, quote: u.text, what: h.what, why: h.why });
  }
  const doBetter: Highlight[] = [];
  for (const h of a.do_better) {
    const u = at(h.line);
    if (!u || doBetter.length >= 3) continue;
    // try_instead is words the rep will say: same hard rules as a live card.
    const blocked = checkCardLine("sendThis", h.try_instead).filter((v) => v.severity === "block");
    doBetter.push({
      key: `b${doBetter.length + 1}`,
      line: u.index,
      time: fmtTime(u.start),
      speaker: u.speaker,
      quote: u.text,
      ...(h.category ? { category: h.category } : {}),
      what: h.what_happened,
      why: h.why,
      tryInstead: blocked.length ? WITHHELD : h.try_instead,
      ...(blocked.length ? { tryInsteadBlocked: [...new Set(blocked.map((v) => v.rule))] } : {}),
    });
  }
  return { didWell, doBetter };
}

/** Rep slips: the deterministic rules on every rep line, plus what the model found on rep lines. */
export function findSlips(t: Transcript, a?: CallAnalysis): Slip[] {
  const byLine = new Map<number, Slip>();
  for (const u of t.utterances) {
    if (u.speaker !== "rep") continue;
    const v = checkRepSpeech(u.text);
    if (v.length) byLine.set(u.index, { line: u.index, time: fmtTime(u.start), text: u.text, rules: [...new Set(v.map((x) => x.rule))], source: "rules" });
  }
  for (const s of a?.compliance_slips ?? []) {
    const u = t.utterances.find((x) => x.index === s.line);
    if (!u || u.speaker !== "rep") continue; // a client can't commit a rep slip
    const existing = byLine.get(u.index);
    if (existing) {
      if (!existing.rules.includes(s.rule)) existing.rules.push(s.rule);
    } else byLine.set(u.index, { line: u.index, time: fmtTime(u.start), text: u.text, rules: [s.rule], source: "model" });
  }
  return [...byLine.values()].sort((x, y) => x.line - y.line);
}

export async function reviewCall(t: Transcript, c: ReviewComponents, onProgress?: ReviewProgress, feedback: CoachFeedback[] = []): Promise<ReviewResult> {
  const meter = new UsageMeter();
  const errors: string[] = [];
  onProgress?.("analysis", 0, 1);
  let analysis: CallAnalysis | undefined;
  let followUp: FollowUpCheck | undefined;
  let highlights: { didWell: Highlight[]; doBetter: Highlight[] } = { didWell: [], doBetter: [] };
  try {
    analysis = await c.analyzer.analyze(numberedTranscript(t), meter, feedback);
    followUp = checkFollowUpText(analysis.text_to_send);
    highlights = buildHighlights(t, analysis);
  } catch (err) {
    errors.push(`analysis: ${(err as Error).message}`);
  }
  onProgress?.("analysis", 1, 1);
  return { transcript: t, analysis, ...highlights, slips: findSlips(t, analysis), followUp, errors, meter };
}

const pretty = (r: string) => r.replace(/_/g, " ");

export function renderReview(r: ReviewResult): string {
  const t = r.transcript;
  const md: string[] = [`# Call review: ${t.id}`, ""];
  const red = Object.entries(t.redactions ?? {}).map(([k, v]) => `${k} ×${v}`).join(", ");
  md.push(
    `${t.synthetic ? "**Synthetic call.**" : "**Real call. Contains customer information even after redaction: do not share outside the team.**"} ${t.utterances.length} lines, ${fmtTime(t.utterances.at(-1)?.end ?? 0)} long. PII redacted: ${red || "none found"}.`,
    "",
  );
  const a = r.analysis;
  if (a) {
    md.push(
      `## Summary`,
      "",
      a.summary,
      "",
      `| | |`,
      `|---|---|`,
      `| Temperature | ${a.temperature} |`,
      `| Stage | ${a.stage} |`,
      `| Objections | ${a.objections} |`,
      `| Next step | ${a.next_step} |`,
      `| Follow up | ${a.follow_up} |`,
      "",
      `**Bottom line:** ${a.coaching_note}`,
      "",
    );
    const tp = turningPointFor(t, a).turningPoint;
    const st = callStats(t.utterances);
    md.push(
      `## Where it went wrong`,
      "",
      tp ? `**Turning point, ${tp.time}:** ${tp.what}\n  > ${tp.speaker === "rep" ? "You" : "Client"}: ${tp.quote}` : `The call never went off track.`,
      "",
      `Next step booked: ${a.next_step_booked ? "yes" : "no"} · You talked ${Math.round(st.repTalkShare * 100)}% of the call · ${st.repQuestions} questions asked${st.longestRepStretchSec !== undefined ? ` · longest stretch without the client speaking: ${Math.round(st.longestRepStretchSec)}s` : ""}`,
      "",
    );
  }
  md.push(`## What you did well`, "");
  if (!r.didWell.length) md.push(a ? `Nothing specific stood out.` : `(Analysis didn't complete.)`);
  for (const h of r.didWell) md.push(`- **${h.time} · ${h.what}** ${h.why}`, `  > ${h.quote}`);
  md.push("", `## What to do better`, "");
  if (!r.doBetter.length) md.push(a ? `Nothing major.` : `(Analysis didn't complete.)`);
  for (const h of r.doBetter) {
    md.push(`- **${h.time} · ${h.category ? `[${h.category}] ` : ""}${h.what}** ${h.why}`, `  > ${h.speaker === "rep" ? "You" : "Client"}: ${h.quote}`, `  - **Try instead:** ${h.tryInstead}`);
  }
  md.push("", `## Compliance: the loan officer's own words`, "");
  if (!r.slips.length) md.push(`No slips flagged.`);
  for (const s of r.slips) md.push(`- **${s.time}** · ${s.rules.map(pretty).join(", ")} (${s.source === "rules" ? "rule" : "AI"}): "${s.text}"`);
  md.push("");
  if (r.followUp) {
    const f = r.followUp;
    md.push(`## Follow-up text`, "", `> ${f.final}`, "");
    if (f.replaced) {
      md.push(`⚠ The drafted text broke a compliance rule and was replaced with a safe one. Draft: "${f.original}" (${f.violations.filter((v) => v.severity === "block").map((v) => v.rule).join(", ")})`, "");
    }
    const style = f.violations.filter((v) => v.severity === "style");
    md.push(style.length ? `Style notes: ${style.map((v) => pretty(v.rule)).join(", ")}.` : `Passes the text rules: under 300 characters, "home" wording, two-option close, no rates or approval language.`, "");
  }
  if (r.errors.length) md.push(`## Errors`, "", ...r.errors.map((e) => `- ${e}`), "");
  md.push(`_AI cost for this review: $${r.meter.costUsd().toFixed(4)}_`, "");
  return md.join("\n");
}

// ---------------------------------------------------------------- stored record

export interface ReviewFeedback {
  /** Per highlight, keyed by Highlight.key. */
  items: Record<string, { vote: "up" | "down"; note: string; at: string }>;
  overall?: { rating: number; note: string; at: string };
}

/** The JSON form of a review, saved next to the Markdown report and shown in the app. */
export interface ReviewRecord {
  id: string;
  createdAt: string;
  fileName: string;
  mode: "live" | "mock";
  synthetic: boolean;
  source: Transcript["source"];
  lines: number;
  durationSec: number;
  redactions: Record<string, number>;
  analysis?: CallAnalysis;
  didWell: Highlight[];
  doBetter: Highlight[];
  followUp?: FollowUpCheck;
  slips: Slip[];
  /** Where the call went off track (from the AI review, tied to a real line). */
  turningPoint?: { line: number; time: string; speaker: "rep" | "client"; quote: string; what: string };
  /** Measured from the transcript, no AI. Missing on reviews saved before stats existed. */
  stats?: CallStats;
  transcript: Array<{ time: string; speaker: "rep" | "client"; text: string }>;
  errors: string[];
  /** AI review cost. Transcription is separate. */
  costUsd: number;
  /** Speech-to-text cost estimate, for audio uploads. */
  transcriptionUsd?: number;
  feedback: ReviewFeedback;
  /** Reviews made before highlights existed had per-moment cards and 1–5 card ratings. Kept so old reviews still open. */
  moments?: Array<{ cardId: number; time: string; type: string; subtype?: string; clientText: string; repNext: string | null; card: Record<string, string>; stoppedByGuard: boolean }>;
  ratings?: Record<string, { rating: number; note: string; at: string }>;
}

export function toRecord(
  r: ReviewResult,
  meta: { id: string; fileName: string; mode: "live" | "mock"; createdAt?: string; transcriptionUsd?: number },
): ReviewRecord {
  const t = r.transcript;
  return {
    id: meta.id,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    fileName: meta.fileName,
    mode: meta.mode,
    synthetic: t.synthetic,
    source: t.source,
    lines: t.utterances.length,
    durationSec: t.utterances.at(-1)?.end ?? 0,
    redactions: t.redactions ?? {},
    analysis: r.analysis,
    didWell: r.didWell,
    doBetter: r.doBetter,
    followUp: r.followUp,
    slips: r.slips,
    ...turningPointFor(t, r.analysis),
    stats: callStats(t.utterances),
    transcript: t.utterances.map((u) => ({ time: fmtTime(u.start), speaker: u.speaker, text: u.text })),
    errors: r.errors,
    costUsd: r.meter.costUsd(),
    ...(meta.transcriptionUsd !== undefined ? { transcriptionUsd: meta.transcriptionUsd } : {}),
    feedback: { items: {} },
  };
}

/** Ties the AI's turning point to a real transcript line; dropped if it points nowhere. */
function turningPointFor(t: Transcript, a?: CallAnalysis): Pick<ReviewRecord, "turningPoint"> {
  const tp = a?.turning_point;
  const u = tp ? t.utterances.find((x) => x.index === tp.line) : undefined;
  if (!tp || !u) return {};
  return { turningPoint: { line: u.index, time: fmtTime(u.start), speaker: u.speaker, quote: u.text, what: tp.what } };
}

/** How many past feedback notes go into each new review's prompt. */
export const FEEDBACK_IN_PROMPT = 12;

/**
 * Turns saved feedback into notes for the analyzer, so feedback changes later reviews.
 * Thumbs-downs and anything with a written note rank first (most signal), then newest.
 * Mock reviews are skipped: feedback on canned highlights teaches the AI nothing.
 */
export function collectFeedback(records: ReviewRecord[], limit = FEEDBACK_IN_PROMPT): CoachFeedback[] {
  const out: Array<CoachFeedback & { at: string; weight: number }> = [];
  for (const r of records) {
    if (r.mode === "mock" || !r.feedback) continue;
    const all = [...(r.didWell ?? []), ...(r.doBetter ?? [])];
    for (const [key, v] of Object.entries(r.feedback.items ?? {})) {
      const h = all.find((x) => x.key === key);
      if (!h) continue;
      const well = key.startsWith("w");
      out.push({
        about: well ? "a 'did well' highlight" : "a 'do better' highlight",
        item: well ? h.what : `${h.what} / try instead: ${h.tryInstead ?? ""}`,
        verdict: v.vote === "up" ? "helpful" : "not helpful",
        note: v.note,
        at: v.at,
        weight: (v.vote === "down" ? 2 : 0) + (v.note ? 1 : 0),
      });
    }
    const o = r.feedback.overall;
    if (o) out.push({ about: "a whole review", verdict: `rated ${o.rating}/5`, note: o.note, at: o.at, weight: (o.rating <= 3 ? 2 : 0) + (o.note ? 1 : 0) });
  }
  return out
    .sort((x, y) => y.weight - x.weight || y.at.localeCompare(x.at))
    .slice(0, limit)
    .map(({ at: _at, weight: _weight, ...f }) => f);
}
