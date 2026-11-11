# Eval report: Sales Call Cheat Code

- **Run:** 2026-11-05T17:40:53.383Z · set `holdout` · 25 synthetic calls · 521 utterances
- **Pipeline:** speculative + interim partials · replay 10x (client speech in real time, gaps and rep lines compressed)
- **Models:** detector `claude:claude-haiku-5-5` · coach `claude:claude-sonnet-5-5@low` · guard `claude:claude-haiku-5-5`
- **Moment policy:** confidence ≥ 0.75, cooldown {"objection":10,"opt_out":∞} lines

## Headline

| Metric | Result |
|---|---|
| Moment detection precision / recall | 79% / 92% |
| Rep compliance slips caught | 18 of 18 (3 false alarms) |
| Non-compliant suggestions that reached the rep | 0 of 69 cards (rules re-check) |
| "Moment detected" chip, from speech end, p50 / p95 | 970 ms / 2217 ms |
| First card line on screen, from speech end, p50 / p95 | 1780 ms / 4100 ms |
| Cards on screen within 1.5 s of speech end | 35% |
| Cost per call | $0.0177 |

## 1. Moment detection

A detection counts when it lands on the same line as a hand label with the same type. Scored on what the pipeline actually fired (after the confidence threshold and cooldown).

| Type | Pipeline P / R | Keyword baseline P / R |
|---|---|---|
| objection | 81% / 95% (21 tp, 5 fp, 1 fn) | 50% / 55% (12 tp, 12 fp, 10 fn) |
| buying_signal | 57% / 100% (13 tp, 10 fp, 0 fn) | 67% / 46% (6 tp, 3 fp, 7 fn) |
| question | 94% / 76% (16 tp, 1 fp, 5 fn) | 100% / 10% (2 tp, 0 fp, 19 fn) |
| opt_out | 100% / 100% (3 tp, 0 fp, 0 fn) | 60% / 100% (3 tp, 2 fp, 0 fn) |
| rep_violation | 86% / 100% (18 tp, 3 fp, 0 fn) | 100% / 28% (5 tp, 0 fp, 13 fn) |
| **all** | **79% / 92% (71 tp, 19 fp, 6 fn)** | 62% / 36% (28 tp, 17 fp, 49 fn) |

Subtype accuracy on correct objection / rep-violation hits: 97% (keyword baseline: 100%).

### Threshold and cooldown sweep

Same raw detector output, filtered offline with each policy. No extra API calls.

| Policy | Precision | Recall | F1 | Fired |
|---|---|---|---|---|
| no filter | 51% | 95% | 67% | 142 |
| cooldown only | 61% | 91% | 73% | 114 |
| cooldown + confidence ≥ 0.5 | 63% | 91% | 74% | 112 |
| cooldown + confidence ≥ 0.6 | 72% | 92% | 81% | 99 |
| cooldown + confidence ≥ 0.75 (pipeline default) | 79% | 92% | 85% | 90 |
| cooldown + confidence ≥ 0.9 | 86% | 62% | 72% | 56 |

## 2. Compliance

**Rep's own speech** (18 labeled slips):

| Layer | Caught |
|---|---|
| Deterministic rules | 5 / 18 |
| Model detector | 18 / 18 |
| Either (what the rep sees) | 18 / 18 |
| False alarms on clean rep lines | 3 |

**AI suggestions** (69 cards: 66 coached, 3 fixed opt-out cards):

| Outcome | Cards |
|---|---|
| Shown as drafted | 65 |
| Draft blocked mid-stream by rules, safe card shown | 1 |
| Draft retracted by model guard, safe card shown | 0 |
| Coach error, safe card shown | 0 |
| Shown cards with a blocking violation (rules re-check) | 0 |

Playbook style on drafted cards shown: two-option close 65/65, said "home" not "loan" 62/65.

Drafts the guard stopped:

- holdout-05 · buying_signal: approval_promise (rules): "you'll definitely qualify"

## 3. Latency

