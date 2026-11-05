// PII redaction: runs on every imported transcript line BEFORE the text reaches
// an AI model, a report, or disk. Deterministic and testable.
//
// What it removes: Social Security numbers, card numbers, account/loan/routing
// numbers (any long digit run, written or spoken), phone numbers, emails,
// birth dates, and street addresses.
// What it deliberately keeps: rates, payments, and loan amounts ("6.5%",
// "$1,540", "$350,000"). The compliance checks need those to catch a rep quoting a rate.
// Known gaps (documented in the README): personal names, and numbers split
// across two transcript lines.

export interface Redaction {
  text: string;
  counts: Record<string, number>;
}

const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";

/** Order matters: the most specific patterns run first. */
const RULES: Array<{ label: string; pattern: RegExp; test?: (match: string) => boolean }> = [
  { label: "EMAIL", pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  // 13–19 digit card numbers, with optional spaces or dashes, checked with Luhn.
  { label: "CARD", pattern: /\b\d(?:[ -]?\d){12,18}\b/g, test: (m) => luhn(m.replace(/\D/g, "")) },
  // SSN: 123-45-6789 / 123 45 6789 / 123456789
  { label: "SSN", pattern: /\b\d{3}([- ]?)\d{2}\1\d{4}\b/g },
  // Phone: (415) 555-6666, 415-555-6666, 415.555.6666, +1 415 555 6666
  { label: "PHONE", pattern: /(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/g },
  // Birth dates: numeric dates with a year 1900–2012 (closing dates are in the future, so they're kept).
  { label: "DOB", pattern: /\b\d{1,2}[/-]\d{1,2}[/-](?:19\d{2}|20(?:0\d|1[0-2]))\b/g },
  { label: "DOB", pattern: /\b(?:19\d{2}|20(?:0\d|1[0-2]))-\d{2}-\d{2}\b/g },
  {
    label: "DOB",
    pattern: /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? (?:19\d{2}|20(?:0\d|1[0-2]))\b/gi,
  },
  // Street addresses: "1234 Maple Street"
  {
    label: "ADDRESS",
    pattern: /\b\d{1,6} (?:[A-Z][a-z]+ ){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Way|Place|Pl|Circle|Cir|Terrace|Ter)\b\.?/g,
  },
  // Any other run of 7+ digits (account, loan, routing, policy numbers), allowing spaces/dashes.
  { label: "NUMBER", pattern: /\b\d(?:[ -]?\d){6,}\b/g },
  // The same, spoken digit by digit: "five five five one two three four".
  { label: "NUMBER", pattern: new RegExp(`\\b${DIGIT_WORD}(?:[ ,-]+${DIGIT_WORD}){5,}\\b`, "gi") },
];

export function redact(text: string): Redaction {
  const counts: Record<string, number> = {};
  let out = text;
  for (const { label, pattern, test } of RULES) {
    out = out.replace(pattern, (match) => {
      if (test && !test(match)) return match;
      counts[label] = (counts[label] ?? 0) + 1;
      return `[${label}]`;
    });
  }
  return { text: out, counts };
}

export function mergeCounts(into: Record<string, number>, add: Record<string, number>): void {
  for (const [k, v] of Object.entries(add)) into[k] = (into[k] ?? 0) + v;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
