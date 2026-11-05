# Sales Cheat Code Live: results

**What it is.** It's a real-time AI coach for mortgage loan officers. While a loan officer is on a sales call, it listens for the moments that matter, such as a "your rates are too high" objection, a client ready to move, a tricky question, or a request to stop calling. A short card then appears on screen telling the rep what's going on, what to say next, and what to avoid. Every suggestion passes compliance checks first, and it also catches the rep's own slips, like quoting a rate or promising approval.

**Where it stands.** It works end to end on **45 synthetic role-play calls**, replayed as if they were live. The team pilot with real calls comes next, after company approval. All numbers below were measured on November 5, 2026, not estimated.

## Speed: how fast help appears

Measured from the moment the client stops talking. The target is **1.5 seconds**.

| | Before (one step at a time) | After |
|---|---|---|
| "Moment detected" signal, typical | none | **0.2 s** |
| Coaching card on screen, typical | 3.8 s | **1.6 s** |
| Coaching card on screen, slowest 1 in 20 | 6.1 s | **3.4 s** |
| Cards that beat the 1.5 s target | 0% | **46%** |
| Cards that appeared *before the client finished talking* | 0 | **37 of 67** |

**How:** I measured before changing anything. Each request to the AI spent about 0.8 s just on the network, and the first version made two requests in a row, so no model swap could ever hit 1.5 s. The fix was to change the design, not the model:
- **Work in parallel:** the coach starts writing at the same time as the detector, instead of waiting for it.
- **Start early:** listen to the words as they're spoken, rather than waiting for the sentence to end.
- **Signal first:** show a "moment detected" signal instantly, before the card text arrives.

Starting the coach early on every line could have been expensive. It isn't, because the unused work is cancelled the moment the detector says there's nothing to coach: the cost per call rose from $0.020 to $0.021.

## Accuracy: does it fire at the right moments?

Tested on **25 held-out calls** written *after* all tuning was finished. The settings were frozen before these calls were ever run, so the numbers aren't inflated by tuning on the test.

| | Keyword matching (baseline) | First AI version | Current version |
|---|---|---|---|
| Real moments it caught (recall) | 36% | 95%* | **92%** |
| Alerts that were real moments (precision) | 62% | 58%* | **79%** |

\* measured on the 20 original calls.

The fix for false alarms was a confidence cutoff, plus not repeating the same objection alert within a few lines. Every false alarm interrupts a rep mid-call.

## Compliance

- **Zero non-compliant suggestions reached the rep** across about 400 cards in testing. Fixed rules check every line *before* it appears, so a rate quote is cut off mid-sentence and replaced with a safe card. A second AI check reviews each finished card.
- **Every rep slip was caught** in testing (18 of 18 on the held-out calls), including numbers spoken as words ("six and an eighth"), which simple rules miss.
- Opt-out requests never go through the AI. They get an instant, fixed "honor it and mark Do Not Contact" card.

## Cost

About **2 cents per call**: a fast, cheap model screens every line, and a stronger one writes cards only when a real moment fires. The whole build-and-evaluate effort, including every test run, cost about $2.21 in AI usage.

## Known limitations

- **Synthetic calls only.** They were written and labeled for this project, and they're cleaner than real calls. The real test is the pilot.
- **Small test set.** There are 77 labeled moments in the held-out calls, so treat the percentages as directional.
- **Speed on the held-out calls was slower** (card 1.8 s typical) than on the original calls. I first blamed the confidence cutoff, checked, and that was wrong. The cause is still open, and the next run logs the data to find it.
- **Speech-to-text was simulated.** Real transcription adds a few hundred milliseconds and some wrong words. That gets measured in the next phase.
- **Card quality isn't scored by a human yet.** The app now collects my 1–5 rating on every coaching card; once there are enough, they'll be used to check an AI judge.

_Details: [`README.md`](../README.md) (architecture, how to run) and the full eval reports in this folder._
