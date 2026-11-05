// Card parsing and the fixed (non-AI) cards.
import { CARD_FIELDS, type Card, type CardField, type DetectedMoment } from "../types.js";

const LABELS: Record<string, CardField> = {
  "READ": "read",
  "SEND THIS": "sendThis",
  "BACKUP": "backup",
  "NEXT STEP": "nextStep",
  "FOLLOW UP": "followUp",
  "WATCH OUT": "watchOut",
};
const LABEL_OF = Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [v, k])) as Record<CardField, string>;

/** Parse one "LABEL: text" line. Returns null for anything else. */
export function parseCardLine(line: string): { field: CardField; text: string } | null {
  const m = line.trim().match(/^\**\s*(READ|SEND THIS|BACKUP|NEXT STEP|FOLLOW UP|WATCH OUT)\s*\**\s*:\s*\**\s*(.*)$/i);
  if (!m) return null;
  const field = LABELS[m[1]!.toUpperCase()];
  return field ? { field, text: m[2]!.trim() } : null;
}

export function parseCard(text: string): Partial<Card> {
  const card: Partial<Card> = {};
  for (const line of text.split("\n")) {
    const parsed = parseCardLine(line);
    if (parsed) card[parsed.field] = parsed.text;
  }
  return card;
}

/**
 * Opt-outs never go through the AI coach: the right move is always the same,
 * and it's legally sensitive. A fixed card is instant and can't go wrong.
 */
export const OPT_OUT_CARD: Card = {
  read: "Borrower opted out. Honor it now. Temperature: Cold. Stage: Contacted.",
  sendThis: "Understood, I'm sorry for the bother. I'll take you off our list right now.",
  backup: "You won't hear from us again. Have a good day.",
  nextStep: "End the call politely and mark them Do Not Contact.",
  followUp: "None. They are Do Not Contact.",
  watchOut: "No pitch, no 'before you go', no close.",
};

/** Shown when a drafted card is blocked by the guard or the coach fails. Safe by construction. */
export function safeFallbackCard(moment: DetectedMoment): Card {
  const base: Card = {
    read: "Slow down; acknowledge before anything else.",
    sendThis: "That makes sense. Can I ask a couple of quick questions so I give you a real answer?",
    backup: "What matters most to you in this decision?",
    nextStep: 'Book a short review: "Does today at 4 or tomorrow at 10 work better?"',
    followUp: "If no time is booked: text same day, then day 2, day 4, day 7, then every 2 weeks.",
    watchOut: "No rates, payments, or approval promises.",
  };
  if (moment.type === "question") {
    base.sendThis = "Great question. The honest answer depends on your full picture, and that's exactly what I'd check for you.";
  }
  return base;
}

/** Render a card in the coach's line format. Missing fields are skipped (older logged cards have no FOLLOW UP). */
export function formatCard(card: Partial<Card>): string {
  return CARD_FIELDS.filter((f) => card[f] !== undefined)
    .map((f) => `${LABEL_OF[f]}: ${card[f]}`)
    .join("\n");
}
