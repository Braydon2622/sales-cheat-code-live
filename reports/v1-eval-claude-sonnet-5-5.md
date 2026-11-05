# Eval report: Sales Cheat Code Live

- **Run:** 2026-11-05T16:52:48.609Z · 20 synthetic calls · 392 utterances · replay speed 10x
- **Models:** detector `claude:claude-haiku-5-5` · coach `claude:claude-sonnet-5-5@low` · guard `claude:claude-haiku-5-5`

## Headline

| Metric | Result |
|---|---|
| Moment detection precision / recall | 59% / 95% |
| Rep compliance slips caught | 11 of 11 (5 false alarms) |
| Non-compliant suggestions that reached the rep | 0 of 85 cards (rules re-check) |
| Card on screen (speech end → first line), p50 / p95 | 3394 ms / 6662 ms |
| Cards on screen within the 1.5 s budget | 0% |
| Cost per call | $0.0126 |

## 1. Moment detection

A detection counts when it lands on the same line as a hand label with the same type.

| Type | Pipeline P / R | Keyword baseline P / R |
|---|---|---|
| objection | 55% / 95% (18 tp, 15 fp, 1 fn) | 80% / 63% (12 tp, 3 fp, 7 fn) |
| buying_signal | 52% / 100% (17 tp, 16 fp, 0 fn) | 100% / 53% (9 tp, 0 fp, 8 fn) |
| question | 71% / 88% (15 tp, 6 fp, 2 fn) | 100% / 35% (6 tp, 0 fp, 11 fn) |
| opt_out | 50% / 100% (2 tp, 2 fp, 0 fn) | 67% / 100% (2 tp, 1 fp, 0 fn) |
| rep_violation | 69% / 100% (11 tp, 5 fp, 0 fn) | 100% / 45% (5 tp, 0 fp, 6 fn) |
| **all** | **59% / 95% (63 tp, 44 fp, 3 fn)** | 89% / 52% (34 tp, 4 fp, 32 fn) |

Subtype accuracy on correct objection / rep-violation hits: 100% (keyword baseline: 94%).

## 2. Compliance

**Rep's own speech** (11 labeled slips):

| Layer | Caught |
|---|---|
| Deterministic rules | 5 / 11 |
| Model detector | 11 / 11 |
| Either (what the rep sees) | 11 / 11 |
| False alarms on clean rep lines | 5 |

**AI suggestions** (85 cards: 81 coached, 4 fixed opt-out cards):

| Outcome | Cards |
|---|---|
| Shown as drafted | 78 |
| Draft blocked mid-stream by rules, safe card shown | 2 |
| Draft retracted by model guard, safe card shown | 1 |
| Coach error, safe card shown | 0 |
| Shown cards with a blocking violation (rules re-check) | 0 |

Playbook style on drafted cards shown: two-option close 72/78, said "home" not "loan" 75/78.

Drafts the guard stopped:

- call-02 · objection: approval_promise (model): "a pre-approval is a great spot to be in"
- call-18 · buying_signal: approval_promise (rules): "you're approved"
- call-20 · question: guarantee (rules): "guarantee"

## 3. Latency

