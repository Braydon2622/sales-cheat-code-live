// Reads the filled-in rating sheet and un-blinds it.
//   npm run ratings:read
// Writes reports/ratings/ratings.json (one row per card, with the model) and
// prints the mean rating per coach model.
import { readFileSync, writeFileSync } from "node:fs";

const sheet = readFileSync("reports/ratings/sheet.md", "utf8");
const key = JSON.parse(readFileSync("reports/ratings/key.json", "utf8")) as Record<string, { coach: string; callId: string; cardId: number }>;

const rows: Array<{ id: string; rating: number; note: string; coach: string; callId: string; cardId: number }> = [];
const unrated: string[] = [];
for (const block of sheet.split(/^## /m).slice(1)) {
  const id = block.slice(0, 3);
  const rating = block.match(/\*\*Rating:\*\*\s*([1-5])\b/)?.[1];
  const note = block.match(/\*\*Note:\*\*[ \t]*(.*)/)?.[1]?.trim() ?? "";
  if (!rating) {
    unrated.push(id);
    continue;
  }
  rows.push({ id, rating: Number(rating), note, ...key[id]! });
}

writeFileSync("reports/ratings/ratings.json", JSON.stringify(rows, null, 2) + "\n");
const byCoach = new Map<string, number[]>();
for (const r of rows) byCoach.set(r.coach, [...(byCoach.get(r.coach) ?? []), r.rating]);
console.log(`${rows.length} rated${unrated.length ? `, ${unrated.length} still blank (${unrated.join(", ")})` : ""}`);
for (const [coach, rs] of byCoach) console.log(`  ${coach}: mean ${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)} over ${rs.length} cards`);
