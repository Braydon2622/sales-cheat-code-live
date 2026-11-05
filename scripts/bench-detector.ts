// Where does detector time go? Compares a bare round trip, the current
// structured-output detector, and the same prompt asking for plain JSON.
import Anthropic from "@anthropic-ai/sdk";
import { DETECTOR_INSTRUCTIONS } from "../src/pipeline/playbook.js";
import { renderCall } from "../src/pipeline/components.js";
import { ClaudeDetector } from "../src/pipeline/claude.js";
import { loadTranscript } from "../src/replay/transcript.js";
import { UsageMeter } from "../src/llm/usage.js";
import { percentile } from "../src/eval/metrics.js";

const client = new Anthropic();
const model = "claude-haiku-5-5";
const t = loadTranscript("data/calls/call-02.json");
const plain = t.utterances.map(({ labels: _l, ...u }) => u);
const idx = [3, 5, 7, 9, 11, 13];
const meter = new UsageMeter();

async function time(label: string, fn: (i: number) => Promise<unknown>) {
  const ms: number[] = [];
  for (const i of idx) {
    const t0 = performance.now();
    await fn(i);
    ms.push(performance.now() - t0);
  }
  console.log(`${label.padEnd(34)} p50 ${Math.round(percentile(ms, 50))} ms  [${ms.map(Math.round).join(", ")}]`);
}

await time("bare round trip (max_tokens 5)", () =>
  client.messages.create({ model, max_tokens: 5, thinking: { type: "disabled" }, messages: [{ role: "user", content: "Say ok." }] }),
);
const detector = new ClaudeDetector(model);
await time("detector, structured output", (i) => detector.detect(plain.slice(Math.max(0, i - 8), i), plain[i]!, meter));
await time("detector, prompted JSON", (i) =>
  client.messages.create({
    model,
    max_tokens: 200,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: [
      {
        type: "text",
        text: DETECTOR_INSTRUCTIONS + '\nReply with only JSON: {"moments":[{"type":"...","subtype":"...|none","evidence":"..."}]}',
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: renderCall(plain.slice(Math.max(0, i - 8), i), plain[i]!) }],
  }),
);
console.log(`cost: $${meter.costUsd().toFixed(4)} (structured runs only; others are similar, well under a cent)`);
