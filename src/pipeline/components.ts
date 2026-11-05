// The three swappable stages of the pipeline. Each has a Claude-backed
// implementation (claude.ts) and a no-API-key mock (mock.ts), so the whole
// system can be tested and demoed for $0.
import type { Card, ComplianceViolation, DetectedMoment, Utterance } from "../types.js";
import type { UsageMeter } from "../llm/usage.js";

export interface Detector {
  readonly name: string;
  detect(history: Utterance[], current: Utterance, meter: UsageMeter, signal?: AbortSignal, partial?: boolean): Promise<DetectedMoment[]>;
}

export interface CoachRequest {
  history: Utterance[];
  current: Utterance;
  /** Undefined = speculative: the coach starts before the detector answers and may reply NONE. */
  moment?: DetectedMoment;
  /** The current line is an interim partial; the speaker is still talking. */
  partial?: boolean;
}

export interface Coach {
  readonly name: string;
  /** Streams card text; calls onText with each chunk. Resolves with the full text. */
  stream(req: CoachRequest, onText: (chunk: string) => void, meter: UsageMeter, signal?: AbortSignal): Promise<string>;
}

export interface CardGuard {
  readonly name: string;
  /** Second-layer review of a finished card. Rules-based checks happen separately. */
  review(card: Card, moment: DetectedMoment, meter: UsageMeter, signal?: AbortSignal): Promise<ComplianceViolation[]>;
}

/** Render the recent call as plain text, marking the line to react to. */
export function renderCall(history: Utterance[], current: Utterance, partial = false): string {
  const lines = history.map((u) => `${u.speaker.toUpperCase()}: ${u.text}`);
  lines.push(`>>> ${current.speaker.toUpperCase()}${partial ? " (still speaking)" : ""}: ${current.text}${partial ? " ..." : ""}`);
  return lines.join("\n");
}
