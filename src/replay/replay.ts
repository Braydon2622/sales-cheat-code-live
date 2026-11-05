// Replay engine: plays a transcript back as if it were a live streaming
// speech-to-text feed.
//
// Real streaming STT emits *interim* (partial) results while someone is still
// talking, then a *final* result when they stop. The replay simulates both:
//   - partial: the words spoken so far, every `partialEveryWords` words
//   - final:   the whole line, released when the speaker finishes ("speech end")
//
// Timing: silences between lines and rep speech are compressed by `speed`, but
// CLIENT speech plays in real time when partials are on. Otherwise a 10x replay
// would squeeze a 3-second sentence's partials into 0.3 s and erase exactly the
// head start partials are supposed to give.
import { setTimeout as sleep } from "node:timers/promises";
import type { Transcript, Utterance } from "../types.js";

export interface ReplayOptions {
  /** Compression for gaps and rep speech: 1 = real time, 10 = ten times faster, Infinity = no waiting. */
  speed?: number;
  /** Emit interim partial results. */
  partials?: boolean;
  partialEveryWords?: number;
  signal?: AbortSignal;
}

export interface ReplayedUtterance extends Utterance {
  /** performance.now() when this event was released. For finals this is "speech end". */
  emittedAt: number;
  /** "final" = speaker finished this line; "partial" = interim text so far. */
  kind: "final" | "partial";
}

export async function* replay(transcript: Transcript, opts: ReplayOptions = {}): AsyncGenerator<ReplayedUtterance> {
  const { speed = 1, partials = false, partialEveryWords = 3, signal } = opts;
  let clock = performance.now();
  let prevEnd = 0;

  const waitUntil = async (at: number) => {
    const wait = at - performance.now();
    if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => undefined);
  };

  for (const u of transcript.utterances) {
    if (signal?.aborted) return;
    // Strip eval labels: the live pipeline must never see ground truth.
    const { index, speaker, start, end, text } = u;
    const realtime = partials && speaker === "client";
    const gap = Math.max(0, start - prevEnd);
    const duration = end - start;
    const finite = Number.isFinite(speed);

    const startAt = clock + (finite ? (gap * 1000) / speed : 0);
    const durationMs = finite ? (duration * 1000) / (realtime ? 1 : speed) : 0;

    if (partials) {
      const words = text.split(/\s+/);
      for (let n = partialEveryWords; n < words.length; n += partialEveryWords) {
        if (finite) await waitUntil(startAt + (n / words.length) * durationMs);
        if (signal?.aborted) return;
        yield { index, speaker, start, end, text: words.slice(0, n).join(" "), emittedAt: performance.now(), kind: "partial" };
      }
    }
    if (finite) await waitUntil(startAt + durationMs);
    if (signal?.aborted) return;
    yield { index, speaker, start, end, text, emittedAt: performance.now(), kind: "final" };
    clock = finite ? startAt + durationMs : performance.now();
    prevEnd = end;
  }
}
