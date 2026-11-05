# Eval report: Sales Cheat Code Live

- **Run:** 2026-11-05T17:22:14.774Z · set `calls` · 20 synthetic calls · 392 utterances
- **Pipeline:** speculative + interim partials · replay 10x (client speech in real time, gaps and rep lines compressed)
- **Models:** detector `claude:claude-haiku-5-5` · coach `claude:claude-sonnet-5-5@low` · guard `claude:claude-haiku-5-5`
- **Moment policy:** confidence ≥ 0.6, cooldown {"objection":10,"opt_out":∞} lines

## Headline

| Metric | Result |
|---|---|
| Moment detection precision / recall | 64% / 92% |
| Rep compliance slips caught | 11 of 11 (10 false alarms) |
| Non-compliant suggestions that reached the rep | 0 of 69 cards (rules re-check) |
| "Moment detected" chip, from speech end, p50 / p95 | 200 ms / 1858 ms |
| First card line on screen, from speech end, p50 / p95 | 1576 ms / 3379 ms |
| Cards on screen within 1.5 s of speech end | 46% |
| Cost per call | $0.0214 |

## 1. Moment detection

A detection counts when it lands on the same line as a hand label with the same type. Scored on what the pipeline actually fired (after the confidence threshold and cooldown).

| Type | Pipeline P / R | Keyword baseline P / R |
|---|---|---|
| objection | 81% / 89% (17 tp, 4 fp, 2 fn) | 80% / 63% (12 tp, 3 fp, 7 fn) |
| buying_signal | 62% / 94% (16 tp, 10 fp, 1 fn) | 100% / 53% (9 tp, 0 fp, 8 fn) |
| question | 60% / 88% (15 tp, 10 fp, 2 fn) | 100% / 35% (6 tp, 0 fp, 11 fn) |
| opt_out | 100% / 100% (2 tp, 0 fp, 0 fn) | 67% / 100% (2 tp, 1 fp, 0 fn) |
| rep_violation | 52% / 100% (11 tp, 10 fp, 0 fn) | 100% / 45% (5 tp, 0 fp, 6 fn) |
| **all** | **64% / 92% (61 tp, 34 fp, 5 fn)** | 89% / 52% (34 tp, 4 fp, 32 fn) |

Subtype accuracy on correct objection / rep-violation hits: 100% (keyword baseline: 94%).

### Threshold and cooldown sweep

Same raw detector output, filtered offline with each policy. No extra API calls.

| Policy | Precision | Recall | F1 | Fired |
|---|---|---|---|---|
| no filter | 49% | 95% | 65% | 128 |
| cooldown only | 56% | 94% | 70% | 111 |
| cooldown + confidence ≥ 0.5 | 59% | 94% | 73% | 105 |
| cooldown + confidence ≥ 0.6 (pipeline default) | 64% | 92% | 76% | 95 |
| cooldown + confidence ≥ 0.75 | 73% | 88% | 79% | 80 |
| cooldown + confidence ≥ 0.9 | 87% | 62% | 73% | 47 |

## 2. Compliance

**Rep's own speech** (11 labeled slips):

| Layer | Caught |
|---|---|
| Deterministic rules | 5 / 11 |
| Model detector | 11 / 11 |
| Either (what the rep sees) | 11 / 11 |
| False alarms on clean rep lines | 10 |

**AI suggestions** (69 cards: 67 coached, 2 fixed opt-out cards):

| Outcome | Cards |
|---|---|
| Shown as drafted | 63 |
| Draft blocked mid-stream by rules, safe card shown | 2 |
| Draft retracted by model guard, safe card shown | 2 |
| Coach error, safe card shown | 0 |
| Shown cards with a blocking violation (rules re-check) | 0 |

Playbook style on drafted cards shown: two-option close 60/63, said "home" not "loan" 62/63.

Drafts the guard stopped:

- call-02 · question: banned_word (rules): "pre-approval"
- call-06 · buying_signal: advice (model): "Day 2: nudge that earlier review leaves more room to adjust things this tax year."
- call-15 · buying_signal: approval_promise (model): "then we'll see what you qualify for on that property"
- call-20 · question: guarantee (rules): "guarantee"

