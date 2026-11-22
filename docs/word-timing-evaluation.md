# Precise word timing: evaluation (not added)

Cutawan cuts between words, so word boundaries matter: a boundary that ends
too early or starts too late puts a cut inside a syllable. This note records
whether a forced-alignment pass was worth adding to the local Whisper route,
as an opt-in "Precise word timing" setting, and why it was not added.

## What the local route does today

`resources/local-whisper/transcribe.py` runs faster-whisper with
`word_timestamps=True` and `vad_filter=True` (Silero VAD picks the speech
regions). faster-whisper's word times come from Whisper's own
cross-attention, aligned with dynamic time warping over the model's
alignment heads. They are good to roughly a word's length, sometimes worse at
the edges of a phrase: a word's end often runs into the pause after it.
Within faster-whisper there is nothing further to switch on: its remaining
word options (`prepend_punctuations`, `append_punctuations`) only decide
which token a punctuation mark is attached to, and the VAD options decide
what is transcribed, not where a word starts or stops.

Cutawan already compensates where it matters for cuts:

- Silero VAD runs over the whole source (`main/pipeline/vad.ts`) and pause
  removal moves every internal cut out of detected speech
  (`snapToSilence` in `shared/tighten.ts`). VAD is acoustic, so this fixes
  the common failure (a cut in a word's tail) without better word times.
- Since this release the check after every export reports any cut that still
  lands inside a word where voice activity says there is speech
  (`midWordCuts` in `main/pipeline/exportCheck.ts`). On the offline test
  renders it found none. That report is the evidence to watch before adding
  an aligner: if real exports show mid-word cuts, alignment is the fix.

## What a forced-alignment pass would take

Forced alignment runs an acoustic model with a CTC head over the audio and
aligns the known transcript to its frame-level character probabilities,
giving boundaries to about 20 ms. The candidates:

| Option | Runtime | Model download | Languages |
| --- | --- | --- | --- |
| whisperX-style wav2vec2 alignment | PyTorch + torchaudio (the CPU `torch` wheel alone is 126-138 MB, several hundred MB installed) | 360 MB per language (wav2vec2-base) up to 1.2 GB (large) | one model per language |
| `ctc-forced-aligner` 1.0.2, ONNX mode | onnxruntime (already installed with faster-whisper) plus librosa, which pulls in numba, llvmlite, scipy and scikit-learn | the MMS forced-alignment model (wav2vec2 with 300 M parameters; about 1.2 GB at full precision), fetched from Hugging Face on first use | many, via romanisation (uroman) |
| wav2vec2-base exported to ONNX and quantised, with our own CTC Viterbi | onnxruntime | about 95 MB (int8) | English only; no maintained export to depend on |

Cost on a CPU: a 300 M-parameter wav2vec2 runs at roughly real time or
slower on a laptop CPU, so an hour of video would add tens of minutes to
transcription. The base model is about three times faster, English only.

## Decision

Not added. Every route that covers the languages Cutawan supports needs
either PyTorch or a download of around a gigabyte plus a heavy Python
dependency chain, and a CPU pass comparable to the transcription itself.
The English-only option is a modest download but would mean maintaining our
own model export and aligner for one language. Meanwhile VAD snapping
already moves cuts out of speech, and the export check now measures how
often a cut still lands in a word.

If the export check shows mid-word cuts in practice, the path with the best
trade-off is the ONNX `ctc-forced-aligner` route, installed only on request
like the Whisper models, run only over the words near planned cuts rather
than the whole transcript (a few seconds of audio per cut, so the CPU cost
becomes negligible), with its result used to adjust word boundaries before
pause removal.

Unverified here: the model sizes and speeds above come from the packages'
published metadata and documentation; this environment could not download
models from Hugging Face, so none of the aligners was run.
