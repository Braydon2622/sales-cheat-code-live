// Turns eval results into a readable Markdown report.
import { MOMENT_TYPES, type DetectedMoment, type Transcript } from "../types.js";
import { tallyCost, UsageMeter, type RequestRecord } from "../llm/usage.js";
import { checkCard } from "../pipeline/rules.js";
import { formatCard } from "../pipeline/card.js";
import { applyPolicy, DEFAULT_COOLDOWN, DEFAULT_POLICY, NO_FILTER, type PolicyOptions } from "../pipeline/policy.js";
import { latencyOf, type LatencyPoint } from "../pipeline/session.js";
import type { CallResult, ReplaySettings } from "./runner.js";
import { percentile, scoreDetection, type DetectionScore, type PRF } from "./metrics.js";

export interface ReportInput {
  mode: "live" | "mock";
  models: { detector: string; coach: string; guard: string };
  settings: ReplaySettings;
  transcripts: Transcript[];
  results: CallResult[];
  baseline?: Map<string, Map<number, DetectedMoment[]>>;
  startedAt: Date;
  setName: string;
  /** Live runs: 1-token pings at start and end, to compare API conditions between runs. */
  conditions?: { pingsStart: Record<string, number[]>; pingsEnd: Record<string, number[]>; overheadUsd: number };
}

/** API conditions for this run: per-stage request timing and cache hit rate, plus ping drift. */
export function runConditions(requests: RequestRecord[]) {
  const stages = [...new Set(requests.map((r) => r.stage))];
  return stages.map((stage) => {
    const rs = requests.filter((r) => r.stage === stage);
    const ok = rs.filter((r) => r.outcome === "ok");
    const durs = ok.map((r) => r.doneAt - r.issuedAt);
    const ttft = rs.map((r) => (r.firstTokenAt === undefined ? undefined : r.firstTokenAt - r.issuedAt)).filter((v): v is number => v !== undefined);
    const accepted = rs.map((r) => (r.acceptedAt === undefined ? undefined : r.acceptedAt - r.issuedAt)).filter((v): v is number => v !== undefined);
    const read = rs.reduce((s, r) => s + r.cacheRead, 0);
    const prompt = rs.reduce((s, r) => s + r.cacheRead + r.cacheWrite + r.input, 0);
    return {
      stage,
      requests: rs.length,
      cancelled: rs.filter((r) => r.outcome === "cancelled").length,
      errors: rs.filter((r) => r.outcome === "error").length,
      durationP50: percentile(durs, 50),
      durationP95: percentile(durs, 95),
      acceptedP50: percentile(accepted, 50),
      firstTokenP50: percentile(ttft, 50),
      firstTokenP95: percentile(ttft, 95),
      cacheHitRate: prompt ? read / prompt : NaN,
    };
  });
}

export const LATENCY_BUDGET_MS = 1500;

/** Detection at a given policy: what would have fired. */
function firedAt(results: CallResult[], policy: PolicyOptions): Map<string, Map<number, DetectedMoment[]>> {
  return new Map(results.map((r) => [r.callId, applyPolicy(r.detections, policy)]));
}

