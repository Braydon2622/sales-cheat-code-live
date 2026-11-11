// Local web app for post-call review: drop in a call recording or transcript,
// get a highlights-style coaching report, and give the AI feedback that shapes
// later reviews. Runs on your own machine only (127.0.0.1).
//
// Everything a user uploads is untrusted: transcripts are parsed as data,
// redacted on import, and the page renders them as text (never as HTML).
// File names never become paths: reviews are stored under generated IDs.
// Audio is held in memory only long enough to send it to speech-to-text.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";
import { fetchDialpadTranscript, importDialpad, importText, NeedRepNameError, type DialpadTranscript } from "../ingest/dialpad.js";
import { audioMimeFor, audioToTranscript, splitSpeakers, type TranscribedAudio, type Transcriber } from "../ingest/audio.js";
import { collectFeedback, renderReview, reviewCall, toRecord, type ReviewComponents, type ReviewRecord } from "../review/review.js";
import { buildInsights } from "../review/insights.js";
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
  /** Speech-to-text for audio uploads. Unset = audio upload disabled (no DEEPGRAM_API_KEY). */
  transcriber?: Transcriber;
}

interface PendingAudio {
  audio: TranscribedAudio;
  fileName: string;
  expires: number;
}

interface Job {
  id: string;
  events: Array<{ event: string; data: unknown }>;
  listeners: Set<http.ServerResponse>;
  done: boolean;
}

const MAX_BODY = 5 * 1024 * 1024;
/** About 3.5 hours of 128 kbps MP3, or 20 minutes of uncompressed WAV. */
const MAX_AUDIO = 200 * 1024 * 1024;
/** How long a transcribed recording waits for "which voice is the loan officer?". */
const PENDING_MS = 30 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;

