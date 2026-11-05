// npm run eval -- [--mock] [--mode speculative|serial] [--no-partials] [--set calls|holdout]
//                 [--speed 10] [--calls call-01,call-05] [--coach-model claude-sonnet-5-5] [--max-usd 3]
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config, hasApiKey } from "../config.js";
import { makeComponents } from "../pipeline/factory.js";
import { ClaudeCoach, ping } from "../pipeline/claude.js";
import { KeywordDetector } from "../pipeline/mock.js";
import type { PipelineMode } from "../pipeline/session.js";
import { loadAllTranscripts } from "../replay/transcript.js";
import { buildReport } from "../eval/report.js";
import { detectOnly, runAll } from "../eval/runner.js";
import { UsageMeter } from "../llm/usage.js";

const { values } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    mode: { type: "string", default: "speculative" },
    "no-partials": { type: "boolean", default: false },
    set: { type: "string", default: "calls" },
    speed: { type: "string", default: "10" },
    calls: { type: "string" },
    "max-usd": { type: "string", default: "3" },
    "coach-model": { type: "string" },
  },
});

const mock = values.mock || !hasApiKey();
if (!values.mock && mock) console.warn("No ANTHROPIC_API_KEY found: running in MOCK mode (no API calls, $0).\n");
const mode = values.mode as PipelineMode;
if (mode !== "speculative" && mode !== "serial") throw new Error(`--mode must be speculative or serial`);
const partials = mode === "speculative" && !values["no-partials"];
const speed = values.speed === "max" ? Infinity : Number(values.speed);
const wanted = values.calls?.split(",").map((s) => s.trim());
const dir = values.set === "holdout" ? "data/holdout" : "data/calls";
const transcripts = loadAllTranscripts(dir).filter((t) => !wanted || wanted.includes(t.id));
const components = makeComponents(mock, { coachModel: values["coach-model"] });
const startedAt = new Date();

console.log(
  `Evaluating ${transcripts.length} calls from ${dir} (${mock ? "mock" : "live"}, ${mode}${partials ? " + partials" : ""}, speed ${values.speed === "max" ? "max" : values.speed + "x"}, cap $${values["max-usd"]})...`,
);
// Baseline pings (1-token requests) at the start and end of the run, to spot API drift between runs.
const pingMeter = new UsageMeter();
const pingModels = mock ? [] : [...new Set([config.detectorModel, values["coach-model"] ?? config.coachModel])];
const pingRound = async () => {
  const out: Record<string, number[]> = {};
  for (const model of pingModels) {
    out[model] = [];
    for (let i = 0; i < 3; i++) {
      const ms = await ping(model, pingMeter);
      if (ms !== undefined) out[model]!.push(ms);
    }
  }
  return out;
};
const pingsStart = await pingRound();
if (components.coach instanceof ClaudeCoach) {
  await components.coach.prewarm(pingMeter).catch((e: Error) => console.warn(`cache prewarm skipped: ${e.message}`));
}
const settings = { speed, mode, partials };
const results = await runAll(transcripts, components, {
  ...settings,
  maxUsd: Number(values["max-usd"]),
  onCallDone: (r, spent) =>
    console.log(`  ${r.callId}: ${r.cards.length} cards, ${r.repAlerts.length} rep alerts, ${r.errors.length} errors · $${spent.toFixed(3)} so far`),
});
const pingsEnd = await pingRound();
const baseline = mock ? undefined : await detectOnly(transcripts, new KeywordDetector());

const { markdown, summary } = buildReport({
  mode: mock ? "mock" : "live",
  models: { detector: components.detector.name, coach: components.coach.name, guard: components.guard.name },
  settings,
  transcripts,
  results,
  baseline,
  startedAt,
  setName: values.set ?? "calls",
  ...(mock ? {} : { conditions: { pingsStart, pingsEnd, overheadUsd: pingMeter.costUsd() } }),
});

// Name outputs after what differs between runs, so they sit side by side.
const coach = values["coach-model"] ?? config.coachModel;
const label = mock
  ? `mock${values.set === "holdout" ? "-holdout" : ""}`
  : [coach, mode, mode === "speculative" && !partials ? "nopartials" : "", values.set === "holdout" ? "holdout" : ""].filter(Boolean).join("-");
mkdirSync("reports/runs", { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const out = `reports/eval-${label}.md`;
writeFileSync(out, markdown);
writeFileSync(`reports/summary-${label}.json`, JSON.stringify(summary, null, 2) + "\n");
writeFileSync(`reports/runs/${stamp}-${label}.json`, JSON.stringify(summary, null, 2));
const cardLog = results.flatMap((r) => r.cards.map((c) => ({ callId: r.callId, coach: components.coach.name, ...c })));
writeFileSync(`reports/cards-${label}.json`, JSON.stringify(cardLog, null, 2) + "\n");
// Every detector answer, timed relative to that line's speech end (negative = mid-sentence).
const detLog = results.flatMap((r) =>
  r.detectionLog.map((d) => ({ callId: r.callId, ...d, msFromSpeechEnd: r.speechEnds[d.utteranceIndex] === undefined ? null : Math.round(d.at - r.speechEnds[d.utteranceIndex]!) })),
);
writeFileSync(`reports/detections-${label}.json`, JSON.stringify(detLog) + "\n");
console.log(`\n${markdown}\nWrote ${out}`);
