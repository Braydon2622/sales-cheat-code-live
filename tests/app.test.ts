import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app/server.js";
import { MockCallAnalyzer } from "../src/pipeline/mock.js";

const dir = mkdtempSync(join(tmpdir(), "scc-app-"));
const components = () => ({ analyzer: new MockCallAnalyzer() });
let base = "";
let server: ReturnType<typeof createApp>;

beforeAll(async () => {
  server = createApp({
    reviewsDir: join(dir, "reviews"),
    privateDir: join(dir, "private"),
    samplesDir: "samples",
    publicDir: "src/app/public",
    components,
    liveAvailable: true,
    maxUsd: 0, // any live request is over budget; mock requests are free
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitForDone(jobId: string): Promise<{ reviewId: string }> {
  const res = await fetch(`${base}/api/jobs/${jobId}/events`);
  const text = await res.text(); // the stream ends after "done" or "failed"
  const done = text.split("\n\n").find((block) => block.startsWith("event: done"));
  if (!done) throw new Error(`job did not finish: ${text}`);
  return JSON.parse(done.split("data: ")[1]!);
}

describe("call review app", () => {
  it("serves the page with a strict content security policy", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Drop a call here");
  });

  it("lists samples and refuses anything not in the list", async () => {
    const list = (await (await fetch(base + "/api/samples")).json()) as Array<{ file: string }>;
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect((await fetch(`${base}/api/samples/${list[0]!.file}`)).status).toBe(200);
    expect((await fetch(`${base}/api/samples/..%2Fpackage.json`)).status).toBe(404);
  });

  it("asks which speaker is the loan officer, then reviews the call end to end with no PII stored", async () => {
    const content = readFileSync("samples/contractor-ready-to-buy.txt", "utf8");
    const ask = await post("/api/reviews", { fileName: "contractor.txt", content, mock: true });
    expect(ask.status).toBe(422);
    expect(((await ask.json()) as { speakers: string[] }).speakers).toEqual(["Chris", "Dominic"]);

    const start = await post("/api/reviews", { fileName: "contractor.txt", content, repName: "Chris", mock: true });
    expect(start.status).toBe(202);
    const { jobId } = (await start.json()) as { jobId: string };
    const { reviewId } = await waitForDone(jobId);

    const record = (await (await fetch(`${base}/api/reviews/${reviewId}`)).json()) as {
      mode: string; redactions: Record<string, number>; didWell: Array<{ key: string }>; doBetter: Array<{ key: string }>; followUp: { final: string };
    };
    expect(record.mode).toBe("mock");
    expect(record.redactions).toMatchObject({ ADDRESS: 1, NUMBER: 1 });
    expect(record.didWell.length + record.doBetter.length).toBeGreaterThan(0);
    expect(record.followUp.final).toContain("home");

    // Nothing written to disk contains the planted details.
    for (const sub of ["reviews", "private"]) {
      for (const f of readdirSync(join(dir, sub))) {
        expect(readFileSync(join(dir, sub, f), "utf8")).not.toMatch(/4821 Ridgeline|004418273356/);
      }
    }

    // Feedback on a highlight and on the whole review; bad input is refused.
    const key = record.doBetter[0]!.key;
    const put = (path: string, body: unknown) => fetch(`${base}/api/reviews/${reviewId}/feedback/${path}`, { method: "PUT", body: JSON.stringify(body) });
    expect((await put(key, { vote: "down", note: "too generic" })).status).toBe(200);
    expect((await put(key, { vote: "maybe" })).status).toBe(400);
    expect((await put("b9", { vote: "up" })).status).toBe(404);
    expect((await put("overall", { rating: 4, note: "useful" })).status).toBe(200);
    expect((await put("overall", { rating: 9 })).status).toBe(400);
    const list = (await (await fetch(base + "/api/reviews")).json()) as Array<{ id: string; feedbackGiven: number }>;
    expect(list.find((r) => r.id === reviewId)?.feedbackGiven).toBe(2);

    // Delete removes the review and its saved transcript.
    expect((await fetch(`${base}/api/reviews/${reviewId}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/reviews/${reviewId}`)).status).toBe(404);
    expect(readdirSync(join(dir, "private")).some((f) => f.startsWith(reviewId))).toBe(false);
  });

  it("reviews a Dialpad JSON sample", async () => {
    const content = readFileSync("samples/nurse-rate-and-approval.json", "utf8");
    const start = await post("/api/reviews", { fileName: "nurse.json", content, mock: true });
    const { reviewId } = await waitForDone(((await start.json()) as { jobId: string }).jobId);
    const record = (await (await fetch(`${base}/api/reviews/${reviewId}`)).json()) as { slips: unknown[]; redactions: Record<string, number> };
    expect(record.slips.length).toBeGreaterThanOrEqual(2);
    expect(record.redactions).toMatchObject({ SSN: 1, PHONE: 1 });
  });

  it("enforces the live spending cap but always allows mock", async () => {
    const live = await post("/api/reviews", { fileName: "x.txt", content: "REP: hi\nCLIENT: hello", mock: false });
    expect(live.status).toBe(402);
  });

  it("rejects bad input clearly", async () => {
    expect((await post("/api/reviews", { fileName: "x.json", content: "{not json", mock: true })).status).toBe(400);
    expect((await post("/api/reviews", { fileName: "x.json", content: '{"calls": []}', mock: true })).status).toBe(400);
    expect((await post("/api/reviews", { fileName: "x.txt", content: "   ", mock: true })).status).toBe(400);
    expect((await fetch(`${base}/api/reviews/..%2F..%2Fpackage`)).status).toBe(404);
  });

  it("explains that the Dialpad connection needs a key", async () => {
    delete process.env.DIALPAD_API_KEY;
    const res = await post("/api/dialpad", { callId: "123" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("DIALPAD_API_KEY");
  });
});
