# Streaming Speech-to-Text Options for Phase 2

This document compares four streaming speech-to-text (STT) vendors for Sales Cheat Code Live Phase 2. The desktop app sends two channels per call (the rep's mic and the client's phone audio, which is 8 kHz) to our server, and the server streams them to the STT vendor. We need fast interim (partial) results, fast finalization (STT plus the roughly 0.8 s Claude round trip has to fit in 1.5 s), and contract terms that are acceptable for GLBA-covered consumer financial data. The goal is to pick two vendors for a bake-off.

**Researched 2026-11-05. Prices and terms change; re-check before signing.** All sources were accessed 2026-11-05.

## Comparison table

| | Deepgram (Nova-3 / Flux) | AssemblyAI (Universal-Streaming / Universal-3.6 Pro Realtime) | AWS Transcribe streaming | Google Cloud STT V2 streaming (Chirp 3) |
|---|---|---|---|---|
| 1. Latency, vendor claim | Under 300 ms transcription latency; Flux end-of-turn about 260 ms | About 300 ms immutable words; 3.6 Pro "sub-300ms" | Not found | Not found |
| 1. Latency, independent (Artificial Analysis) | Nova-3: 0.07 s first partial, 0.08 s final, WER 6.5% | 3.6 Pro (min latency): 0.14 s / 0.14 s, WER 3.6% | 0.23 s / 0.49 s, WER 5.1% | Chirp 3: 1.11 s / 1.19 s, WER 4.8% |
| 2. Interims and endpointing | Yes (`interim_results`), `endpointing` (ms), `utterance_end_ms`, `speech_final` | Word-by-word partials (Universal-Streaming); 3.6 Pro sends partials only during silence; `min_turn_silence` and `max_turn_silence` | Yes (`IsPartial`), with partial-result stabilization (low/med/high); no tunable endpointing found | Yes (`interim_results`), voice-activity events and timeouts |
| 3. Two channels | One stream, multichannel (`channel_index`) | One session per channel | One stream, channel identification (2 channels max) | One stream, `SEPARATE_RECOGNITION_PER_CHANNEL` (streaming support not confirmed in docs) |
| 3. Channel billing | Per channel (stereo bills 2x) | Per session duration, so 2 sessions bill 2x | **Not billed per channel** (up to 2) | Per channel |
| 4. List price, streaming | Nova-3 $0.0077/min pay-as-you-go; $0.0065 Growth | $0.15/hr Universal-Streaming; $0.45/hr 3.6 Pro | $0.01/min (US East) | $0.016/min (V2, 0 to 500k min) |
| 4. Free credit | $200 | $50 | 60 min/month for 12 months | No V2 free tier (V1: 60 min/month) |
| 5. Training on our data | Model Improvement Program unless `mip_opt_out=true` per request | Opt-out toggle for paid plans; free plans can't opt out; BAA opts out automatically | Possible by default; opt out with AWS Organizations AI opt-out policy | Off by default (data logging is opt-in) |
| 5. Retention | Opted-out requests are kept only while processing; default retention not found | Streaming: zero retention once opted out | No streaming retention period found; content may be stored for improvement unless opted out | Not logged by default |
| 5. Region options | US default, EU and AU endpoints | EU servers mentioned | Choice of AWS Region | Choice of region (Chirp 3: `us` and `eu`) |
| 6. SOC 2, BAA, DPA | SOC 2 Type 1 and 2; BAA on request; general DPA not found | SOC 2 Type 2; self-serve BAA (paid plans) | HIPAA eligible under AWS BAA; SOC not verified here | HIPAA covered product; SOC 2 not verified for STT specifically |
| 7. 8 kHz telephony | mulaw/alaw, `sample_rate=8000` | 8000 Hz used in streaming examples | 8,000 Hz supported | `telephony` model (8 kHz); Chirp 3 at 8 kHz not confirmed |

Rough monthly cost, based on an assumption, not a quote: 9 reps × about 84 talk hours/month = 756 call hours (45,360 minutes, or 90,720 channel-minutes). That works out to about $700 for Deepgram Nova-3 PAYG, $230 for AssemblyAI Universal-Streaming or $680 for 3.6 Pro (2 sessions), $450 for AWS, and $1,450 for Google V2.

## Deepgram

