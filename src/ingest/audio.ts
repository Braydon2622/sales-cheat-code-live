// Audio import: a recorded call → Deepgram speech-to-text → a redacted Transcript.
//
// Deepgram pre-recorded API (docs read 2026-11-05):
//   POST https://api.deepgram.com/v1/listen?model=nova-3&...   body = raw audio bytes
//   Authorization: Token <DEEPGRAM_API_KEY>
//   developers.deepgram.com/docs/pre-recorded-audio, /docs/diarization
//   - diarize_model=latest labels each utterance with a speaker number (0, 1, ...)
//   - utterances=true groups words into sentence-like utterances with start/end times
//   - smart_format=true writes numbers as digits, which also helps our PII redaction
//
// A recording has no "rep" or "client" tag, only Speaker 1 / Speaker 2, so the
// person uploading picks which voice is the loan officer. Every line is redacted
// here, before it's stored or sent to any AI model. The audio itself is never
// written to disk; it goes straight from the upload to Deepgram.
import { mergeCounts, redact } from "../privacy/redact.js";
import type { LabeledUtterance, Transcript } from "../types.js";

/**
 * Nova-3 pre-recorded, pay-as-you-go, about $0.0043 per minute (third-party pricing
 * summaries, November 2026; check deepgram.com/pricing). Used only for the cost shown in the app.
 */
export const DEEPGRAM_USD_PER_MINUTE = 0.0043;

export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "mp4", "aac", "ogg", "oga", "opus", "webm", "flac", "amr"] as const;
const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
  amr: "audio/amr",
};

export function audioMimeFor(fileName: string): string | undefined {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return MIME[ext];
}

export interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
  channel?: number;
  confidence?: number;
}

export interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: { utterances?: DeepgramUtterance[] };
}

export type Transcriber = (audio: Uint8Array, contentType: string) => Promise<DeepgramResponse>;

/** Sends the audio to Deepgram. Needs DEEPGRAM_API_KEY. */
export function deepgramTranscriber(apiKey: string, fetchImpl: typeof fetch = fetch): Transcriber {
  return async (audio, contentType) => {
    const params = new URLSearchParams({ model: "nova-3", smart_format: "true", diarize_model: "latest", utterances: "true", punctuate: "true" });
    const res = await fetchImpl(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": contentType },
      body: new Blob([audio as Uint8Array<ArrayBuffer>]),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 408 || /SLOW_UPLOAD/.test(detail)) {
        throw new Error("The upload to speech-to-text was too slow and timed out. Try a compressed recording (MP3 or M4A rather than WAV) or a faster connection.");
      }
      if (res.status === 401 || res.status === 403) throw new Error("Deepgram didn't accept the API key. Check DEEPGRAM_API_KEY in .env.");
      throw new Error(`Speech-to-text failed (Deepgram ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as DeepgramResponse;
  };
}

export interface AudioSpeaker {
  /** "Speaker 1", "Speaker 2", ... in order of first appearance. */
  label: string;
  /** A redacted sample of what they said, to help pick the loan officer. */
  sample: string;
  words: number;
}

/** A transcribed, redacted call that's waiting for someone to say which voice is the loan officer. */
export interface TranscribedAudio {
  durationSec: number;
  lines: Array<{ speaker: string; start: number; end: number; text: string }>;
  speakers: AudioSpeaker[];
  redactions: Record<string, number>;
  transcriptionUsd: number;
}

/** Consecutive utterances from one speaker closer than this become one line. */
const MERGE_GAP_SECONDS = 1.0;

export function splitSpeakers(resp: DeepgramResponse): TranscribedAudio {
  const utterances = (resp.results?.utterances ?? []).filter((u) => u.transcript?.trim());
  if (!utterances.length) throw new Error("No speech found in this recording.");
  const order: number[] = [];
  const counts: Record<string, number> = {};
  const lines: TranscribedAudio["lines"] = [];
  for (const u of [...utterances].sort((a, b) => a.start - b.start)) {
    const id = u.speaker ?? u.channel ?? 0;
    if (!order.includes(id)) order.push(id);
    const speaker = `Speaker ${order.indexOf(id) + 1}`;
    const r = redact(u.transcript.trim());
    mergeCounts(counts, r.counts);
    const prev = lines.at(-1);
    if (prev && prev.speaker === speaker && u.start - prev.end < MERGE_GAP_SECONDS) {
      prev.text += ` ${r.text}`;
      prev.end = u.end;
    } else lines.push({ speaker, start: u.start, end: u.end, text: r.text });
  }
  const speakers = order.map((_, i) => {
    const label = `Speaker ${i + 1}`;
    const mine = lines.filter((l) => l.speaker === label);
    const longest = [...mine].sort((a, b) => b.text.length - a.text.length)[0]?.text ?? "";
    return {
      label,
      sample: longest.length > 160 ? `${longest.slice(0, 157)}…` : longest,
      words: mine.reduce((n, l) => n + l.text.split(/\s+/).length, 0),
    };
  });
  const durationSec = resp.metadata?.duration ?? lines.at(-1)!.end;
  return { durationSec, lines, speakers, redactions: counts, transcriptionUsd: (durationSec / 60) * DEEPGRAM_USD_PER_MINUTE };
}

/** Builds the Transcript once the loan officer's voice is known. Every other voice is the client side. */
export function audioToTranscript(a: TranscribedAudio, repSpeaker: string, id: string): Transcript {
  if (!a.speakers.some((s) => s.label === repSpeaker)) throw new Error(`No ${repSpeaker} in this recording.`);
  const utterances: LabeledUtterance[] = a.lines.map((l, index) => ({
    index,
    speaker: l.speaker === repSpeaker ? "rep" : "client",
    start: Math.round(l.start * 10) / 10,
    end: Math.round(l.end * 10) / 10,
    text: l.text,
    labels: [],
  }));
  return {
    id,
    title: `Recorded call ${id}`,
    scenario: "Imported call recording (transcribed, PII-redacted).",
    synthetic: false,
    source: "audio",
    redactions: a.redactions,
    utterances,
  };
}