Measured from speech end (the moment the replay releases the client's finished line) on 81 coached cards. Card lines appear on screen only once each line is complete and has passed the rules.

| Stage (from speech end) | p50 | p95 |
|---|---|---|
| Detector verdict (all 392 lines) | 1402 ms | 2849 ms |
| Coach first token | 3081 ms | 6325 ms |
| First card line on screen | 3394 ms | 6662 ms |
| Full card | 4928 ms | 8159 ms |
| Model guard cleared | 6255 ms | 9675 ms |

## 4. Cost

| Model | Calls | Input | Cache write | Cache read | Output | USD |
|---|---|---|---|---|---|---|
| `claude-haiku-5-5` | 471 | 112133 | 0 | 608819 | 8444 | $0.0215 |
| `claude-sonnet-5-5` | 79 | 23055 | 0 | 119369 | 15993 | $0.2299 |
| **Total** | | | | | | **$0.2514** |

Per call: $0.0126 · per card: $0.0031

## 5. Detection errors (first 25)

- call-01 #19 · false alarm buying_signal · "Tomorrow at ten works. I'll dig up that ARM letter too."
- call-02 #12 · false alarm rep_violation:other · "Fair enough. What I'd really like to do is just be a second look. Do you have their loan estimate yet?"
- call-02 #14 · false alarm rep_violation:other · "Got it. Once your offer's accepted you'll get a formal loan estimate from them. If you want, send me the details and I can show you what ours looks like side by side."
- call-02 #15 · false alarm question · "Maybe. How long does it usually take you guys to close?"
- call-02 #17 · false alarm objection:stall · "Okay. Let me see if the offer even gets accepted first."
- call-03 #7 · false alarm buying_signal · "Contractor said he could start in February. After that he's booked into the fall."
- call-03 #15 · false alarm objection:spouse · "I'd need to find them. Martha keeps all that."
- call-04 #11 · false alarm objection · "I figured I needed like twenty percent, which, yeah, that's not happening."
- call-04 #15 · false alarm buying_signal · "Yeah, that would actually be helpful."
- call-05 #11 · false alarm question · "Does that include points or whatever?"
- call-05 #13 · false alarm objection:rate_too_high · "Okay, so it's not really six and an eighth then."
- call-05 #15 · false alarm objection:stall · "Right. Okay. I've got a meeting in a few, so I'm going to have to go."
- call-05 #17 · missed objection:stall · "Sure, send it over, I'll look at it."
- call-06 #7 · false alarm objection:just_shopping · "My rent went up again. And everyone keeps saying self-employed people can't get mortgages. Is that true? Would I even get approved?"
- call-06 #15 · false alarm buying_signal · "This week. I'll ask my accountant to send them."
- call-07 #11 · false alarm objection:stall · "Maybe. He works pretty long days though."
- call-08 #9 · false alarm question · "Mostly whether we can actually afford it if the rental side sits empty."
- call-08 #15 · false alarm buying_signal · "Thursday evening, like six-thirty."
- call-09 #5 · false alarm buying_signal · "Yep, starting in January. We need to find a place before then, ideally."
- call-10 #3 · false alarm objection:stall · "Logistics. It's peak season, everything's on fire until like January."
- call-10 #15 · false alarm buying_signal · "Tomorrow morning, before my shift."
- call-11 #9 · false alarm objection · "Well, my credit took a hit last year when I had some medical bills. I'm worried I'm not going to qualify. Do you think I'd still get approved?"
- call-11 #13 · false alarm objection:stall · "I'd still want to wait until things settle down with the baby."
- call-12 #5 · false alarm objection:stall · "I guess, um, it's that I'd be taking on a bigger mortgage. That feels scary even if it pays off the cards."
- call-12 #11 · false alarm buying_signal · "Maybe a call. I'll have questions."

## Sample cards

**call-01 · objection:rate_too_high** (trigger: "that just feels way too high. I'm not refinancing at six")
```
READ: Rate-anchored; six feels high, but she's still engaged.
SEND THIS: That makes sense, and comparing is smart. I can't tell you what's right without seeing your full picture, so let me give you a second look at your options.
BACKUP: What would need to be true for a refinance to feel worth it for you?
NEXT STEP: Book a 15-minute review: "Does today at 4 or tomorrow at 10 work better?"
WATCH OUT: Don't quote or compare rates, and don't knock the other lender.
```
**call-01 · buying_signal** (trigger: "what would you need from me to do that?")
```
READ: Buying signal. They're asking how to move forward.
SEND THIS: Just a quick look at your current statement, the letter on the ARM, and a rough idea of income. Fifteen minutes and I'll put it next to your quote.
BACKUP: Easiest is to grab that letter and your latest mortgage statement, and I'll walk you through the rest.
NEXT STEP: Lock the review: "Does today at 4 or tomorrow at 10 work better? If you have a partner, have them join."
WATCH OUT: Stop selling. No rate talk, no promise they'll qualify or save.
```
**call-01 · buying_signal** (trigger: "Tomorrow at ten works. I'll dig up that ARM letter too.")
```
READ: Booked tomorrow at ten; volunteering the ARM letter. Stop selling.
SEND THIS: Perfect, tomorrow at ten it is. Have that ARM letter and your latest mortgage statement handy, and I'll walk you through exactly what happens on the call.
BACKUP: Is there anyone else on the mortgage who should join us at ten?
NEXT STEP: Confirm ten tomorrow, get a good number and email, and send a calendar invite.
WATCH OUT: Don't guess what the ARM letter means; no rate or savings talk.
```
