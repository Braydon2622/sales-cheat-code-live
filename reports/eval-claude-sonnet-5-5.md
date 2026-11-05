# Eval report: Sales Cheat Code Live

- **Run:** 2026-11-05T17:02:03.855Z · 20 synthetic calls · 392 utterances · replay speed 10x
- **Models:** detector `claude:claude-haiku-5-5` · coach `claude:claude-sonnet-5-5@low` · guard `claude:claude-haiku-5-5`

## Headline

| Metric | Result |
|---|---|
| Moment detection precision / recall | 58% / 97% |
| Rep compliance slips caught | 11 of 11 (8 false alarms) |
| Non-compliant suggestions that reached the rep | 0 of 83 cards (rules re-check) |
| Card on screen (speech end → first line), p50 / p95 | 3768 ms / 6106 ms |
| Cards on screen within the 1.5 s budget | 0% |
| Cost per call | $0.0198 |

## 1. Moment detection

A detection counts when it lands on the same line as a hand label with the same type.

| Type | Pipeline P / R | Keyword baseline P / R |
|---|---|---|
| objection | 49% / 95% (18 tp, 19 fp, 1 fn) | 80% / 63% (12 tp, 3 fp, 7 fn) |
| buying_signal | 59% / 100% (17 tp, 12 fp, 0 fn) | 100% / 53% (9 tp, 0 fp, 8 fn) |
| question | 70% / 94% (16 tp, 7 fp, 1 fn) | 100% / 35% (6 tp, 0 fp, 11 fn) |
| opt_out | 67% / 100% (2 tp, 1 fp, 0 fn) | 67% / 100% (2 tp, 1 fp, 0 fn) |
| rep_violation | 58% / 100% (11 tp, 8 fp, 0 fn) | 100% / 45% (5 tp, 0 fp, 6 fn) |
| **all** | **58% / 97% (64 tp, 47 fp, 2 fn)** | 89% / 52% (34 tp, 4 fp, 32 fn) |

Subtype accuracy on correct objection / rep-violation hits: 100% (keyword baseline: 94%).

## 2. Compliance

**Rep's own speech** (11 labeled slips):

| Layer | Caught |
|---|---|
| Deterministic rules | 5 / 11 |
| Model detector | 11 / 11 |
| Either (what the rep sees) | 11 / 11 |
| False alarms on clean rep lines | 8 |

**AI suggestions** (83 cards: 80 coached, 3 fixed opt-out cards):

| Outcome | Cards |
|---|---|
| Shown as drafted | 76 |
| Draft blocked mid-stream by rules, safe card shown | 1 |
| Draft retracted by model guard, safe card shown | 3 |
| Coach error, safe card shown | 0 |
| Shown cards with a blocking violation (rules re-check) | 0 |

Playbook style on drafted cards shown: two-option close 74/76, said "home" not "loan" 74/76.

Drafts the guard stopped:

- call-02 · question: banned_word (rules): "pre-approval"
- call-11 · objection: opt_out_ignored (model): "Honor the pause but lock a small 10-minute check-in: "Does Thursday at 4 or Friday at 10 work better?" If she refuses, confirm the call-back date next month before hanging up."
- call-13 · question: guarantee (model): "December twelfth is workable if we move fast, and I'll check your contract deadlines so we stay ahead of them."
- call-19 · objection: opt_out_ignored (model): "FOLLOW UP: Same day text with the two times, day 2 with a reason to compare before committing, then day 4, day 7, then every 2 weeks."

## 3. Latency

