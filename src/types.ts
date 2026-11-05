// Core data types shared by the replay engine, pipeline, and eval harness.

export type Speaker = "rep" | "client";

/** The moment types the detector can emit. */
export const MOMENT_TYPES = [
  "objection",
  "buying_signal",
  "question",
  "opt_out",
  "rep_violation",
] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];

export const OBJECTION_SUBTYPES = [
  "rate_too_high",
  "just_shopping",
  "spouse",
  "stall",
  "bank_loyalty",
] as const;
export const REP_VIOLATION_SUBTYPES = ["rate_quote", "approval_promise", "other"] as const;

/** A label like `objection:spouse` or `buying_signal`. */
export interface MomentLabel {
  type: MomentType;
  subtype?: string;
}

/** One finalized line of speech, as a streaming speech-to-text engine would emit it. */
export interface Utterance {
  index: number;
  speaker: Speaker;
  /** Seconds from call start. */
  start: number;
  end: number;
  text: string;
}

/** A labeled utterance in a transcript file (labels are ground truth for evals). */
export interface LabeledUtterance extends Utterance {
  labels: MomentLabel[];
}

export interface Transcript {
  id: string;
  title: string;
  scenario: string;
  /** Synthetic role-play (eval sets) or an imported real call. */
  synthetic: boolean;
  source?: "synthetic" | "dialpad" | "text";
  /** Imported calls: PII redaction counts, e.g. { SSN: 1, PHONE: 2 }. */
  redactions?: Record<string, number>;
  utterances: LabeledUtterance[];
}

/** What the detector decided about one utterance. */
export interface DetectedMoment extends MomentLabel {
  utteranceIndex: number;
  /** Short quote or reason from the detector. */
  evidence: string;
  /** Detector confidence, 0–1. Missing means certain (rules, keyword baseline). */
  confidence?: number;
  /** True when found on an interim partial, before the speaker finished. */
  fromPartial?: boolean;
}

export const CARD_FIELDS = ["read", "sendThis", "backup", "nextStep", "followUp", "watchOut"] as const;
export type CardField = (typeof CARD_FIELDS)[number];
export type Card = Record<CardField, string>;

export interface ComplianceViolation {
  rule: string;
  /** Which card field (or "rep_speech") the problem is in. */
  where: CardField | "rep_speech";
  quote: string;
  source: "rules" | "model";
  /** "block" = must never reach the rep; "style" = playbook preference, reported only. */
  severity: "block" | "style";
}
