// Latency microbenchmark: times each stage in isolation, one request at a
// time (no overlap), to separate model speed from pipeline effects.
//   npx tsx scripts/bench.ts [coachModel...]
import { ClaudeCoach, ClaudeDetector } from "../src/pipeline/claude.js";
import { loadTranscript } from "../src/replay/transcript.js";
import { UsageMeter } from "../src/llm/usage.js";
import { percentile } from "../src/eval/metrics.js";

const coachModels = process.argv.slice(2).length ? process.argv.slice(2) : ["claude-opus-5-5", "claude-sonnet-5-5"];
const t = loadTranscript("data/calls/call-02.json");
const plain = t.utterances.map(({ labels: _l, ...u }) => u);
const meter = new UsageMeter();

const detector = new ClaudeDetector();
const det: number[] = [];
for (const i of [3, 5, 7, 9, 11, 13]) {
  const t0 = performance.now();
  await detector.detect(plain.slice(Math.max(0, i - 8), i), plain[i]!, meter);
  det.push(performance.now() - t0);
}
console.log(`detector (haiku, sequential): ${det.map(Math.round).join(", ")} ms · p50 ${Math.round(percentile(det, 50))}`);

for (const model of coachModels) {
  const coach = new ClaudeCoach(model, "low");
  await coach.prewarm(meter);
  const ttft: number[] = [];
  const full: number[] = [];
  for (const i of [5, 13, 15]) {
    const t0 = performance.now();
    let first: number | undefined;
    await coach.stream(
      { history: plain.slice(Math.max(0, i - 8), i), current: plain[i]!, moment: { type: "objection", evidence: "", utteranceIndex: i } },
      () => (first ??= performance.now() - t0),
      meter,
    );
    ttft.push(first ?? NaN);
    full.push(performance.now() - t0);
  }
  console.log(`coach ${model}: first token ${ttft.map(Math.round).join(", ")} ms · full ${full.map(Math.round).join(", ")} ms`);
}
for (const [m, tally] of meter.byModel) console.log(`  ${m}: ${tally.calls} calls, ${tally.output} output tokens`);
console.log(`bench cost: $${meter.costUsd().toFixed(4)}`);
