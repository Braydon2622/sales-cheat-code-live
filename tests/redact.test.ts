import { describe, expect, it } from "vitest";
import { redact } from "../src/privacy/redact.js";
import { checkRepSpeech } from "../src/pipeline/rules.js";

describe("PII redaction", () => {
  it.each([
    ["My social is 123-45-6789.", "My social is [SSN].", "SSN"],
    ["It's 123 45 6789", "It's [SSN]", "SSN"],
    ["Card is 4111 1111 1111 1111 if you need it", "Card is [CARD] if you need it", "CARD"],
    ["Call me at (415) 555-6666.", "Call me at [PHONE].", "PHONE"],
    ["or 415-555-6666", "or [PHONE]", "PHONE"],
    ["email jane.doe+home@example.com", "email [EMAIL]", "EMAIL"],
    ["Born 03/14/1985", "Born [DOB]", "DOB"],
    ["DOB is March 14th, 1985", "DOB is [DOB]", "DOB"],
    ["We live at 1234 Maple Street now", "We live at [ADDRESS] now", "ADDRESS"],
    ["Loan number 0045812673", "Loan number [NUMBER]", "NUMBER"],
    ["routing is 1210 0035 8", "routing is [NUMBER]", "NUMBER"],
    ["it's five five five one two three four", "it's [NUMBER]", "NUMBER"],
  ])("redacts %j", (input, expected, label) => {
    const r = redact(input);
    expect(r.text).toBe(expected);
    expect(r.counts[label]).toBe(1);
  });

  it.each([
    "I can get you 5.875% today.",
    "Your payment would be about $1,540 a month.",
    "We're looking at houses around $350,000.",
    "My score is 680 and I have 5 percent down.",
    "Does today at 4 or tomorrow at 10 work better?",
    "We want to close by 12/15/2026.",
    "We bought it in 2019 for about 280 thousand.",
    "Card ending in 4242.",
  ])("keeps non-PII numbers the compliance checks need: %j", (input) => {
    expect(redact(input).text).toBe(input);
  });

  it("a non-Luhn 16-digit run is still removed as a long number", () => {
    expect(redact("ref 1234 5678 9012 3456").text).toBe("ref [NUMBER]");
  });

  it("rep rate quotes still trip the compliance rules after redaction", () => {
    const line = "With 680 you're approved, and I can do 6.25% on the loan, my cell is 415-555-6666.";
    const r = redact(line);
    expect(r.text).not.toContain("555-6666");
    expect(checkRepSpeech(r.text).map((v) => v.rule)).toEqual(expect.arrayContaining(["rate_quote", "approval_promise"]));
  });
});
