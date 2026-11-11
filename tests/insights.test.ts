import { describe, expect, it } from "vitest";
import { buildInsights, callStats } from "../src/review/insights.js";
import type { ReviewRecord } from "../src/review/review.js";

describe("callStats", () => {
  it("measures talk share, questions and the longest stretch without the client speaking", () => {
    const s = callStats([
      { speaker: "rep", text: "Hi there, thanks for calling today.", start: 0, end: 3 },
      { speaker: "rep", text: "So what made you reach out?", start: 3, end: 6 },
      { speaker: "client", text: "Just looking.", start: 6, end: 7 },
      { speaker: "rep", text: "Got it. How long have you owned the home?", start: 7, end: 40 },
    ]);
    expect(s.repTalkShare).toBeCloseTo(21 / 23, 5);
    expect(s.repQuestions).toBe(2);
    expect(s.longestRepStretchSec).toBe(33);
  });

  it("leaves the stretch out when timings are missing", () => {
    const s = callStats([{ speaker: "rep", text: "Hello" }, { speaker: "client", text: "Hi" }]);
    expect(s.repTalkShare).toBe(0.5);
    expect(s.longestRepStretchSec).toBeUndefined();
  });
});

const rec = (over: Partial<ReviewRecord>): ReviewRecord => ({
  id: "r1",
  createdAt: "2026-11-08T10:00:00Z",
  fileName: "call.txt",
  mode: "live",
  synthetic: true,
  source: "text",
  lines: 2,
  durationSec: 60,
  redactions: {},
  didWell: [],
  doBetter: [],
  slips: [],
  transcript: [
    { time: "0:00", speaker: "rep", text: "one two three" },
    { time: "0:05", speaker: "client", text: "four" },
  ],
  errors: [],
  costUsd: 0,
  feedback: { items: {} },
  ...over,
});
const analysis = (over: object = {}) =>
  ({
    summary: "", temperature: "Warm", stage: "Contacted", objections: "", next_step: "", follow_up: "", text_to_send: "",
    did_well: [], do_better: [], turning_point: null, next_step_booked: false, compliance_slips: [], coaching_note: "", ...over,
  }) as ReviewRecord["analysis"];
const miss = (category: string | undefined, what: string) =>
  ({ key: "b1", line: 0, time: "0:00", speaker: "rep", quote: "", what, why: "", ...(category ? { category } : {}) }) as ReviewRecord["doBetter"][number];

describe("buildInsights", () => {
  it("counts misses by category, slips by rule, stages, booked next steps, and skips mock reviews", () => {
    const records = [
      rec({ id: "a", analysis: analysis({ next_step_booked: true, temperature: "Hot", stage: "App out" }), doBetter: [miss("Discovery", "pitched first")],
        stats: { repTalkShare: 0.7, repQuestions: 1, longestRepStretchSec: 20 } }),
      rec({ id: "b", analysis: analysis({ stage: "Contacted" }), doBetter: [miss("Discovery", "no questions"), miss("Next step / close", "no close")],
        slips: [{ line: 0, time: "0:10", text: "about six percent", rules: ["rate_quote"], source: "rules" }],
        turningPoint: { line: 0, time: "0:10", speaker: "rep", quote: "about six percent", what: "Quoted a rate" } }),
      rec({ id: "c", doBetter: [miss(undefined, "old review")] }), // older review: no analysis fields, no stats
      rec({ id: "m", mode: "mock", doBetter: [miss("Rapport", "mock")] }),
    ];
    const d = buildInsights(records);
    expect(d.calls).toBe(3);
    expect(d.mockSkipped).toBe(1);
    expect(d.misses.map((m) => [m.category, m.count])).toEqual([["Discovery", 2], ["Next step / close", 1], ["Not categorized (older review)", 1]]);
    expect(d.misses[0]!.examples.map((e) => e.reviewId)).toEqual(["a", "b"]);
    expect(d.slipsByRule).toMatchObject([{ rule: "rate_quote", count: 1 }]);
    expect(d.callsWithSlips).toBe(1);
    expect(d.nextStepBooked).toEqual({ yes: 1, known: 2 });
    expect(d.stages).toEqual([{ stage: "Contacted", Hot: 0, Warm: 1, Cold: 0 }, { stage: "App out", Hot: 1, Warm: 0, Cold: 0 }]);
    expect(d.turningPoints).toMatchObject([{ reviewId: "b", text: "Quoted a rate", stage: "Contacted" }]);
    // a: 0.7 (stored); b and c: 3 of 4 words from the transcript.
    expect(d.avgRepTalkShare).toBeCloseTo((0.7 + 0.75 + 0.75) / 3, 5);
    expect(d.talkHeavyCalls).toBe(3);
    expect(buildInsights(records, { includeMock: true }).calls).toBe(4);
  });

  it("handles no reviews", () => {
    const d = buildInsights([]);
    expect(d.calls).toBe(0);
    expect(d.avgRepTalkShare).toBeNull();
  });
});
