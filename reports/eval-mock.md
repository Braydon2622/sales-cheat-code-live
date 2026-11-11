# Eval report: Sales Call Cheat Code

> **MOCK RUN.** No AI models were called. Detection is the keyword baseline, cards are canned templates, and latencies are simulated. These numbers test the harness, not the product.

- **Run:** 2026-11-05T18:14:18.037Z · set `calls` · 20 synthetic calls · 392 utterances
- **Pipeline:** speculative + interim partials · replay max (client speech in real time, gaps and rep lines compressed)
- **Models:** detector `keyword-baseline` · coach `mock-template` · guard `none`
- **Moment policy:** confidence ≥ 0.75, cooldown {"objection":10,"opt_out":∞} lines

## Headline

| Metric | Result |
|---|---|
| Moment detection precision / recall | 94% / 52% |
| Rep compliance slips caught | 5 of 11 (0 false alarms) |
| Non-compliant suggestions that reached the rep | 0 of 31 cards (rules re-check) |
| "Moment detected" chip, from speech end, p50 / p95 | 0 ms / 0 ms |
| First card line on screen, from speech end, p50 / p95 | 555 ms / 557 ms |
| Cards on screen within 1.5 s of speech end | 100% |
| Cost per call | $0.0000 |

## 1. Moment detection

A detection counts when it lands on the same line as a hand label with the same type. Scored on what the pipeline actually fired (after the confidence threshold and cooldown).

| Type | Pipeline P / R | 
|---|---|
| objection | 86% / 63% (12 tp, 2 fp, 7 fn) | 
| buying_signal | 100% / 53% (9 tp, 0 fp, 8 fn) | 
| question | 100% / 35% (6 tp, 0 fp, 11 fn) | 
| opt_out | 100% / 100% (2 tp, 0 fp, 0 fn) | 
| rep_violation | 100% / 45% (5 tp, 0 fp, 6 fn) | 
| **all** | **94% / 52% (34 tp, 2 fp, 32 fn)** | 

Subtype accuracy on correct objection / rep-violation hits: 94%.

### Threshold and cooldown sweep

Same raw detector output, filtered offline with each policy. No extra API calls.

| Policy | Precision | Recall | F1 | Fired |
|---|---|---|---|---|
| no filter | 89% | 52% | 65% | 38 |
| cooldown only | 94% | 52% | 67% | 36 |
| cooldown + confidence ≥ 0.5 | 94% | 52% | 67% | 36 |
| cooldown + confidence ≥ 0.6 | 94% | 52% | 67% | 36 |
| cooldown + confidence ≥ 0.75 (pipeline default) | 94% | 52% | 67% | 36 |
| cooldown + confidence ≥ 0.9 | 94% | 52% | 67% | 36 |

## 2. Compliance

**Rep's own speech** (11 labeled slips):

| Layer | Caught |
|---|---|
| Deterministic rules | 5 / 11 |
| Model detector | 5 / 11 |
| Either (what the rep sees) | 5 / 11 |
| False alarms on clean rep lines | 0 |

**AI suggestions** (31 cards: 29 coached, 2 fixed opt-out cards):

| Outcome | Cards |
|---|---|
| Shown as drafted | 27 |
| Draft blocked mid-stream by rules, safe card shown | 2 |
| Draft retracted by model guard, safe card shown | 0 |
| Coach error, safe card shown | 0 |
| Shown cards with a blocking violation (rules re-check) | 0 |

Playbook style on drafted cards shown: two-option close 27/27, said "home" not "loan" 27/27.

Drafts the guard stopped:

- call-01 · objection: banned_word (rules): "lowest"
- call-03 · objection: banned_word (rules): "lowest"

## 3. Latency

On 29 coached cards. **From speech end** = from the moment the client stopped talking (negative means the card arrived before they finished). **From first partial** = from the first interim transcript of that line, roughly when the client started the sentence. Card lines appear only once each is complete and has passed the rules.

| Stage | From speech end, p50 | p95 | From first partial, p50 | p95 |
|---|---|---|---|---|
| "Moment detected" chip | 0 ms | 0 ms | 0 ms | 0 ms |
| Coach first token | 451 ms | 452 ms | 451 ms | 452 ms |
| First card line on screen | 555 ms | 557 ms | 555 ms | 557 ms |
| Full card | 1418 ms | 1433 ms | 1418 ms | 1434 ms |
| Model guard cleared | 1418 ms | 1433 ms | 1419 ms | 1434 ms |

Within 1.5 s of speech end: chip 100%, first card line 100%. Detector round trip on final lines: p50 0 ms, p95 0 ms.

