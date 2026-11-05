import { describe, expect, it } from "vitest";
import { checkCard, checkCardLine, checkRepSpeech, hasTwoOptionClose } from "../src/pipeline/rules.js";
import { OPT_OUT_CARD, safeFallbackCard } from "../src/pipeline/card.js";

const rules = (text: string) => checkRepSpeech(text).map((v) => v.rule);

describe("rep speech rules", () => {
  it.each([
    ["I can get you 5.875% today.", "rate_quote"],
    ["With 5% down you'd be at 6.5% on a 30-year.", "rate_quote"],
    ["We're at six and a quarter right now.", "rate_quote"],
    ["Rates are around six point five this week.", "rate_quote"],
    ["Your payment would be about 2100 a month.", "rate_quote"],
    ["That's roughly $1,540 a month.", "rate_quote"],
    ["Oh, you're approved, don't even worry about it.", "approval_promise"],
    ["With that score you're basically pre-approved.", "approval_promise"],
    ["You'll definitely qualify.", "approval_promise"],
    ["I guarantee we'll save you money.", "guarantee"],
    ["Honestly your bank is ripping you off.", "bank_disparagement"],
  ])("flags %j as %s", (text, rule) => {
    expect(rules(text)).toContain(rule);
  });

  it.each([
    "You can put as little as 3% down on that program.",
    "Most buyers here put 20 percent down.",
    "I can also offer you a 10% discount on your first purchase.",
    "Rates depend on your full picture, that's exactly what I'd check.",
    "Does today at 4 or tomorrow at 10 work better?",
    "Let's do a 15-minute review.",
    "It's smart to compare; I'll be a second set of eyes for you.",
    "Let's see what you qualify for.",
    "I'll send you the application to get you pre-approved.",
    "You'd need about two years of tax returns.",
  ])("does not flag compliant line %j", (text) => {
    expect(checkRepSpeech(text)).toEqual([]);
  });
});

describe("card rules", () => {
  it("only checks the words the rep will say, not warnings", () => {
    expect(checkCardLine("watchOut", "Don't quote 6% or say you're approved.")).toEqual([]);
    expect(checkCardLine("sendThis", "I can do 6% for you.")[0]?.rule).toBe("rate_quote");
  });

  it("reports missing two-option close and 'loan' wording as style, not block", () => {
    const v = checkCard(
      { read: "x", sendThis: "Happy to look at your loan.", backup: "x", nextStep: "When works for you?", watchOut: "x" },
      "objection",
    );
    expect(v.map((x) => [x.rule, x.severity])).toEqual([
      ["say_home_not_loan", "style"],
      ["two_option_close", "style"],
    ]);
  });

  it("fixed cards are compliant by construction", () => {
    expect(checkCard(OPT_OUT_CARD, "opt_out")).toEqual([]);
    for (const type of ["objection", "question", "buying_signal"] as const) {
      expect(checkCard(safeFallbackCard({ type, evidence: "", utteranceIndex: 0 }), type)).toEqual([]);
    }
  });

  it("blocks the playbook's banned words in cards but not in rep speech", () => {
    expect(checkCardLine("sendThis", "Let's get you pre approved this week.")[0]?.rule).toBe("banned_word");
    expect(checkCardLine("followUp", "Day 2: mention our lowest options.")[0]?.rule).toBe("banned_word");
    // A rep acknowledging the client's existing pre-approval is not a violation.
    expect(checkRepSpeech("So your credit union already pre-approved you, nice.")).toEqual([]);
  });

  it("does not mistake a booking time for a rate (live-run false positive)", () => {
    expect(checkCardLine("nextStep", 'Book a rate review: "Does today at 4 or tomorrow at 10 work better?"')).toEqual([]);
    expect(checkCardLine("sendThis", "Your rate would be 6.25 on that.")[0]?.rule).toBe("rate_quote");
  });

  it("flags 'mortgage' wording and lines over 300 characters as style", () => {
    const long = "x".repeat(301);
    const rules = checkCard(
      { read: "x", sendThis: "About your mortgage options.", backup: long, nextStep: '"Today at 4 or tomorrow at 10?"', followUp: "x", watchOut: "x" },
      "objection",
    ).map((v) => [v.rule, v.severity]);
    expect(rules).toEqual([
      ["say_home_not_loan", "style"],
      ["over_300_chars", "style"],
    ]);
  });

  it("recognizes two-option closes", () => {
    expect(hasTwoOptionClose('Book it: "Does today at 4 or tomorrow at 10 work better?"')).toBe(true);
    expect(hasTwoOptionClose("When works for you?")).toBe(false);
  });
});