- **Pricing:** Streaming Nova-3 (monolingual) is $0.0077/min pay-as-you-go and $0.0065/min on the Growth plan. Flux English is the same. The free credit is $200 and doesn't expire. "Multichannel audio bills by total processed duration across channels." ([Deepgram pricing](https://deepgram.com/pricing), accessed 2026-11-05)
- **Latency (vendor claim):** "transcription latency in 300 milliseconds or less for streaming workloads." Deepgram recommends sending 20–100 ms audio chunks and measuring latency from interim results. ([Measuring streaming latency](https://developers.deepgram.com/docs/measuring-streaming-latency), accessed 2026-11-05) Flux claims about 260 ms end-of-turn detection. ([Flux docs](https://developers.deepgram.com/speech-to-text/streaming-audio), accessed 2026-11-05)
- **Interims and endpointing:** Interim results are off by default and turned on with `interim_results=true`. ([Interim results](https://developers.deepgram.com/docs/interim-results), accessed 2026-11-05) Endpointing is on by default at 10 ms and can be set in ms. `speech_final=true` marks an endpoint. ([Endpointing](https://developers.deepgram.com/docs/endpointing), accessed 2026-11-05)
- **Multichannel:** Streaming is supported for Nova and Flux. Each message carries `channel_index` (for example `[1, 2]`). ([Multichannel](https://developers.deepgram.com/docs/multichannel), accessed 2026-11-05)
- **Data use:** Deepgram stores "small portions of customer data" for model improvement. Opting out takes `mip_opt_out=true` on every request, and opted-out data "is retained only for the duration necessary to process the request." The page doesn't say whether opting out changes the price. ([Model Improvement Program](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program), accessed 2026-11-05)
- **Compliance:** SOC 2 Type 1 and Type 2 (certificates on request). Deepgram acts as a HIPAA Business Associate and provides a BAA on request. It describes itself as "GDPR ready." EU endpoint `api.eu.deepgram.com`. No GLBA mention. ([Data privacy compliance](https://developers.deepgram.com/docs/data-privacy-compliance), accessed 2026-11-05)
- **8 kHz:** Raw `mulaw`, `alaw` and `linear16` are supported. `sample_rate` is required with `encoding`, and the docs' example uses 8000. ([Encoding](https://developers.deepgram.com/docs/encoding), accessed 2026-11-05)

## AssemblyAI

- **Pricing:** Universal-Streaming English is $0.15/hr and Universal-3.6 Pro Realtime is $0.45/hr. Streaming is "billed per session duration," so idle open time counts. The free credit is $50. ([AssemblyAI pricing](https://www.assemblyai.com/pricing), accessed 2026-11-05)
- **Latency (vendor claim):** "~300ms" immutable transcripts. AssemblyAI's own benchmark reports 307 ms median word latency against 516 ms for Deepgram Nova-3. It is vendor-run and more than a year old. ([Universal-Streaming launch](https://www.assemblyai.com/blog/introducing-universal-streaming), accessed 2026-11-05)
- **Interims and endpointing:** Universal-Streaming sends partials word by word. Universal-3 Pro streaming sends partials only during silence and uses punctuation-based turn detection. `min_turn_silence` and `max_turn_silence` can be changed mid-stream. ([Partial transcripts](https://www.assemblyai.com/docs/guides/partial_transcripts), [Optimizing latency](https://www.assemblyai.com/docs/streaming/getting-started/optimizing-accuracy-and-latency.md), accessed 2026-11-05)
- **Multichannel:** "we recommend creating a separate session for each channel." The examples use `sample_rate` 8000. ([Streaming multichannel](https://www.assemblyai.com/docs/streaming/diarization-and-multichannel), accessed 2026-11-05)
- **Data use and retention:** "If you are opted out of model training, we offer zero data retention of audio and transcripts for our Streaming product." Metadata is kept for billing. Data on EU servers or under a BAA is not used for training. ([Data retention and model training](https://www.assemblyai.com/docs/data-retention-and-model-training), accessed 2026-11-05) Paid customers opt out self-serve "at no additional cost." Free users can't opt out. ([Opt-out FAQ](https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program.md), accessed 2026-11-05)
- **Compliance:** SOC 2 Type 2 covering security, availability and confidentiality. TLS 1.2+ in transit and AES at rest. ([Security](https://www.assemblyai.com/security), accessed 2026-11-05) The BAA is self-serve on paid plans and automatically opts you out of training. ([Data controls](https://www.assemblyai.com/docs/data-controls.md), accessed 2026-11-05) DPA and GLBA: not found.

## AWS Transcribe (streaming)

- **Pricing:** Standard streaming is $0.01/min in US East, billed per second with no minimum. "For a two channel conversation, you only pay for the total audio duration." The free tier is 60 min/month for 12 months. Streaming PII redaction is an add-on (Tier 1 $0.0024/min). ([AWS Transcribe pricing](https://aws.amazon.com/transcribe/pricing/), accessed 2026-11-05) Artificial Analysis lists AWS at $24 per 1,000 min, which doesn't match AWS's own page.
- **Latency (vendor claim):** not found. ([Transcribe FAQ](https://aws.amazon.com/transcribe/faqs/), accessed 2026-11-05)
- **Interims:** Partials are flagged `IsPartial`, and the docs' example shows one about every 0.5 s. Partial-result stabilization (low, medium or high) locks earlier words and lowers latency. ([Partial results](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html), accessed 2026-11-05) No user-set endpointing or silence parameter found.
- **Multichannel:** Channel identification works for streaming over HTTP/2 or WebSocket, with a maximum of 2 channels (`ch_0`, `ch_1`). ([Channel identification](https://docs.aws.amazon.com/transcribe/latest/dg/channel-id.html), accessed 2026-11-05)
- **Data use:** "Amazon Transcribe may temporarily store your content to continuously improve the quality of its analysis models." ([Data input and output](https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html), accessed 2026-11-05) The AI services opt-out policy stops this, deletes previously stored improvement copies, and stops storage outside your Region. ([AI services opt-out](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html), accessed 2026-11-05)
- **Compliance:** "AWS Transcribe [Includes Healthscribe]" is on the HIPAA-eligible list. ([AWS HIPAA eligible services](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/), accessed 2026-11-05) SOC scope: not verified (the scope page loads dynamically; check AWS Artifact).
- **8 kHz:** "Sample rates for low fidelity audio, such as telephone recordings, typically use 8,000 Hz." Streaming accepts PCM, FLAC or Ogg Opus. ([Data input and output](https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html), accessed 2026-11-05)

## Google Cloud Speech-to-Text (V2 streaming)

- **Pricing:** V2 standard recognition is $0.016/min for the first 500k min/month (Chirp is a standard model), billed in 1-second increments. "Each audio channel is billed separately." V1 has 60 free min/month, and $0.024/min without data logging versus $0.016 with it. ([Google STT pricing](https://cloud.google.com/speech-to-text/pricing), accessed 2026-11-05)
- **Latency (vendor claim):** not found.
- **Interims and endpointing:** `interim_results`, `enable_voice_activity_events`, and `voice_activity_timeout` (`speech_start_timeout` and `speech_end_timeout`). The `channel_tag` field labels streaming results per channel. ([V2 RPC reference](https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2), accessed 2026-11-05)
- **Limits:** "A stream can remain open for up to 5 minutes," so longer calls need reconnect logic. ([Quotas](https://docs.cloud.google.com/speech-to-text/docs/quotas), accessed 2026-11-05) Streaming is gRPC only. ([Streaming recognize](https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize), accessed 2026-11-05)
- **Data use:** "By default, Cloud Speech-to-Text does not log customer audio data or transcripts." Data logging is opt-in. ([Data logging](https://docs.cloud.google.com/speech-to-text/docs/data-logging), accessed 2026-11-05)
- **Compliance:** Speech-to-Text is a HIPAA-covered product, with the instruction "don't opt in to data logging" under a BAA. ([Google Cloud HIPAA](https://docs.cloud.google.com/security/compliance/hipaa), accessed 2026-11-05) Chirp 3 regions: `us` and `eu`. ([Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3), accessed 2026-11-05)
- **8 kHz:** The `telephony` model is meant for audio "typically recorded at an 8 kHz sampling rate." Its streaming support isn't stated. ([Transcription models](https://docs.cloud.google.com/speech-to-text/docs/transcription-model), accessed 2026-11-05)

**Independent benchmark note:** All "independent" figures above come from the [Artificial Analysis streaming STT leaderboard](https://artificialanalysis.ai/speech-to-text/streaming) (accessed 2026-11-05). I read them from the page's embedded data. Its latency clock starts at end of speech, which is the same moment our 1.5 s budget starts. Its test audio is not 8 kHz phone calls, and some entries show implausibly low values that probably come from its fallback rules (Deepgram Flux 0.02 s, Universal-Streaming English 0.03 s). Treat these numbers as directional only.

## Recommendation for Phase 2

**Shortlist for the bake-off: Deepgram (Nova-3) and AssemblyAI (Universal-3.6 Pro Realtime, plus Universal-Streaming English as a cheaper variant).**

- **Why these two:** Both have the lowest finalization latency in the independent data, per-request endpointing controls, 8 kHz support, a BAA, and a way to stop training on our audio.
- **Alternate:** AWS Transcribe is cheapest for two channels and comes with AWS's contract framework, but it has no tunable endpointing and finalizes more slowly (about 0.5 s).
- **Dropped:** Google is out because of the 5-minute stream limit and roughly 1.2 s Chirp 3 finalization.

**How to run the bake-off:** Replay the same set of recorded two-channel calls through our harness, with the client side at 8 kHz. For each vendor, measure time to first partial and time from end of speech to final at p50 and p95, plus word error rate on mortgage terms. Vendor latency claims use different definitions, so don't compare them directly.

**Questions for each vendor's sales and security team:**
1. **Retention:** How long is streaming audio, transcript text and metadata retained by default? Can they confirm zero retention in writing?
2. **Training:** Is training on our data off contractually for every request, not just per request? Does opting out change the price? For Deepgram, ask whether `mip_opt_out` is billed differently.
3. **DPA:** Will they sign a DPA that names us as controller and them as processor? Ask for the subprocessor list and breach-notice timelines.
4. **GLBA:** Will they agree to GLBA Safeguards Rule service-provider language (16 CFR 314.4(f)), including security program, oversight and audit rights? Ask for the current SOC 2 Type 2 report.
5. **Hosting:** Are data residency and processing US-only?

## Alternative to check first: Dialpad

From Dialpad's public API docs, Dialpad does **not** appear to expose live transcript lines or live call audio:

- **No live transcript or audio feed:** Call events cover call states, and their `call_transcription` state means "The call transcription is ready." `transcription` is for voicemail only. No event type for live transcript lines was found. ([Dialpad call events](https://developers.dialpad.com/docs/call-events), accessed 2026-11-05)
- **Transcripts by API:** `Call Transcript -- Get` returns the Dialpad AI transcript, including moments. Line types include `real_time_moment`. ([Transcript Get](https://developers.dialpad.com/reference/transcriptsget.md), accessed 2026-11-05)
- **Event delivery:** Events can go to a webhook or a WebSocket, but they are the same events in both cases. ([Events via WebSocket](https://developers.dialpad.com/docs/event-subscriptions-via-websocket.md), accessed 2026-11-05)
- **Live transcription toggle:** An API can turn on Voice Intelligence ("live transcription and real-time assist") for an active call, but no documented way to stream the result out was found. ([Call VI Toggle](https://developers.dialpad.com/reference/userstoggle_call_vi.md), accessed 2026-11-05)

No media-streaming or WebSocket audio API for Dialpad was found. Ask Dialpad directly whether a partner or beta real-time transcript or audio feed exists before building desktop capture.

## Open questions / couldn't verify

- Deepgram: default retention for requests without `mip_opt_out` was not found. A general DPA was not found (only an AU DPA is mentioned). Whether opting out raises the price was not found.
- AssemblyAI: whether the EU region covers streaming, and a DPA, were not found. Streaming per-session billing for two channels is inferred from "billed per session duration."
- AWS: streaming latency claim not found. SOC scope for Transcribe and streaming retention period not verified. The $0.01/min list price conflicts with Artificial Analysis's $24 per 1,000 min.
- Google: whether multichannel works in V2 *streaming* (the `channel_tag` field suggests it does), streaming support for the `telephony` model, and Chirp 3 accuracy at 8 kHz were not confirmed.
- No vendor addresses GLBA on its public pages. GLBA terms will have to be negotiated.
- No independent benchmark on 8 kHz phone audio was found.
