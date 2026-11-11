// Live terminal demo: replays a synthetic call and shows the "moment detected"
// chip and coaching cards as they stream in.
//   npm run demo -- [call-18] [--speed 1] [--mock] [--mode serial] [--no-partials] [--intro]
//   npm run demo:video        (call-18, real time, intro screen: ready to screen-record)
//
// In a terminal, the speaker's words appear as they're spoken (interim
// partials), so you can watch the chip fire before the client finishes.
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { hasApiKey } from "../config.js";
import { makeComponents } from "../pipeline/factory.js";
import { ClaudeCoach } from "../pipeline/claude.js";
import { CallSession, latencyOf, type PipelineMode } from "../pipeline/session.js";
import { replay } from "../replay/replay.js";
import { loadTranscript } from "../replay/transcript.js";
import { percentile } from "../eval/metrics.js";
import type { CardField } from "../types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    speed: { type: "string", default: "1" },
    mock: { type: "boolean", default: false },
    mode: { type: "string", default: "speculative" },
    "no-partials": { type: "boolean", default: false },
    intro: { type: "boolean", default: false },
  },
});

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
const LABEL: Record<CardField, string> = {
  read: "READ      ",
  sendThis: "SEND THIS ",
  backup: "BACKUP    ",
  nextStep: "NEXT STEP ",
  followUp: "FOLLOW UP ",
  watchOut: "WATCH OUT ",
};

const callId = positionals[0] ?? "call-18";
const transcript = loadTranscript(`data/${callId.startsWith("holdout") ? "holdout" : "calls"}/${callId}.json`);
const mock = values.mock || !hasApiKey();
const speed = Number(values.speed);
const components = makeComponents(mock);
const mode = values.mode as PipelineMode;
const partials = mode === "speculative" && !values["no-partials"];
const session = new CallSession(components.detector, components.coach, components.guard, { mode });
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const who = (speaker: string) => (speaker === "rep" ? c.cyan("REP   ") : c.magenta("CLIENT"));

// ---- output: one in-place "live" line for words being spoken, everything else scrolls above it
const tty = Boolean(process.stdout.isTTY);
let live = "";
const say = (line: string) => {
  if (live) process.stdout.write("\r\x1b[2K");
  console.log(line);
  if (live) process.stdout.write(live);
};
const showLive = (time: number, speaker: string, text: string) => {
  if (!tty) return;
  const width = (process.stdout.columns || 100) - 14;
  const shown = text.length > width ? "…" + text.slice(-width + 1) : text;
  live = `${c.dim(fmtTime(time))} ${who(speaker)} ${shown} ${c.dim("…")}`;
  process.stdout.write("\r\x1b[2K" + live);
};

const ago = (ms: number | undefined) =>
  ms === undefined || Number.isNaN(ms) ? "while the client is still talking" : ms < 0 ? `${(-ms / 1000).toFixed(1)} s before they finished` : `${(ms / 1000).toFixed(1)} s after they finished`;

session.on("utterance", (u) => say(`${c.dim(fmtTime(u.end))} ${who(u.speaker)} ${u.text}`));
// The chip: shown the instant the detector fires, before any card text.
session.on("chip", (t) => {
  const tag = (t.moment.subtype ? `${t.moment.type}: ${t.moment.subtype}` : t.moment.type).replace(/_/g, " ");
  say(c.yellow(`        ◆ moment detected: ${c.bold(tag)} ${c.dim(`(${ago(latencyOf(t, "chipAt", "speechEnd"))})`)}`));
  say(c.yellow(`        ┌─ CARD #${t.id}`));
});
session.on("card_line", (id, field, text) => {
  const body = field === "sendThis" ? c.bold(text) : text;
  say(`${c.yellow(`        │ #${id}`)} ${c.dim(LABEL[field])}${body}`);
});
session.on("card_done", (t) => {
  // Blocked drafts are quietly replaced with a safe card; only a coach failure gets a note.
  const verdict = t.outcome === "coach_error" ? c.red(`✗ coach error (${t.error}); backup card shown`) : c.green("✓");
  say(c.yellow(`        └─ #${t.id} `) + verdict + c.dim(` · first line ${ago(latencyOf(t, "firstLineAt", "speechEnd"))}`));
});
session.on("stage_error", (stage, err) => say(c.red(`        ! ${stage} error: ${err.message}`)));

const ac = new AbortController();
process.on("SIGINT", () => {
  ac.abort();
  session.cancel();
});

if (values.intro && tty) process.stdout.write("\x1b[2J\x1b[H");
say(c.bold(`\n Sales Call Cheat Code · real-time AI call coach for loan officers`));
say(c.dim(` Replaying ${transcript.id}: "${transcript.title}". SYNTHETIC role-play call, no real borrower.`));
say(c.dim(` ${mock ? "MOCK mode: keyword detector + canned cards" : `detector ${components.detector.name} · coach ${components.coach.name} · guard ${components.guard.name}`}`));
say(c.dim(` ${mode}${partials ? " + interim partials" : ""} · ${speed}x speed\n`));
if (components.coach instanceof ClaudeCoach) await components.coach.prewarm(session.meter).catch(() => undefined);
if (values.intro) {
  for (const n of [3, 2, 1]) {
    if (tty) process.stdout.write(`\r\x1b[2K ${c.dim(`starting in ${n}…`)}`);
    await sleep(1000);
  }
  if (tty) process.stdout.write("\r\x1b[2K");
}

for await (const u of replay(transcript, { speed, partials, signal: ac.signal })) {
  if (u.kind === "partial") showLive(u.start, u.speaker, u.text);
  else {
    if (live) process.stdout.write("\r\x1b[2K");
    live = "";
  }
  session.push(u);
}
await session.finish();

const coached = session.cards.filter((t) => t.kind === "coach");
const chips = session.cards.map((t) => latencyOf(t, "chipAt", "speechEnd")).filter((v): v is number => v !== undefined);
const firstLines = coached.map((t) => latencyOf(t, "firstLineAt", "speechEnd")).filter((v): v is number => v !== undefined);
const early = chips.filter((v) => v < 0).length;
say(c.bold(`\n Call over`));
say(` ${session.cards.length} coaching moments · ${early} flagged before the client finished talking`);
say(` Typical timing · chip: ${ago(percentile(chips, 50))} · card on screen: ${ago(percentile(firstLines, 50))}`);
say(c.dim(` AI cost for this call: $${session.meter.costUsd().toFixed(4)}${mock ? " (mock mode: no AI calls)" : ""}\n`));
