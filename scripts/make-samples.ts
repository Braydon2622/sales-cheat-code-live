// Builds samples/: SYNTHETIC call transcripts in the formats the app accepts,
// with fake personal details planted so the redaction is visible.
// All values are fictional: 555-01xx phone numbers, SSNs in the never-issued
// 9xx range or the well-known 078-05-1120 sample, example.com emails.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadTranscript } from "../src/replay/transcript.js";
import type { Transcript } from "../src/types.js";

const OUT = "samples";
mkdirSync(OUT, { recursive: true });

type Insert = { after: number; speaker: "rep" | "client"; text: string };

function withInserts(t: Transcript, inserts: Insert[]) {
  const lines = t.utterances.map((u) => ({ speaker: u.speaker, text: u.text, start: u.start }));
  for (const ins of [...inserts].sort((a, b) => b.after - a.after)) {
    const at = lines[ins.after]!;
    lines.splice(ins.after + 1, 0, { speaker: ins.speaker, text: ins.text, start: at.start + 0.5 });
  }
  return lines;
}

function toDialpad(t: Transcript, callId: string, inserts: Insert[]) {
  const base = Date.parse("2026-11-03T15:00:00.000Z");
  let clock = 0;
  const lines = withInserts(t, inserts).map((l) => {
    clock = Math.max(clock + 2, l.start);
    return {
      ...(l.speaker === "rep" ? { user_id: "4512" } : { contact_id: "ag5kZXZ-sample-contact" }),
      name: l.speaker === "rep" ? "Loan Officer (Copperleaf Home Loans)" : "(555) 010-0199",
      content: l.text,
      time: new Date(base + clock * 1000).toISOString().replace("Z", "000"),
      type: "transcript",
    };
  });
  return JSON.stringify({ call_id: callId, lines }, null, 2) + "\n";
}

function toText(t: Transcript, rep: string, client: string, inserts: Insert[], timestamps: boolean) {
  return (
    withInserts(t, inserts)
      .map((l) => {
        const ts = `[${String(Math.floor(l.start / 60)).padStart(2, "0")}:${String(Math.floor(l.start % 60)).padStart(2, "0")}] `;
        return `${timestamps ? ts : ""}${l.speaker === "rep" ? rep : client}: ${l.text}`;
      })
      .join("\n") + "\n"
  );
}

const samples = [
  {
    file: "nurse-rate-and-approval.json",
    title: "Nurse fishes for a rate and approval",
    format: "Dialpad JSON",
    note: "rep quotes a rate and promises approval",
    body: toDialpad(loadTranscript("data/calls/call-18.json"), "9000000101", [
      { after: 3, speaker: "client", text: "If you need it my cell is (555) 010-0142 and my social is 078-05-1120." },
    ]),
  },
  {
    file: "credit-union-loyalist.json",
    title: "Payment too high, credit union already approved her",
    format: "Dialpad JSON",
    note: "rep talks down the credit union",
    body: toDialpad(loadTranscript("data/calls/call-02.json"), "9000000102", [
      { after: 2, speaker: "client", text: "Sure, it's dana.sample@example.com, and I was born 04/12/1991 if you need that." },
    ]),
  },
  {
    file: "opt-out-ignored.json",
    title: "Client opts out, rep keeps pitching",
    format: "Dialpad JSON",
    note: "opt-out handling",
    body: toDialpad(loadTranscript("data/holdout/holdout-19.json"), "9000000103", []),
  },
  {
    file: "contractor-ready-to-buy.txt",
    title: "Self-employed contractor ready to buy",
    format: "text with names",
    note: "asks which speaker is the loan officer",
    body: toText(loadTranscript("data/calls/call-15.json"), "Chris", "Dominic", [
      { after: 5, speaker: "client", text: "The land is at 4821 Ridgeline Drive, and my account number at the bank is 004418273356." },
    ], true),
  },
  {
    file: "wife-handles-the-money.txt",
    title: "Needs to talk to her husband first",
    format: "text, REP/CLIENT",
    note: "spouse objection, clean rep",
    body: toText(loadTranscript("data/calls/call-07.json"), "REP", "CLIENT", [], false),
  },
];

for (const s of samples) writeFileSync(`${OUT}/${s.file}`, s.body);
writeFileSync(`${OUT}/index.json`, JSON.stringify(samples.map(({ body: _b, ...meta }) => meta), null, 2) + "\n");
writeFileSync(
  `${OUT}/README.md`,
  "# Sample calls\n\nSYNTHETIC role-play transcripts for trying the call-review app (`npm run app`). The personal details in them are fake and exist only to show the redaction working. Regenerate with `npx tsx scripts/make-samples.ts`.\n",
);
console.log(`Wrote ${samples.length} samples to ${OUT}/`);
