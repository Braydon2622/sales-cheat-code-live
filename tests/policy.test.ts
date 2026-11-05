import { describe, expect, it } from "vitest";
import { applyPolicy, DEFAULT_POLICY, MomentPolicy, NO_FILTER } from "../src/pipeline/policy.js";
import { parseDetectorReply } from "../src/pipeline/claude.js";
import type { DetectedMoment } from "../src/types.js";

const m = (utteranceIndex: number, type: DetectedMoment["type"], subtype?: string, confidence = 0.9): DetectedMoment => ({
  type, subtype, utteranceIndex, confidence, evidence: "",
});

describe("MomentPolicy", () => {
  it("applies the confidence threshold", () => {
    const p = new MomentPolicy({ threshold: 0.7, cooldownLines: {} });
    expect(p.accept(m(1, "question", undefined, 0.65))).toBe(false);
    expect(p.accept(m(2, "question", undefined, 0.75))).toBe(true);
  });

  it("cools down the same objection subtype, but not a different one", () => {
    const p = new MomentPolicy(DEFAULT_POLICY);
    expect(p.accept(m(1, "objection", "rate_too_high"))).toBe(true);
    expect(p.accept(m(3, "objection", "rate_too_high"))).toBe(false);
    expect(p.accept(m(4, "objection", "spouse"))).toBe(true);
    expect(p.accept(m(12, "objection", "rate_too_high"))).toBe(true); // cooldown over
  });

  it("never cools down rep violations or buying signals", () => {
    const p = new MomentPolicy(DEFAULT_POLICY);
    for (const i of [1, 2, 3]) expect(p.accept(m(i, "rep_violation", "rate_quote"))).toBe(true);
    for (const i of [4, 5]) expect(p.accept(m(i, "buying_signal"))).toBe(true);
  });

  it("treats the same line seen on a partial and the final as one moment", () => {
    const p = new MomentPolicy(DEFAULT_POLICY);
    expect(p.accept(m(5, "opt_out"))).toBe(true);
    expect(p.accept(m(5, "opt_out"))).toBe(true);
    expect(p.accept(m(9, "opt_out"))).toBe(false); // once per call
  });

  it("applies offline in call order", () => {
    const raw = new Map([[7, [m(7, "objection", "stall")]], [2, [m(2, "objection", "stall")]]]);
    const out = applyPolicy(raw, DEFAULT_POLICY);
    expect(out.get(2)).toHaveLength(1);
    expect(out.get(7)).toHaveLength(0);
    expect(applyPolicy(raw, NO_FILTER).get(7)).toHaveLength(1);
  });
});

describe("detector reply parsing", () => {
  it("accepts JSON with surrounding text and validates it", () => {
    const r = parseDetectorReply('Sure:\n{"moments":[{"type":"question","subtype":"none","confidence":0.8,"evidence":"what rate"}]}');
    expect(r.moments[0]).toMatchObject({ type: "question", confidence: 0.8 });
    expect(parseDetectorReply('{"moments": []}').moments).toEqual([]);
  });

  it("takes the first JSON object when the model adds a second one (live-run parse error)", () => {
    const r = parseDetectorReply('{"moments": []}\n{"moments": [{"type": "question"}]}');
    expect(r.moments).toEqual([]);
    expect(parseDetectorReply('{"moments":[{"type":"question","evidence":"a } in text"}]} trailing').moments).toHaveLength(1);
  });

  it("accepts a bare [] as no moments (live-run parse error)", () => {
    expect(parseDetectorReply("[]").moments).toEqual([]);
    expect(parseDetectorReply(" [ ] ").moments).toEqual([]);
  });

  it("rejects malformed replies instead of guessing", () => {
    expect(() => parseDetectorReply('{"moments":[{"type":"vibe"}]}')).toThrow(/unparseable/);
    expect(() => parseDetectorReply("no json here")).toThrow();
  });
});

import { UsageMeter } from "../src/llm/usage.js";
import { runConditions } from "../src/eval/report.js";

describe("request timing log", () => {
  it("aggregates per-stage timing and cache hit rate, and survives merge", () => {
    const a = new UsageMeter();
    a.logRequest({ stage: "coach", model: "m", issuedAt: 0, acceptedAt: 300, firstTokenAt: 900, doneAt: 2000, outcome: "ok" },
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
    a.logRequest({ stage: "coach_speculative", model: "m", issuedAt: 0, doneAt: 500, outcome: "cancelled" });
    const total = new UsageMeter();
    total.merge(a);
    const [coach, spec] = runConditions(total.requests);
    expect(coach).toMatchObject({ stage: "coach", requests: 1, durationP50: 2000, acceptedP50: 300, firstTokenP50: 900, cacheHitRate: 0.9 });
    expect(spec).toMatchObject({ stage: "coach_speculative", requests: 1, cancelled: 1 });
  });
});

import { buildReport } from "../src/eval/report.js";
import { runCall } from "../src/eval/runner.js";
import { KeywordDetector, NoopGuard, TemplateCoach } from "../src/pipeline/mock.js";
import { loadTranscript } from "../src/replay/transcript.js";

describe("report: run conditions section", () => {
  it("renders pings, per-stage timing and the chip breakdown", async () => {
    const t = loadTranscript("data/calls/call-18.json");
    const settings = { speed: Infinity, mode: "speculative" as const, partials: true };
    const r = await runCall(t, { detector: new KeywordDetector(), coach: new TemplateCoach(0, 0), guard: new NoopGuard() }, settings);
    r.meter.logRequest({ stage: "detector", model: "claude-haiku-5-5", issuedAt: 0, doneAt: 1100, outcome: "ok" },
      { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 800 });
    const { markdown, summary } = buildReport({
      mode: "live", models: { detector: "d", coach: "c", guard: "g" }, settings, transcripts: [t], results: [r],
      startedAt: new Date(0), setName: "calls",
      conditions: { pingsStart: { "claude-haiku-5-5": [700, 750, 800] }, pingsEnd: { "claude-haiku-5-5": [900, 950, 1000] }, overheadUsd: 0 },
    });
    expect(markdown).toContain("## Run conditions");
    expect(markdown).toMatch(/\| `claude-haiku-5-5` \| 750 ms \| 950 ms \|/);
    expect(markdown).toMatch(/\| detector \| 1 \| 0 \| 0 \| 1100 ms/);
    expect(markdown).toContain("Where chip time went");
    expect((summary as any).conditions.chipBreakdown.partial.n + (summary as any).conditions.chipBreakdown.final.n).toBe(r.cards.filter((c) => c.kind === "coach").length);
  });
});
