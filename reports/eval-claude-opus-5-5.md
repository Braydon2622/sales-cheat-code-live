# Eval report: Sales Cheat Code Live

- **Run:** 2026-11-05T16:46:10.760Z · 20 synthetic calls · 392 utterances · replay speed 10x
- **Models:** detector `claude:claude-haiku-5-5` · coach `claude:claude-opus-5-5@low` · guard `claude:claude-haiku-5-5`

## Headline

| Metric | Result |
|---|---|
| Moment detection precision / recall | 58% / 95% |
| Rep compliance slips caught | 11 of 11 (4 false alarms) |
| Non-compliant suggestions that reached the rep | 0 of 86 cards (rules re-check) |
| Card on screen (speech end → first line), p50 / p95 | 4264 ms / 7131 ms |
| Cards on screen within the 1.5 s budget | 0% |
| Cost per call | $0.0279 |

## 1. Moment detection

A detection counts when it lands on the same line as a hand label with the same type.

| Type | Pipeline P / R | Keyword baseline P / R |
|---|---|---|
| objection | 55% / 95% (18 tp, 15 fp, 1 fn) | 80% / 63% (12 tp, 3 fp, 7 fn) |
| buying_signal | 52% / 100% (17 tp, 16 fp, 0 fn) | 100% / 53% (9 tp, 0 fp, 8 fn) |
| question | 65% / 88% (15 tp, 8 fp, 2 fn) | 100% / 35% (6 tp, 0 fp, 11 fn) |
| opt_out | 50% / 100% (2 tp, 2 fp, 0 fn) | 67% / 100% (2 tp, 1 fp, 0 fn) |
| rep_violation | 73% / 100% (11 tp, 4 fp, 0 fn) | 100% / 45% (5 tp, 0 fp, 6 fn) |
| **all** | **58% / 95% (63 tp, 45 fp, 3 fn)** | 89% / 52% (34 tp, 4 fp, 32 fn) |

Subtype accuracy on correct objection / rep-violation hits: 100% (keyword baseline: 94%).

## 2. Compliance

**Rep's own speech** (11 labeled slips):

| Layer | Caught |
|---|---|
| Deterministic rules | 5 / 11 |
| Model detector | 11 / 11 |
| Either (what the rep sees) | 11 / 11 |
| False alarms on clean rep lines | 4 |

**AI suggestions** (86 cards: 82 coached, 4 fixed opt-out cards):

| Outcome | Cards |
|---|---|
| Shown as drafted | 78 |
| Draft blocked mid-stream by rules, safe card shown | 3 |
| Draft retracted by model guard, safe card shown | 1 |
| Coach error, safe card shown | 0 |
| Shown cards with a blocking violation (rules re-check) | 0 |

Playbook style on drafted cards shown: two-option close 76/78, said "home" not "loan" 72/78.

Drafts the guard stopped:

- call-02 · objection: approval_promise (rules): "you're already pre-approved"
- call-15 · question: approval_promise (model): "Self-employed buyers get approved all the time"
- call-18 · buying_signal: approval_promise (rules): "you're approved"
- call-19 · question: rate_quote (rules): "rate review: "Does today at 4"

## 3. Latency

