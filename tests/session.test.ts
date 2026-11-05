import { describe, expect, it } from "vitest";
import { CallSession, latencyOf, type PipelineMode } from "../src/pipeline/session.js";
import { OPT_OUT_CARD, formatCard } from "../src/pipeline/card.js";
import { NoopGuard } from "../src/pipeline/mock.js";
import type { CardGuard, Coach, CoachRequest, Detector } from "../src/pipeline/components.js";
import type { ReplayedUtterance } from "../src/replay/replay.js";
import type { Card, DetectedMoment, MomentType } from "../src/types.js";

const GOOD: Card = {
  read: "Rate-anchored.",
  sendThis: "Totally fair to compare. Let me be a second set of eyes.",
  backup: "What matters most to you?",
  nextStep: '"Does today at 4 or tomorrow at 10 work better?"',
  followUp: "Same day, then day 2.",
  watchOut: "Don't quote a rate.",
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const detectorOf = (type: MomentType, opts: { delayMs?: number; confidence?: number } = {}): Detector => ({
  name: "fixed",
  detect: async (_h, u) => {
    if (opts.delayMs) await wait(opts.delayMs);
    return u.speaker === "client" ? [{ type, evidence: u.text, utteranceIndex: u.index, confidence: opts.confidence ?? 1 }] : [];
  },
});
const silentDetector: Detector = { name: "none", detect: async () => [] };
const coachOf = (card: Card, seen: CoachRequest[] = []): Coach => ({
  name: "fixed",
  stream: async (req, onText) => {
    seen.push(req);
    const text = formatCard(card);
    for (const line of text.split(/(?<=\n)/)) onText(line);
    return text;
  },
});
const utter = (speaker: "rep" | "client", text: string, index = 0, kind: "final" | "partial" = "final"): ReplayedUtterance => ({
  index, speaker, text, start: 0, end: 1, emittedAt: performance.now(), kind,
});

async function runOne(mode: PipelineMode, detector: Detector, coach: Coach, guard: CardGuard = new NoopGuard(), u = utter("client", "Your rates are too high.")) {
  const s = new CallSession(detector, coach, guard, { mode });
  const events: string[] = [];
  s.on("chip", () => events.push("chip"));
  s.on("card_line", (_id, field, text) => events.push(`${field}:${text}`));
  s.push(u);
  await s.finish();
  return { s, events, lines: events.filter((e) => e !== "chip") };
}

describe.each(["serial", "speculative"] as const)("CallSession (%s)", (mode) => {
  it("shows a compliant coach card and records latency", async () => {
    const { s, events } = await runOne(mode, detectorOf("objection"), coachOf(GOOD));
    const card = s.cards[0]!;
    expect(card.outcome).toBe("shown");
    expect(card.shown).toEqual(GOOD);
    expect(events[0]).toBe("chip"); // chip comes before any card text
    expect(latencyOf(card, "firstLineAt", "speechEnd")).toBeGreaterThanOrEqual(0);
    expect(card.fullCardAt!).toBeGreaterThanOrEqual(card.firstLineAt!);
  });

  it("blocks a rate quote mid-stream: the bad line never reaches the screen", async () => {
    const bad = { ...GOOD, sendThis: "I can get you 5.99% today." };
    const { s, lines } = await runOne(mode, detectorOf("objection"), coachOf(bad));
    expect(s.cards[0]!.outcome).toBe("blocked_by_rules");
    expect(lines.some((l) => l.includes("5.99"))).toBe(false);
    expect(lines.some((l) => l.startsWith("sendThis:"))).toBe(true); // safe card replaces it
  });

  it("retracts a card the model guard flags", async () => {
    const guard: CardGuard = {
      name: "flags",
      review: async () => [{ rule: "bank_disparagement", where: "sendThis", quote: "x", source: "model", severity: "block" }],
    };
    const { s } = await runOne(mode, detectorOf("objection"), coachOf(GOOD), guard);
    expect(s.cards[0]!.outcome).toBe("retracted_by_model");
    expect(s.cards[0]!.shown).not.toEqual(GOOD);
  });

  it("opt-outs show only the fixed card, never coach text", async () => {
    const { s, lines } = await runOne(mode, detectorOf("opt_out"), coachOf(GOOD), new NoopGuard(), utter("client", "Take me off your list."));
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]!.kind).toBe("fixed_opt_out");
    expect(lines).toEqual(Object.entries(OPT_OUT_CARD).map(([f, t]) => `${f}:${t}`));
  });

  it("falls back to a safe card when the coach fails", async () => {
    const coach: Coach = { name: "boom", stream: async () => { throw new Error("timeout"); } };
    const { s } = await runOne(mode, detectorOf("objection"), coach);
    expect(s.cards[0]!.outcome).toBe("coach_error");
    expect(s.cards[0]!.shown.sendThis).toBeTruthy();
  });

  it("alerts instantly on a rep rate quote, before the detector answers", async () => {
    const s = new CallSession(detectorOf("rep_violation", { delayMs: 50 }), coachOf(GOOD), new NoopGuard(), { mode });
    s.push(utter("rep", "I can do six and a quarter for you."));
    expect(s.repAlerts).toHaveLength(1);
    expect(s.repAlerts[0]!.source).toBe("rules");
    await s.finish();
  });

  it("ignores moments below the confidence threshold", async () => {
    const { s } = await runOne(mode, detectorOf("objection", { confidence: 0.3 }), coachOf(GOOD));
    expect(s.cards).toHaveLength(0);
  });
});

