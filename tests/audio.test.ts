import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app/server.js";
import { audioToTranscript, deepgramTranscriber, splitSpeakers, type DeepgramResponse } from "../src/ingest/audio.js";
import { feedbackBlock, type CallAnalysis } from "../src/pipeline/claude.js";
import { MockCallAnalyzer } from "../src/pipeline/mock.js";
import { buildHighlights, collectFeedback, findSlips, WITHHELD, type ReviewRecord } from "../src/review/review.js";
import type { Transcript } from "../src/types.js";

// A synthetic two-voice recording, as Deepgram would return it (fake PII planted on purpose).
const deepgram: DeepgramResponse = {
  metadata: { duration: 120 },
  results: {
    utterances: [
      { start: 0.2, end: 2.0, speaker: 1, transcript: "Hi, this is Shawn with Copperleaf Home Loans." },
      { start: 2.3, end: 3.0, speaker: 1, transcript: "Thanks for calling back." },
      { start: 3.5, end: 7.0, speaker: 0, transcript: "Sure. My social is 078-05-1120 if you need it." },
      { start: 7.5, end: 10.0, speaker: 1, transcript: "You're approved, don't worry about it." },
      { start: 10.5, end: 12.0, speaker: 0, transcript: "Great, call me at 415-555-0199." },
    ],
  },
};

describe("audio import", () => {
  it("splits voices in order of appearance, merges close lines, redacts, and estimates cost", () => {
    const a = splitSpeakers(deepgram);
    expect(a.speakers.map((s) => s.label)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(a.lines[0]).toMatchObject({ speaker: "Speaker 1", text: "Hi, this is Shawn with Copperleaf Home Loans. Thanks for calling back." });
    expect(a.lines).toHaveLength(4);
    expect(JSON.stringify(a)).not.toMatch(/078-05-1120|555-0199/);
    expect(a.redactions).toMatchObject({ SSN: 1, PHONE: 1 });
    expect(a.transcriptionUsd).toBeCloseTo(2 * 0.0043, 5);
    expect(a.speakers[1]!.sample).toContain("[SSN]");
  });

  it("maps the chosen voice to the loan officer and everyone else to the client", () => {
    const t = audioToTranscript(splitSpeakers(deepgram), "Speaker 1", "rec");
    expect(t.source).toBe("audio");
    expect(t.synthetic).toBe(false);
    expect(t.utterances.map((u) => u.speaker)).toEqual(["rep", "client", "rep", "client"]);
    expect(() => audioToTranscript(splitSpeakers(deepgram), "Speaker 7", "rec")).toThrow(/No Speaker 7/);
  });

  it("fails clearly on a recording with no speech", () => {
    expect(() => splitSpeakers({ results: { utterances: [] } })).toThrow(/No speech/);
  });

  it("calls Deepgram with the key, the audio type, and diarization on", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = { url, headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify(deepgram), { status: 200 });
    }) as typeof fetch;
    await deepgramTranscriber("dg-test", fakeFetch)(new Uint8Array([1, 2, 3]), "audio/mpeg");
    expect(seen!.url).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?/);
    expect(seen!.url).toContain("model=nova-3");
    expect(seen!.url).toContain("diarize_model=latest");
    expect(seen!.url).toContain("utterances=true");
    expect(seen!.headers).toMatchObject({ Authorization: "Token dg-test", "Content-Type": "audio/mpeg" });

    const failing = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(deepgramTranscriber("x", failing)(new Uint8Array([1]), "audio/wav")).rejects.toThrow(/didn.t accept the API key/);
    const slow = (async () => new Response("{\"err_code\":\"SLOW_UPLOAD\"}", { status: 408 })) as unknown as typeof fetch;
    await expect(deepgramTranscriber("x", slow)(new Uint8Array([1]), "audio/wav")).rejects.toThrow(/too slow/);
  });
});

// ---------------------------------------------------------------- highlights and slips

