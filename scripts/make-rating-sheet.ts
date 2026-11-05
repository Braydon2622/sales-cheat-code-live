// Builds a blind rating sheet of ~15 real coach cards for a sales manager to score 1–5.
//   npm run ratings:sheet -- claude-opus-5-5 claude-sonnet-5-5
// Reads reports/cards-<label>.json from live eval runs. Writes:
//   reports/ratings/sheet.md   what the reviewer fills in (model names hidden)
//   reports/ratings/key.json   which model wrote each card (don't open while rating)
// His ratings later calibrate an AI judge: if the judge agrees with him on
// these cards, it can score thousands of cards he never has to read.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadAllTranscripts } from "../src/replay/transcript.js";
import { formatCard } from "../src/pipeline/card.js";
import type { CardTrace } from "../src/pipeline/session.js";

type LoggedCard = CardTrace & { callId: string; coach: string };

const labels = process.argv.slice(2);
const TARGET = Number(process.env.RATING_SAMPLE ?? 15);
if (!labels.length) throw new Error("usage: make-rating-sheet <label> [label...]");

const transcripts = new Map(loadAllTranscripts().map((t) => [t.id, t]));
const pools = labels.map((l) => {
  const file = `reports/cards-${l}.json`;
  if (!existsSync(file)) throw new Error(`${file} not found: run the eval with that coach first`);
  // Only cards the coach actually drafted in full. Fixed opt-out cards aren't the coach's work.
  return (JSON.parse(readFileSync(file, "utf8")) as LoggedCard[]).filter(
    (c) => c.kind === "coach" && c.draft.read && c.draft.sendThis && c.draft.nextStep,
  );
});

// Deterministic PRNG so the same runs always give the same sheet.
let seed = 20261105;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = <T>(xs: T[]) => xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

// Stratify: round-robin across models, and within each model across moment kinds,
// so the sheet covers objections of each type, questions and buying signals.
const kind = (c: LoggedCard) => (c.moment.subtype ? `${c.moment.type}:${c.moment.subtype}` : c.moment.type);
const queues = pools.map((pool) => {
  const byKind = new Map<string, LoggedCard[]>();
  for (const c of shuffle(pool)) byKind.set(kind(c), [...(byKind.get(kind(c)) ?? []), c]);
  const order: LoggedCard[] = [];
  while ([...byKind.values()].some((q) => q.length)) for (const q of byKind.values()) if (q.length) order.push(q.shift()!);
  return order;
});
const picked: LoggedCard[] = [];
for (let i = 0; picked.length < TARGET && queues.some((q) => q.length); i++) {
  const q = queues[i % queues.length]!;
  if (q.length) picked.push(q.shift()!);
}
const sheetCards = shuffle(picked);

const md: string[] = [
  "# Card rating sheet",
  "",
  `${sheetCards.length} real coaching cards from synthetic calls. Model names are hidden on purpose.`,
  "",
  "For each card, replace the `_` after **Rating** with a number, and add a note if you want:",
  "",
  "- **5:** I'd say this word for word. It's the right move.",
  "- **4:** Good. Minor wording tweaks.",
  "- **3:** Right idea, but I'd rework it before using it.",
  "- **2:** Wrong move, or too clunky to use live.",
  "- **1:** Harmful: off-playbook, non-compliant, or would hurt the call.",
  "",
  "Judge the card as if you were the loan officer reading it mid-call. Compliance problems mean 1, even if the line is persuasive.",
  "",
];
const key: Record<string, { coach: string; callId: string; cardId: number; outcome: string }> = {};
sheetCards.forEach((c, i) => {
  const id = `C${String(i + 1).padStart(2, "0")}`;
  key[id] = { coach: c.coach, callId: c.callId, cardId: c.id, outcome: c.outcome };
  const t = transcripts.get(c.callId)!;
  const at = c.moment.utteranceIndex;
  const context = t.utterances.slice(Math.max(0, at - 4), at + 1);
  md.push(`---`, "", `## ${id} · ${kind(c).replace(/_/g, " ")}`, "", `*${t.title}*`, "");
  for (const u of context) md.push(`> ${u.index === at ? "**" : ""}${u.speaker.toUpperCase()}: ${u.text}${u.index === at ? "**" : ""}`);
  md.push("", "```", formatCard(c.draft), "```", "", "**Rating:** _", "", "**Note:** ", "");
});

mkdirSync("reports/ratings", { recursive: true });
writeFileSync("reports/ratings/sheet.md", md.join("\n"));
writeFileSync("reports/ratings/key.json", JSON.stringify(key, null, 2) + "\n");
const mix = Object.values(key).reduce<Record<string, number>>((m, k) => ((m[k.coach] = (m[k.coach] ?? 0) + 1), m), {});
console.log(`Wrote reports/ratings/sheet.md with ${sheetCards.length} cards`, mix);
