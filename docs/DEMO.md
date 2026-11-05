# Recording the demo video

A 90-second replay of a **synthetic** call (call-18: a nurse fishing for a rate and an approval, and a rep who slips on both). It shows every feature in one take:
- The client's words appear as they speak.
- A **"◆ moment detected"** chip fires, often before they finish the sentence.
- The coaching card streams in line by line, and each card is cleared by the compliance guard.
- The rep's rate quote and "you're approved" are flagged in red the moment they're said.
- A summary at the end shows how many moments were caught before the client finished.

## Run it

```bash
npm run demo:video
```

That's `call-18`, real-time speed, with a 3-second countdown so you can start recording first. It needs `ANTHROPIC_API_KEY` in your shell, and **each take costs about 2 cents**.

To try a different call: `npm run demo -- call-02 --intro`. Good alternatives are `call-02` (credit-union loyalty, rep talks it down) and `call-15` (ready-to-buy contractor, lots of buying signals).

## Before you record

- **Terminal:** dark theme, about 110 columns × 40 rows, font size 16+ so it's readable on a phone.
- Clear the screen first; the countdown clears it too.
- Do one practice take. Live AI output differs a little each run, so pick the take where a chip lands before the client finishes, which happens on most takes.
- Don't use `--mock` for the portfolio video. Mock mode shows canned cards and is only for testing.

## What to say over it (about 30 seconds of narration)

1. "This is a real-time coach for loan officers. It's replaying a role-play call as if it were live audio."
2. When a **chip** appears: "It flagged the moment *before the client finished the sentence*. The card is already being written in parallel."
3. When a **red compliance alert** appears: "The rep just quoted a rate. That's a compliance problem, and it's caught as it's said."
4. On a **card**: "Every line is rule-checked before it reaches the screen, and a second AI reviews the finished card. Across about 400 test cards, no non-compliant suggestion reached the rep."
5. At the **summary**: "On a held-out test set it catches 92% of the moments, about 2 cents per call."

Numbers and limitations to quote are in [`reports/RESULTS.md`](../reports/RESULTS.md).
