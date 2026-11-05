// Moment policy: decides which detector outputs actually fire a card.
//
// Two knobs, both aimed at false alarms (each one interrupts a rep mid-call):
//   threshold: minimum detector confidence (0–1) to fire.
//   cooldown:  after a moment fires, the same kind can't fire again for N lines.
//              Clients often restate an objection; the rep already has the card.
//
// The same class runs live in CallSession and offline in the eval's threshold
// sweep, so swept numbers are exactly what the pipeline would have done.
import type { DetectedMoment, MomentType } from "../types.js";

export interface PolicyOptions {
  threshold: number;
  /** Lines of cooldown per moment type. 0 = none. Infinity = once per call. */
  cooldownLines: Partial<Record<MomentType, number>>;
}

export const DEFAULT_COOLDOWN: PolicyOptions["cooldownLines"] = {
  objection: 10, // per subtype: the same objection doesn't fire twice in quick succession
  opt_out: Infinity, // the fixed opt-out card already says it all
  // buying_signal / question: none. Several in a row are normal on a hot call.
  // rep_violation: none. Every slip should be flagged.
};

// 0.75 chosen on the 20-call dev set (best F1 in the sweep: 73% precision, 88% recall),
// then frozen before the held-out set was run.
export const DEFAULT_POLICY: PolicyOptions = { threshold: 0.75, cooldownLines: DEFAULT_COOLDOWN };
export const NO_FILTER: PolicyOptions = { threshold: 0, cooldownLines: {} };

const keyOf = (m: DetectedMoment) => (m.type === "objection" ? `objection:${m.subtype ?? ""}` : m.type);

export class MomentPolicy {
  private lastFired = new Map<string, number>();
  constructor(private opts: PolicyOptions = DEFAULT_POLICY) {}

  accept(m: DetectedMoment): boolean {
    if ((m.confidence ?? 1) < this.opts.threshold) return false;
    const key = keyOf(m);
    const last = this.lastFired.get(key);
    const cooldown = this.opts.cooldownLines[m.type] ?? 0;
    // Same line (e.g. seen on a partial, then on the final) isn't a repeat.
    if (last !== undefined && last !== m.utteranceIndex && m.utteranceIndex - last <= cooldown) return false;
    this.lastFired.set(key, m.utteranceIndex);
    return true;
  }
}

/** Offline: apply a policy to one call's raw detections, in call order. */
export function applyPolicy(raw: Map<number, DetectedMoment[]>, opts: PolicyOptions): Map<number, DetectedMoment[]> {
  const policy = new MomentPolicy(opts);
  const out = new Map<number, DetectedMoment[]>();
  for (const index of [...raw.keys()].sort((a, b) => a - b)) {
    out.set(index, (raw.get(index) ?? []).filter((m) => policy.accept(m)));
  }
  return out;
}
