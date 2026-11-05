# Coach model comparison: `claude-opus-5-5` vs `claude-sonnet-5-5`

Same 20 synthetic calls, same detector (`claude:claude-haiku-5-5`) and guard (`claude:claude-haiku-5-5`); only the coach differs.
Runs: 2026-11-05T16:46:10.760Z (claude:claude-opus-5-5@low) and 2026-11-05T16:52:48.609Z (claude:claude-sonnet-5-5@low).

| Metric | claude-opus-5-5 | claude-sonnet-5-5 | Better |
|---|---|---|---|
| **Latency** | | | |
| Coach first token, p50 | 3980 ms | 3081 ms | claude-sonnet-5-5 |
| Coach first token, p95 | 6939 ms | 6325 ms | claude-sonnet-5-5 |
| First card line on screen, p50 | 4264 ms | 3394 ms | claude-sonnet-5-5 |
| First card line on screen, p95 | 7131 ms | 6662 ms | claude-sonnet-5-5 |
| Full card, p50 | 5763 ms | 4928 ms | claude-sonnet-5-5 |
| Full card, p95 | 8801 ms | 8159 ms | claude-sonnet-5-5 |
| Cards on screen within 1.5 s | 0% | 0% | – |
| **Quality (proxies)** | | | |
| Drafts shown as written | 95% | 96% | claude-sonnet-5-5 |
| Drafts stopped by compliance guard | 5% | 4% | claude-sonnet-5-5 |
| Coach errors / incomplete cards | 0% | 0% | – |
| Two-option close used | 97% | 92% | claude-opus-5-5 |
| Said "home" not "loan" | 92% | 96% | claude-sonnet-5-5 |
| Non-compliant cards reaching rep | 0 | 0 | – |
| **Cost** | | | |
| Coach output tokens per card (incl. thinking) | 257 | 197 | claude-sonnet-5-5 |
| Coach cost per card | $0.0065 | $0.0028 | claude-sonnet-5-5 |
| Total cost per call (all stages) | $0.0279 | $0.0126 | claude-sonnet-5-5 |

Detection is the same model in both runs; small differences between runs show run-to-run variance: precision/recall 58%/95% vs 59%/95%. Cards drafted: 82 vs 81.

**About "quality":** these are playbook-adherence proxies, not a judgment of how persuasive a card is. A real quality score needs a sales manager's 1–5 ratings on a sample of cards (and an AI judge calibrated against them), which is the next eval step. Read both reports' sample cards before choosing.
