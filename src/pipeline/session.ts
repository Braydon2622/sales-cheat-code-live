// CallSession: the live pipeline for one call.
//
// Two modes:
//   serial       final line ─► detector ─► coach ─► card              (Phase 1 v1; two round trips in a row)
//   speculative  partial lines ─► detector ─► moment? ─► chip + coach  (card can start before the client finishes)
//                final line ─┬► detector ─┐
//                            └► coach ────┴► detector confirms ─► chip + card shown
//                                            detector says no  ─► coach cancelled, nothing shown
//
// In both modes every card line is released to the screen only when complete
// and rule-checked, and the model guard reviews the finished card.
// Timestamps are absolute (performance.now); latency is computed against
// speech end and against the line's first partial (see `latencyOf`).
import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { UsageMeter } from "../llm/usage.js";
import type { ReplayedUtterance } from "../replay/replay.js";
import type { Card, CardField, ComplianceViolation, DetectedMoment, MomentType, Utterance } from "../types.js";
import { OPT_OUT_CARD, parseCardLine, safeFallbackCard } from "./card.js";
import type { CardGuard, Coach, CoachRequest, Detector } from "./components.js";
import { DEFAULT_POLICY, MomentPolicy, type PolicyOptions } from "./policy.js";
import { checkCard, checkCardLine, checkRepSpeech } from "./rules.js";

export type PipelineMode = "serial" | "speculative";

export interface SessionOptions {
  mode?: PipelineMode;
  policy?: PolicyOptions;
}

export interface CardTrace {
  id: number;
  utteranceIndex: number;
  moment: DetectedMoment;
  kind: "coach" | "fixed_opt_out";
  /** Was the moment found on an interim partial or on the final line? */
  trigger: "partial" | "final";
  /** speculative = coach was already running when the detector confirmed. */
  path: "direct" | "speculative" | "speculative_miss";
  // Absolute timestamps (performance.now()).
  chipAt: number;
  firstTokenAt?: number;
  firstLineAt?: number;
  fullCardAt?: number;
  guardAt?: number;
  // Reference points for latency, filled in when known.
  firstPartialAt?: number;
  speechEndAt?: number;
  /** The detector request that fired this card: issued and answered (for chip-latency breakdown). */
  detectorIssuedAt?: number;
  detectorAnsweredAt?: number;
  draft: Partial<Card>;
  shown: Card;
  outcome: "shown" | "blocked_by_rules" | "retracted_by_model" | "coach_error";
  violations: ComplianceViolation[];
  error?: string;
}

export type LatencyPoint = "chipAt" | "firstTokenAt" | "firstLineAt" | "fullCardAt" | "guardAt";

/** Milliseconds from a reference point to a stage. Negative = before the client stopped talking. */
export function latencyOf(t: CardTrace, stage: LatencyPoint, from: "speechEnd" | "firstPartial"): number | undefined {
  const at = t[stage];
  const ref = from === "speechEnd" ? t.speechEndAt : (t.firstPartialAt ?? t.speechEndAt);
  return at === undefined || ref === undefined ? undefined : at - ref;
}

export interface RepAlert {
  utteranceIndex: number;
  violations: ComplianceViolation[];
  source: "rules" | "model";
  at: number;
}

export interface SessionEvents {
  utterance: [u: ReplayedUtterance];
  chip: [trace: CardTrace];
  rep_alert: [alert: RepAlert];
  card_line: [cardId: number, field: CardField, text: string];
  card_done: [trace: CardTrace];
  stage_error: [stage: string, err: Error];
}

/** One detector call, for offline latency/threshold analysis (e.g. "what if the chip fired at 0.6?"). */
export interface DetectionLogEntry {
  utteranceIndex: number;
  partial: boolean;
  words: number;
  /** performance.now() when the detector answered. */
  at: number;
  moments: Array<{ type: string; subtype?: string; confidence?: number }>;
}

export interface SpeculationStats {
  started: number;
  used: number;
  cancelled: number;
  /** Coach said NONE but the detector found a moment: fell back to a direct coach call. */
  missed: number;
}

/** Detector output for one request, with when it was issued and answered. */
type Detection = DetectedMoment[] & { issuedAt: number; answeredAt: number };

/** When several moments fire on one line, coach the most important one. */
const PRIORITY: MomentType[] = ["opt_out", "objection", "question", "buying_signal"];

interface LineState {
  firstPartialAt?: number;
  speechEndAt?: number;
  fired: boolean;
  /** Speculative coach request running for this line's final text, if any. */
  specRun?: CardRun;
  partialDetectBusy: boolean;
  repAlerted: boolean;
}

