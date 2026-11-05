# Should the chip use a lower confidence threshold than the card?

_Offline analysis, $0, 2026-11-05. Data: `reports/cards-claude-sonnet-5-5-speculative.json` (20 dev calls, live run with the moment threshold at 0.6) and `reports/cards-claude-sonnet-5-5-speculative-holdout.json` (25 held-out calls, threshold 0.75)._

## The question

The held-out run (threshold 0.75) showed a slower chip than the dev run (threshold 0.6): p50 0.97 s vs 0.20 s after speech end. The working theory was that the stricter threshold holds back less-confident detections made mid-sentence. If that's true, a lower threshold *only for the chip* ("moment detected") would buy back speed while the card keeps the stricter bar.

## What the data says

The dev run fired every moment at confidence 0.6 or higher and logged each card's confidence and timing. Splitting those cards shows what a 0.75 policy would have done on **the same calls**:

| Dev calls, live run at 0.6 | Cards | Real moments | False alarms | Started mid-sentence | Chip p50 / p95 | Chips within 1.5 s | First card line p50 / p95 |
|---|---|---|---|---|---|---|---|
| All cards (fired at ≥ 0.6) | 67 | 43 | 24 | 37 | 0.20 s / 1.86 s | 91% | 1.58 s / 3.38 s |
| Confidence ≥ 0.75 (would fire at 0.75) | 53 | 39 | 14 | 31 | **0.16 s / 1.62 s** | 94% | **1.45 s / 2.97 s** |
| Confidence 0.6–0.75 (chip-only under a split) | 14 | **4** | **10** | 6 | 0.83 s / 3.76 s | 79% | 1.95 s / 6.73 s |

(The ≥ 0.75 row is exact for those lines: the detection that fired them also clears 0.75. The one approximation is cooldown. With the 0.6–0.75 cards gone, a later repeat of the same objection could fire instead, but this happens rarely.)

## Conclusions

1. **Don't add a lower chip threshold.** The extra chips it would show are mostly false alarms (10 of 14) *and* slower than the confident ones. A rep would see more "moment detected" flashes that lead nowhere, and gain no speed.
2. **The 0.75 threshold did not cause the slower held-out latency.** On the same calls, the stricter threshold makes the chip and card *faster*, because the confident detections are the early, clear ones. The earlier write-up blamed the threshold; that was wrong and has been corrected in the README and STATUS.
3. **The held-out slowdown is unexplained so far.** Only 38% of held-out cards started mid-sentence (dev: 58% of the ≥ 0.75 cards). The held-out chip p50 (0.97 s) is close to the detector's round trip on finished lines (1.07 s), so most held-out chips waited for the client to finish. Things checked and ruled out:
   - Line length: median 15 words held-out vs 14 dev.
   - Where the trigger words appear: 17% of the way into the line in both sets.

   The likely remaining causes are lower detector confidence on held-out *partials* (sub-threshold detections weren't logged), or API latency differing between the two runs. Neither can be checked from the saved data.

## Was it drift between runs?

The two live runs were 18 minutes apart. Their aggregate stats argue against API drift explaining the chip gap:

| | Dev run (17:22 UTC) | Held-out run (17:40 UTC) |
|---|---|---|
| Detector round trip on finished lines, p50 | 1154 ms | 1071 ms (faster) |
| Coach first token, p50 / p95 | 947 / 2803 ms | 1041 / 3737 ms |
| Prompt-cache hit rate, detector / coach | 83% / 86% | 84% / 86% |

Cache behaviour was identical, and the detector was *faster* during the held-out run. The coach's slow tail drifted (+0.9 s at p95), which plausibly explains part of the slower p95 for the first card line, but not a 0.77 s slower *median chip*. These are run-level aggregates, though, not a controlled test. The next live run records per-request timing, cache tokens, and 1-token baseline pings at the start and end, which settles it.

## What changed

The eval now records, for the next live run:
- **Every detector answer** with confidence and timing relative to speech end (`reports/detections-<run>.json`), including answers below the threshold. That makes threshold questions answerable exactly offline.
- **Every API request**, timed: issued, accepted, first token, and done, with cache read/write tokens. The report's new "Run conditions" section shows these per stage.
- **Baseline pings** (three 1-token requests per model) at the start and end of each run.
- **A breakdown of each chip:** time until the detector request was sent, the detector's API time, and local overhead.

If the held-out slowdown matches the ping and API drift, that's the answer. If the APIs look the same and fewer partials fired, it's the data.
