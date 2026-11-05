// Runs transcripts through the real pipeline (same CallSession the demo uses)
// and collects everything the report needs.
import { replay } from "../replay/replay.js";
import { CallSession, type CardTrace, type DetectionLogEntry, type PipelineMode, type RepAlert, type SpeculationStats } from "../pipeline/session.js";
import type { CardGuard, Coach, Detector } from "../pipeline/components.js";
import { UsageMeter } from "../llm/usage.js";
import type { DetectedMoment, Transcript } from "../types.js";

export interface Components {
  detector: Detector;
  coach: Coach;
  guard: CardGuard;
}

export interface CallResult {
  callId: string;
  /** Raw detector output per line (before threshold/cooldown). */
  detections: Map<number, DetectedMoment[]>;
  speculation: SpeculationStats;
  detectionLog: DetectionLogEntry[];
  /** performance.now() of each line's speech end, to make detectionLog times relative. */
  speechEnds: Record<number, number>;
  detectorMs: number[];
  cards: CardTrace[];
  repAlerts: RepAlert[];
  meter: UsageMeter;
  errors: string[];
}

export interface ReplaySettings {
  speed: number;
  mode: PipelineMode;
  partials: boolean;
}

export async function runCall(t: Transcript, c: Components, s: ReplaySettings): Promise<CallResult> {
  const session = new CallSession(c.detector, c.coach, c.guard, { mode: s.mode });
  const errors: string[] = [];
  session.on("stage_error", (stage, err) => errors.push(`${stage}: ${err.message}`));
  const speechEnds: Record<number, number> = {};
  for await (const u of replay(t, { speed: s.speed, partials: s.partials })) {
    if (u.kind === "final") speechEnds[u.index] = u.emittedAt;
    session.push(u);
  }
  await session.finish();
  return {
    callId: t.id,
    detections: session.rawDetections,
    speculation: session.speculation,
    detectionLog: session.detectionLog,
    speechEnds,
    detectorMs: session.detectorMs,
    cards: session.cards,
    repAlerts: session.repAlerts,
    meter: session.meter,
    errors,
  };
}

export interface RunOptions extends ReplaySettings {
  /** Stop starting new calls once spend passes this (live mode safety cap). */
  maxUsd: number;
  onCallDone?: (r: CallResult, spentUsd: number) => void;
}

export async function runAll(transcripts: Transcript[], c: Components, opts: RunOptions): Promise<CallResult[]> {
  const results: CallResult[] = [];
  let spent = 0;
  for (const t of transcripts) {
    if (spent >= opts.maxUsd) {
      console.warn(`Stopping: spend $${spent.toFixed(2)} reached the --max-usd cap of $${opts.maxUsd}.`);
      break;
    }
    const r = await runCall(t, c, opts);
    spent += r.meter.costUsd();
    results.push(r);
    opts.onCallDone?.(r, spent);
  }
  return results;
}

/** Detector-only pass with no timing: used for the keyword baseline. */
export async function detectOnly(transcripts: Transcript[], detector: Detector): Promise<Map<string, Map<number, DetectedMoment[]>>> {
  const out = new Map<string, Map<number, DetectedMoment[]>>();
  const meter = new UsageMeter();
  for (const t of transcripts) {
    const perCall = new Map<number, DetectedMoment[]>();
    for (const [i, u] of t.utterances.entries()) {
      const { labels: _labels, ...plain } = u;
      const history = t.utterances.slice(Math.max(0, i - 8), i).map(({ labels: _l, ...h }) => h);
      perCall.set(u.index, await detector.detect(history, plain, meter));
    }
    out.set(t.id, perCall);
  }
  return out;
}