export class CallSession extends EventEmitter<SessionEvents> {
  readonly meter = new UsageMeter();
  /** Every detector output (partials and finals), before the policy: input to the threshold sweep. */
  readonly rawDetections = new Map<number, DetectedMoment[]>();
  /** Every detector answer with its timestamp, including ones below the threshold. */
  readonly detectionLog: DetectionLogEntry[] = [];
  /** Final-line detector round trips, ms from speech end. */
  readonly detectorMs: number[] = [];
  readonly cards: CardTrace[] = [];
  readonly repAlerts: RepAlert[] = [];
  readonly speculation: SpeculationStats = { started: 0, used: 0, cancelled: 0, missed: 0 };
  readonly mode: PipelineMode;
  private readonly policy: MomentPolicy;
  private readonly history: Utterance[] = [];
  private readonly lines = new Map<number, LineState>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private nextCardId = 1;

  constructor(
    private detector: Detector,
    private coach: Coach,
    private guard: CardGuard,
    opts: SessionOptions = {},
  ) {
    super();
    this.mode = opts.mode ?? "speculative";
    this.policy = new MomentPolicy(opts.policy ?? DEFAULT_POLICY);
  }

  /** Feed one partial or final utterance. Returns immediately; work runs concurrently. */
  push(u: ReplayedUtterance): void {
    const kind = u.kind ?? "final";
    const state = this.stateOf(u.index);
    const context = this.history.slice(-config.contextLines);
    if (kind === "final") {
      this.history.push(u);
      state.speechEndAt = u.emittedAt;
      for (const c of this.cards) if (c.utteranceIndex === u.index) c.speechEndAt = u.emittedAt;
      this.emit("utterance", u);
    } else {
      state.firstPartialAt ??= u.emittedAt;
    }

    if (u.speaker === "rep") {
      const violations = checkRepSpeech(u.text);
      if (violations.length && !state.repAlerted) this.alertRep(u.index, violations, "rules", state);
      if (kind === "final") this.track(this.detectRep(u, context, state));
      return;
    }

    if (kind === "partial") {
      if (this.mode === "speculative" && !state.fired && !state.partialDetectBusy) {
        state.partialDetectBusy = true;
        this.track(this.detectPartial(u, context, state).finally(() => (state.partialDetectBusy = false)));
      }
      return;
    }
    this.track(this.mode === "speculative" ? this.handleFinalSpeculative(u, context, state) : this.handleFinalSerial(u, context, state));
  }