const transcript: Transcript = {
  id: "t",
  title: "t",
  scenario: "",
  synthetic: true,
  utterances: [
    { index: 0, speaker: "rep", start: 0, end: 2, text: "Hi, thanks for calling back.", labels: [] },
    { index: 1, speaker: "client", start: 3, end: 5, text: "What rate can I get?", labels: [] },
    { index: 2, speaker: "rep", start: 6, end: 8, text: "Probably around six and a quarter.", labels: [] },
    { index: 3, speaker: "client", start: 9, end: 10, text: "My bank is terrible.", labels: [] },
  ],
};
const analysis = (over: Partial<CallAnalysis> = {}): CallAnalysis => ({
  summary: "",
  temperature: "Warm",
  stage: "Contacted",
  objections: "None",
  next_step: "",
  follow_up: "",
  text_to_send: "",
  did_well: [{ line: 0, what: "Warm open", why: "Builds rapport" }],
  do_better: [{ line: 2, category: "Compliance", what_happened: "Quoted a rate", try_instead: "It depends on your full picture. Does today at 4 or tomorrow at 10 work better?", why: "Compliance" }],
  turning_point: { line: 2, what: "Quoted a rate before a review" },
  next_step_booked: false,
  compliance_slips: [],
  coaching_note: "",
  ...over,
});

describe("highlights", () => {
  it("ties each highlight to the real transcript line, not the model's quote", () => {
    const h = buildHighlights(transcript, analysis());
    expect(h.didWell[0]).toMatchObject({ key: "w1", time: "0:00", speaker: "rep", quote: "Hi, thanks for calling back." });
    expect(h.doBetter[0]).toMatchObject({ key: "b1", time: "0:06", quote: "Probably around six and a quarter." });
  });

  it("drops highlights that point at a line that doesn't exist, and keeps at most 3", () => {
    const many = Array.from({ length: 5 }, () => ({ line: 0, what: "x", why: "y" }));
    const h = buildHighlights(transcript, analysis({ did_well: [{ line: 99, what: "ghost", why: "" }, ...many] }));
    expect(h.didWell.map((x) => x.what)).not.toContain("ghost");
    expect(h.didWell).toHaveLength(3);
  });

  it("withholds suggested wording that breaks a compliance rule", () => {
    const h = buildHighlights(transcript, analysis({ do_better: [{ line: 2, category: "Compliance", what_happened: "x", try_instead: "Tell them you're pre approved at 5.9%.", why: "" }] }));
    expect(h.doBetter[0]!.tryInstead).toBe(WITHHELD);
    expect(h.doBetter[0]!.tryInsteadBlocked!.length).toBeGreaterThan(0);
  });
});

describe("rep compliance slips", () => {
  it("combines the rules with the model, and ignores model slips on client lines", () => {
    const slips = findSlips(transcript, analysis({
      compliance_slips: [
        { line: 2, rule: "rate_quote", quote: "six and a quarter" },
        { line: 3, rule: "talked_down_lender", quote: "My bank is terrible." },
        { line: 0, rule: "other", quote: "Hi" },
      ],
    }));
    expect(slips.map((s) => s.line)).toEqual([0, 2]);
    expect(slips.find((s) => s.line === 2)!.source).toBe("rules");
    expect(slips.find((s) => s.line === 0)!.source).toBe("model");
  });

  it("still catches rule slips when the AI step fails", () => {
    expect(findSlips(transcript).map((s) => s.line)).toEqual([2]);
  });
});

// ---------------------------------------------------------------- feedback loop

const record = (over: Partial<ReviewRecord>): ReviewRecord => ({
  id: "r",
  createdAt: "2026-11-05T00:00:00Z",
  fileName: "f",
  mode: "live",
  synthetic: true,
  source: "text",
  lines: 0,
  durationSec: 0,
  redactions: {},
  didWell: buildHighlights(transcript, analysis()).didWell,
  doBetter: buildHighlights(transcript, analysis()).doBetter,
  slips: [],
  transcript: [],
  errors: [],
  costUsd: 0,
  feedback: { items: {} },
  ...over,
});

describe("feedback for the AI", () => {
  it("puts thumbs-downs and notes first, skips mock reviews, and caps the count", () => {
    const fb = collectFeedback([
      record({ feedback: { items: { w1: { vote: "up", note: "", at: "2026-11-05T03:00:00Z" } } } }),
      record({ feedback: { items: { b1: { vote: "down", note: "too generic", at: "2026-11-05T01:00:00Z" } }, overall: { rating: 5, note: "", at: "2026-11-05T02:00:00Z" } } }),
      record({ mode: "mock", feedback: { items: { w1: { vote: "down", note: "mock", at: "2026-11-05T04:00:00Z" } } } }),
    ]);
    expect(fb[0]).toMatchObject({ verdict: "not helpful", note: "too generic" });
    expect(fb.some((f) => f.note === "mock")).toBe(false);
    expect(fb).toHaveLength(3);
    expect(collectFeedback([record({ feedback: { items: { w1: { vote: "up", note: "a", at: "x" }, b1: { vote: "up", note: "b", at: "y" } } } })], 1)).toHaveLength(1);
  });

  it("frames feedback as preferences that never override compliance", () => {
    expect(feedbackBlock([])).toBe("");
    const text = feedbackBlock([{ about: "a whole review", verdict: "rated 2/5", note: "Focus on the close." }]);
    expect(text).toContain("never overrides the compliance rules");
    expect(text).toContain("Focus on the close.");
  });
});

