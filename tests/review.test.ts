import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchDialpadTranscript, importDialpad, importText, type DialpadTranscript } from "../src/ingest/dialpad.js";
import { checkFollowUpText, renderReview, reviewCall, SAFE_FOLLOW_UP_TEXT } from "../src/review/review.js";
import { MockCallAnalyzer } from "../src/pipeline/mock.js";

const fixture = JSON.parse(readFileSync("tests/fixtures/dialpad-sample.json", "utf8")) as DialpadTranscript;

describe("Dialpad import", () => {
  it("maps user lines to the rep and contact lines to the client, skips moments, redacts PII", () => {
    const t = importDialpad(fixture);
    expect(t.synthetic).toBe(false);
    expect(t.source).toBe("dialpad");
    expect(t.utterances[0]!.speaker).toBe("rep");
    expect(t.utterances.some((u) => u.text === "price_inquiry")).toBe(false);
    const all = t.utterances.map((u) => u.text).join(" ");
    expect(all).not.toMatch(/078-05-1120|555-0142/);
    expect(t.redactions).toMatchObject({ SSN: 1, PHONE: 1 });
    // Speaker display names are dropped (names *spoken* in the call are a known gap, see README).
    expect(JSON.stringify(t)).not.toContain("Shawn (Copperleaf Home Loans)");
  });

  it("sorts out-of-order lines by time and accepts numeric or string IDs", () => {
    const t = importDialpad({
      call_id: 5,
      lines: [
        { contact_id: "c1", content: "second", time: "2018-05-08T21:33:19.300000", type: "transcript" },
        { user_id: 2, content: "first", time: "2018-05-08T21:33:15.300000", type: "transcript" },
      ],
    });
    expect(t.utterances.map((u) => [u.speaker, u.text])).toEqual([["rep", "first"], ["client", "second"]]);
    expect(t.utterances[1]!.start).toBeCloseTo(4, 1);
  });

  it("treats other Dialpad users as the client when rep IDs are given", () => {
    const t = importDialpad(
      {
        lines: [
          { user_id: "1", content: "I'm the rep", time: "2026-01-01T00:00:00", type: "transcript" },
          { user_id: "9", content: "I'm a transferred colleague", time: "2026-01-01T00:00:05", type: "transcript" },
        ],
      },
      { repUserIds: ["1"] },
    );
    expect(t.utterances.map((u) => u.speaker)).toEqual(["rep", "client"]);
  });

  it("fails loudly on a response with no usable lines", () => {
    expect(() => importDialpad({ call_id: 1, lines: [] })).toThrow(/No transcript lines/);
  });
});

describe("text import", () => {
  const sample = "[00:00:02] Marcus: Hi, is this Dana?\n[00:00:05] Dana: Yes. My number is 415-555-0199.\n[00:00:09] Marcus: Great.";

  it("uses --rep-name to tell the speakers apart, keeps timestamps, redacts", () => {
    const t = importText(sample, { id: "x", repName: "marcus" });
    expect(t.utterances.map((u) => u.speaker)).toEqual(["rep", "client", "rep"]);
    expect(t.utterances[1]!.start).toBe(5);
    expect(t.utterances[1]!.text).toBe("Yes. My number is [PHONE].");
  });

  it("asks for the rep name when it can't tell", () => {
    expect(() => importText(sample, { id: "x" })).toThrow(/--rep-name/);
  });

  it("accepts REP/CLIENT labels without a rep name", () => {
    expect(importText("REP: hi\nCLIENT: hello", { id: "y" }).utterances.map((u) => u.speaker)).toEqual(["rep", "client"]);
  });
});

describe("follow-up text check", () => {
  it("passes a compliant text", () => {
    const c = checkFollowUpText("Thanks for today! Does today at 4 or tomorrow at 10 work better to look at your home options?");
    expect(c.replaced).toBe(false);
    expect(c.violations).toEqual([]);
  });

  it("replaces a text that quotes a rate or uses a banned word", () => {
    for (const bad of ["Great news, you're pre approved! Today at 4 or 5?", "I can lock 6.25% for you. Today at 4 or tomorrow at 10?"]) {
      const c = checkFollowUpText(bad);
      expect(c.replaced).toBe(true);
      expect(c.final).toBe(SAFE_FOLLOW_UP_TEXT);
    }
  });

  it("notes style misses without replacing", () => {
    const c = checkFollowUpText("Following up on your refinance. When works for you?");
    expect(c.replaced).toBe(false);
    expect(c.violations.map((v) => v.rule).sort()).toEqual(["say_home_not_loan", "two_option_close"]);
  });

  it("doesn't flag the company's own name as \"loan\" wording", () => {
    const c = checkFollowUpText("Hi, it's Mike with Copperleaf Home Loans. Does today at 4 or tomorrow at 10 work better to talk about your home options?");
    expect(c.violations).toEqual([]);
    expect(checkFollowUpText("Hi, let's talk about your loan. Does today at 4 or tomorrow at 10 work better?").violations.map((v) => v.rule)).toContain("say_home_not_loan");
  });

  it("allows the opt-out confirmation without a two-option close", () => {
    expect(checkFollowUpText("Understood, we've removed you from our list. Take care.").violations).toEqual([]);
  });
});

describe("post-call review", () => {
  it("reviews an imported call end to end and the report contains no PII", async () => {
    const t = importDialpad(fixture);
    const r = await reviewCall(t, { analyzer: new MockCallAnalyzer() });
    expect(r.slips.length).toBeGreaterThanOrEqual(2); // rate quote + approval promise in call-18
    expect(r.didWell.length).toBe(1);
    expect(r.doBetter.length).toBe(1);
    expect(r.didWell[0]!.speaker).toBe("rep");
    const md = renderReview(r);
    expect(md).toContain("## What you did well");
    expect(md).toContain("## What to do better");
    expect(md).toContain("## Follow-up text");
    expect(md).toContain("approval promise");
    expect(md).not.toMatch(/078-05-1120|555-0142/);
  });
});

describe("Dialpad fetch", () => {
  it("sends the bearer token and rejects non-numeric IDs", async () => {
    process.env.DIALPAD_API_KEY = "test-key";
    let seen: { url: string; auth?: string } | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init?.headers as Record<string, string>).Authorization };
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const json = await fetchDialpadTranscript("9000000001", fakeFetch);
    expect(seen).toEqual({ url: "https://dialpad.com/api/v2/transcripts/9000000001", auth: "Bearer test-key" });
    expect(json.lines?.length).toBe(fixture.lines?.length);
    await expect(fetchDialpadTranscript("../etc", fakeFetch)).rejects.toThrow(/numeric/);
    delete process.env.DIALPAD_API_KEY;
  });
});

describe("text import formats seen in the wild", () => {
  it("accepts Markdown-bold speaker labels", () => {
    const a = importText("**Sales Rep**: Hi there.\n**Customer**: Hello.", { id: "a", repName: "Sales Rep" });
    const b = importText("**Sales Rep:** Hi there.\n**Customer:** Hello.", { id: "b", repName: "Sales Rep" });
    for (const t of [a, b]) {
      expect(t.utterances.map((u) => [u.speaker, u.text])).toEqual([["rep", "Hi there."], ["client", "Hello."]]);
    }
  });

  it("ignores code fences and blank lines", () => {
    const t = importText("```\nSales Rep: One.\n\nCustomer: Two.\n```", { id: "c", repName: "Sales Rep" });
    expect(t.utterances).toHaveLength(2);
  });
});