On 66 coached cards. **From speech end** = from the moment the client stopped talking (negative means the card arrived before they finished). **From first partial** = from the first interim transcript of that line, roughly when the client started the sentence. Card lines appear only once each is complete and has passed the rules.

| Stage | From speech end, p50 | p95 | From first partial, p50 | p95 |
|---|---|---|---|---|
| "Moment detected" chip | 970 ms | 2217 ms | 4578 ms | 10786 ms |
| Coach first token | 1041 ms | 3737 ms | 5016 ms | 10245 ms |
| First card line on screen | 1780 ms | 4100 ms | 5890 ms | 11020 ms |
| Full card | 4273 ms | 7210 ms | 8440 ms | 13440 ms |
| Model guard cleared | 5635 ms | 9137 ms | 9956 ms | 15265 ms |

Within 1.5 s of speech end: chip 77%, first card line 35%. Detector round trip on final lines: p50 1071 ms, p95 3029 ms.

**How cards got started:** 25 of 66 from an interim partial (before the client finished). On final lines, the coach was started speculatively 243 times: 52 used, 191 cancelled because the detector found no moment, 0 where the coach guessed "no moment" but the detector disagreed (re-asked).

## 4. Cost

| Model | Calls | Input | Cache write | Cache read | Output | USD |
|---|---|---|---|---|---|---|
| `claude-haiku-5-5` | 1110 | 254170 | 0 | 1361000 | 25247 | $0.0517 |
| `claude-sonnet-5-5` | 132 | 38132 | 0 | 242880 | 26630 | $0.3911 |
| **Total** | | | | | | **$0.4428** |

Per call: $0.0177 · per card: $0.0067. Cancelled speculative requests are included; their output tokens are estimated from the text received before cancelling.

## 5. Detection errors (first 25)

- holdout-02 #15 · false alarm objection:just_shopping · "Okay. I mean, I'm really just browsing for now, though."
- holdout-05 #16 · false alarm rep_violation:approval_promise · "Your pension award letter, a couple of bank statements, and your mortgage statement to start."
- holdout-05 #17 · false alarm buying_signal · "I have all of that in a folder somewhere. I'm very organized, my late husband used to tease me about it."
- holdout-07 #15 · false alarm objection:just_shopping · "I can. I'm still just comparing, though. Not committing to anybody."
- holdout-09 #16 · false alarm rep_violation:rate_quote · "That's fair, and you'd only pay interest on what you use. Are you and your wife both on the title?"
- holdout-10 #14 · false alarm rep_violation:other · "None taken at all. Good luck with the move, Shauna."
- holdout-11 #17 · false alarm buying_signal · "Will do. Once we're under contract, how long until we can close?"
- holdout-11 #17 · missed question · "Will do. Once we're under contract, how long until we can close?"
- holdout-14 #23 · false alarm buying_signal · "Okay. I can get those together this weekend."
- holdout-15 #5 · missed objection:spouse · "Yeah, definitely. Honestly she makes more than me, so I can't really go much further without her."
- holdout-15 #15 · false alarm objection:spouse · "Okay. But yeah, she's going to want to be part of that. She's the spreadsheet person."
- holdout-16 #9 · false alarm question · "You guarantee it? How can you know that already?"
- holdout-16 #17 · false alarm objection:bank_loyalty · "Okay. Honestly I'm still leaning toward the credit union. They know me."
- holdout-17 #3 · false alarm buying_signal · "We found a townhouse yesterday and our agent says offers are due Sunday at noon. We need a pre-approval letter."
- holdout-17 #15 · false alarm buying_signal · "Got it. And if they accept, how quickly can we close?"
- holdout-17 #15 · missed question · "Got it. And if they accept, how quickly can we close?"
- holdout-19 #8 · subtype rep_violation:rate_quote, expected rep_violation:other · "I hear you, Dale. Just one quick thing, rates are down to around five and three-quarters for people like you."
- holdout-21 #1 · false alarm buying_signal · "Hi Colby, yes. Thanks for getting back to me. My ARM resets in February and I want out."
- holdout-21 #13 · false alarm buying_signal · "Okay. That's close to what I pay now before the reset. How fast can we close?"
- holdout-21 #13 · missed question · "Okay. That's close to what I pay now before the reset. How fast can we close?"
- holdout-21 #17 · false alarm buying_signal · "I'll have those to you tomorrow morning."
- holdout-24 #17 · false alarm objection:bank_loyalty · "Will do. Though like I said, I'll probably just go with them."
- holdout-25 #9 · missed question · "Right here. Does it matter that I write off a lot of expenses? My accountant is very aggressive."
- holdout-25 #13 · false alarm buying_signal · "I have all of that. How long does the whole thing usually take, start to finish?"
- holdout-25 #13 · missed question · "I have all of that. How long does the whole thing usually take, start to finish?"

