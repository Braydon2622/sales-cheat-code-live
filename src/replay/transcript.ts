// Parses the human-editable call source format (data/calls-src/*.txt) into a
// timestamped Transcript. Timing is synthesized deterministically from word
// count so every run of the eval replays the call identically.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MOMENT_TYPES,
  type LabeledUtterance,
  type MomentLabel,
  type MomentType,
  type Transcript,
} from "../types.js";

/** ~155 words per minute, a typical phone-conversation pace. */
const WORDS_PER_SECOND = 2.6;
const MIN_UTTERANCE_SECONDS = 0.8;

export function parseLabel(raw: string): MomentLabel {
  const [type, subtype] = raw.trim().split(":");
  if (!type || !(MOMENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown label type: "${raw}"`);
  }
  return subtype ? { type: type as MomentType, subtype } : { type: type as MomentType };
}

/** Deterministic pause between turns (0.4–1.2s) so replays are repeatable. */
function gapAfter(index: number): number {
  return 0.4 + ((index * 37) % 9) / 10;
}

export function parseCallSource(source: string): Transcript {
  const header: Record<string, string> = {};
  const utterances: LabeledUtterance[] = [];
  let clock = 0;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const headerMatch = line.match(/^#\s*(\w+):\s*(.*)$/);
    if (headerMatch) {
      header[headerMatch[1]!] = headerMatch[2]!;
      continue;
    }
    const m = line.match(/^(REP|CLIENT):\s*(.*?)(?:\s{2,}\[([^\]]+)\])?\s*$/);
    if (!m) throw new Error(`Unparseable line: ${line}`);
    const text = m[2]!.trim();
    const labels = m[3] ? m[3].split(",").map(parseLabel) : [];
    const words = text.split(/\s+/).filter(Boolean).length;
    const duration = Math.max(MIN_UTTERANCE_SECONDS, words / WORDS_PER_SECOND);
    const start = round1(clock);
    const end = round1(clock + duration);
    utterances.push({
      index: utterances.length,
      speaker: m[1] === "REP" ? "rep" : "client",
      start,
      end,
      text,
      labels,
    });
    clock = end + gapAfter(utterances.length);
  }

  if (!header.id || !header.title) throw new Error("Call source needs '# id:' and '# title:' headers");
  if (header.synthetic !== "true") throw new Error(`${header.id}: must be marked '# synthetic: true'`);
  return {
    id: header.id,
    title: header.title,
    scenario: header.scenario ?? "",
    synthetic: true,
    utterances,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function loadTranscript(path: string): Transcript {
  return JSON.parse(readFileSync(path, "utf8")) as Transcript;
}

export function loadAllTranscripts(dir = "data/calls"): Transcript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadTranscript(join(dir, f)));
}
