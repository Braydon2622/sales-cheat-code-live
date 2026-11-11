// No-API-key implementations. The keyword detector also serves as the
// "dumb baseline" in evals: if the model detector can't beat keyword
// matching, it isn't earning its cost.
import { setTimeout as sleep } from "node:timers/promises";
import type { UsageMeter } from "../llm/usage.js";
import type { Card, ComplianceViolation, DetectedMoment, Utterance } from "../types.js";
import { checkRepSpeech } from "./rules.js";
import { formatCard } from "./card.js";
import type { CardGuard, Coach, CoachRequest, Detector } from "./components.js";

const CLIENT_PATTERNS: Array<{ type: DetectedMoment["type"]; subtype?: string; re: RegExp }> = [
  { type: "opt_out", re: /\b(stop calling|take me off|remove me|don'?t (call|contact) me|do not (call|contact)|lose my number)\b/i },
  { type: "objection", subtype: "spouse", re: /\b(my (wife|husband|spouse|partner|fianc[eé]e?)|talk to (her|him|them) first|run it by)\b/i },
  { type: "objection", subtype: "rate_too_high", re: /\b(rates? (are|is) (too )?high|too high|wait (for|until) rates|rates (to )?(come|go) down|can'?t afford)\b/i },
  { type: "objection", subtype: "just_shopping", re: /\b(just (looking|shopping|comparing|curious|browsing)|shopping around|not ready)\b/i },
  { type: "objection", subtype: "bank_loyalty", re: /\b(my bank|credit union|current lender|stick with)\b/i },
  { type: "objection", subtype: "stall", re: /\b(been (busy|swamped|slammed)|think about it|call me (back|later|next)|send me (an )?email|not a good time|get back to you)\b/i },
  { type: "buying_signal", re: /\b(what (do|would) you need|next steps?|how (fast|soon|long)|documents?|get (this|things) started|pay ?stubs|when can we)\b/i },
  { type: "question", re: /\b(what('?s| is| are) (your|the) rates?|what rate|will I (get )?(approved|qualify)|can I (get )?(approved|qualify)|how much (would|will)|what would my payment)\b/i },
];

export class KeywordDetector implements Detector {
  readonly name = "keyword-baseline";

  async detect(_history: Utterance[], current: Utterance): Promise<DetectedMoment[]> {
    if (current.speaker === "rep") {
      return checkRepSpeech(current.text).map((v) => ({
        type: "rep_violation",
        subtype: v.rule === "rate_quote" || v.rule === "approval_promise" ? v.rule : "other",
        evidence: v.quote,
        utteranceIndex: current.index,
      }));
    }
    const out: DetectedMoment[] = [];
    for (const p of CLIENT_PATTERNS) {
      const m = current.text.match(p.re);
      if (!m) continue;
      if (out.some((o) => o.type === p.type)) continue; // one per type
      out.push({ type: p.type, ...(p.subtype ? { subtype: p.subtype } : {}), evidence: m[0], utteranceIndex: current.index });
      if (p.type === "opt_out") break;
    }
    return out;
  }
}

const TEMPLATES: Record<string, Card> = {
  rate_too_high: {
    read: "Rate-anchored; worried about the monthly cost.",
    sendThis: "Totally fair. The rate is one piece; let me look at your whole picture so we find what actually fits.",
    backup: "What matters most: lowest payment, or lowest total cost?",
    nextStep: 'Book a 15-minute review: "Does today at 4 or tomorrow at 10 work better?"',
    followUp: "Same day text with two times, then day 2.",
    watchOut: "Don't quote a rate to compete.",
  },
  spouse: {
    read: "Shared decision; partner needs to hear it.",
    sendThis: "Makes total sense. Let's set a quick call with both of you so nobody's relaying details.",
    backup: "What do you think their biggest question will be?",
    nextStep: 'Three-way call: "Does tonight at 7 or Saturday at 10 work better for you both?"',
    followUp: "Text both of them tomorrow with two times.",
    watchOut: "Don't pitch one to sell the other.",
  },
  default: {
    read: "They need to feel heard before anything else.",
    sendThis: "That makes sense. Can I ask a couple of quick questions so I give you a real answer?",
    backup: "What would make this worth your time?",
    nextStep: 'Short review: "Does today at 4 or tomorrow at 10 work better?"',
    followUp: "Same day, then day 2, day 4, day 7, then every 2 weeks.",
    watchOut: "No rates, payments, or approval promises.",
  },
};

/** Streams a canned card word-by-word with simulated model latency. */
export class TemplateCoach implements Coach {
  readonly name = "mock-template";
  constructor(private firstTokenMs = 450, private perWordMs = 12) {}

  async stream(req: CoachRequest, onText: (chunk: string) => void, _meter: UsageMeter, signal?: AbortSignal): Promise<string> {
    const card = TEMPLATES[req.moment?.subtype ?? ""] ?? TEMPLATES.default!;
    const text = formatCard(card);
    await sleep(this.firstTokenMs, undefined, { signal });
    for (const word of text.split(/(?<=\s)/)) {
      onText(word);
      await sleep(this.perWordMs, undefined, { signal });
    }
    return text;
  }
}

/** Mock mode has no model guard; the deterministic rules still run. */
export class NoopGuard implements CardGuard {
  readonly name = "none";
  async review(): Promise<ComplianceViolation[]> {
    return [];
  }
}

/** Mock post-call analysis: a fixed, compliant answer so reviews run for $0. */
export class MockCallAnalyzer {
  readonly name = "mock-analysis";
  /** Feedback passed in on the last call (lets tests check the app sends it). */
  lastFeedback: import("./claude.js").CoachFeedback[] = [];
  async analyze(transcriptText: string, _meter?: unknown, feedback: import("./claude.js").CoachFeedback[] = []): Promise<import("./claude.js").CallAnalysis> {
    this.lastFeedback = feedback;
    // Point the canned highlights at real REP lines so the page can show them in context.
    const repLines = [...transcriptText.matchAll(/^\[(\d+)\] REP:/gm)].map((m) => Number(m[1]));
    const first = repLines[0] ?? 0;
    const last = repLines.at(-1) ?? first;
    return {
      summary: "MOCK: canned summary. Run without mock mode for a real analysis.",
      temperature: "Warm",
      stage: "Contacted",
      objections: "None",
      next_step: "Book a 15-minute review.",
      follow_up: "Tomorrow at 10am",
      text_to_send: "Thanks for the chat today! Does today at 4 or tomorrow at 10 work better to go over your home options?",
      did_well: [{ line: first, what: "MOCK: opened warmly and set an agenda.", why: "Canned highlight for testing the page." }],
      do_better: [
        {
          line: last,
          category: "Next step / close",
          what_happened: "MOCK: ended without a specific next step.",
          try_instead: "Does today at 4 or tomorrow at 10 work better for a quick review?",
          why: "Canned highlight for testing the page.",
        },
      ],
      turning_point: { line: last, what: "MOCK: the call ended without a booked next step." },
      next_step_booked: false,
      compliance_slips: [],
      coaching_note: "MOCK: canned note.",
    };
  }
}
