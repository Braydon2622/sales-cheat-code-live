> Example pilot proposal from this project. The company name is fictional; the real version went to my employer's leadership and compliance team.

# Proposal: an 8-week pilot of a real-time call coach for the loan officer team

**From:** Braydon Hart, Sales Director · **To:** Copperleaf Home Loans leadership and compliance · **Date:** [FILL IN]
**Ask:** approval to pilot the tool with 2–3 volunteer loan officers, then all 9, for 8 weeks, under the safeguards below.

> Items marked **[OPEN]** need a decision or confirmation from compliance, legal, or IT before any live call. This is not legal advice; counsel should confirm everything about consent and GLBA.

## What it does
During a sales call, the tool shows the loan officer a short on-screen card at key moments: an objection ("rates are too high"), a client ready to move forward, a tricky question, or a request to stop calling. The card suggests what to say next and what to avoid. It also flags the loan officer's own compliance slips, such as quoting a rate or promising approval, as they happen. The tool **suggests**; the loan officer decides what to say. It never speaks to the client, sends messages, or changes records on its own.

**Tested so far** on 45 role-play calls with no real borrower data: it caught 92% of key moments, and no suggestion that broke our compliance rules reached the loan officer (about 400 suggestions checked). Opt-out requests always get a fixed "honor it and mark Do Not Contact" response that the AI never writes.

## What data it touches, and where it goes
| Data | Where it goes | Kept |
|---|---|---|
| Live call audio (loan officer's mic and the client's voice) | Our server → speech-to-text vendor **[OPEN: vendor, see STT_OPTIONS.md]** | Proposed: **not stored** by us; vendor retention set to zero or minimum by contract |
| Call transcript text | Our server → **PII redaction** → Anthropic (Claude AI) for detection and coaching | Proposed: redacted transcripts kept **30 days** for quality review, then deleted **[OPEN: compliance to set]** |
| Coaching cards, timing, usage counts | Our server's database | Kept for the pilot's measurement; no client identifiers |

- **PII redaction:** Social Security numbers, dates of birth, account and loan numbers, and card numbers are stripped from transcripts before they reach the AI or our database. This will be tested before the pilot; the speech-to-text vendor necessarily hears the raw audio.
- **Vendors (GLBA):** the FTC Safeguards Rule (16 CFR 314.4(f)) requires choosing capable service providers, requiring safeguards by contract, and monitoring them. Each vendor needs a security review and a contract covering data use, retention, no training on our data, and breach notice. **[OPEN: IT/compliance vendor review for the speech-to-text vendor, Anthropic, and hosting; confirm each vendor's current retention and training terms in writing]**
- **Hosting:** **[OPEN: company cloud account or approved provider; US region]**

## Recording consent
- Several states require **every party's consent** to record or monitor a phone call. Commonly cited: California, Delaware, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire, Pennsylvania, and Washington, plus Connecticut and Nevada for phone calls. Published lists differ. **[OPEN: counsel to confirm the list for the states we call]**
- Our calls already play a Dialpad recording disclosure. **[OPEN: confirm the disclosure covers real-time AI processing and transcription by third-party vendors, or update its wording]**
- Proposed rule: the tool runs **only on calls where the disclosure played**. If consent is unclear (for example, a client objects), the loan officer turns it off for that call.

## Loan officers
Participation is **voluntary and opt-in, in writing.** Loan officers see exactly what is captured. It's a coaching tool, not surveillance: proposed, its data is **not used for performance discipline** during the pilot **[OPEN: leadership to confirm]**.

## Pilot plan (8 weeks)
- **Weeks 1–2:** 2–3 volunteer loan officers. Daily check-ins; fix problems fast.
- **Weeks 3–8:** all 9 loan officers who opt in. Alternate weeks with the tool on and off, to compare.
- **Success metrics:** contact-to-application rate (on vs off weeks, and against the pre-pilot baseline), time to follow-up, how often reps use the cards, a rep survey, **zero compliance incidents caused by the tool**, and suggestions appearing within about 1.5 seconds.
- **Stop conditions:** any compliance incident caused by the tool, a vendor data issue, or rep feedback that it's distracting. Any of these pauses the pilot for review.

## Cost
AI coaching measured about **$0.02 per call** in testing. Speech-to-text is the larger cost. At an assumed 84 talk hours per rep per month (two audio channels), the two shortlisted vendors list at about **$230–$700/month for the team**; see `STT_OPTIONS.md` for the list prices behind this. **[FILL IN: actual talk hours per rep]** A monthly spending cap is set with the AI and STT providers. **[OPEN: monthly pilot budget]**

## Off switch (built and tested before the first live call)
- Each loan officer can turn it off for any call with one click.
- An administrator can turn it off for everyone instantly from the server.
- If the tool fails or is switched off, the call continues normally. The tool never sits between the loan officer and the client.

## Decisions needed
1. Approval to run the pilot, and who signs off for compliance **[OPEN]**.
2. Consent: the state list confirmed, and the Dialpad disclosure confirmed or updated.
3. Vendor reviews and contracts: speech-to-text, Anthropic, hosting.
4. Retention periods and the no-discipline commitment.
5. Monthly budget.

_Sources (accessed 2026-11-05): [Kixie: call recording laws](https://www.kixie.com/sales-blog/what-are-the-laws-governing-call-recordings); [Layer3 Labs: two-party consent states (updated Aug 2026)](https://www.layer3labs.io/guides/two-party-consent-states); [Prospeo: one-party recording states, 2026](https://prospeo.io/s/one-party-recording-states); FTC Safeguards Rule service-provider oversight summarized in [Mitratech: GLBA and third-party risk](https://mitratech.com/resource-hub/blog/tprm-glba/) and the [FTC 2019 Federal Register notice](https://www.govinfo.gov/content/pkg/FR-2019-04-04/html/2019-04981.htm). These are secondary sources; counsel should rely on the statutes and 16 CFR Part 314 directly._
