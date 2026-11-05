// Builds a SYNTHETIC Dialpad-format transcript (tests/fixtures/dialpad-sample.json)
// from a role-play call, with fake PII sprinkled in, so the importer, redaction
// and review can be tested without any real call data.
// All numbers are fictional (555-01xx phone range, test SSN/card numbers).
import { writeFileSync, mkdirSync } from "node:fs";
import { loadTranscript } from "../src/replay/transcript.js";

const t = loadTranscript("data/calls/call-18.json");
const base = Date.parse("2026-11-05T15:00:00.000Z");
const lines = t.utterances.map((u) => ({
  ...(u.speaker === "rep" ? { user_id: "4512" } : { contact_id: "ag5kZXZ-fake-contact" }),
  name: u.speaker === "rep" ? "Shawn (Copperleaf Home Loans)" : "(415) 555-0142",
  content: u.text,
  time: new Date(base + u.start * 1000).toISOString().replace("Z", "000"),
  type: "transcript",
}));
// Fake PII the redactor must catch.
lines.splice(4, 0, {
  contact_id: "ag5kZXZ-fake-contact",
  name: "(415) 555-0142",
  content: "If you need it my cell is (415) 555-0142 and my social is 078-05-1120.",
  time: new Date(base + 16_500).toISOString().replace("Z", "000"),
  type: "transcript",
});
// Dialpad AI "moment" lines are not speech and must be skipped.
lines.push({ user_id: "4512", name: "Shawn (Copperleaf Home Loans)", content: "price_inquiry", time: lines[7]!.time, type: "moment" });

mkdirSync("tests/fixtures", { recursive: true });
writeFileSync("tests/fixtures/dialpad-sample.json", JSON.stringify({ call_id: "9000000001", lines }, null, 2) + "\n");
console.log(`Wrote tests/fixtures/dialpad-sample.json (${lines.length} lines, synthetic)`);
