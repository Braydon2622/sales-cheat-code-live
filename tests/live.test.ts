import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLiveServer } from "../src/live/server.js";
import { KeywordDetector, NoopGuard, TemplateCoach } from "../src/pipeline/mock.js";

let base = "";
let server: ReturnType<typeof createLiveServer>;
let liveRequests = 0;

beforeAll(async () => {
  server = createLiveServer({
    callDirs: ["data/calls"],
    publicDir: "src/live/public",
    components: (mock) => {
      if (!mock) liveRequests++;
      return { detector: new KeywordDetector(), coach: new TemplateCoach(0, 0), guard: new NoopGuard() };
    },
    liveAvailable: true,
    maxUsd: 0, // any live replay is over budget; mock replays are free
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function parseEvents(text: string): Array<{ event: string; data: any }> {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event: "))
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }));
}

describe("live replay view", () => {
  it("serves the page with a strict content security policy", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Coaching cards");
  });

  it("lists only the bundled synthetic calls", async () => {
    const calls = (await (await fetch(base + "/api/calls")).json()) as Array<{ id: string }>;
    expect(calls.length).toBe(20);
    expect(calls.map((c) => c.id)).toContain("call-18");
  });

  it("refuses unknown calls and odd speeds instead of touching the filesystem", async () => {
    expect((await fetch(`${base}/api/replay?call=../../package&mock=1`)).status).toBe(404);
    expect((await fetch(`${base}/api/replay?call=call-18&speed=1000&mock=1`)).status).toBe(400);
  });

  it("enforces the spend cap before a live replay starts", async () => {
    const res = await fetch(`${base}/api/replay?call=call-18&speed=10`);
    expect(res.status).toBe(402);
    expect(liveRequests).toBe(0);
  });

  it("streams a mock replay end to end: words, chips, cards, rep alerts, summary", async () => {
    const res = await fetch(`${base}/api/replay?call=call-18&speed=10&mock=1`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseEvents(await res.text());
    const kinds = new Set(events.map((e) => e.event));
    for (const k of ["start", "partial", "utterance", "chip", "card_line", "card_done", "rep_alert", "done"]) expect(kinds).toContain(k);
    expect(events[0]!.event).toBe("start");
    expect(events.at(-1)!.event).toBe("done");
    const chips = events.filter((e) => e.event === "chip").length;
    const done = events.filter((e) => e.event === "card_done");
    expect(done.length).toBe(chips);
    for (const d of done) expect(d.data.shown.sendThis).toBeTruthy();
    // Ground-truth labels must never leave the server.
    expect(JSON.stringify(events)).not.toContain("labels");
    expect(events.at(-1)!.data.costUsd).toBe(0);
    expect(events.at(-1)!.data.nonCompliantShown).toBe(0);
  }, 60_000);
});