**How cards got started:** 22 of 29 from an interim partial (before the client finished). On final lines, the coach was started speculatively 170 times: 7 used, 163 cancelled because the detector found no moment, 0 where the coach guessed "no moment" but the detector disagreed (re-asked).

## 4. Cost

| Model | Calls | Input | Cache write | Cache read | Output | USD |
|---|---|---|---|---|---|---|
| **Total** | | | | | | **$0.0000** |

Per call: $0.0000 · per card: $0.0000. Cancelled speculative requests are included; their output tokens are estimated from the text received before cancelling.

## 5. Detection errors (first 25)

- call-02 #5 · missed objection:rate_too_high · "Well, I got a payment estimate from the online calculator and it's just way more than I want to pay every month. Like, I don't know how anyone affords this."
- call-02 #10 · missed rep_violation:other · "Look, credit unions are fine for checking accounts, but they're slow and they're going to bury you in fees. You'll lose this condo waiting on them."
- call-03 #3 · false alarm objection:spouse · "Yes, the kitchen. It's original to the house, nineteen eighty-six. My wife has been after me for years."
- call-03 #11 · missed question · "What would a home equity line even run me right now?"
- call-04 #13 · missed buying_signal · "Huh. Okay, so what would I even need to get pre-approved?"
- call-05 #8 · missed rep_violation:rate_quote · "For a townhouse purchase like that, I can get you six and an eighth today, easy."
- call-05 #17 · missed objection:stall · "Sure, send it over, I'll look at it."
- call-06 #7 · missed question · "My rent went up again. And everyone keeps saying self-employed people can't get mortgages. Is that true? Would I even get approved?"
- call-06 #13 · missed buying_signal · "Sure, I can do that. Would you need anything else?"
- call-07 #15 · missed question · "Okay. Do we have to sell our house before we can buy the new one?"
- call-08 #7 · missed objection:spouse · "Ha, yeah. Anyway, I'm into it, but Tasha's the co-borrower and she's way more cautious than me. I can't move on anything until she's on board."
- call-08 #11 · missed question · "I don't even know how that works. Can you count the rent?"
- call-09 #9 · missed buying_signal · "What do I need to get that?"
- call-10 #1 · missed objection:stall · "Oh, hey. Yeah, sorry, I've just been super busy. Work's been crazy."
- call-10 #7 · missed objection:stall · "Yeah, I mean, eventually. Can you just send me something in an email and I'll look at it when I get a chance?"
- call-10 #13 · missed buying_signal · "Okay, yeah, I can do that. Where do I send them?"
- call-11 #9 · missed question · "Well, my credit took a hit last year when I had some medical bills. I'm worried I'm not going to qualify. Do you think I'd still get approved?"
- call-13 #6 · missed buying_signal · "Okay, I have all of that. Do you need it today?"
- call-13 #14 · missed question · "No! Do I need that already?"
- call-14 #1 · false alarm objection:spouse · "Hi Lauren, it's Paul. We spoke last week about refinancing. My wife and I talked it over and we want to go ahead."
- call-14 #7 · missed question · "Okay. Will you need to do an appraisal?"
- call-14 #11 · missed question · "Okay. And what will my new payment end up being?"
- call-15 #7 · missed buying_signal · "My CPA has all that. I can have her send it today. Can she email it straight to you?"
- call-15 #9 · missed question · "Perfect. Am I going to have trouble getting approved since I'm self-employed?"
- call-15 #15 · missed buying_signal · "December twentieth. Can you hit that?"

## Sample cards

**call-01 · buying_signal** (trigger: "what would you need", from partial)
```
READ: They need to feel heard before anything else.
SEND THIS: That makes sense. Can I ask a couple of quick questions so I give you a real answer?
BACKUP: What would make this worth your time?
NEXT STEP: Short review: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: Same day, then day 2, day 4, day 7, then every 2 weeks.
WATCH OUT: No rates, payments, or approval promises.
```
**call-02 · objection:bank_loyalty** (trigger: "credit union", from partial)
```
READ: They need to feel heard before anything else.
SEND THIS: That makes sense. Can I ask a couple of quick questions so I give you a real answer?
BACKUP: What would make this worth your time?
NEXT STEP: Short review: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: Same day, then day 2, day 4, day 7, then every 2 weeks.
WATCH OUT: No rates, payments, or approval promises.
```
**call-02 · buying_signal** (trigger: "How long", from partial)
```
READ: They need to feel heard before anything else.
SEND THIS: That makes sense. Can I ask a couple of quick questions so I give you a real answer?
BACKUP: What would make this worth your time?
NEXT STEP: Short review: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: Same day, then day 2, day 4, day 7, then every 2 weeks.
WATCH OUT: No rates, payments, or approval promises.
```