## 3. Latency

On 67 coached cards. **From speech end** = from the moment the client stopped talking (negative means the card arrived before they finished). **From first partial** = from the first interim transcript of that line, roughly when the client started the sentence. Card lines appear only once each is complete and has passed the rules.

| Stage | From speech end, p50 | p95 | From first partial, p50 | p95 |
|---|---|---|---|---|
| "Moment detected" chip | 200 ms | 1858 ms | 4016 ms | 7206 ms |
| Coach first token | 947 ms | 2803 ms | 4848 ms | 8289 ms |
| First card line on screen | 1576 ms | 3379 ms | 5396 ms | 9038 ms |
| Full card | 4090 ms | 5928 ms | 7725 ms | 11460 ms |
| Model guard cleared | 5380 ms | 7555 ms | 9135 ms | 13050 ms |

Within 1.5 s of speech end: chip 91%, first card line 46%. Detector round trip on final lines: p50 1154 ms, p95 3237 ms.

**How cards got started:** 37 of 67 from an interim partial (before the client finished). On final lines, the coach was started speculatively 161 times: 36 used, 125 cancelled because the detector found no moment, 0 where the coach guessed "no moment" but the detector disagreed (re-asked).

## 4. Cost

| Model | Calls | Input | Cache write | Cache read | Output | USD |
|---|---|---|---|---|---|---|
| `claude-haiku-5-5` | 853 | 210351 | 0 | 1038722 | 18556 | $0.0407 |
| `claude-sonnet-5-5` | 120 | 35947 | 0 | 220800 | 27039 | $0.3864 |
| **Total** | | | | | | **$0.4271** |

Per call: $0.0214 · per card: $0.0064. Cancelled speculative requests are included; their output tokens are estimated from the text received before cancelling.

## 5. Detection errors (first 25)

- call-02 #12 · false alarm rep_violation:other · "Fair enough. What I'd really like to do is just be a second look. Do you have their loan estimate yet?"
- call-02 #14 · false alarm rep_violation:other · "Got it. Once your offer's accepted you'll get a formal loan estimate from them. If you want, send me the details and I can show you what ours looks like side by side."
- call-02 #15 · missed buying_signal · "Maybe. How long does it usually take you guys to close?"
- call-02 #15 · false alarm question · "Maybe. How long does it usually take you guys to close?"
- call-02 #16 · false alarm rep_violation:other · "Typically we can close within the contract window, usually around thirty days, depending on the appraisal and how fast we get documents."
- call-02 #17 · false alarm objection:stall · "Okay. Let me see if the offer even gets accepted first."
- call-03 #7 · false alarm buying_signal · "Contractor said he could start in February. After that he's booked into the fall."
- call-03 #15 · false alarm objection:spouse · "I'd need to find them. Martha keeps all that."
- call-04 #13 · false alarm question · "Huh. Okay, so what would I even need to get pre-approved?"
- call-04 #15 · false alarm buying_signal · "Yeah, that would actually be helpful."
- call-05 #10 · false alarm rep_violation:other · "Yeah, we're usually pretty sharp."
- call-05 #11 · false alarm question · "Does that include points or whatever?"
- call-05 #15 · false alarm objection:stall · "Right. Okay. I've got a meeting in a few, so I'm going to have to go."
- call-05 #17 · missed objection:stall · "Sure, send it over, I'll look at it."
- call-06 #10 · false alarm rep_violation:other · "That's really common, and it's exactly why it's worth looking early. Sometimes a small change in how you file this year makes a big difference later."
- call-06 #15 · false alarm buying_signal · "This week. I'll ask my accountant to send them."
- call-08 #9 · false alarm question · "Mostly whether we can actually afford it if the rental side sits empty."
- call-09 #5 · false alarm buying_signal · "Yep, starting in January. We need to find a place before then, ideally."
- call-10 #7 · missed objection:stall · "Yeah, I mean, eventually. Can you just send me something in an email and I'll look at it when I get a chance?"
- call-10 #11 · false alarm buying_signal · "Oh. That's it? I thought it was a whole thing."
- call-11 #12 · false alarm rep_violation:approval_promise · "Yeah. So we could get the application going this week."
- call-13 #8 · false alarm question · "December twelfth. Is that enough time? How fast can you close?"
- call-13 #10 · false alarm buying_signal · "Okay, I'll do it tonight. Oh, and do I lock my rate now? What's the rate going to be?"
- call-13 #14 · missed question · "No! Do I need that already?"
- call-14 #1 · false alarm buying_signal · "Hi Lauren, it's Paul. We spoke last week about refinancing. My wife and I talked it over and we want to go ahead."

