// Token and dollar accounting. Every model call reports its usage here so the
// eval can print an honest cost-per-call number.

/** USD per million tokens. Source: Anthropic pricing as of 2026-10 (5-minute cache TTL). */
export const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface ModelTally {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * One API request, timed. Used to tell API latency apart from our own
 * overhead, and to compare conditions between runs (drift, cache hits).
 */
export interface RequestRecord {
  stage: "detector" | "detector_partial" | "coach" | "coach_speculative" | "guard" | "ping" | "prewarm";
  model: string;
  /** performance.now() just before the SDK call. */
  issuedAt: number;
  /** Streams only: the API accepted the request (message_start). */
  acceptedAt?: number;
  /** Streams only: first text token. */
  firstTokenAt?: number;
  /** Response complete, or the request was cancelled/failed. */
  doneAt: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  outcome: "ok" | "cancelled" | "error";
}

export class UsageMeter {
  readonly byModel = new Map<string, ModelTally>();
  readonly requests: RequestRecord[] = [];

  /** Log a timed request. Token fields come from the API's usage block. */
  logRequest(r: Omit<RequestRecord, "input" | "cacheRead" | "cacheWrite" | "output">, usage?: UsageLike): void {
    this.requests.push({
      ...r,
      input: usage?.input_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
    });
  }

  record(model: string, usage: UsageLike): void {
    const t = this.byModel.get(model) ?? { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    t.calls += 1;
    t.input += usage.input_tokens;
    t.output += usage.output_tokens;
    t.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    t.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.byModel.set(model, t);
  }

  costUsd(): number {
    let total = 0;
    for (const [model, t] of this.byModel) total += tallyCost(model, t);
    return total;
  }

  merge(other: UsageMeter): void {
    for (const [model, t] of other.byModel) {
      this.record(model, {
        input_tokens: t.input,
        output_tokens: t.output,
        cache_creation_input_tokens: t.cacheWrite,
        cache_read_input_tokens: t.cacheRead,
      });
      // record() counted this as one call; fix the call count.
      this.byModel.get(model)!.calls += t.calls - 1;
    }
    this.requests.push(...other.requests);
  }
}

export function tallyCost(model: string, t: ModelTally): number {
  const p = PRICING[model];
  if (!p) return 0; // unknown or mock model: no cost
  return (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;
}
