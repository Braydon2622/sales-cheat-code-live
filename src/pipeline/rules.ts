// Deterministic compliance rules. These run in microseconds, so they check
// every streamed line of every card AND every line the rep says. They are
// the first line of defense; the model check (guard.ts) is the second.
import type { Card, CardField, ComplianceViolation, MomentType } from "../types.js";

interface Rule {
  rule: string;
  severity: "block" | "style";
  pattern: RegExp;
}

const NUM_WORD = "(?:two|three|four|five|six|seven|eight|nine|ten)";

/** Things that must never be said to a borrower, by the rep or by a card. */
export const BLOCK_RULES: Rule[] = [
  // "6.5%", "6 percent", "six and a quarter percent". Not "3% down", "20 percent down payment",
  // or "10% off/discount": down-payment and discount percentages aren't rate quotes (found in outside-call testing).
  { rule: "rate_quote", severity: "block", pattern: /\d+(?:\.\d+)?\s*(?:%|percent\b)(?!\s*(?:down|off|discount)\b)/i },
  { rule: "rate_quote", severity: "block", pattern: new RegExp(`\\b${NUM_WORD}(?: and an? (?:half|quarter)| point \\w+)\\b`, "i") },
  // "rate is 6.25" (needs a decimal, so "rate review at 4" doesn't match)
  { rule: "rate_quote", severity: "block", pattern: /\b(?:rate|apr)\b[^.?!]{0,25}\b\d+\.\d+\b/i },
  // "$2,100", "payment would be about 1800"
  { rule: "rate_quote", severity: "block", pattern: /\$\s?\d/ },
  { rule: "rate_quote", severity: "block", pattern: /\bpayment\b[^.?!]{0,30}\b\d{3,}/i },
  {
    rule: "approval_promise",
    severity: "block",
    pattern:
      /\byou(?:'re| are|'ll be| will be)\s+(?:already\s+|basically\s+|definitely\s+|totally\s+|pretty much\s+)?(?:pre-?)?approved\b/i,
  },
  {
    rule: "approval_promise",
    severity: "block",
    pattern: /\b(?:you'll|you will)\s+(?:definitely|easily|for sure|100%|totally)\s+(?:qualify|get approved|be approved)/i,
  },
  { rule: "approval_promise", severity: "block", pattern: /\bno problem (?:getting )?(?:you )?approved\b/i },
  { rule: "guarantee", severity: "block", pattern: /\bguarantee/i },
  { rule: "guarantee", severity: "block", pattern: /\b(?:i'll|i will|we'll|we will) (?:beat|crush)\b/i },
  {
    rule: "bank_disparagement",
    severity: "block",
    pattern:
      /\b(?:banks?|credit unions?|lenders?)\b[^.?!]{0,40}\b(?:rip(?:ping|s)?\b|rip-?off|scam|terrible|awful|screw|gouge|crooks?|predatory|lazy|don't care|clueless)/i,
  },
];

/**
 * The playbook's banned words (from the original Sales Cheat Code prompt). Applied to cards
 * only: a rep may legitimately mention a client's existing pre-approval from
 * their bank, so these would false-alarm on rep speech.
 */
export const CARD_ONLY_RULES: Rule[] = [
  { rule: "banned_word", severity: "block", pattern: /\bpre[- ]?approv\w*/i },
  { rule: "banned_word", severity: "block", pattern: /\blowest\b/i },
];

/** Card fields with words the rep will say or send. READ and WATCH OUT are notes to the rep. */
const SPOKEN_FIELDS: CardField[] = ["sendThis", "backup", "nextStep", "followUp"];
export const MAX_SPOKEN_CHARS = 300;

/** Check text the rep actually said on the call. */
export function checkRepSpeech(text: string): ComplianceViolation[] {
  return matchRules(BLOCK_RULES, text).map((m) => ({ ...m, where: "rep_speech", source: "rules" }));
}

/** Check one card line as it streams in. Only the words the rep will say are checked. */
export function checkCardLine(field: CardField, text: string): ComplianceViolation[] {
  if (!SPOKEN_FIELDS.includes(field)) return [];
  return matchRules([...BLOCK_RULES, ...CARD_ONLY_RULES], text).map((m) => ({ ...m, where: field, source: "rules" }));
}

/** Full-card check: block rules plus playbook style rules. */
export function checkCard(card: Partial<Card>, moment: MomentType): ComplianceViolation[] {
  const out: ComplianceViolation[] = [];
  for (const field of SPOKEN_FIELDS) {
    const text = card[field];
    if (text) out.push(...checkCardLine(field, text));
  }
  // Style: say "home", not "mortgage"/"loan"/"refinance", and stay under 300 characters.
  for (const field of ["sendThis", "backup"] as const) {
    const m = card[field]?.match(/\b(?:mortgages?|loans?|refinanc\w*|refi)\b/i);
    if (m) out.push({ rule: "say_home_not_loan", severity: "style", where: field, quote: m[0], source: "rules" });
    const text = card[field];
    if (text && text.length > MAX_SPOKEN_CHARS) {
      out.push({ rule: "over_300_chars", severity: "style", where: field, quote: `${text.length} chars`, source: "rules" });
    }
  }
  // Style: booking moments should end in a two-option close ("A or B?").
  if (moment !== "opt_out" && card.nextStep && !hasTwoOptionClose(card.nextStep)) {
    out.push({ rule: "two_option_close", severity: "style", where: "nextStep", quote: card.nextStep, source: "rules" });
  }
  return out;
}

export function hasTwoOptionClose(text: string): boolean {
  return /\bor\b[^?]*\?/i.test(text);
}

function matchRules(rules: Rule[], text: string): Array<Pick<ComplianceViolation, "rule" | "severity" | "quote">> {
  const hits: Array<Pick<ComplianceViolation, "rule" | "severity" | "quote">> = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const m = text.match(r.pattern);
    if (m && !seen.has(r.rule)) {
      seen.add(r.rule);
      hits.push({ rule: r.rule, severity: r.severity, quote: m[0] });
    }
  }
  return hits;
}
