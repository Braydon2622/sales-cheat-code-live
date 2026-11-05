// Imports a Dialpad call transcript into the pipeline's Transcript format.
//
// Source: Dialpad API "Call Transcript -- Get", GET /api/v2/transcripts/{call_id}
// (https://developers.dialpad.com/reference/transcriptsget, read 2026-11-05).
// Response: { call_id, lines: [{ contact_id?, user_id?, name, content, time, type }] }
//   - type "transcript" lines are speech; "moment" and the other types are Dialpad's
//     own AI tags and are skipped.
//   - user_id set   -> a Dialpad user: the loan officer (rep)
//   - contact_id set -> the external party: the client
//     (Inferred from the field descriptions; verify against a real response.)
// Every line is PII-redacted on import. Speaker names are dropped.
import type { LabeledUtterance, Speaker, Transcript } from "../types.js";
import { mergeCounts, redact } from "../privacy/redact.js";

export interface DialpadLine {
  contact_id?: string | null;
  user_id?: string | number | null;
  name?: string | null;
  content?: string | null;
  time?: string | null;
  type?: string | null;
}

export interface DialpadTranscript {
  call_id?: string | number | null;
  lines?: DialpadLine[] | null;
}

export interface ImportOptions {
  /** If the call has several Dialpad users, which user IDs are the rep. Default: every user line is the rep. */
  repUserIds?: Array<string | number>;
}

const WORDS_PER_SECOND = 2.6;
/** Consecutive lines from the same speaker closer than this are merged into one utterance. */
const MERGE_GAP_SECONDS = 1.5;

export function importDialpad(json: DialpadTranscript, opts: ImportOptions = {}): Transcript {
  const repIds = opts.repUserIds?.map(String);
  const speech = (json.lines ?? [])
    .filter((l) => (l.type ?? "transcript") === "transcript" && l.content?.trim())
    .map((l) => ({ ...l, t: l.time ? Date.parse(l.time.replace(/(\.\d{3})\d+/, "$1")) : NaN }))
    .filter((l) => !Number.isNaN(l.t))
    .sort((a, b) => a.t - b.t);
  if (!speech.length) throw new Error("No transcript lines with timestamps found in this Dialpad response.");

  const speakerOf = (l: DialpadLine): Speaker | undefined => {
    if (l.user_id !== undefined && l.user_id !== null) return !repIds || repIds.includes(String(l.user_id)) ? "rep" : "client";
    if (l.contact_id) return "client";
    return undefined;
  };

  const t0 = speech[0]!.t;
  const counts: Record<string, number> = {};
  const raw: Array<{ speaker: Speaker; start: number; text: string }> = [];
  let skipped = 0;
  for (const l of speech) {
    const speaker = speakerOf(l);
    if (!speaker) {
      skipped++;
      continue;
    }
    const r = redact(l.content!.trim());
    mergeCounts(counts, r.counts);
    const start = (l.t - t0) / 1000;
    const prev = raw.at(-1);
    const prevEnd = prev ? prev.start + prev.text.split(/\s+/).length / WORDS_PER_SECOND : -Infinity;
    if (prev && prev.speaker === speaker && start - prevEnd < MERGE_GAP_SECONDS) prev.text += ` ${r.text}`;
    else raw.push({ speaker, start, text: r.text });
  }
  if (skipped) counts.UNKNOWN_SPEAKER_LINES_SKIPPED = skipped;
  return finish(raw, {
    id: `dialpad-${json.call_id ?? "unknown"}`,
    title: `Dialpad call ${json.call_id ?? ""}`.trim(),
    source: "dialpad",
    counts,
  });
}

/** Thrown when a text transcript has named speakers and we need to know which one is the loan officer. */
export class NeedRepNameError extends Error {
  constructor(readonly speakers: string[]) {
    super(`Can't tell who the loan officer is. Pass --rep-name (speakers found: ${speakers.join(", ")}).`);
  }
}

// "[00:01:23] Name: text", also tolerating Markdown bold around the name: "**Name**: text" / "**Name:** text".
const LINE_RE = /^(?:\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+)?[*_]{0,2}([^:*_]{1,40}?)[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.+)$/;

/** Speaker names in a "Speaker: text" transcript, in order of first appearance. */
export function listSpeakers(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const name = line.trim().match(LINE_RE)?.[2]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Plain-text import, for transcripts pasted or exported as lines like:
 *   "Marcus: Hi, is this Dana?"   or   "[00:01:23] Dana: Yeah, hi."   or   "REP: ..." / "CLIENT: ..."
 * `repName` says which speaker is the loan officer (not needed with REP/CLIENT labels).
 */
export function importText(source: string, opts: { id: string; repName?: string }): Transcript {
  const lines = source.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const counts: Record<string, number> = {};
  const raw: Array<{ speaker: Speaker; start: number; text: string }> = [];
  const speakers = new Set<string>();
  let clock = 0;
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const name = m[2]!.trim();
    speakers.add(name);
    const speaker: Speaker | undefined = /^rep$/i.test(name)
      ? "rep"
      : /^client$/i.test(name)
        ? "client"
        : opts.repName
          ? name.toLowerCase() === opts.repName.toLowerCase()
            ? "rep"
            : "client"
          : undefined;
    if (!speaker) throw new NeedRepNameError(listSpeakers(source));
    const start = m[1] ? toSeconds(m[1]) : clock;
    const r = redact(m[3]!);
    mergeCounts(counts, r.counts);
    raw.push({ speaker, start, text: r.text });
    clock = start + r.text.split(/\s+/).length / WORDS_PER_SECOND + 0.6;
  }
  if (!raw.length) throw new Error("No 'Speaker: text' lines found.");
  return finish(raw, { id: opts.id, title: `Imported call ${opts.id}`, source: "text", counts });
}

function finish(
  raw: Array<{ speaker: Speaker; start: number; text: string }>,
  meta: { id: string; title: string; source: "dialpad" | "text"; counts: Record<string, number> },
): Transcript {
  const utterances: LabeledUtterance[] = raw.map((u, index) => {
    const spoken = u.text.split(/\s+/).length / WORDS_PER_SECOND;
    const next = raw[index + 1]?.start;
    const end = Math.max(u.start + 0.5, next !== undefined ? Math.min(next, u.start + spoken) : u.start + spoken);
    return { index, speaker: u.speaker, start: round1(u.start), end: round1(end), text: u.text, labels: [] };
  });
  return {
    id: meta.id,
    title: meta.title,
    scenario: "Imported call (PII-redacted).",
    synthetic: false,
    source: meta.source,
    redactions: meta.counts,
    utterances,
  };
}

function toSeconds(ts: string): number {
  return ts.split(":").map(Number).reduce((s, n) => s * 60 + n, 0);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Fetch one call's transcript from the Dialpad API. Requires DIALPAD_API_KEY.
 * Real calls contain borrower data: only use after the pilot is approved (docs/APPROVAL_REQUEST.md).
 */
export async function fetchDialpadTranscript(callId: string, fetchImpl: typeof fetch = fetch): Promise<DialpadTranscript> {
  const key = process.env.DIALPAD_API_KEY;
  if (!key) throw new Error("DIALPAD_API_KEY is not set.");
  if (!/^\d+$/.test(callId)) throw new Error(`Dialpad call IDs are numeric; got "${callId}".`);
  const res = await fetchImpl(`https://dialpad.com/api/v2/transcripts/${callId}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Dialpad API ${res.status} for call ${callId}`);
  return (await res.json()) as DialpadTranscript;
}
