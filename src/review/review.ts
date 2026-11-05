// Post-call review: runs a recorded (already transcribed, already redacted)
// call through the same detector → coach → compliance pipeline used for live
// calls, plus one call-level analysis, and renders a coaching report.
//
// No live audio and no latency budget here, so lines are processed one at a
// time (each card sees the right context, and we never burst the API).
import { CallSession, type CardTrace, type RepAlert } from "../pipeline/session.js";
import type { CardGuard, Coach, Detector } from "../pipeline/components.js";
import type { CallAnalysis, CallAnalyzer } from "../pipeline/claude.js";
import { checkCard, checkCardLine, hasTwoOptionClose, MAX_SPOKEN_CHARS } from "../pipeline/rules.js";
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
  detector: Detector;
  coach: Coach;
  guard: CardGuard;
  analyzer: CallAnalyzer;
}

export interface ReviewResult {
  transcript: Transcript;
  cards: CardTrace[];
  repAlerts: RepAlert[];
  analysis?: CallAnalysis;
  followUp?: FollowUpCheck;
  errors: string[];
  meter: UsageMeter;
}

export type ReviewProgress = (step: "lines" | "analysis", done: number, total: number) => void;

export async function reviewCall(t: Transcript, c: ReviewComponents, onProgress?: ReviewProgress): Promise<ReviewResult> {
  const session = new CallSession(c.detector, c.coach, c.guard, { mode: "serial" });
  const errors: string[] = [];
  session.on("stage_error", (stage, err) => errors.push(`${stage}: ${err.message}`));
  for (const [i, u] of t.utterances.entries()) {
    const { labels: _labels, ...line } = u;
    session.push({ ...line, kind: "final", emittedAt: performance.now() });
    await session.finish();
    onProgress?.("lines", i + 1, t.utterances.length);
  }
  onProgress?.("analysis", 0, 1);
  let analysis: CallAnalysis | undefined;
  let followUp: FollowUpCheck | undefined;
  try {
    analysis = await c.analyzer.analyze(t.utterances.map((u) => `${u.speaker.toUpperCase()}: ${u.text}`).join("\n"), session.meter);
    followUp = checkFollowUpText(analysis.text_to_send);
  } catch (err) {
    errors.push(`analysis: ${(err as Error).message}`);
  }
  return { transcript: t, cards: session.cards, repAlerts: session.repAlerts, analysis, followUp, errors, meter: session.meter };
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function renderReview(r: ReviewResult): string {
  const t = r.transcript;
  const md: string[] = [`# Call review: ${t.id}`, ""];
  const red = Object.entries(t.redactions ?? {}).map(([k, v]) => `${k} ×${v}`).join(", ");
  md.push(
    `${t.synthetic ? "**Synthetic call.**" : "**Real call. Contains customer information even after redaction: do not share outside the team.**"} ${t.utterances.length} lines, ${fmtTime(t.utterances.at(-1)?.end ?? 0)} long. PII redacted: ${red || "none found"}.`,
    "",
  );

  if (r.analysis) {
    const a = r.analysis;
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
      `**Coaching note:** ${a.coaching_note}`,
      "",
      `## Follow-up text`,
      "",
    );
    const f = r.followUp!;
    md.push(`> ${f.final}`, "");
    if (f.replaced) {
      md.push(`⚠ The drafted text broke a compliance rule and was replaced with a safe one. Draft: "${f.original}" (${f.violations.filter((v) => v.severity === "block").map((v) => v.rule).join(", ")})`, "");
    }
    const style = f.violations.filter((v) => v.severity === "style");
    md.push(style.length ? `Style notes: ${style.map((v) => v.rule.replace(/_/g, " ")).join(", ")}.` : `Passes the text rules: under 300 characters, "home" wording, two-option close, no rates or approval language.`, "");
  }

  md.push(`## Compliance: the loan officer's own words`, "");
  if (!r.repAlerts.length) md.push(`No slips flagged.`, "");
  for (const a of r.repAlerts) {
    const u = t.utterances[a.utteranceIndex]!;
    const what = a.violations.map((v) => v.rule.replace(/_/g, " ")).join(", ");
    md.push(`- **${fmtTime(u.start)}** · ${what} (${a.source === "rules" ? "rule" : "AI"}): "${u.text}"`);
  }
  md.push("");

  md.push(`## Coaching moments`, "");
  const coached = r.cards.filter((c) => c.kind === "coach" || c.kind === "fixed_opt_out");
  if (!coached.length) md.push(`No coaching moments detected.`, "");
  for (const c of coached) {
    const u = t.utterances[c.utteranceIndex]!;
    const said = t.utterances.slice(c.utteranceIndex + 1).find((x) => x.speaker === "rep");
    const tag = (c.moment.subtype ? `${c.moment.type}: ${c.moment.subtype}` : c.moment.type).replace(/_/g, " ");
    md.push(`### ${fmtTime(u.start)} · ${tag}`, "", `> **Client:** ${u.text}`, ">");
    md.push(`> **Loan officer said next:** ${said?.text ?? "(nothing)"}`, "");
    md.push(
      `**Card${c.outcome === "shown" ? "" : " (safe fallback, the draft was stopped by the compliance guard)"}:**`,
      "",
      `- **Read:** ${c.shown.read}`,
      `- **Send this:** ${c.shown.sendThis}`,
      `- **Backup:** ${c.shown.backup}`,
      `- **Next step:** ${c.shown.nextStep}`,
      `- **Watch out:** ${c.shown.watchOut}`,
      "",
    );
  }
  if (r.errors.length) md.push(`## Errors`, "", ...r.errors.map((e) => `- ${e}`), "");
  md.push(`_AI cost for this review: $${r.meter.costUsd().toFixed(4)}_`, "");
  return md.join("\n");
}

// ---------------------------------------------------------------- stored record

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
  followUp?: FollowUpCheck;
  slips: Array<{ time: string; text: string; rules: string[]; source: "rules" | "model" }>;
  moments: Array<{
    cardId: number;
    time: string;
    type: string;
    subtype?: string;
    clientText: string;
    repNext: string | null;
    card: CardTrace["shown"];
    stoppedByGuard: boolean;
  }>;
  transcript: Array<{ time: string; speaker: "rep" | "client"; text: string }>;
  errors: string[];
  costUsd: number;
  /** Your 1–5 ratings of each card, keyed by cardId. */
  ratings: Record<string, { rating: number; note: string; at: string }>;
}

export function toRecord(r: ReviewResult, meta: { id: string; fileName: string; mode: "live" | "mock"; createdAt?: string }): ReviewRecord {
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
    followUp: r.followUp,
    slips: r.repAlerts.map((a) => {
      const u = t.utterances[a.utteranceIndex]!;
      return { time: fmtTime(u.start), text: u.text, rules: a.violations.map((v) => v.rule), source: a.source };
    }),
    moments: r.cards.map((c) => {
      const u = t.utterances[c.utteranceIndex]!;
      const next = t.utterances.slice(c.utteranceIndex + 1).find((x) => x.speaker === "rep");
      return {
        cardId: c.id,
        time: fmtTime(u.start),
        type: c.moment.type,
        ...(c.moment.subtype ? { subtype: c.moment.subtype } : {}),
        clientText: u.text,
        repNext: next?.text ?? null,
        card: c.shown,
        stoppedByGuard: c.outcome !== "shown",
      };
    }),
    transcript: t.utterances.map((u) => ({ time: fmtTime(u.start), speaker: u.speaker, text: u.text })),
    errors: r.errors,
    costUsd: r.meter.costUsd(),
    ratings: {},
  };
}