describe("speculative coaching", () => {
  it("starts the coach before the detector answers, but shows nothing until it confirms", async () => {
    const seen: CoachRequest[] = [];
    const { s, events } = await runOne("speculative", detectorOf("objection", { delayMs: 30 }), coachOf(GOOD, seen));
    expect(seen[0]!.moment).toBeUndefined(); // coach ran speculatively
    expect(events[0]).toBe("chip"); // its finished lines waited for the detector
    expect(s.cards[0]!.path).toBe("speculative");
    expect(s.cards[0]!.firstTokenAt!).toBeLessThan(s.cards[0]!.chipAt);
    expect(s.speculation).toMatchObject({ started: 1, used: 1, cancelled: 0 });
  });

  it("cancels the speculative card when the detector finds no moment", async () => {
    const { s, events } = await runOne("speculative", silentDetector, coachOf(GOOD));
    expect(events).toEqual([]);
    expect(s.cards).toHaveLength(0);
    expect(s.speculation).toMatchObject({ started: 1, cancelled: 1 });
  });

  it("re-asks with the moment when the coach guessed NONE but the detector disagrees", async () => {
    const seen: CoachRequest[] = [];
    const coach: Coach = {
      name: "none-then-card",
      stream: async (req, onText) => {
        seen.push(req);
        const text = req.moment ? formatCard(GOOD) : "NONE";
        onText(text);
        return text;
      },
    };
    const { s } = await runOne("speculative", detectorOf("question", { delayMs: 10 }), coach);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.moment?.type).toBe("question");
    expect(s.cards[0]!.path).toBe("speculative_miss");
    expect(s.cards[0]!.shown).toEqual(GOOD);
    expect(s.speculation.missed).toBe(1);
  });

  it("fires from an interim partial, before the client finishes", async () => {
    const s = new CallSession(detectorOf("objection"), coachOf(GOOD), new NoopGuard(), { mode: "speculative" });
    s.push(utter("client", "Honestly your rates are", 3, "partial"));
    await s.finish();
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]!.trigger).toBe("partial");
    s.push(utter("client", "Honestly your rates are way too high.", 3, "final"));
    await s.finish();
    expect(s.cards).toHaveLength(1); // the final doesn't fire a second card
    expect(latencyOf(s.cards[0]!, "firstLineAt", "speechEnd")).toBeLessThan(0); // card was up before speech end
  });

  it("a partial detection that resolves after speech end adopts the running speculative coach", async () => {
    const seen: CoachRequest[] = [];
    // Partial detection is slow (fires late); the final's detector is slower still.
    const detector: Detector = {
      name: "late",
      detect: async (_h, u, _m, _s, partial) => {
        await wait(partial ? 20 : 60);
        return [{ type: "objection", subtype: "stall", evidence: "", utteranceIndex: u.index, confidence: 0.9 }];
      },
    };
    const s = new CallSession(detector, coachOf(GOOD, seen), new NoopGuard(), { mode: "speculative" });
    s.push(utter("client", "I've been really", 4, "partial"));
    s.push(utter("client", "I've been really busy lately.", 4, "final"));
    await s.finish();
    expect(s.cards).toHaveLength(1);
    expect(seen).toHaveLength(1); // no second coach call
    expect(s.cards[0]).toMatchObject({ trigger: "partial", path: "speculative", outcome: "shown" });
  });

  it("serial mode ignores partials", async () => {
    const s = new CallSession(detectorOf("objection"), coachOf(GOOD), new NoopGuard(), { mode: "serial" });
    s.push(utter("client", "Honestly your rates are", 3, "partial"));
    await s.finish();
    expect(s.cards).toHaveLength(0);
  });

  it("cooldown: the same objection on the next line doesn't fire again", async () => {
    const s = new CallSession(detectorOf("objection"), coachOf(GOOD), new NoopGuard(), { mode: "speculative" });
    s.push(utter("client", "Rates are too high.", 1));
    s.push(utter("client", "Like I said, too high.", 2));
    await s.finish();
    expect(s.cards).toHaveLength(1);
  });
});

describe("chip latency breakdown", () => {
  it("records when the firing detector request was sent and answered", async () => {
    const { s } = await runOne("speculative", detectorOf("objection", { delayMs: 20 }), coachOf(GOOD));
    const t = s.cards[0]!;
    expect(t.detectorIssuedAt).toBeDefined();
    expect(t.detectorAnsweredAt! - t.detectorIssuedAt!).toBeGreaterThanOrEqual(15);
    expect(t.chipAt).toBeGreaterThanOrEqual(t.detectorAnsweredAt!);
  });
});
