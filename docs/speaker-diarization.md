# Speaker turns and audio reactions

Date: 22 November 2026. Two local analyses run once per source at transcription time and are saved with the transcript: `Transcript.speakerTurns` (who speaks when) and `Transcript.reactions` (laughter, applause, a crowd, an impact, a music sting). Clip selection reads them; nothing here calls an API.

## Where they run

`ensureTranscript` (`src/main/pipeline/projectTranscript.ts`) starts them as soon as Silero voice activity is known, alongside Whisper, so they are usually finished when the transcript lands. The source is decoded once as a 16 kHz mono stream that both analyses read (`audioAnalysis.ts`); memory stays flat for multi-hour sources. The transcript is checkpointed before the stage waits on them, so a cancel or crash there never loses the transcription. Older projects get both fields backfilled the first time clips are generated again, the way `speech` is.

Neither analysis can fail transcription: each is isolated, logs its error and leaves its field absent. Only cancellation propagates.

## Speaker model

| | |
|---|---|
| Model | 3D-Speaker CAM++, trained on VoxCeleb (`iic/speech_campplus_sv_en_voxceleb_16k`), ONNX export by sherpa-onnx |
| Licence | Apache-2.0 (3D-Speaker repository and its ModelScope model card; sherpa-onnx, which hosts the export, is Apache-2.0). Training data VoxCeleb is CC BY 4.0. |
| Source | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` |
| Size | 29,596,979 bytes |
| SHA-256 | `98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5` |
| Input / output | 80-bin Kaldi fbank `[N, T, 80]`, per-window mean-normalised, samples in −1..1 → 512-d embedding |

The model is not bundled (it would quadruple `resources/models`). On first use it is downloaded into `userData/models/campplus-voxceleb-en.onnx` and kept only if it matches the pinned size and checksum (`speakerModel.ts`). The stage never waits on a first download past the moment the transcript lands (10 s when backfilling an older project): a slow download carries on in the background and serves the next run. Offline or on a failed download, diarization is skipped and the download is not tried again until the app restarts; reactions still run. Cancelling one job abandons only its own wait for the model, never the shared download. A copy placed in `resources/models` is used without downloading, and `CUTAWAN_SPEAKER_MODEL` points tests and scripts at a local file. Inference runs in its own inference child, so a failure there cannot latch the client automatic framing uses.

## Speaker turns

1. 1.5 s windows every 0.75 s over voice activity (`planWindows`); regions under 0.6 s are labelled from their neighbours.
2. Fbank (`fbank.ts`, verified against kaldi-native-fbank) and CAM++ embeddings, batched 16 windows per request.
3. Average-linkage agglomerative clustering on cosine distance, cut at 0.6 (3D-Speaker's own setting for this model family), nearest-neighbour-chain O(n²). Above 1,500 windows an even subsample is clustered and the rest assigned to the nearest voice. Clusters under 5 windows (a cough, a laugh, music) join their nearest voice; voices whose centroids are above 0.8 cosine similarity merge.
4. Each window speaks for the middle of its span; changes shorter than 1 s are absorbed; each word goes to the turn covering most of it and turns are rebuilt from runs of words, so boundaries fall between words. Same-speaker turns split at pauses over 2 s. Speakers are renumbered by first appearance. One voice, or under 20 windows of speech, leaves `speakerTurns` absent; a small `audio-analysis.json` beside `project.json` records that diarization ran, so a talking-head project is not re-diarized on every regeneration.

### Measured (scripts/calibrate-diarization.ts)

Synthesized dialogue with espeak-ng voices (the only speech available offline here), 3–5 minutes each:

| Source | Voices | Result at the default |
|---|---|---|
| male + female | 2 | 2 speakers, 0% frame error |
| same, with pink noise, a music bed and echo | 2 | 2 speakers, 0% frame error |
| one voice, varied pitch and rate | 1 | 1 speaker (no turns) |
| same, with noise, music and echo | 1 | 1 speaker |
| three / four voices (two or three espeak male variants) | 3 / 4 | 2 speakers: the male variants merge |

Window distances: same voice p50 0.28–0.36, p99 0.46–0.63; male vs female p1 0.56–0.59, p50 0.70–0.75; espeak male variants p50 ~0.55. A cut of 0.5 separates all synthetic voices but a single synthetic voice already reaches 0.49 at p99, and real people vary more than espeak, so 0.5 would split real speakers. A missed speaker only loses turns; an invented one misleads clip selection, so the published 0.6 stays. **Not verified on real recordings**: no real multi-speaker speech was available in the build environment.

## Audio reactions

Per 50 ms frame: loudness, spectral flux over 20 log-spaced bands, spectral flatness (200 Hz–6 kHz) and the share of energy above 2 kHz (`reactions.ts`). Words, stretched to the edge of the voice-activity region they sit in, define speech; laughter inside a VAD region without words stays a gap.

- In a gap, sound must be 12 dB above the local non-speech floor (20th percentile within ±20 s) and within 10 dB of the source's typical speech level.
- Over speech, the sustained level must be 8 dB above the speaker's own median within ±10 s, with spectral flux 1.5 dB above theirs.
- Kinds only on clear evidence: impact (≤ 0.6 s, flux peak ≥ 32 dB), applause (≥ 1.5 s, flatness ≥ 0.4, high share ≥ 0.45, level s.d. ≤ 3.5 dB), laughter (0.6–10 s, 2.5–8 bursts/s of ≥ 6 dB, some breathiness), music (≥ 1 s, flatness ≤ 0.06); otherwise `other`.
- Strength is the excess in dB (longer reactions a little more), relative to the source's strongest but never above an absolute 10 dB floor. At most one reaction per 20 s of source on average, strongest kept.

Measured on synthetic ffmpeg sources (`scripts/calibrate-reactions.ts`, `tests/reactionsMedia.test.ts`): a laughter-like burst, applause and an impact between speech over a −35 dBFS music bed peak +18 to +20 dB over the floor and are all found and named; with no events, gaps peak +3.2 dB over room tone and +0.1 dB over a −26 dBFS music bed. Laughter 10 dB louder than the speaker reads +11.6 dB over their level and is found; at their own level it reads +4.4 dB and is deliberately missed, as is a 13 s stretch delivered 6 dB louder.

## Timing

Measured on a 4-core Linux VM with a 20.7-minute speech-dense source: voice activity 16 s (already part of the pipeline), then one decode with reactions and 1,231 embeddings 36 s, clustering under a second. A 60-minute source therefore adds about 105 s of local work after voice activity, in parallel with Whisper; reactions alone (no speaker model) cost under 10 s per hour.
