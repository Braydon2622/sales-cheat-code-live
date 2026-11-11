// npm run live  →  http://127.0.0.1:4311
// Browser view of a live replay (for demos and the portfolio video).
// LIVE_MAX_USD caps live AI spend per server session (default $0.25, about 10 replays).
import { config, hasApiKey } from "../config.js";
import { createLiveServer } from "../live/server.js";
import { makeComponents } from "../pipeline/factory.js";

const port = Number(process.env.PORT ?? 4311);
const maxUsd = Number(process.env.LIVE_MAX_USD ?? 0.25);
const liveAvailable = hasApiKey();

const server = createLiveServer({
  callDirs: ["data/calls", "data/holdout"],
  publicDir: "src/live/public",
  components: (mock) => makeComponents(mock),
  liveAvailable,
  maxUsd,
  models: { detector: config.detectorModel, coach: config.coachModel, guard: config.guardModel },
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  Sales Call Cheat Code: live replay view`);
  console.log(`  Open http://127.0.0.1:${port} in your browser\n`);
  console.log(`  AI: ${liveAvailable ? `live (about 2 cents per replay; cap $${maxUsd.toFixed(2)} this session)` : "no ANTHROPIC_API_KEY found: mock mode only"}`);
  console.log(`  Only the bundled synthetic calls can be replayed. Ctrl+C to stop.\n`);
});