## Pipeline errors (10)

- call-03: detector(partial): unparseable detector reply: []
- call-05: detector(partial): unparseable detector reply: []
- call-05: detector: unparseable detector reply: []
- call-07: detector(partial): unparseable detector reply: []
- call-08: detector(partial): unparseable detector reply: []
- call-08: detector: unparseable detector reply: []
- call-15: detector: unparseable detector reply: []
- call-16: detector(partial): unparseable detector reply: []
- call-20: detector(partial): unparseable detector reply: []
- call-20: detector: unparseable detector reply: []

## Sample cards

**call-01 · objection:rate_too_high** (trigger: "it was right around six percent, and that just feels way", from partial)
```
READ: Dana has a quote in hand and is already feeling the rate is too high. She's comparing, not closed. Temperature: Warm. Stage: Contacted.
SEND THIS: I hear you, that's a real frustration. Before I say anything about numbers, what's the main goal for your home here, a lower monthly payment, pulling cash out, or paying off other debt?
BACKUP: Totally fair. I'd welcome the comparison. Can I ask what you were hoping to get out of this so I know what to look at?
NEXT STEP: After she answers, offer a 10-minute side by side: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: If not booked, same day text with the two times, then day 2 with an angle tied to her stated goal, then day 4, day 7.
WATCH OUT: Don't quote, match, or beat a rate, and don't knock the other lender. Let her finish the sentence first. Ask what the quote covered (loan type, points, fees) before comparing.
```
**call-01 · buying_signal** (trigger: "So what would you need from", from partial)
```
READ: Client is leaning in and about to ask what you need to run the review. Buying signal, a bit of ARM worry. Temperature: Hot. Stage: Contacted.
SEND THIS: Just a few things. Your latest statement, that letter from your bank, and your best email so I can send a secure link to get your info in. About 10 minutes and I'll put it side by side for you.
BACKUP: Mostly your current statement and that letter. I can walk you through the rest while we're on the phone, no pressure.
NEXT STEP: Book the review now: "Does today at 4 or tomorrow at 10 work better for the side by side?" Then get the letter and statement lined up before that time.
FOLLOW UP: If not booked, text same day with the two times and a short reminder to grab that letter, then day 2, day 4, day 7.
WATCH OUT: Don't quote a rate or promise a result. The ARM adjustment details come from their letter, so don't guess at them. Zillow value is an estimate, so don't treat it as a real appraisal.
```
**call-02 · objection:rate_too_high** (trigger: "it's just way more ...", from partial)
```
READ: Sticker shock from a generic online calculator, and she has an offer pending, so the clock is real. Temperature: Warm. Stage: Contacted.
SEND THIS: I hear you, those calculators are generic and miss your actual picture. Let me run it properly so you know where you really stand before you hear back on that offer. Takes about 10 minutes.
BACKUP: What number were you hoping to land at? Let's see how close we can get for your home.
NEXT STEP: Let her finish, then book a 10-minute review: "Does today at 4 or tomorrow at 10 work better?"
FOLLOW UP: If not booked, text same day with the two times, then day 2 with an angle on being ready before the seller responds.
WATCH OUT: Don't quote or react to her calculator numbers, and don't promise a lower payment. Ask if she has a down payment amount and budget in mind.
```