// ---------------------------------------------------------------- app: audio upload → review → feedback → next review

describe("app: audio upload", () => {
  const dir = mkdtempSync(join(tmpdir(), "scc-audio-"));
  const analyzer = new MockCallAnalyzer();
  let base = "";
  let server: ReturnType<typeof createApp>;
  let transcribeCalls = 0;

  beforeAll(async () => {
    server = createApp({
      reviewsDir: join(dir, "reviews"),
      privateDir: join(dir, "private"),
      samplesDir: "samples",
      publicDir: "src/app/public",
      components: () => ({ analyzer }),
      liveAvailable: true,
      maxUsd: 1,
      transcriber: async (audio) => {
        transcribeCalls++;
        if (audio[0] === 0x00) return { results: { utterances: [{ start: 0, end: 1, speaker: 0, transcript: "Hello? Anyone there?" }] } };
        return deepgram;
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const upload = (name: string, bytes = new Uint8Array([0x49, 0x44, 0x33])) =>
    fetch(`${base}/api/audio?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });

  async function reviewUpload(): Promise<string> {
    const up = await upload("call.mp3");
    expect(up.status).toBe(200);
    const { pendingId, speakers } = (await up.json()) as { pendingId: string; speakers: Array<{ label: string }> };
    expect(speakers.map((s) => s.label)).toEqual(["Speaker 1", "Speaker 2"]);
    const start = await fetch(`${base}/api/audio/${pendingId}/review`, { method: "POST", body: JSON.stringify({ repSpeaker: "Speaker 1", mock: false }) });
    expect(start.status).toBe(202);
    const { jobId } = (await start.json()) as { jobId: string };
    const events = await (await fetch(`${base}/api/jobs/${jobId}/events`)).text();
    const done = events.split("\n\n").find((b) => b.startsWith("event: done"));
    if (!done) throw new Error(events);
    return (JSON.parse(done.split("data: ")[1]!) as { reviewId: string }).reviewId;
  }

  it("refuses unsupported files and one-voice recordings", async () => {
    expect((await upload("notes.pdf")).status).toBe(400);
    const one = await upload("voicemail.mp3", new Uint8Array([0x00]));
    expect(one.status).toBe(422);
    expect(((await one.json()) as { error: string }).error).toMatch(/Only one voice/);
  });

  it("transcribes, asks for the loan officer's voice, reviews, and stores no PII and no audio", async () => {
    const reviewId = await reviewUpload();
    const r = (await (await fetch(`${base}/api/reviews/${reviewId}`)).json()) as ReviewRecord;
    expect(r.source).toBe("audio");
    expect(r.transcriptionUsd).toBeGreaterThan(0);
    expect(r.slips.some((s) => s.rules.includes("approval_promise"))).toBe(true);
    expect(r.didWell[0]!.speaker).toBe("rep");
    for (const sub of ["reviews", "private"]) {
      for (const f of readdirSync(join(dir, sub))) {
        expect(f).not.toMatch(/\.(mp3|wav|m4a)$/);
        expect(readFileSync(join(dir, sub, f), "utf8")).not.toMatch(/078-05-1120|555-0199/);
      }
    }
    // A used or unknown upload can't be reviewed twice.
    expect((await fetch(`${base}/api/audio/nope/review`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("feeds feedback from one review into the next review's prompt", async () => {
    const first = await reviewUpload();
    const r = (await (await fetch(`${base}/api/reviews/${first}`)).json()) as ReviewRecord;
    await fetch(`${base}/api/reviews/${first}/feedback/${r.doBetter[0]!.key}`, { method: "PUT", body: JSON.stringify({ vote: "down", note: "Give wording for the spouse objection." }) });
    const visible = (await (await fetch(`${base}/api/feedback`)).json()) as Array<{ note: string }>;
    expect(visible.some((f) => f.note === "Give wording for the spouse objection.")).toBe(true);

    await reviewUpload();
    expect(analyzer.lastFeedback.some((f) => f.note === "Give wording for the spouse objection.")).toBe(true);
    expect(transcribeCalls).toBeGreaterThan(0);
  });
});