/** Turns raw API errors into something a loan officer can act on. */
export function friendlyError(raw: string): string {
  if (/credit balance is too low/i.test(raw)) return "Your Anthropic account is out of API credits. Add credits at console.anthropic.com (Plans & Billing), then try again. Mock mode works without credits.";
  if (/authentication|invalid x-api-key|401/i.test(raw)) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env, then restart the app.";
  if (/overloaded|529|rate.?limit|429/i.test(raw)) return "The AI service is busy right now. Wait a minute and try again.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) return "Couldn't reach the AI service. Check your internet connection and try again.";
  return `The review didn't finish: ${raw.replace(/^analysis:\s*/, "").slice(0, 300)}`;
}

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

  const allRecords = (): ReviewRecord[] =>
    readdirSync(opts.reviewsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadRecord(f.slice(0, -5)))
      .filter((r): r is ReviewRecord => Boolean(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function startReview(t: Transcript, fileName: string, mock: boolean, transcriptionUsd?: number): Job {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const slug = t.id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "call";
    const id = `${slug}-${stamp}-${nextJob}`;
    const job: Job = { id: `job-${nextJob++}`, events: [], listeners: new Set(), done: false };
    jobs.set(job.id, job);
    emit(job, "queued", { reviewId: id, fileName, lines: t.utterances.length, redactions: t.redactions ?? {} });
    queue = queue.then(async () => {
      try {
        writeFileSync(join(opts.privateDir, `${id}.transcript.json`), JSON.stringify(t, null, 2) + "\n");
        // Feedback left on earlier reviews goes into this one's prompt.
        const feedback = collectFeedback(allRecords());
        const result = await reviewCall(t, opts.components(mock), (step, done, total) => emit(job, "progress", { step, done, total }), feedback);
        // A review without the AI analysis is just an error page: say why plainly and don't save it.
        if (!result.analysis) {
          emit(job, "failed", { error: friendlyError(result.errors.join("; ")) });
          return;
        }
        const record = toRecord(result, { id, fileName, mode: mock ? "mock" : "live", transcriptionUsd });
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

  const pendingAudio = new Map<string, PendingAudio>();
  const prunePending = () => {
    for (const [k, p] of pendingAudio) if (p.expires < Date.now()) pendingAudio.delete(k);
  };

  async function readBytes(req: http.IncomingMessage, max: number): Promise<Buffer> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) throw Object.assign(new Error(`File too large (${Math.round(max / 1024 / 1024)} MB max).`), { status: 413 });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw Object.assign(new Error(`File too large (${Math.round(max / 1024 / 1024)} MB max).`), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
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
          audioAvailable: Boolean(opts.transcriber),
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
      // Audio step 1: upload → speech-to-text → redact. Returns the voices found;
      // nothing is reviewed until someone says which voice is the loan officer.
      if (req.method === "POST" && url.pathname === "/api/audio") {
        if (!opts.transcriber) return send(res, 400, { error: "Audio upload needs DEEPGRAM_API_KEY. Add it to .env, then restart the app." });
        const fileName = String(url.searchParams.get("name") ?? "call.mp3").slice(0, 200);
        const mime = audioMimeFor(fileName);
        if (!mime) return send(res, 400, { error: "Unsupported audio type. Use MP3, WAV, M4A, AAC, OGG, WEBM, FLAC or AMR." });
        // Transcription is a real charge even in mock mode, so the cap always applies.
        if (spentUsd >= opts.maxUsd) return send(res, 402, { error: `This session has spent $${spentUsd.toFixed(2)}, the $${opts.maxUsd.toFixed(2)} cap. Restart the app with a higher REVIEW_MAX_USD.` });
        const audio = await readBytes(req, MAX_AUDIO);
        if (!audio.length) return send(res, 400, { error: "The file is empty." });
        let transcribed: TranscribedAudio;
        try {
          transcribed = splitSpeakers(await opts.transcriber(audio, mime));
        } catch (err) {
          return send(res, 502, { error: (err as Error).message });
        }
        spentUsd += transcribed.transcriptionUsd;
        if (transcribed.speakers.length < 2) {
          return send(res, 422, { error: "Only one voice was found, so the loan officer and client can't be told apart. Try a recording with both sides of the call." });
        }
        prunePending();
        const pendingId = randomUUID();
        pendingAudio.set(pendingId, { audio: transcribed, fileName, expires: Date.now() + PENDING_MS });
        return send(res, 200, {
          pendingId,
          speakers: transcribed.speakers,
          durationSec: transcribed.durationSec,
          transcriptionUsd: transcribed.transcriptionUsd,
          redactions: transcribed.redactions,
        });
      }
      // Audio step 2: the loan officer's voice is picked → start the review.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "audio" && parts[2] && parts[3] === "review") {
        prunePending();
        const pending = pendingAudio.get(parts[2]);
        if (!pending) return send(res, 404, { error: "That recording expired. Upload it again." });
        const body = await readJson(req);
        const mock = wantsMock(body.mock);
        if (overBudget(mock)) return send(res, 402, { error: `This session has spent $${spentUsd.toFixed(2)}, the $${opts.maxUsd.toFixed(2)} cap. Restart the app with a higher REVIEW_MAX_USD, or use Mock mode.` });
        const id = pending.fileName.replace(/\.[^.]+$/, "");
        let t: Transcript;
        try {
          t = audioToTranscript(pending.audio, String(body.repSpeaker ?? ""), id);
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
        pendingAudio.delete(parts[2]);
        const job = startReview(t, pending.fileName, mock, pending.audio.transcriptionUsd);
        return send(res, 202, { jobId: job.id, reviewId: (job.events[0]!.data as { reviewId: string }).reviewId, mock });
      }
      // Patterns across every saved review: where calls go wrong. ?mock=1 includes mock reviews.
      if (req.method === "GET" && url.pathname === "/api/insights") {
        return send(res, 200, buildInsights(allRecords(), { includeMock: url.searchParams.get("mock") === "1" }));
      }
      // What the AI will be told on the next review (so it's never a black box).
      if (req.method === "GET" && url.pathname === "/api/feedback") {
        return send(res, 200, collectFeedback(allRecords()));
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
        const list = allRecords().map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          fileName: r.fileName,
          mode: r.mode,
          source: r.source,
          temperature: r.analysis?.temperature,
          stage: r.analysis?.stage,
          slips: r.slips.length,
          highlights: (r.didWell?.length ?? 0) + (r.doBetter?.length ?? 0),
          feedbackGiven: Object.keys(r.feedback?.items ?? {}).length + (r.feedback?.overall ? 1 : 0),
          costUsd: r.costUsd + (r.transcriptionUsd ?? 0),
        }));
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
        // Feedback for the AI: PUT .../feedback/overall {rating 1–5, note} or .../feedback/<highlight key> {vote up|down|none, note}
        if (req.method === "PUT" && parts[3] === "feedback" && parts[4] && parts.length === 5) {
          const body = await readJson(req);
          const note = String(body.note ?? "").trim().slice(0, 1000);
          const at = new Date().toISOString();
          record.feedback ??= { items: {} };
          if (parts[4] === "overall") {
            const rating = Number(body.rating);
            if (!Number.isInteger(rating) || rating < 1 || rating > 5) return send(res, 400, { error: "Rating must be 1–5." });
            record.feedback.overall = { rating, note, at };
            saveRecord(record);
            return send(res, 200, record.feedback.overall);
          }
          const key = parts[4];
          if (![...(record.didWell ?? []), ...(record.doBetter ?? [])].some((h) => h.key === key)) return send(res, 404, { error: "No such highlight." });
          if (body.vote === "none") {
            delete record.feedback.items[key];
            saveRecord(record);
            return send(res, 200, { cleared: key });
          }
          if (body.vote !== "up" && body.vote !== "down") return send(res, 400, { error: "Vote must be up, down or none." });
          record.feedback.items[key] = { vote: body.vote, note, at };
          saveRecord(record);
          return send(res, 200, record.feedback.items[key]);
        }
        // Older reviews (before highlights) still have per-card 1–5 ratings.
        if (req.method === "PUT" && parts[3] === "ratings" && parts[4]) {
          const body = await readJson(req);
          const rating = Number(body.rating);
          if (!record.moments?.some((m) => String(m.cardId) === parts[4])) return send(res, 404, { error: "No such card." });
          if (!Number.isInteger(rating) || rating < 1 || rating > 5) return send(res, 400, { error: "Rating must be 1–5." });
          record.ratings ??= {};
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
