// Post-call review of recorded calls.
//   npm run review -- <file.json|file.txt ...> [--rep-name Marcus] [--rep-user-id 123,456] [--mock] [--max-usd 0.5]
//   npm run review -- --dialpad-call-id 123456789          (fetch from the Dialpad API; needs DIALPAD_API_KEY)
//
// .json files are Dialpad "Call Transcript -- Get" responses; .txt files are
// "Speaker: text" lines. Everything is PII-redacted on import. The redacted
// transcript goes to data/private/ and the report to reports/reviews/; both
// are gitignored because real calls contain customer information.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { config, hasApiKey } from "../config.js";
import { ClaudeCallAnalyzer } from "../pipeline/claude.js";
import { makeComponents } from "../pipeline/factory.js";
import { MockCallAnalyzer } from "../pipeline/mock.js";
import { fetchDialpadTranscript, importDialpad, importText, type DialpadTranscript } from "../ingest/dialpad.js";
import { renderReview, reviewCall, toRecord } from "../review/review.js";
import type { Transcript } from "../types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "rep-name": { type: "string" },
    "rep-user-id": { type: "string" },
    "dialpad-call-id": { type: "string" },
    mock: { type: "boolean", default: false },
    "max-usd": { type: "string", default: "0.5" },
    out: { type: "string", default: "reports/reviews" },
  },
});

const mock = values.mock || !hasApiKey();
if (!values.mock && mock) console.warn("No ANTHROPIC_API_KEY found: running in MOCK mode (canned cards and analysis, $0).\n");
const repUserIds = values["rep-user-id"]?.split(",").map((s) => s.trim());

async function load(): Promise<Transcript[]> {
  const out: Transcript[] = [];
  if (values["dialpad-call-id"]) out.push(importDialpad(await fetchDialpadTranscript(values["dialpad-call-id"]), { repUserIds }));
  for (const file of positionals) {
    const text = readFileSync(file, "utf8");
    if (extname(file) === ".json") out.push(importDialpad(JSON.parse(text) as DialpadTranscript, { repUserIds }));
    else out.push(importText(text, { id: basename(file, extname(file)), repName: values["rep-name"] }));
  }
  if (!out.length) throw new Error("Give one or more transcript files, or --dialpad-call-id.");
  return out;
}

const transcripts = await load();
const components = { ...makeComponents(mock), analyzer: mock ? new MockCallAnalyzer() : new ClaudeCallAnalyzer(config.coachModel) };
mkdirSync(values.out!, { recursive: true });
mkdirSync("data/private", { recursive: true });

let spent = 0;
for (const t of transcripts) {
  if (spent >= Number(values["max-usd"])) {
    console.warn(`Stopping: spend $${spent.toFixed(3)} reached --max-usd ${values["max-usd"]}.`);
    break;
  }
  // Same naming as the app, so CLI reviews show up in the app's Reviews list too.
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const id = `${t.id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}-${stamp}`;
  writeFileSync(`data/private/${id}.transcript.json`, JSON.stringify(t, null, 2) + "\n");
  console.log(`Reviewing ${t.id} (${t.utterances.length} lines, redacted: ${JSON.stringify(t.redactions ?? {})})...`);
  const r = await reviewCall(t, components);
  spent += r.meter.costUsd();
  const out = `${values.out}/${id}.md`;
  writeFileSync(out, renderReview(r));
  const fileName = values["dialpad-call-id"] && t.source === "dialpad" ? `dialpad-${values["dialpad-call-id"]}` : `${t.id}${t.source === "dialpad" ? ".json" : ".txt"}`;
  writeFileSync(`${values.out}/${id}.json`, JSON.stringify(toRecord(r, { id, fileName, mode: mock ? "mock" : "live" }), null, 2) + "\n");
  console.log(`  ${r.cards.length} coaching moments, ${r.repAlerts.length} compliance flags, ${r.errors.length} errors · $${r.meter.costUsd().toFixed(4)} → ${out}`);
}
console.log(`\nDone. Total AI cost: $${spent.toFixed(4)}`);
