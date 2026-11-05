// Pure scoring functions for the eval harness (unit-tested in tests/metrics.test.ts).
import { MOMENT_TYPES, type DetectedMoment, type MomentType, type Transcript } from "../types.js";

export interface PRF {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export function prf(tp: number, fp: number, fn: number): PRF {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

export interface DetectionError {
  callId: string;
  utteranceIndex: number;
  text: string;
  kind: "missed" | "false_alarm" | "wrong_subtype";
  expected?: string;
  got?: string;
}

export interface DetectionScore {
  overall: PRF;
  byType: Record<MomentType, PRF>;
  /** Of true-positive objections/rep violations, how often the subtype was also right. */
  subtypeAccuracy: number;
  errors: DetectionError[];
}

/**
 * A detection matches a label when it is on the same utterance with the same
 * type. Subtype mismatches are reported separately (still a true positive:
 * the coach still fires, it just gets a slightly wrong hint).
 */
export function scoreDetection(
  transcripts: Transcript[],
  detectionsByCall: Map<string, Map<number, DetectedMoment[]>>,
): DetectionScore {
  const counts = Object.fromEntries(MOMENT_TYPES.map((t) => [t, { tp: 0, fp: 0, fn: 0 }])) as Record<
    MomentType,
    { tp: number; fp: number; fn: number }
  >;
  let subtypeTotal = 0;
  let subtypeRight = 0;
  const errors: DetectionError[] = [];

  for (const t of transcripts) {
    const detections = detectionsByCall.get(t.id) ?? new Map<number, DetectedMoment[]>();
    for (const u of t.utterances) {
      const got = detections.get(u.index) ?? [];
      for (const type of MOMENT_TYPES) {
        const label = u.labels.find((l) => l.type === type);
        const hit = got.find((d) => d.type === type);
        if (label && hit) {
          counts[type].tp++;
          if (label.subtype) {
            subtypeTotal++;
            if (label.subtype === hit.subtype) subtypeRight++;
            else
              errors.push({ callId: t.id, utteranceIndex: u.index, text: u.text, kind: "wrong_subtype", expected: `${type}:${label.subtype}`, got: `${type}:${hit.subtype ?? "-"}` });
          }
        } else if (label) {
          counts[type].fn++;
          errors.push({ callId: t.id, utteranceIndex: u.index, text: u.text, kind: "missed", expected: fmt(label) });
        } else if (hit) {
          counts[type].fp++;
          errors.push({ callId: t.id, utteranceIndex: u.index, text: u.text, kind: "false_alarm", got: fmt(hit) });
        }
      }
    }
  }

  const byType = Object.fromEntries(MOMENT_TYPES.map((t) => [t, prf(counts[t].tp, counts[t].fp, counts[t].fn)])) as Record<MomentType, PRF>;
  const sum = (k: "tp" | "fp" | "fn") => MOMENT_TYPES.reduce((s, t) => s + counts[t][k], 0);
  return {
    overall: prf(sum("tp"), sum("fp"), sum("fn")),
    byType,
    subtypeAccuracy: subtypeTotal ? subtypeRight / subtypeTotal : 1,
    errors,
  };
}

function fmt(m: { type: string; subtype?: string }): string {
  return m.subtype ? `${m.type}:${m.subtype}` : m.type;
}

/** Nearest-rank percentile. Returns NaN for an empty list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}
