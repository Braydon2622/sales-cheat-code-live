// Browser view of a live replay, for demos and the portfolio video.
//
// Same pipeline as the terminal demo: a synthetic call is replayed as if it
// were streaming speech-to-text, and every CallSession event (words being
// spoken, the "moment detected" chip, card lines, compliance alerts) is pushed
// to the page with Server-Sent Events. SSE is one-way server→browser over plain
// HTTP, which is all this needs, so there's no websocket library involved.
//
// Local only (127.0.0.1). Only the bundled synthetic calls can be replayed:
// the call ID is looked up in a fixed list, never used as a path.
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { PipelineComponents } from "../pipeline/factory.js";
import { ClaudeCoach } from "../pipeline/claude.js";
import { CallSession, latencyOf, type CardTrace } from "../pipeline/session.js";
import { checkCard } from "../pipeline/rules.js";
import { replay } from "../replay/replay.js";
import { loadTranscript } from "../replay/transcript.js";
import type { Transcript } from "../types.js";

export interface LiveOptions {
  /** Folders of synthetic transcript JSON (e.g. data/calls, data/holdout). */
  callDirs: string[];
  publicDir: string;
  components: (mock: boolean) => PipelineComponents;
  liveAvailable: boolean;
  /** Refuse live replays once this server session has spent this much. */
  maxUsd: number;
  models?: Record<string, string>;
}

interface CallEntry {
  id: string;
  title: string;
  scenario: string;
  path: string;
}

const SPEEDS = [1, 2, 4, 10];

export function createLiveServer(opts: LiveOptions): http.Server {
  const calls = new Map<string, CallEntry>();
  for (const dir of opts.callDirs) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const t = loadTranscript(join(dir, f));
      if (!t.synthetic) continue; // the demo never shows real calls
      calls.set(t.id, { id: t.id, title: t.title, scenario: t.scenario, path: join(dir, f) });
    }
  }
  let spentUsd = 0;
  let liveRunning = false;

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function runReplay(req: http.IncomingMessage, res: http.ServerResponse, t: Transcript, speed: number, mock: boolean) {
    const components = opts.components(mock);
    const session = new CallSession(components.detector, components.coach, components.guard, { mode: "speculative" });
    const ac = new AbortController();
    let closed = false;
    const emit = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Browser tab closed or "Stop" pressed: stop replaying and cancel in-flight AI calls.
    req.on("close", () => {
      closed = true;
      ac.abort();
      session.cancel();
    });

    const cardSummary = (c: CardTrace) => ({
      id: c.id,
      utteranceIndex: c.utteranceIndex,
      type: c.moment.type,
      subtype: c.moment.subtype,
      kind: c.kind,
      chipMs: latencyOf(c, "chipAt", "speechEnd"),
    });
    session.on("utterance", (u) => emit("utterance", { index: u.index, speaker: u.speaker, start: u.start, end: u.end, text: u.text }));
    session.on("chip", (c) => emit("chip", cardSummary(c)));
    session.on("card_line", (id, field, text) => emit("card_line", { id, field, text }));
    session.on("card_done", (c) =>
      emit("card_done", {
        ...cardSummary(c),
        outcome: c.outcome,
        shown: c.shown,
        blocked: c.violations.filter((v) => v.severity === "block").map((v) => v.rule),
        firstLineMs: latencyOf(c, "firstLineAt", "speechEnd"),
      }),
    );
    session.on("rep_alert", (a) =>
      emit("rep_alert", { utteranceIndex: a.utteranceIndex, source: a.source, violations: a.violations.map((v) => ({ rule: v.rule, quote: v.quote })) }),
    );
    session.on("stage_error", (stage, err) => emit("stage_error", { stage, message: err.message }));

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    emit("start", {
      id: t.id,
      title: t.title,
      scenario: t.scenario,
      speed,
      mock,
      models: mock ? undefined : opts.models,
    });
    try {
      if (components.coach instanceof ClaudeCoach) await components.coach.prewarm(session.meter).catch(() => undefined);
      for await (const u of replay(t, { speed, partials: true, signal: ac.signal })) {
        if (u.kind === "partial") emit("partial", { index: u.index, speaker: u.speaker, start: u.start, text: u.text });
        session.push(u);
      }
      await session.finish();
      const chips = session.cards.map((c) => latencyOf(c, "chipAt", "speechEnd")).filter((v): v is number => v !== undefined);
      emit("done", {
        cards: session.cards.length,
        earlyChips: chips.filter((v) => v < 0).length,
        repAlerts: session.repAlerts.length,
        // Re-check what the rep actually saw with the deterministic rules (same check as the eval report).
        nonCompliantShown: session.cards.filter((c) => checkCard(c.shown, c.moment.type).some((v) => v.severity === "block")).length,
        costUsd: session.meter.costUsd(),
        stopped: closed,
      });
    } catch (err) {
      emit("failed", { message: (err as Error).message });
    } finally {
      if (!mock) spentUsd += session.meter.costUsd();
      res.end();
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        });
        return res.end(readFileSync(join(opts.publicDir, "live.html")));
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(res, 200, { liveAvailable: opts.liveAvailable, spentUsd, maxUsd: opts.maxUsd, speeds: SPEEDS, models: opts.models });
      }
      if (req.method === "GET" && url.pathname === "/api/calls") {
        return send(res, 200, [...calls.values()].map(({ id, title, scenario }) => ({ id, title, scenario })));
      }
      if (req.method === "GET" && url.pathname === "/api/replay") {
        const entry = calls.get(url.searchParams.get("call") ?? "");
        if (!entry) return send(res, 404, { error: "No such call." });
        const speed = Number(url.searchParams.get("speed") ?? 1);
        if (!SPEEDS.includes(speed)) return send(res, 400, { error: `Speed must be one of ${SPEEDS.join(", ")}.` });
        const mock = url.searchParams.get("mock") === "1" || !opts.liveAvailable;
        if (!mock) {
          if (spentUsd >= opts.maxUsd) return send(res, 402, { error: `This session has spent $${spentUsd.toFixed(2)}, the $${opts.maxUsd.toFixed(2)} cap. Restart with a higher LIVE_MAX_USD, or use mock mode.` });
          // One live replay at a time, so a double click can't double the bill.
          if (liveRunning) return send(res, 409, { error: "A live replay is already running." });
          liveRunning = true;
          return await runReplay(req, res, loadTranscript(entry.path), speed, mock).finally(() => (liveRunning = false));
        }
        return await runReplay(req, res, loadTranscript(entry.path), speed, mock);
      }
      send(res, 404, { error: "Not found." });
    } catch (err) {
      if (res.headersSent) return res.end();
      send(res, 500, { error: (err as Error).message });
    }
  });
}