  /** Wait for every in-flight detector/coach/guard call to finish. */
  async finish(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  cancel(): void {
    this.abort.abort();
  }

  // ------------------------------------------------------------ detection

  private stateOf(index: number): LineState {
    let s = this.lines.get(index);
    if (!s) this.lines.set(index, (s = { fired: false, partialDetectBusy: false, repAlerted: false }));
    return s;
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private async detect(u: Utterance, context: Utterance[], partial: boolean): Promise<Detection | undefined> {
    const issuedAt = performance.now();
    try {
      const moments = await this.detector.detect(context, u, this.meter, this.abort.signal, partial);
      this.detectionLog.push({
        utteranceIndex: u.index,
        partial,
        words: u.text.split(/\s+/).length,
        at: performance.now(),
        moments: moments.map((m) => ({ type: m.type, subtype: m.subtype, confidence: m.confidence })),
      });
      const raw = this.rawDetections.get(u.index) ?? [];
      for (const m of moments) {
        const same = raw.find((r) => r.type === m.type && r.subtype === m.subtype);
        if (!same) raw.push(m);
        else if ((m.confidence ?? 1) > (same.confidence ?? 1)) same.confidence = m.confidence;
      }
      this.rawDetections.set(u.index, raw);
      return Object.assign(moments, { issuedAt, answeredAt: performance.now() });
    } catch (err) {
      if (!this.abort.signal.aborted) this.emit("stage_error", partial ? "detector(partial)" : "detector", err as Error);
      return undefined;
    }
  }

  /** Apply the threshold + cooldown policy and pick the moment to coach. */
  private choose(moments: DetectedMoment[]): DetectedMoment | undefined {
    const accepted = moments.filter((m) => this.policy.accept(m));
    return PRIORITY.map((t) => accepted.find((m) => m.type === t)).find(Boolean);
  }

  private alertRep(index: number, violations: ComplianceViolation[], source: "rules" | "model", state: LineState): void {
    state.repAlerted = true;
    const alert: RepAlert = { utteranceIndex: index, violations, source, at: performance.now() };
    this.repAlerts.push(alert);
    this.emit("rep_alert", alert);
  }

  private async detectRep(u: ReplayedUtterance, context: Utterance[], state: LineState): Promise<void> {
    const moments = await this.detect(u, context, false);
    if (!moments) return;
    this.detectorMs.push(performance.now() - u.emittedAt);
    const slips = moments.filter((m) => m.type === "rep_violation" && this.policy.accept(m));
    if (slips.length && !state.repAlerted) {
      this.alertRep(
        u.index,
        slips.map((m) => ({ rule: m.subtype ?? "other", where: "rep_speech", quote: m.evidence, source: "model", severity: "block" })),
        "model",
        state,
      );
    }
  }

  private async detectPartial(u: ReplayedUtterance, context: Utterance[], state: LineState): Promise<void> {
    const moments = await this.detect(u, context, true);
    if (!moments || state.fired) return;
    const moment = this.choose(moments);
    if (!moment) return;
    state.fired = true;
    if (state.specRun && moment.type !== "opt_out") {
      // The client finished while this partial was being classified, and a
      // speculative coach is already running on the full line: adopt it
      // instead of starting over.
      this.speculation.used++;
      const run = state.specRun;
      state.specRun = undefined;
      await this.finishCard(this.newTrace(u.index, moment, "partial", "speculative", state, moments), run, { history: context, current: run.req.current, moment });
      return;
    }
    await this.runCard(this.newTrace(u.index, moment, "partial", "direct", state, moments), { history: context, current: u, moment, partial: true });
  }

  private async handleFinalSerial(u: ReplayedUtterance, context: Utterance[], state: LineState): Promise<void> {
    const moments = await this.detect(u, context, false);
    if (!moments) return;
    this.detectorMs.push(performance.now() - u.emittedAt);
    const moment = this.choose(moments);
    if (!moment || state.fired) return;
    state.fired = true;
    await this.runCard(this.newTrace(u.index, moment, "final", "direct", state, moments), { history: context, current: u, moment });
  }

  private async handleFinalSpeculative(u: ReplayedUtterance, context: Utterance[], state: LineState): Promise<void> {
    if (state.fired) {
      // A partial already fired the card. Still classify the full line for the eval.
      await this.detect(u, context, false);
      this.detectorMs.push(performance.now() - u.emittedAt);
      return;
    }
    // Start the coach now, in parallel with the detector, and decide when the detector answers.
    this.speculation.started++;
    const run = new CardRun(this, this.coach, { history: context, current: u });
    state.specRun = run;
    const moments = await this.detect(u, context, false);
    this.detectorMs.push(performance.now() - u.emittedAt);
    if (state.specRun !== run) return; // a late partial detection adopted it
    state.specRun = undefined;
    const moment = moments && !state.fired ? this.choose(moments) : undefined;
    if (!moment || moment.type === "opt_out") {
      // No moment, an opt-out (fixed card instead), or a partial already fired its own card.
      run.cancel();
      this.speculation.cancelled++;
      if (moment) {
        state.fired = true;
        await this.runCard(this.newTrace(u.index, moment, "final", "direct", state, moments), { history: context, current: u, moment });
      }
      return;
    }
    state.fired = true;
    this.speculation.used++;
    const trace = this.newTrace(u.index, moment, "final", "speculative", state, moments);
    await this.finishCard(trace, run, { history: context, current: u, moment });
  }

  // ------------------------------------------------------------ cards

  private newTrace(
    index: number,
    moment: DetectedMoment,
    trigger: CardTrace["trigger"],
    path: CardTrace["path"],
    state: LineState,
    detection?: Detection,
  ): CardTrace {
    const trace: CardTrace = {
      id: this.nextCardId++,
      utteranceIndex: index,
      moment,
      kind: moment.type === "opt_out" ? "fixed_opt_out" : "coach",
      trigger,
      path,
      chipAt: performance.now(),
      firstPartialAt: state.firstPartialAt,
      speechEndAt: state.speechEndAt,
      detectorIssuedAt: detection?.issuedAt,
      detectorAnsweredAt: detection?.answeredAt,
      draft: {},
      shown: OPT_OUT_CARD,
      outcome: "shown",
      violations: [],
    };
    this.cards.push(trace);
    // The chip: "moment detected", shown before any card text arrives.
    this.emit("chip", trace);
    return trace;
  }

  /** @internal Used by CardRun to put a rule-checked line on screen. */
  showLine(trace: CardTrace, field: CardField, text: string): void {
    trace.firstLineAt ??= performance.now();
    this.emit("card_line", trace.id, field, text);
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  private async runCard(trace: CardTrace, req: CoachRequest): Promise<void> {
    if (trace.kind === "fixed_opt_out") {
      for (const [field, text] of Object.entries(OPT_OUT_CARD) as [CardField, string][]) this.showLine(trace, field, text);
      trace.firstTokenAt = trace.fullCardAt = trace.guardAt = trace.firstLineAt;
      this.emit("card_done", trace);
      return;
    }
    await this.finishCard(trace, new CardRun(this, this.coach, req), req);
  }

  private async finishCard(trace: CardTrace, run: CardRun, req: CoachRequest): Promise<void> {
    run.attach(trace);
    await run.done;
    if (run.saidNone && !run.blocked) {
      // Speculation guessed "no moment" but the detector disagreed: ask again, now telling the coach the moment.
      this.speculation.missed++;
      trace.path = "speculative_miss";
      run = new CardRun(this, this.coach, { ...req, moment: trace.moment });
      run.attach(trace);
      await run.done;
    }
    trace.firstTokenAt = run.firstTokenAt;
    trace.fullCardAt = performance.now();
    trace.draft = run.draft;
    trace.violations.push(...run.violations);

    if (run.blocked) {
      trace.outcome = "blocked_by_rules";
      trace.shown = safeFallbackCard(trace.moment);
    } else if (run.error || !isComplete(run.draft)) {
      trace.outcome = "coach_error";
      trace.error = run.error ?? "incomplete card";
      trace.shown = safeFallbackCard(trace.moment);
    } else {
      trace.shown = run.draft;
      trace.violations.push(...checkCard(trace.shown, trace.moment.type).filter((v) => v.severity === "style"));
      try {
        const modelViolations = await this.guard.review(trace.shown, trace.moment, this.meter, this.abort.signal);
        if (modelViolations.length) {
          trace.violations.push(...modelViolations);
          trace.outcome = "retracted_by_model";
          trace.shown = safeFallbackCard(trace.moment);
        }
      } catch (err) {
        this.emit("stage_error", "guard", err as Error);
      }
      trace.guardAt = performance.now();
    }
    if (trace.outcome !== "shown") {
      for (const [field, text] of Object.entries(trace.shown) as [CardField, string][]) this.showLine(trace, field, text);
    }
    this.emit("card_done", trace);
  }
}

/**
 * One streamed coach request. Lines are parsed and rule-checked as they
 * complete; they reach the screen only after `attach` (i.e. once the detector
 * has confirmed a moment). Before that they wait in a buffer, so a speculative
 * card that gets cancelled is never seen.
 */
class CardRun {
  readonly draft: Partial<Card> = {};
  readonly violations: ComplianceViolation[] = [];
  readonly done: Promise<void>;
  firstTokenAt?: number;
  blocked = false;
  saidNone = false;
  error?: string;
  private readonly abort = new AbortController();
  private readonly ready: Array<[CardField, string]> = [];
  private trace?: CardTrace;
  private buffer = "";
  private text = "";

  constructor(
    private session: CallSession,
    coach: Coach,
    readonly req: CoachRequest,
  ) {
    const signal = AbortSignal.any([session.signal, this.abort.signal]);
    this.done = coach
      .stream(req, (chunk) => this.onChunk(chunk), session.meter, signal)
      .then(() => this.releaseLine(this.buffer))
      .catch((err: Error) => {
        if (!this.blocked && !this.abort.signal.aborted) {
          this.error = err.message;
          session.emit("stage_error", "coach", err);
        }
      });
  }

  /** The detector confirmed: show buffered lines now, and future lines as they arrive. */
  attach(trace: CardTrace): void {
    this.trace = trace;
    for (const [field, text] of this.ready.splice(0)) this.session.showLine(trace, field, text);
  }

  cancel(): void {
    this.abort.abort();
  }

  private onChunk(chunk: string): void {
    this.firstTokenAt ??= performance.now();
    this.text += chunk;
    if (/^\s*NONE\b/.test(this.text)) this.saidNone = true;
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      this.releaseLine(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
  }

  private releaseLine(line: string): void {
    const parsed = parseCardLine(line);
    if (!parsed || this.blocked) return;
    const v = checkCardLine(parsed.field, parsed.text);
    this.draft[parsed.field] = parsed.text;
    if (v.length) {
      this.blocked = true;
      this.violations.push(...v);
      this.abort.abort();
      return;
    }
    if (this.trace) this.session.showLine(this.trace, parsed.field, parsed.text);
    else this.ready.push([parsed.field, parsed.text]);
  }
}

function isComplete(card: Partial<Card>): card is Card {
  return Boolean(card.read && card.sendThis && card.backup && card.nextStep && card.followUp && card.watchOut);
}