Measured from speech end (the moment the replay releases the client's finished line) on 82 coached cards. Card lines appear on screen only once each line is complete and has passed the rules.

| Stage (from speech end) | p50 | p95 |
|---|---|---|
| Detector verdict (all 392 lines) | 1367 ms | 3196 ms |
| Coach first token | 3980 ms | 6939 ms |
| First card line on screen | 4264 ms | 7131 ms |
| Full card | 5763 ms | 8801 ms |
| Model guard cleared | 7032 ms | 10885 ms |

## 4. Cost

| Model | Calls | Input | Cache write | Cache read | Output | USD |
|---|---|---|---|---|---|---|
| `claude-haiku-5-5` | 471 | 111056 | 0 | 608819 | 8444 | $0.0214 |
| `claude-opus-5-5` | 79 | 22682 | 0 | 119448 | 21053 | $0.5357 |
| **Total** | | | | | | **$0.5571** |

Per call: $0.0279 · per card: $0.0068

## 5. Detection errors (first 25)

- call-01 #1 · false alarm objection:stall · "Oh, yeah, hi. I remember. I'm actually in the middle of making lunch, so..."
- call-01 #19 · false alarm buying_signal · "Tomorrow at ten works. I'll dig up that ARM letter too."
- call-02 #14 · false alarm rep_violation:other · "Got it. Once your offer's accepted you'll get a formal loan estimate from them. If you want, send me the details and I can show you what ours looks like side by side."
- call-02 #15 · false alarm question · "Maybe. How long does it usually take you guys to close?"
- call-03 #7 · false alarm buying_signal · "Contractor said he could start in February. After that he's booked into the fall."
- call-03 #15 · false alarm objection:spouse · "I'd need to find them. Martha keeps all that."
- call-04 #11 · false alarm objection · "I figured I needed like twenty percent, which, yeah, that's not happening."
- call-04 #15 · false alarm buying_signal · "Yeah, that would actually be helpful."
- call-05 #11 · false alarm question · "Does that include points or whatever?"
- call-05 #13 · false alarm objection:rate_too_high · "Okay, so it's not really six and an eighth then."
- call-05 #15 · false alarm objection:stall · "Right. Okay. I've got a meeting in a few, so I'm going to have to go."
- call-05 #17 · missed objection:stall · "Sure, send it over, I'll look at it."
- call-06 #9 · false alarm objection · "Yeah, my accountant writes off basically everything."
- call-06 #15 · false alarm buying_signal · "This week. I'll ask my accountant to send them."
- call-07 #11 · false alarm objection:stall · "Maybe. He works pretty long days though."
- call-07 #15 · false alarm buying_signal · "Okay. Do we have to sell our house before we can buy the new one?"
- call-08 #9 · false alarm question · "Mostly whether we can actually afford it if the rental side sits empty."
- call-08 #15 · false alarm buying_signal · "Thursday evening, like six-thirty."
- call-09 #5 · false alarm buying_signal · "Yep, starting in January. We need to find a place before then, ideally."
- call-10 #3 · false alarm objection:stall · "Logistics. It's peak season, everything's on fire until like January."
- call-10 #15 · false alarm buying_signal · "Tomorrow morning, before my shift."
- call-11 #9 · false alarm objection:stall · "Well, my credit took a hit last year when I had some medical bills. I'm worried I'm not going to qualify. Do you think I'd still get approved?"
- call-11 #13 · false alarm objection:stall · "I'd still want to wait until things settle down with the baby."
- call-12 #5 · false alarm objection:stall · "I guess, um, it's that I'd be taking on a bigger mortgage. That feels scary even if it pays off the cards."
- call-12 #11 · false alarm buying_signal · "Maybe a call. I'll have questions."

## Sample cards

**call-01 · objection:stall** (trigger: "I'm actually in the middle of making lunch, so...")
```
READ: Bad timing, not disinterest; she remembers the form.
SEND THIS: No problem at all, I'll be quick. I'd love to set a short call when you're free so I can learn what you're hoping to do with your home.
BACKUP: Totally understand, I just need two minutes later to see what makes sense for you.
NEXT STEP: Book a callback: "Does this afternoon at 3 or tomorrow at 10 work better?"
WATCH OUT: Don't pitch over lunch; lock the time and hang up.
```
**call-01 · objection:rate_too_high** (trigger: "it was right around six percent, and that just feels way too high")
```
READ: Rate-anchored at six; frustrated, but still engaged and shopping.
SEND THIS: I hear you, nobody wants to refinance for a number that doesn't feel worth it. The rate's only one piece, though. Term, costs, and your goals all change what makes sense, and I can't know that until I look at your full picture.
BACKUP: What would make refinancing worth it for you: lower payment, cash out, or paying off sooner?
NEXT STEP: Book a 15-minute review after lunch: "Does today at 3 or tomorrow at 10 work better?"
WATCH OUT: Don't repeat "six," promise to beat it, or knock that lender.
```
**call-01 · buying_signal** (trigger: "what would you need from me to do that")
```
READ: Buying signal: they're ready to move forward.
SEND THIS: Easy: a quick consent to pull credit, your last two pay stubs, last year's W-2, and that ARM letter so we can compare apples to apples.
BACKUP: Simplest start is a 15-minute call where we gather it together.
NEXT STEP: Lock the review: "Does today at 4 or tomorrow at 10 work better to go through it?"
WATCH OUT: Stop selling; don't imply approval or estimate savings.
```