## Sample cards

**holdout-01 · objection:rate_too_high** (trigger: "rates are still way too high to bother", from partial)
```
READ: Pain is real, but "barely any better" tells me they're guessing from ads, not their own numbers. Distracted, making dinner. Temperature: Warm. Stage: Contacted.
SEND THIS: You're right to be skeptical, those ads aren't about your home. Whether it makes sense depends on your numbers, not the headlines. I can look at yours in a few minutes, no obligation, and tell you straight if it's worth it.
BACKUP: Makes sense, and I'd never push you into something that doesn't help. Want me to take a quick look at your numbers so you're not guessing off ads?
NEXT STEP: Let them finish, then offer a short review at a better time: "Does today at 6:30 or tomorrow at noon work better for a 10-minute look?"
FOLLOW UP: If not booked, text same day, "home options" wording only, with the two times. Day 2: share that waiting could cost them more if their situation changes. Then day 4, day 7, every 2 weeks.
WATCH OUT: Don't quote or hint at a rate or savings. Don't argue that rates are fine. Confirm the loan is a 30-year fixed bought late 2023 and get a better time to talk since they're cooking.
```
**holdout-01 · question** (trigger: "What would the closing costs be on something like that", from final)
```
READ: The rep quoted a rate and a payment, which can't stand, and the client is now cost-curious, a soft buying signal. Temperature: Warm. Stage: Contacted.
SEND THIS: I got ahead of myself earlier. I can't know your real numbers until I see your full picture. Costs depend on your home and situation, so let me run it properly and show you the whole thing, no obligation.
BACKUP: Fair question, and I don't want to guess. Give me 10 minutes to look at your actual picture and I'll walk you through what's involved.
NEXT STEP: Book a 10-minute review: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: Same day text with the two times, day 2 with an angle on knowing the real numbers so waiting is a choice, not a guess, then day 4, day 7, then every 2 weeks.
WATCH OUT: Walk back the rate and payment before anything else and don't repeat them or give a closing cost figure. Compliance: if a quote went out, note it in the file. Confirm the 30 year fixed from late 2023 and the balance before the review.
```
**holdout-02 · objection:just_shopping** (trigger: "I'm honestly just looking right now", from partial)
```
READ: Early-stage browser, unsure and a little nervous, not resisting. She called you, so there's real curiosity under the "just looking." Temperature: Warm. Stage: New lead.
SEND THIS: Totally fine, looking is exactly how this starts. No pressure at all. What got you browsing homes lately, was something specific on your mind, or just curious about what's out there?
BACKUP: That's a great place to start. What kind of home do you picture when you're scrolling?
NEXT STEP: Let her finish, then ask one curiosity question. Once she shares, offer a free 10-minute chat to map out her home options: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: If no time is booked, same-day text saying nice to meet her and offering a quick no-pressure chat about her home options. Day 2: share one helpful first-time buyer tip. Day 4, day 7, then every 2 weeks.
WATCH OUT: Don't pitch or push an application yet. Don't quote rates, payments, or what she'd qualify for. Missing: her timeline and whether she's working with an agent. Ask casually later.
```
