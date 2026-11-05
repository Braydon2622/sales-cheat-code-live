# Outside test calls

To check the call-review tool on calls we didn't write, we used five transcripts from a public dataset:

- **Source:** [gwenshap/sales-transcripts](https://huggingface.co/datasets/gwenshap/sales-transcripts) on Hugging Face, generated for Nile's Sales Assistant example.
- **License:** Apache-2.0 (dataset card, checked 2026-11-05).
- **What it is:** "Simulated sales conversations for 5 different fictional companies." There are no real customers or real calls.
- **Files used:**
  - `verity-capital__0_transcript.txt` and `verity-capital__1_transcript.txt` (investment firm)
  - `terravista-properties__0_transcript.txt` and `terravista-properties__1_transcript.txt` (real estate)
  - `modamart__0_transcript.txt` (retail, as an off-topic control)

They aren't mortgage calls, so this is a **stress test**, not an accuracy measurement:
- Does the tool stay sensible on a different kind of sales call?
- Does it avoid inventing mortgage moments?
- Does the compliance guard react to things like a rep giving investment advice?

There are no hand labels for these calls, so they're reviewed by reading the reports, not scored.

The files are downloaded locally into `data/external/` (gitignored) rather than committed. To fetch them again:

```bash
mkdir -p data/external/sales-transcripts && cd data/external/sales-transcripts
for f in verity-capital__0 verity-capital__1 terravista-properties__0 terravista-properties__1 modamart__0; do
  curl -fsSL -o "${f}_transcript.txt" "https://huggingface.co/datasets/gwenshap/sales-transcripts/resolve/main/data/transcripts/${f}_transcript.txt"
done
cd ../../.. && npm run review -- data/external/sales-transcripts/*.txt --rep-name "Sales Rep"
```

Searched and not used:
- [CallCenterEN](https://arxiv.org/abs/2507.02958): real people's calls, non-commercial license.
- [Gong's call-playbook](https://huggingface.co/datasets/gong-io-research/call-playbook): gated, custom license.

No openly licensed mortgage-call transcripts were found.

## Results (2026-11-05, live run, about $0.06 for the five calls)

| Call | Moments | Rep flags | Read of the result |
|---|---|---|---|
| Verity Capital 0 (investments) | 2 (fees question, next steps) | 0 | Correct. Both are real moments; the rep stayed clean. |
| Verity Capital 1 (investments) | 2 | 2 ("other") | Debatable. It flagged an advisor implying benefits ("our clients often find..."). That's arguably a guarantee, but it isn't mortgage compliance. |
| TerraVista 0 (real estate) | **0** | 0 | **Missed.** The client said "prices seem really high right now, I'm worried about overpaying", then stalled ("haven't found the time"). |
| TerraVista 1 (real estate) | **0** | 0 | Missed the same kind of moment. |
| ModaMart 0 (retail) | 0 | 1 (rate quote, **wrong**) | **False alarm:** the rule fired on "a 10% discount". |

### What this found
1. **Fixed: the percentage rule over-fired.** Any percentage the rep said counted as a rate quote. That would also misfire on mortgage calls ("you can put 3% down"). Down-payment and discount percentages are now excluded, with tests. On both labeled call sets the rules still catch the same slips with no new false alarms.
2. **Open: the detector has no "home prices / market timing" objection.** Its objection types are mortgage-specific (rates, shopping, spouse, stall, bank). A buyer worried about home prices is a real objection for a loan officer, so add the category, label examples, and re-test.
3. **Open: repeated "other" flags after a real slip.** In the credit-union sample, once the rep trashed the credit union, the next two rep lines were also flagged even though they were good ("just be a second look"). It needs confidence data from a logged run before tuning.
4. **Expected: the coach is mortgage-only.** On off-topic calls it still writes mortgage-style follow-up texts ("your home options"). That's by design, but it shows the playbook is domain-specific.