Measured from speech end (the moment the replay releases the client's finished line) on 80 coached cards. Card lines appear on screen only once each line is complete and has passed the rules.

| Stage (from speech end) | p50 | p95 |
|---|---|---|
| Detector verdict (all 392 lines) | 1424 ms | 3135 ms |
| Coach first token | 3096 ms | 5412 ms |
| First card line on screen | 3768 ms | 6106 ms |
| Full card | 6233 ms | 8929 ms |
| Model guard cleared | 7675 ms | 11413 ms |

## 4. Cost

| Model | Calls | Input | Cache write | Cache read | Output | USD |
|---|---|---|---|---|---|---|
| `claude-haiku-5-5` | 471 | 126004 | 2320 | 653277 | 8721 | $0.0238 |
| `claude-sonnet-5-5` | 79 | 22481 | 0 | 145360 | 29880 | $0.3728 |
| **Total** | | | | | | **$0.3966** |

Per call: $0.0198 · per card: $0.0050

## 5. Detection errors (first 25)

- call-01 #1 · false alarm objection:stall · "Oh, yeah, hi. I remember. I'm actually in the middle of making lunch, so..."
- call-02 #11 · false alarm objection · "Hm. I mean, they've been pretty good to me so far."
- call-02 #14 · false alarm rep_violation:other · "Got it. Once your offer's accepted you'll get a formal loan estimate from them. If you want, send me the details and I can show you what ours looks like side by side."
- call-02 #15 · false alarm question · "Maybe. How long does it usually take you guys to close?"
- call-02 #16 · false alarm rep_violation:other · "Typically we can close within the contract window, usually around thirty days, depending on the appraisal and how fast we get documents."
- call-02 #17 · false alarm objection:stall · "Okay. Let me see if the offer even gets accepted first."
- call-03 #15 · false alarm objection:spouse · "I'd need to find them. Martha keeps all that."
- call-04 #11 · false alarm objection · "I figured I needed like twenty percent, which, yeah, that's not happening."
- call-04 #15 · false alarm buying_signal · "Yeah, that would actually be helpful."
- call-05 #7 · false alarm objection:just_shopping · "Honestly, rate. That's all anyone talks about. So what's your rate today?"
- call-05 #10 · false alarm rep_violation:other · "Yeah, we're usually pretty sharp."
- call-05 #11 · false alarm question · "Does that include points or whatever?"
- call-05 #13 · false alarm objection:rate_too_high · "Okay, so it's not really six and an eighth then."
- call-05 #17 · missed objection:stall · "Sure, send it over, I'll look at it."
- call-06 #7 · false alarm objection · "My rent went up again. And everyone keeps saying self-employed people can't get mortgages. Is that true? Would I even get approved?"
- call-06 #15 · false alarm buying_signal · "This week. I'll ask my accountant to send them."
- call-07 #11 · false alarm objection:stall · "Maybe. He works pretty long days though."
- call-07 #15 · false alarm buying_signal · "Okay. Do we have to sell our house before we can buy the new one?"
- call-08 #9 · false alarm question · "Mostly whether we can actually afford it if the rental side sits empty."
- call-09 #5 · false alarm buying_signal · "Yep, starting in January. We need to find a place before then, ideally."
- call-10 #3 · false alarm objection:stall · "Logistics. It's peak season, everything's on fire until like January."
- call-11 #9 · false alarm objection:stall · "Well, my credit took a hit last year when I had some medical bills. I'm worried I'm not going to qualify. Do you think I'd still get approved?"
- call-11 #13 · false alarm objection:stall · "I'd still want to wait until things settle down with the baby."
- call-12 #5 · false alarm objection:stall · "I guess, um, it's that I'd be taking on a bigger mortgage. That feels scary even if it pays off the cards."
- call-12 #11 · false alarm buying_signal · "Maybe a call. I'll have questions."

## Sample cards

**call-01 · objection:stall** (trigger: "I'm actually in the middle of making lunch, so...")
```
READ: Soft stall, bad timing rather than disinterest. She remembers the form, which is a good sign. Temperature: Warm. Stage: Contacted.
SEND THIS: No problem at all, Dana, go enjoy lunch. I just want to get you a quick time to talk about your home options. Does today at 4 or tomorrow at 10 work better?
BACKUP: Totally get it. When's a better time for a quick 10 minute chat, later today or tomorrow morning?
NEXT STEP: Get a booked time on the spot with a two option close: "Does today at 4 or tomorrow at 10 work better?" Confirm by text right after.
FOLLOW UP: If no time is booked, text same day with the two time options, then day 2 mentioning her form and a quick no obligation review, day 4, day 7, then every 2 weeks.
WATCH OUT: Keep it under 30 seconds and don't pitch while she's busy. No rates, savings, or approval talk. In texts, say "home options" instead of "refinance" or "mortgage".
```
**call-01 · objection:rate_too_high** (trigger: "that just feels way too high. I'm not refinancing at six")
```
READ: Rate shock plus an existing quote, but she gave you five minutes, so she's engaged. Her real goal is still unknown. Temperature: Warm. Stage: Contacted.
SEND THIS: I hear you, nobody wants to move at a number that feels off. I can't say what's right for you without seeing your full picture, so what's the goal: lower payment, cash out, or paying off debt?
BACKUP: Totally fair to compare. Happy to be a second set of eyes on that other quote. What would make a refinance worth it for you?
NEXT STEP: Once she names the goal, offer a no-obligation 10-minute review: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: If not booked, same-day text about her home options with the two times, then day 2 with an angle tied to her stated goal.
WATCH OUT: Don't quote or counter with any rate, and don't knock the other lender. She's mid-lunch, so stay inside the five minutes. If she cites a specific lender or terms, ask whether the quote was in writing.
```
**call-01 · buying_signal** (trigger: "what would you need from me to do that?")
```
READ: Client is asking what you need from them, which is a clear buying signal. Stop selling and move to a small, specific ask. Temperature: Hot. Stage: Contacted.
SEND THIS: Super simple. Just a few details over the phone, and a quick look at that letter so we compare apples to apples. Then I'll run your real numbers side by side. Takes about 10 minutes.
BACKUP: Not much. If you can grab that letter, I'll walk you through the rest and we'll see where you land.
NEXT STEP: Book the review now: "Does today at 3 or tomorrow at 10 work better?" Ask them to have the letter in hand.
FOLLOW UP: If not booked, text same day with the two times and a reminder to grab the letter. Then day 2: the adjustable terms are worth pinning down soon.
WATCH OUT: Earlier you said "six-ish", which counts as a rate reference. Walk it back: "I can't know your real numbers until I see your full picture." Also confirm what "the letter" is, since the client was unsure of its terms, and don't quote or promise anything. Never knock the other lender.
```
