// npm run app  →  http://127.0.0.1:4310
// Local only. REVIEW_MAX_USD caps live AI spend per app session (default $1).
import { config, hasApiKey } from "../config.js";
import { createApp } from "../app/server.js";
import { ClaudeCallAnalyzer } from "../pipeline/claude.js";
import { makeComponents } from "../pipeline/factory.js";
import { MockCallAnalyzer } from "../pipeline/mock.js";

const port = Number(process.env.PORT ?? 4310);
const maxUsd = Number(process.env.REVIEW_MAX_USD ?? 1);
const liveAvailable = hasApiKey();

const server = createApp({
  reviewsDir: "reports/reviews",
  privateDir: "data/private",
  samplesDir: "samples",
  publicDir: "src/app/public",
  liveAvailable,
  maxUsd,
  models: { detector: config.detectorModel, coach: config.coachModel, guard: config.guardModel },
  components: (mock) => ({ ...makeComponents(mock), analyzer: mock ? new MockCallAnalyzer() : new ClaudeCallAnalyzer(config.coachModel) }),
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  Sales Cheat Code Live: call review`);
  console.log(`  Open http://127.0.0.1:${port} in your browser\n`);
  console.log(`  AI: ${liveAvailable ? `live (spend cap $${maxUsd.toFixed(2)} this session)` : "no ANTHROPIC_API_KEY found: mock mode only"}`);
  console.log(`  Dialpad API: ${process.env.DIALPAD_API_KEY ? "key found" : "no DIALPAD_API_KEY (file upload only)"}`);
  console.log(`  Reviews are saved in reports/reviews/ (gitignored). Ctrl+C to stop.\n`);
});