export function buildReport(input: ReportInput): { markdown: string; summary: Record<string, unknown> } {
  const { results, settings } = input;
  const ran = new Set(results.map((r) => r.callId));
  const transcripts = input.transcripts.filter((t) => ran.has(t.id));
  const fired = firedAt(results, DEFAULT_POLICY);
  const detection = scoreDetection(transcripts, fired);
  const baseline = input.baseline ? scoreDetection(transcripts, input.baseline) : undefined;

  // ---- threshold / cooldown sweep (offline, from the same raw detections)
  const sweep: Array<[string, PolicyOptions]> = [
    ["no filter", NO_FILTER],
    ["cooldown only", { threshold: 0, cooldownLines: DEFAULT_COOLDOWN }],
    ["cooldown + confidence ≥ 0.5", { threshold: 0.5, cooldownLines: DEFAULT_COOLDOWN }],
    ["cooldown + confidence ≥ 0.6", { threshold: 0.6, cooldownLines: DEFAULT_COOLDOWN }],
    [`cooldown + confidence ≥ ${DEFAULT_POLICY.threshold} (pipeline default)`, DEFAULT_POLICY],
    ["cooldown + confidence ≥ 0.9", { threshold: 0.9, cooldownLines: DEFAULT_COOLDOWN }],
  ];
  const sweepScores = sweep.map(([label, p]) => [label, scoreDetection(transcripts, firedAt(results, p)).overall] as const);

  // ---- rep violations caught
  let repLabels = 0, byRules = 0, byModel = 0, byEither = 0, repFalseAlarms = 0;
  for (const t of transcripts) {
    const r = results.find((x) => x.callId === t.id)!;
    for (const u of t.utterances.filter((x) => x.speaker === "rep")) {
      const labeled = u.labels.some((l) => l.type === "rep_violation");
      const rules = r.repAlerts.some((a) => a.utteranceIndex === u.index && a.source === "rules");
      const model = (fired.get(t.id)?.get(u.index) ?? []).some((d) => d.type === "rep_violation");
      if (labeled) {
        repLabels++;
        if (rules) byRules++;
        if (model) byModel++;
        if (rules || model) byEither++;
      } else if (rules || model) repFalseAlarms++;
    }
  }

  // ---- cards
  const cards = results.flatMap((r) => r.cards.map((c) => ({ ...c, callId: r.callId })));
  const coachCards = cards.filter((c) => c.kind === "coach");
  const count = (o: string) => coachCards.filter((c) => c.outcome === o).length;
  const shownViolations = cards.flatMap((c) => checkCard(c.shown, c.moment.type).filter((v) => v.severity === "block"));
  const shownCoachOwn = coachCards.filter((c) => c.outcome === "shown");
  const twoOption = shownCoachOwn.filter((c) => !c.violations.some((v) => v.rule === "two_option_close")).length;
  const homeWord = shownCoachOwn.filter((c) => !c.violations.some((v) => v.rule === "say_home_not_loan")).length;
  const fromPartial = coachCards.filter((c) => c.trigger === "partial").length;
  const spec = results.reduce(
    (s, r) => ({ started: s.started + r.speculation.started, used: s.used + r.speculation.used, cancelled: s.cancelled + r.speculation.cancelled, missed: s.missed + r.speculation.missed }),
    { started: 0, used: 0, cancelled: 0, missed: 0 },
  );

  // ---- latency
  const lat = (stage: LatencyPoint, from: "speechEnd" | "firstPartial") =>
    coachCards.map((c) => latencyOf(c, stage, from)).filter((v): v is number => typeof v === "number");
  const detectorAll = results.flatMap((r) => r.detectorMs);
  const firstLine = lat("firstLineAt", "speechEnd");
  const chips = lat("chipAt", "speechEnd");
  const within = (xs: number[]) => (xs.length ? xs.filter((v) => v <= LATENCY_BUDGET_MS).length / xs.length : NaN);

  // ---- cost
  const meter = new UsageMeter();
  for (const r of results) meter.merge(r.meter);
  const totalUsd = meter.costUsd();
  const coachModel = input.models.coach.replace(/^claude:/, "").replace(/@.*$/, "");
  const coachTally = meter.byModel.get(coachModel);

  const md: string[] = [];
  const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "–");
  const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)} ms` : "–");
  const p = (xs: number[], q: number) => ms(percentile(xs, q));

  md.push(`# Eval report: Sales Call Cheat Code`, "");
  if (input.mode === "mock") {
    md.push(`> **MOCK RUN.** No AI models were called. Detection is the keyword baseline, cards are canned templates, and latencies are simulated. These numbers test the harness, not the product.`, "");
  }
  md.push(
    `- **Run:** ${input.startedAt.toISOString()} · set \`${input.setName}\` · ${results.length} synthetic calls · ${transcripts.reduce((s, t) => s + t.utterances.length, 0)} utterances`,
    `- **Pipeline:** ${settings.mode}${settings.partials ? " + interim partials" : ""} · replay ${Number.isFinite(settings.speed) ? `${settings.speed}x` : "max"} (${settings.partials ? "client speech in real time, gaps and rep lines compressed" : "everything compressed"})`,
    `- **Models:** detector \`${input.models.detector}\` · coach \`${input.models.coach}\` · guard \`${input.models.guard}\``,
    `- **Moment policy:** confidence ≥ ${DEFAULT_POLICY.threshold}, cooldown ${JSON.stringify(DEFAULT_COOLDOWN).replace(/null/g, "∞")} lines`,
    "",
    `## Headline`,
    "",
    `| Metric | Result |`,
    `|---|---|`,
    `| Moment detection precision / recall | ${pct(detection.overall.precision)} / ${pct(detection.overall.recall)} |`,
    `| Rep compliance slips caught | ${byEither} of ${repLabels} (${repFalseAlarms} false alarms) |`,
    `| Non-compliant suggestions that reached the rep | ${shownViolations.length} of ${cards.length} cards (rules re-check) |`,
    `| "Moment detected" chip, from speech end, p50 / p95 | ${p(chips, 50)} / ${p(chips, 95)} |`,
    `| First card line on screen, from speech end, p50 / p95 | ${p(firstLine, 50)} / ${p(firstLine, 95)} |`,
    `| Cards on screen within ${LATENCY_BUDGET_MS / 1000} s of speech end | ${pct(within(firstLine))} |`,
    `| Cost per call | $${(totalUsd / Math.max(1, results.length)).toFixed(4)} |`,
    "",
  );

  md.push(`## 1. Moment detection`, "", `A detection counts when it lands on the same line as a hand label with the same type. Scored on what the pipeline actually fired (after the confidence threshold and cooldown).`, "");
  md.push(detectionTable(detection, baseline), "");
  md.push(`Subtype accuracy on correct objection / rep-violation hits: ${pct(detection.subtypeAccuracy)}${baseline ? ` (keyword baseline: ${pct(baseline.subtypeAccuracy)})` : ""}.`, "");
  md.push(`### Threshold and cooldown sweep`, "", `Same raw detector output, filtered offline with each policy. No extra API calls.`, "", `| Policy | Precision | Recall | F1 | Fired |`, `|---|---|---|---|---|`);
  for (const [label, s] of sweepScores) md.push(`| ${label} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} | ${s.tp + s.fp} |`);
  md.push("");

  md.push(`## 2. Compliance`, "", `**Rep's own speech** (${repLabels} labeled slips):`, "", `| Layer | Caught |`, `|---|---|`);
  md.push(`| Deterministic rules | ${byRules} / ${repLabels} |`, `| Model detector | ${byModel} / ${repLabels} |`, `| Either (what the rep sees) | ${byEither} / ${repLabels} |`, `| False alarms on clean rep lines | ${repFalseAlarms} |`, "");
  md.push(`**AI suggestions** (${cards.length} cards: ${coachCards.length} coached, ${cards.length - coachCards.length} fixed opt-out cards):`, "", `| Outcome | Cards |`, `|---|---|`);
  md.push(
    `| Shown as drafted | ${count("shown")} |`,
    `| Draft blocked mid-stream by rules, safe card shown | ${count("blocked_by_rules")} |`,
    `| Draft retracted by model guard, safe card shown | ${count("retracted_by_model")} |`,
    `| Coach error, safe card shown | ${count("coach_error")} |`,
    `| Shown cards with a blocking violation (rules re-check) | ${shownViolations.length} |`,
    "",
    `Playbook style on drafted cards shown: two-option close ${twoOption}/${shownCoachOwn.length}, said "home" not "loan" ${homeWord}/${shownCoachOwn.length}.`,
  );
  const flagged = coachCards.filter((c) => c.violations.some((v) => v.severity === "block"));
  if (flagged.length) {
    md.push("", `Drafts the guard stopped:`, "");
    for (const c of flagged.slice(0, 10)) {
      const v = c.violations.filter((x) => x.severity === "block").map((x) => `${x.rule} (${x.source}): "${x.quote}"`).join("; ");
      md.push(`- ${c.callId} · ${c.moment.type}: ${v}`);
    }
  }
  md.push("");

  md.push(
    `## 3. Latency`,
    "",
    `On ${coachCards.length} coached cards. **From speech end** = from the moment the client stopped talking (negative means the card arrived before they finished). **From first partial** = from the first interim transcript of that line, roughly when the client started the sentence. Card lines appear only once each is complete and has passed the rules.`,
    "",
    `| Stage | From speech end, p50 | p95 | From first partial, p50 | p95 |`,
    `|---|---|---|---|---|`,
  );
  const stages: Array<[string, LatencyPoint]> = [
    [`"Moment detected" chip`, "chipAt"],
    ["Coach first token", "firstTokenAt"],
    ["First card line on screen", "firstLineAt"],
    ["Full card", "fullCardAt"],
    ["Model guard cleared", "guardAt"],
  ];
  for (const [label, stage] of stages) {
    const a = lat(stage, "speechEnd"), b = lat(stage, "firstPartial");
    md.push(`| ${label} | ${p(a, 50)} | ${p(a, 95)} | ${settings.partials ? p(b, 50) : "–"} | ${settings.partials ? p(b, 95) : "–"} |`);
  }
  md.push(
    "",
    `Within ${LATENCY_BUDGET_MS / 1000} s of speech end: chip ${pct(within(chips))}, first card line ${pct(within(firstLine))}. Detector round trip on final lines: p50 ${p(detectorAll, 50)}, p95 ${p(detectorAll, 95)}.`,
    "",
    `**How cards got started:** ${fromPartial} of ${coachCards.length} from an interim partial (before the client finished). On final lines, the coach was started speculatively ${spec.started} times: ${spec.used} used, ${spec.cancelled} cancelled because the detector found no moment, ${spec.missed} where the coach guessed "no moment" but the detector disagreed (re-asked).`,
    "",
  );

  // ---- run conditions: API timing, cache, ping drift, and where chip time went
  const conditions = runConditions(meter.requests);
  const chipParts = (trigger: "partial" | "final") => {
    const cs = coachCards.filter((c) => c.trigger === trigger && c.detectorIssuedAt !== undefined && c.speechEndAt !== undefined);
    return {
      n: cs.length,
      waitBefore: percentile(cs.map((c) => c.detectorIssuedAt! - c.speechEndAt!), 50),
      detectorApi: percentile(cs.map((c) => c.detectorAnsweredAt! - c.detectorIssuedAt!), 50),
      localAfter: percentile(cs.map((c) => c.chipAt - c.detectorAnsweredAt!), 50),
      chip: percentile(cs.map((c) => c.chipAt - c.speechEndAt!), 50),
    };
  };
  const chipBreakdown = { partial: chipParts("partial"), final: chipParts("final") };
  if (meter.requests.length || input.conditions) {
    md.push(`## Run conditions`, "", `For comparing runs made at different times: API speed, prompt-cache hits, and drift.`, "");
    if (input.conditions) {
      md.push(`**Baseline pings** (1-token requests, ${Object.values(input.conditions.pingsStart)[0]?.length ?? 0} per model):`, "", `| Model | Start of run, median | End of run, median |`, `|---|---|---|`);
      for (const model of Object.keys(input.conditions.pingsStart)) {
        md.push(`| \`${model}\` | ${p(input.conditions.pingsStart[model]!, 50)} | ${p(input.conditions.pingsEnd[model] ?? [], 50)} |`);
      }
      md.push("");
    }
    md.push(`| Stage | Requests | Cancelled | Errors | Duration p50 / p95 | Accepted p50 | First token p50 / p95 | Cache hit rate |`, `|---|---|---|---|---|---|---|---|`);
    for (const c of conditions) {
      md.push(`| ${c.stage} | ${c.requests} | ${c.cancelled} | ${c.errors} | ${ms(c.durationP50)} / ${ms(c.durationP95)} | ${ms(c.acceptedP50)} | ${ms(c.firstTokenP50)} / ${ms(c.firstTokenP95)} | ${pct(c.cacheHitRate)} |`);
    }
    md.push(
      "",
      `**Where chip time went** (medians, from speech end; negative = before the client finished):`,
      "",
      `| Chip fired from | Cards | Detector request sent | Detector API time | Local overhead after answer | Chip |`,
      `|---|---|---|---|---|---|`,
    );
    for (const k of ["partial", "final"] as const) {
      const b = chipBreakdown[k];
      md.push(`| ${k} line | ${b.n} | ${ms(b.waitBefore)} | ${ms(b.detectorApi)} | ${ms(b.localAfter)} | ${ms(b.chip)} |`);
    }
    md.push("");
  }

  md.push(`## 4. Cost`, "", `| Model | Calls | Input | Cache write | Cache read | Output | USD |`, `|---|---|---|---|---|---|---|`);
  for (const [model, t] of meter.byModel) md.push(`| \`${model}\` | ${t.calls} | ${t.input} | ${t.cacheWrite} | ${t.cacheRead} | ${t.output} | $${tallyCost(model, t).toFixed(4)} |`);
  md.push(
    `| **Total** | | | | | | **$${totalUsd.toFixed(4)}** |`,
    "",
    `Per call: $${(totalUsd / Math.max(1, results.length)).toFixed(4)} · per card: $${(totalUsd / Math.max(1, coachCards.length)).toFixed(4)}. Cancelled speculative requests are included; their output tokens are estimated from the text received before cancelling.`,
    "",
  );

  md.push(`## 5. Detection errors (first 25)`, "");
  if (!detection.errors.length) md.push(`None.`);
  for (const e of detection.errors.slice(0, 25)) {
    const what = e.kind === "missed" ? `missed ${e.expected}` : e.kind === "false_alarm" ? `false alarm ${e.got}` : `subtype ${e.got}, expected ${e.expected}`;
    md.push(`- ${e.callId} #${e.utteranceIndex} · ${what} · "${e.text}"`);
  }
  md.push("");

  const errs = results.flatMap((r) => r.errors.map((e) => `${r.callId}: ${e}`));
  if (errs.length) {
    md.push(`## Pipeline errors (${errs.length})`, "");
    for (const e of errs.slice(0, 20)) md.push(`- ${e}`);
    md.push("");
  }

  md.push(`## Sample cards`, "");
  for (const c of coachCards.filter((x) => x.outcome === "shown").slice(0, 3)) {
    md.push(`**${c.callId} · ${c.moment.type}${c.moment.subtype ? `:${c.moment.subtype}` : ""}** (trigger: "${c.moment.evidence}", from ${c.trigger})`, "```", formatCard(c.shown), "```");
  }

  const summary = {
    mode: input.mode,
    set: input.setName,
    settings: { ...settings, speed: Number.isFinite(settings.speed) ? settings.speed : "max" },
    startedAt: input.startedAt.toISOString(),
    models: input.models,
    calls: results.length,
    detection: { precision: detection.overall.precision, recall: detection.overall.recall, f1: detection.overall.f1 },
    sweep: Object.fromEntries(sweepScores.map(([l, s]) => [l, { precision: s.precision, recall: s.recall, f1: s.f1 }])),
    baseline: baseline && { precision: baseline.overall.precision, recall: baseline.overall.recall, f1: baseline.overall.f1 },
    repViolations: { labeled: repLabels, caught: byEither, byRules, byModel, falseAlarms: repFalseAlarms },
    cards: { total: cards.length, coached: coachCards.length, fromPartial, blockedByRules: count("blocked_by_rules"), retractedByModel: count("retracted_by_model"), coachErrors: count("coach_error"), shownWithViolations: shownViolations.length },
    speculation: spec,
    conditions: { stages: conditions, chipBreakdown, pings: input.conditions && { start: input.conditions.pingsStart, end: input.conditions.pingsEnd } },
    latencyMs: {
      chipP50: percentile(chips, 50), chipP95: percentile(chips, 95),
      detectorP50: percentile(detectorAll, 50), detectorP95: percentile(detectorAll, 95),
      firstTokenP50: percentile(lat("firstTokenAt", "speechEnd"), 50), firstTokenP95: percentile(lat("firstTokenAt", "speechEnd"), 95),
      firstLineP50: percentile(firstLine, 50), firstLineP95: percentile(firstLine, 95),
      fullCardP50: percentile(lat("fullCardAt", "speechEnd"), 50), fullCardP95: percentile(lat("fullCardAt", "speechEnd"), 95),
      firstLineFromPartialP50: percentile(lat("firstLineAt", "firstPartial"), 50), firstLineFromPartialP95: percentile(lat("firstLineAt", "firstPartial"), 95),
      withinBudgetRate: within(firstLine),
      chipWithinBudgetRate: within(chips),
    },
    costUsd: { total: totalUsd, perCall: totalUsd / Math.max(1, results.length), coach: coachTally ? tallyCost(coachModel, coachTally) : 0 },
    coachQuality: {
      cardsDrafted: coachCards.length,
      shownAsDraftedRate: coachCards.length ? count("shown") / coachCards.length : NaN,
      stoppedByGuardRate: coachCards.length ? (count("blocked_by_rules") + count("retracted_by_model")) / coachCards.length : NaN,
      coachErrorRate: coachCards.length ? count("coach_error") / coachCards.length : NaN,
      twoOptionCloseRate: shownCoachOwn.length ? twoOption / shownCoachOwn.length : NaN,
      homeNotLoanRate: shownCoachOwn.length ? homeWord / shownCoachOwn.length : NaN,
      outputTokensPerCard: coachTally && coachCards.length ? coachTally.output / coachCards.length : NaN,
    },
  };
  return { markdown: md.join("\n") + "\n", summary };
}

function detectionTable(model: DetectionScore, baseline?: DetectionScore): string {
  const cell = (p: PRF) => `${(p.precision * 100).toFixed(0)}% / ${(p.recall * 100).toFixed(0)}% (${p.tp} tp, ${p.fp} fp, ${p.fn} fn)`;
  const rows = [`| Type | Pipeline P / R | ${baseline ? "Keyword baseline P / R |" : ""}`, `|---|---|${baseline ? "---|" : ""}`];
  for (const t of MOMENT_TYPES) rows.push(`| ${t} | ${cell(model.byType[t])} | ${baseline ? `${cell(baseline.byType[t])} |` : ""}`);
  rows.push(`| **all** | **${cell(model.overall)}** | ${baseline ? `${cell(baseline.overall)} |` : ""}`);
  return rows.join("\n");
}
