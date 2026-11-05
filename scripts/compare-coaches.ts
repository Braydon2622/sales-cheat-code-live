// Side-by-side comparison of two live eval runs that differ only in the coach model.
//   npm run compare -- claude-opus-5-5 claude-sonnet-5-5
// Reads reports/summary-<model>.json (written by `npm run eval -- --coach-model <model>`)
// and writes reports/coach-comparison.md.
import { readFileSync, writeFileSync } from "node:fs";

type Summary = Record<string, any>;
const [a = "claude-opus-5-5", b = "claude-sonnet-5-5"] = process.argv.slice(2);
const load = (m: string): Summary => JSON.parse(readFileSync(`reports/summary-${m}.json`, "utf8"));
const A = load(a);
const B = load(b);

const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)} ms` : "–");
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "–");
const num = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "–");

/** Each row: label, formatter, getter, and whether lower is better (for the "better" column). */
const rows: Array<[string, (x: number) => string, (s: Summary) => number, "lower" | "higher" | "none"]> = [
  ["**Latency**", () => "", () => NaN, "none"],
  ["Coach first token, p50", ms, (s) => s.latencyMs.firstTokenP50, "lower"],
  ["Coach first token, p95", ms, (s) => s.latencyMs.firstTokenP95, "lower"],
  ["First card line on screen, p50", ms, (s) => s.latencyMs.firstLineP50, "lower"],
  ["First card line on screen, p95", ms, (s) => s.latencyMs.firstLineP95, "lower"],
  ["Full card, p50", ms, (s) => s.latencyMs.fullCardP50, "lower"],
  ["Full card, p95", ms, (s) => s.latencyMs.fullCardP95, "lower"],
  ["Cards on screen within 1.5 s", pct, (s) => s.latencyMs.withinBudgetRate, "higher"],
  ["**Quality (proxies)**", () => "", () => NaN, "none"],
  ["Drafts shown as written", pct, (s) => s.coachQuality.shownAsDraftedRate, "higher"],
  ["Drafts stopped by compliance guard", pct, (s) => s.coachQuality.stoppedByGuardRate, "lower"],
  ["Coach errors / incomplete cards", pct, (s) => s.coachQuality.coachErrorRate, "lower"],
  ["Two-option close used", pct, (s) => s.coachQuality.twoOptionCloseRate, "higher"],
  ['Said "home" not "loan"', pct, (s) => s.coachQuality.homeNotLoanRate, "higher"],
  ["Non-compliant cards reaching rep", num, (s) => s.cards.shownWithViolations, "lower"],
  ["**Cost**", () => "", () => NaN, "none"],
  ["Coach output tokens per card (incl. thinking)", num, (s) => s.coachQuality.outputTokensPerCard, "lower"],
  ["Coach cost per card", usd, (s) => s.costUsd.coach / Math.max(1, s.coachQuality.cardsDrafted), "lower"],
  ["Total cost per call (all stages)", usd, (s) => s.costUsd.perCall, "lower"],
];

const md: string[] = [
  `# Coach model comparison: \`${a}\` vs \`${b}\``,
  "",
  `Same 20 synthetic calls, same detector (\`${A.models.detector}\`) and guard (\`${A.models.guard}\`); only the coach differs.`,
  `Runs: ${A.startedAt} (${A.models.coach}) and ${B.startedAt} (${B.models.coach}).`,
  "",
  `| Metric | ${a} | ${b} | Better |`,
  `|---|---|---|---|`,
];
for (const [label, fmt, get, dir] of rows) {
  if (dir === "none") {
    md.push(`| ${label} | | | |`);
    continue;
  }
  const va = get(A), vb = get(B);
  const better = !Number.isFinite(va) || !Number.isFinite(vb) || va === vb ? "–" : (dir === "lower" ? va < vb : va > vb) ? a : b;
  md.push(`| ${label} | ${fmt(va)} | ${fmt(vb)} | ${better} |`);
}
md.push(
  "",
  `Detection is the same model in both runs; small differences between runs show run-to-run variance: precision/recall ${pct(A.detection.precision)}/${pct(A.detection.recall)} vs ${pct(B.detection.precision)}/${pct(B.detection.recall)}. Cards drafted: ${A.coachQuality.cardsDrafted} vs ${B.coachQuality.cardsDrafted}.`,
  "",
  `**About "quality":** these are playbook-adherence proxies, not a judgment of how persuasive a card is. A real quality score needs a sales manager's 1–5 ratings on a sample of cards (and an AI judge calibrated against them), which is the next eval step. Read both reports' sample cards before choosing.`,
  "",
);
writeFileSync("reports/coach-comparison.md", md.join("\n"));
console.log(md.join("\n"));
console.log("Wrote reports/coach-comparison.md");
