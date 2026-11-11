// Call analysis: where calls go wrong, per call and across every saved review.
//
// Two kinds of signal:
//   - Measured from the transcript (no AI): how much the loan officer talked,
//     how many questions they asked, their longest stretch without letting the
//     client speak.
//   - Tagged by the AI review: the category of each "do better" item, the
//     turning point where the call went off track, and whether a next step was booked.
// The insights view counts both across reviews so a manager can see the
// patterns (e.g. "most misses are Discovery, mostly at the Contacted stage").
import type { ReviewRecord } from "./review.js";

export interface CallStats {
  /** Share of all words spoken by the loan officer, 0–1. */
  repTalkShare: number;
  /** Loan officer lines that ask a question. */
  repQuestions: number;
  /** Longest run of consecutive loan officer lines, in seconds. Undefined when timings are missing. */
  longestRepStretchSec?: number;
}

/** A loan officer talking more than this share of the call is flagged. */
export const TALK_SHARE_FLAG = 0.6;
/** A stretch longer than this without the client speaking is flagged. */
export const MONOLOGUE_FLAG_SEC = 60;

interface Line {
  speaker: "rep" | "client";
  text: string;
  start?: number;
  end?: number;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const QUESTION = /\?|^(what|how|when|where|why|who|which|is|are|do|does|did|can|could|would|will|have|has)\b/i;

export function callStats(lines: Line[]): CallStats {
  let repWords = 0;
  let allWords = 0;
  let repQuestions = 0;
  let longest: number | undefined;
  let runStart: number | undefined;
  let runEnd: number | undefined;
  const timed = lines.length > 0 && lines.every((l) => typeof l.start === "number" && typeof l.end === "number");
  for (const l of lines) {
    const n = words(l.text);
    allWords += n;
    if (l.speaker === "rep") {
      repWords += n;
      if (l.text.split(/(?<=[.!?])\s+/).some((s) => QUESTION.test(s.trim()))) repQuestions++;
      if (timed) {
        runStart ??= l.start;
        runEnd = l.end;
        longest = Math.max(longest ?? 0, runEnd! - runStart!);
      }
    } else {
      runStart = runEnd = undefined;
    }
  }
  return {
    repTalkShare: allWords ? repWords / allWords : 0,
    repQuestions,
    ...(timed ? { longestRepStretchSec: longest ?? 0 } : {}),
  };
}

// ---------------------------------------------------------------- across reviews

export interface Example {
  reviewId: string;
  fileName: string;
  time: string;
  text: string;
}

export interface Insights {
  calls: number;
  /** Reviews left out because they're mock (canned) reviews. */
  mockSkipped: number;
  nextStepBooked: { yes: number; known: number };
  avgRepTalkShare: number | null;
  talkHeavyCalls: number;
  avgRepQuestions: number | null;
  callsWithSlips: number;
  /** "Do better" items by category, most common first. */
  misses: Array<{ category: string; count: number; examples: Example[] }>;
  slipsByRule: Array<{ rule: string; count: number; examples: Example[] }>;
  /** Calls by stage, split by temperature, in pipeline order. */
  stages: Array<{ stage: string; Hot: number; Warm: number; Cold: number }>;
  /** Most recent turning points first. */
  turningPoints: Array<Example & { stage?: string; temperature?: string }>;
}

const EXAMPLES = 3;
const STAGE_ORDER = ["New lead", "Contacted", "Soft pull", "Credit pull", "App out", "Package back", "Underwriting"];

function statsFor(r: ReviewRecord): CallStats {
  if (r.stats) return r.stats;
  // Reviews saved before stats existed: words and questions only (their transcript has no timings).
  return callStats(r.transcript.map((l) => ({ speaker: l.speaker, text: l.text })));
}

/** Counts patterns across reviews. Reviews arrive newest first. Mock reviews are skipped unless asked for. */
export function buildInsights(records: ReviewRecord[], opts: { includeMock?: boolean } = {}): Insights {
  const use = records.filter((r) => opts.includeMock || r.mode !== "mock");
  const misses = new Map<string, { count: number; examples: Example[] }>();
  const slips = new Map<string, { count: number; examples: Example[] }>();
  const stages = new Map<string, { Hot: number; Warm: number; Cold: number }>();
  const turningPoints: Insights["turningPoints"] = [];
  let booked = 0;
  let bookedKnown = 0;
  let talkSum = 0;
  let questionSum = 0;
  let talkHeavy = 0;
  let withSlips = 0;
  const bump = (m: Map<string, { count: number; examples: Example[] }>, key: string, ex: Example) => {
    const e = m.get(key) ?? { count: 0, examples: [] };
    e.count++;
    if (e.examples.length < EXAMPLES) e.examples.push(ex);
    m.set(key, e);
  };

  for (const r of use) {
    const s = statsFor(r);
    talkSum += s.repTalkShare;
    questionSum += s.repQuestions;
    if (s.repTalkShare > TALK_SHARE_FLAG || (s.longestRepStretchSec ?? 0) > MONOLOGUE_FLAG_SEC) talkHeavy++;
    if (r.slips.length) withSlips++;
    for (const h of r.doBetter ?? []) bump(misses, h.category ?? "Not categorized (older review)", { reviewId: r.id, fileName: r.fileName, time: h.time, text: h.what });
    for (const sl of r.slips) for (const rule of sl.rules) bump(slips, rule, { reviewId: r.id, fileName: r.fileName, time: sl.time, text: sl.text });
    const a = r.analysis;
    if (!a) continue;
    if (typeof a.next_step_booked === "boolean") {
      bookedKnown++;
      if (a.next_step_booked) booked++;
    }
    const st = stages.get(a.stage) ?? { Hot: 0, Warm: 0, Cold: 0 };
    st[a.temperature]++;
    stages.set(a.stage, st);
    if (r.turningPoint) {
      turningPoints.push({ reviewId: r.id, fileName: r.fileName, time: r.turningPoint.time, text: r.turningPoint.what, stage: a.stage, temperature: a.temperature });
    }
  }

  const sorted = (m: Map<string, { count: number; examples: Example[] }>) =>
    [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((x, y) => y.count - x.count || x.key.localeCompare(y.key));
  return {
    calls: use.length,
    mockSkipped: records.length - use.length,
    nextStepBooked: { yes: booked, known: bookedKnown },
    avgRepTalkShare: use.length ? talkSum / use.length : null,
    talkHeavyCalls: talkHeavy,
    avgRepQuestions: use.length ? questionSum / use.length : null,
    callsWithSlips: withSlips,
    misses: sorted(misses).map(({ key, ...v }) => ({ category: key, ...v })),
    slipsByRule: sorted(slips).map(({ key, ...v }) => ({ rule: key, ...v })),
    stages: [...stages.entries()]
      .sort((x, y) => STAGE_ORDER.indexOf(x[0]) - STAGE_ORDER.indexOf(y[0]))
      .map(([stage, t]) => ({ stage, ...t })),
    turningPoints: turningPoints.slice(0, 10),
  };
}
