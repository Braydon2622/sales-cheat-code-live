// Local web app for post-call review: drop transcript files in, get coaching
// reports out, rate the cards. Runs on your own machine only (127.0.0.1).
//
// Everything a user uploads is untrusted: transcripts are parsed as data,
// redacted on import, and the page renders them as text (never as HTML).
// File names never become paths: reviews are stored under generated IDs.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";
import { fetchDialpadTranscript, importDialpad, importText, listSpeakers, NeedRepNameError, type DialpadTranscript } from "../ingest/dialpad.js";
import { renderReview, reviewCall, toRecord, type ReviewComponents, type ReviewRecord } from "../review/review.js";
import type { Transcript } from "../types.js";

export interface AppOptions {
  reviewsDir: string;
  privateDir: string;
  samplesDir: string;
  publicDir: string;
  /** Builds pipeline components; mock = no API calls. */
  components: (mock: boolean) => ReviewComponents;
  liveAvailable: boolean;
  /** Stop accepting live reviews once this server session has spent this much. */
  maxUsd: number;
  models?: Record<string, string>;
}

interface Job {
  id: string;
  events: Array<{ event: string; data: unknown }>;
  listeners: Set<http.ServerResponse>;
  done: boolean;
}

const MAX_BODY = 5 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;

export function createApp(opts: AppOptions): http.Server {
  mkdirSync(opts.reviewsDir, { recursive: true });
  mkdirSync(opts.privateDir, { recursive: true });
  const jobs = new Map<string, Job>();
  let queue: Promise<unknown> = Promise.resolve();
  let spentUsd = 0;
  let nextJob = 1;

  const reviewPath = (id: string) => join(opts.reviewsDir, `${id}.json`);
  const loadRecord = (id: string): ReviewRecord | undefined =>
    SAFE_ID.test(id) && existsSync(reviewPath(id)) ? (JSON.parse(readFileSync(reviewPath(id), "utf8")) as ReviewRecord) : undefined;
  const saveRecord = (r: ReviewRecord) => writeFileSync(reviewPath(r.id), JSON.stringify(r, null, 2) + "\n");

  const samples = (): Array<{ file: string; title: string; format: string; note: string }> => {
    const manifest = join(opts.samplesDir, "index.json");
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
  };

  function emit(job: Job, event: string, data: unknown) {
    job.events.push({ event, data });
    for (const res of job.listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === "done" || event === "failed") {
      job.done = true;
      for (const res of job.listeners) res.end();
      job.listeners.clear();
    }
  }

  function importUpload(fileName: string, content: string, repName?: string): Transcript {
    const isJson = extname(fileName).toLowerCase() === ".json" || content.trimStart().startsWith("{");
    if (isJson) {
      let parsed: DialpadTranscript;
      try {
        parsed = JSON.parse(content) as DialpadTranscript;
      } catch {
        throw new Error("This .json file isn't valid JSON.");
      }
      if (!Array.isArray(parsed.lines)) throw new Error("This JSON doesn't look like a Dialpad transcript (no \"lines\" array).");
      return importDialpad(parsed);
    }
    const base = fileName.replace(/\.[^.]+$/, "");
    return importText(content, { id: base, repName });
  }

  function startReview(t: Transcript, fileName: string, mock: boolean): Job {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const slug = t.id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "call";
    const id = `${slug}-${stamp}-${nextJob}`;
    const job: Job = { id: `job-${nextJob++}`, events: [], listeners: new Set(), done: false };
    jobs.set(job.id, job);
    emit(job, "queued", { reviewId: id, fileName, lines: t.utterances.length, redactions: t.redactions ?? {} });
    queue = queue.then(async () => {
      try {
        writeFileSync(join(opts.privateDir, `${id}.transcript.json`), JSON.stringify(t, null, 2) + "\n");
        const result = await reviewCall(t, opts.components(mock), (step, done, total) => emit(job, "progress", { step, done, total }));
        const record = toRecord(result, { id, fileName, mode: mock ? "mock" : "live" });
        if (!mock) spentUsd += record.costUsd;
        saveRecord(record);
        writeFileSync(join(opts.reviewsDir, `${id}.md`), renderReview(result));
        emit(job, "done", { reviewId: id, costUsd: record.costUsd });
      } catch (err) {
        emit(job, "failed", { error: (err as Error).message });
      }
    });
    return job;
  }

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw Object.assign(new Error("File too large (5 MB max)."), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Object.assign(new Error("Request body isn't valid JSON."), { status: 400 });
    }
  }

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const wantsMock = (requested: unknown) => requested === true || !opts.liveAvailable;
  const overBudget = (mock: boolean) => !mock && spentUsd >= opts.maxUsd;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The page only talks to this server; no external scripts.
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        });
        res.end(readFileSync(join(opts.publicDir, "index.html")));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(res, 200, {
          liveAvailable: opts.liveAvailable,
          dialpadAvailable: Boolean(process.env.DIALPAD_API_KEY),
          spentUsd,
          maxUsd: opts.maxUsd,
          models: opts.models ?? {},
        });
      }
      if (req.method === "GET" && url.pathname === "/api/samples") return send(res, 200, samples());
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "samples" && parts[2]) {
        const s = samples().find((x) => x.file === parts[2]);
        if (!s) return send(res, 404, { error: "No such sample." });
        return send(res, 200, { fileName: s.file, content: readFileSync(join(opts.samplesDir, s.file), "utf8") });
      }
      if (req.method === "POST" && url.pathname === "/api/reviews") {
        const body = await readJson(req);
        const fileName = String(body.fileName ?? "call.txt").slice(0, 200);
        const content = String(body.content ?? "");
        const repName = body.repName ? String(body.repName) : undefined;
        const mock = wantsMock(body.mock);
        if (!content.trim()) return send(res, 400, { error: "The file is empty." });
        if (overBudget(mock)) return send(res, 402, { error: `This session has spent $${spentUsd.toFixed(2)}, the $${opts.maxUsd.toFixed(2)} cap. Restart the app with a higher REVIEW_MAX_USD, or use Mock mode.` });
        let t: Transcript;
        try {
          t = importUpload(fileName, content, repName);
        } catch (err) {
          if (err instanceof NeedRepNameError) return send(res, 422, { error: "Which speaker is the loan officer?", speakers: err.speakers });
          return send(res, 400, { error: (err as Error).message });
        }
        const job = startReview(t, fileName, mock);
        return send(res, 202, { jobId: job.id, reviewId: (job.events[0]!.data as { reviewId: string }).reviewId, mock });
      }
      if (req.method === "POST" && url.pathname === "/api/dialpad") {
        if (!process.env.DIALPAD_API_KEY) return send(res, 400, { error: "DIALPAD_API_KEY isn't set. Add it to your shell or .env, then restart the app." });
        const body = await readJson(req);
        const mock = wantsMock(body.mock);
        if (overBudget(mock)) return send(res, 402, { error: "Spending cap reached for this session." });
        const callId = String(body.callId ?? "").trim();
        const t = importDialpad(await fetchDialpadTranscript(callId));
        const job = startReview(t, `dialpad-${callId}`, mock);
        return send(res, 202, { jobId: job.id, mock });
      }
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "jobs" && parts[2] && parts[3] === "events") {
        const job = jobs.get(parts[2]);
        if (!job) return send(res, 404, { error: "No such job." });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        for (const e of job.events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        if (job.done) return res.end();
        job.listeners.add(res);
        req.on("close", () => job.listeners.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/reviews") {
        const list = readdirSync(opts.reviewsDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => loadRecord(f.slice(0, -5)))
          .filter((r): r is ReviewRecord => Boolean(r))
          .map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            fileName: r.fileName,
            mode: r.mode,
            temperature: r.analysis?.temperature,
            stage: r.analysis?.stage,
            slips: r.slips.length,
            moments: r.moments.length,
            rated: Object.keys(r.ratings).length,
            costUsd: r.costUsd,
          }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return send(res, 200, list);
      }
      if (parts[0] === "api" && parts[1] === "reviews" && parts[2]) {
        const record = loadRecord(parts[2]);
        if (!record) return send(res, 404, { error: "No such review." });
        if (req.method === "GET" && parts.length === 3) return send(res, 200, record);
        if (req.method === "DELETE" && parts.length === 3) {
          for (const f of [reviewPath(record.id), join(opts.reviewsDir, `${record.id}.md`), join(opts.privateDir, `${record.id}.transcript.json`)]) rmSync(f, { force: true });
          return send(res, 200, { deleted: record.id });
        }
        if (req.method === "PUT" && parts[3] === "ratings" && parts[4]) {
          const body = await readJson(req);
          const rating = Number(body.rating);
          if (!record.moments.some((m) => String(m.cardId) === parts[4])) return send(res, 404, { error: "No such card." });
          if (!Number.isInteger(rating) || rating < 1 || rating > 5) return send(res, 400, { error: "Rating must be 1–5." });
          record.ratings[parts[4]] = { rating, note: String(body.note ?? "").slice(0, 1000), at: new Date().toISOString() };
          saveRecord(record);
          return send(res, 200, record.ratings[parts[4]]);
        }
      }
      send(res, 404, { error: "Not found." });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      send(res, status, { error: (err as Error).message });
    }
  });
}
