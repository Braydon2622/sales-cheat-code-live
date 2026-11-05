import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCallSource, loadAllTranscripts } from "../src/replay/transcript.js";
import { replay } from "../src/replay/replay.js";
import { parseCard } from "../src/pipeline/card.js";
import { percentile, prf, scoreDetection } from "../src/eval/metrics.js";
import type { DetectedMoment } from "../src/types.js";

describe.each([
  ["data/calls-src", "data/calls", 20],
  ["data/holdout-src", "data/holdout", 25],
] as const)("call set %s", (src, dir, n) => {
  const set = loadAllTranscripts(dir);

  it(`has ${n} synthetic calls, and the JSON is in sync with the sources`, () => {
    expect(set).toHaveLength(n);
    for (const f of readdirSync(src).filter((x) => x.endsWith(".txt"))) {
      const fromSource = parseCallSource(readFileSync(`${src}/${f}`, "utf8"));
      expect(set.find((t) => t.id === fromSource.id)).toEqual(fromSource);
    }
  });

  it("labels are on the right speaker", () => {
    for (const t of set) {
      expect(t.synthetic).toBe(true);
      for (const u of t.utterances) {
        for (const l of u.labels) {
          if (l.type === "rep_violation") expect(u.speaker, `${t.id} #${u.index}`).toBe("rep");
          else expect(u.speaker, `${t.id} #${u.index}`).toBe("client");
        }
      }
    }
  });
});

describe("transcripts", () => {
  const all = loadAllTranscripts();

  it("parses labels and synthesizes increasing timestamps", () => {
    const t = parseCallSource("# id: x\n# title: t\n# synthetic: true\nREP: Hi there.\nCLIENT: Stop calling me.  [opt_out]\n");
    expect(t.utterances[1]!.labels).toEqual([{ type: "opt_out" }]);
    expect(t.utterances[1]!.start).toBeGreaterThan(t.utterances[0]!.end);
  });

  it("rejects sources not marked synthetic", () => {
    expect(() => parseCallSource("# id: x\n# title: t\nREP: hi\n")).toThrow(/synthetic/);
  });

  it("replay emits growing partials before each client final", async () => {
    const t = parseCallSource("# id: x\n# title: t\n# synthetic: true\nCLIENT: one two three four five six seven\nREP: ok then\n");
    const out = [];
    for await (const u of replay(t, { speed: Infinity, partials: true, partialEveryWords: 3 })) out.push([u.kind, u.text]);
    expect(out).toEqual([
      ["partial", "one two three"],
      ["partial", "one two three four five six"],
      ["final", "one two three four five six seven"],
      ["final", "ok then"],
    ]);
  });

  it("replay strips labels and emits in order", async () => {
    const out = [];
    for await (const u of replay(all[0]!, { speed: Infinity })) out.push(u);
    expect(out).toHaveLength(all[0]!.utterances.length);
    expect("labels" in out[0]!).toBe(false);
  });
});

describe("card parsing", () => {
  it("parses labeled lines, tolerating markdown bold", () => {
    expect(parseCard("READ: a\n**SEND THIS:** b\nBackup: c\nNEXT STEP: d\nFOLLOW UP: f\nWATCH OUT: e")).toEqual({
      read: "a", sendThis: "b", backup: "c", nextStep: "d", followUp: "f", watchOut: "e",
    });
  });
});

describe("metrics", () => {
  it("computes precision/recall and nearest-rank percentiles", () => {
    expect(prf(3, 1, 1)).toMatchObject({ precision: 0.75, recall: 0.75 });
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("scores detections by line and type", () => {
    const t = parseCallSource(
      "# id: c\n# title: t\n# synthetic: true\nCLIENT: Too high.  [objection:rate_too_high]\nCLIENT: Nice weather.\nCLIENT: Next steps?  [buying_signal]\n",
    );
    const m = (type: DetectedMoment["type"], i: number, subtype?: string): DetectedMoment => ({ type, subtype, evidence: "", utteranceIndex: i });
    const det = new Map([[0, [m("objection", 0, "stall")]], [1, [m("question", 1)]]]);
    const s = scoreDetection([t], new Map([["c", det]]));
    expect(s.overall).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(s.subtypeAccuracy).toBe(0);
  });
});
