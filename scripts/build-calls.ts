// Converts the human-editable call sources into timestamped JSON the replay
// engine and evals read:
//   data/calls-src/*.txt   -> data/calls/*.json     (dev set: 20 calls, used for tuning)
//   data/holdout-src/*.txt -> data/holdout/*.json   (held-out set: never tune on it)
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseCallSource } from "../src/replay/transcript.js";

const SETS: Array<[string, string]> = [
  ["data/calls-src", "data/calls"],
  ["data/holdout-src", "data/holdout"],
];

for (const [src, out] of SETS) {
  if (!existsSync(src)) continue;
  mkdirSync(out, { recursive: true });
  const counts: Record<string, number> = {};
  console.log(`\n${src} -> ${out}`);
  for (const file of readdirSync(src).filter((f) => f.endsWith(".txt")).sort()) {
    const t = parseCallSource(readFileSync(join(src, file), "utf8"));
    writeFileSync(join(out, `${t.id}.json`), JSON.stringify(t, null, 2) + "\n");
    for (const u of t.utterances) {
      for (const l of u.labels) {
        const key = l.subtype ? `${l.type}:${l.subtype}` : l.type;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    const last = t.utterances.at(-1);
    console.log(`  ${t.id}  ${t.utterances.length} lines  ${last ? Math.round(last.end) : 0}s  ${t.title}`);
  }
  console.log("  Label counts:", counts);
}
