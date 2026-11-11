# Recording the demo video

A 90-second replay of a **synthetic** call (call-18: a nurse fishing for a rate and an approval, and a rep who slips on both). It shows every feature in one take:
- The client's words appear as they speak.
- A **"◆ moment detected"** chip fires, often before they finish the sentence.
- The coaching card streams in line by line.
- A summary at the end shows how many moments were caught before the client finished.

## Run it

```bash
npm run demo:video
```

That's `call-18`, real-time speed, with a 3-second countdown so you can start recording first. It needs `ANTHROPIC_API_KEY` in your shell, and **each take costs about 2 cents**.

To try a different call: `npm run demo -- call-02 --intro`. Good alternatives are `call-02` (credit-union loyalty, rep talks it down) and `call-15` (ready-to-buy contractor, lots of buying signals).

## Browser version (often looks better on video)

```bash
npm run live
```

Then open `http://127.0.0.1:4311/?call=call-18&speed=1&autostart=1`. It starts the replay as the page loads. The transcript scrolls on the left and cards stream in on the right. A footer keeps a running count of moments and chips that fired before the client finished. Same pipeline and cost as the terminal demo, about 2 cents per take. The server caps live spend at $0.25 per session (`LIVE_MAX_USD`) and runs one live replay at a time. Make the browser full screen, zoom to 125% if the text looks small, and leave **Mock** off for the real video.

`docs/images/live-view.png` is a **mock-mode** screenshot (keyword detector, canned cards). Don't use it as an example of real AI output.

## Before you record

- **Terminal:** dark theme, about 110 columns × 40 rows, font size 16+ so it's readable on a phone.
- Clear the screen first; the countdown clears it too.
- Do one practice take. Live AI output differs a little each run, so pick the take where a chip lands before the client finishes, which happens on most takes.
- Don't use `--mock` for the portfolio video. Mock mode shows canned cards and is only for testing.

## What to say over it (about 30 seconds of narration)

1. "This is a real-time coach for loan officers. It's replaying a role-play call as if it were live audio."
2. When a **chip** appears: "It flagged the moment *before the client finished the sentence*. The card is already being written in parallel."
3. On a **card**: "It tells the rep what to say next, the backup if that doesn't land, and the next step to aim for."
4. At the **summary**: "On a held-out test set it catches 92% of the moments, about 2 cents per call."

Numbers and limitations to quote are in [`reports/RESULTS.md`](../reports/RESULTS.md).

## Portfolio walkthrough (Loom, about 2.5 minutes)

Three acts: **during the call**, **after the call**, **across the team**. Everything shown is synthetic.

**Before recording (one time, about 20 cents):**
1. Add API credits at console.anthropic.com (each take and each review needs them).
2. `npm run app`, untick Mock, and review the sample calls plus `samples/roleplay-spouse-call.m4a`. That fills the "Where calls go wrong" view with real AI reviews. Mock reviews don't count there.
3. Do Not Disturb on, browser at 125% zoom, Loom camera bubble in a bottom corner.

| Time | Screen | Say |
|---|---|---|
| 0:00 | You, app behind | "I run a team of nine loan officers. I built Sales Call Cheat Code to coach them: what to say during a call, what to fix after it, and where calls go wrong across the whole team." |
| 0:15 | `npm run live` → `http://127.0.0.1:4311/?call=call-18&speed=1&autostart=1` | "This is a role-play call replayed as if it were live." |
| when the chip fires | point at it | "It caught that moment before the client finished the sentence. The coaching card is already being written." |
| on a card | let it stream in | "The card tells the rep exactly what to say next, a backup if that doesn't land, and the next step to aim for." |
| 0:55 | Call review app, drag in `demo-refi-shopper.txt` from the Desktop (or `roleplay-spouse-call.m4a` to show a recording) | "After a call, I drop in the recording. It transcribes it, removes personal details, and I pick which voice is the loan officer." |
| 1:10 | The report | "The rep gets what they did well, what to do better with the exact words to try next time, and a follow-up text ready to send." |
| 1:30 | "Where it went wrong" panel | "This shows the turning point where the call went off track, whether a next step got booked, and how much the rep talked. Those last numbers are measured from the transcript, not guessed by AI." |
| 1:45 | Click **Where calls go wrong** | "This is the manager view. Across every call: the most common misses, where leads stall, and how many calls ended with a booked next step. I can click any example to jump into that call." |
| 2:05 | README latency table or `reports/RESULTS.md` | "I measured it. First coaching line went from 3.8 seconds to 1.6. On 25 calls it was never tuned on, it caught 92% of the key moments. About 3 cents a call." |
| 2:20 | You | "Live calls need a real audio feed and company approval, so I wrote the approval request first. Recordings and the team analysis work today. Code and results are linked below." |

Say clearly that the calls are synthetic role-plays. Don't name the employer.
