# Changelog

Notable changes per release. Full commit history and downloadable builds are on
the [releases page](https://github.com/JeremySNR/cutawan/releases).

This project uses [semantic versioning](https://semver.org/), loosely: while
still pre-1.0, minor bumps carry new features and patch bumps carry fixes.

## [Unreleased]

### Added

- **OpenRouter** is now a connection in first-run setup and Settings. Add an OpenRouter key (encrypted with your system keychain), then pick the clip-finding model from OpenRouter's full model list. The list is searchable, suggests models at the top, and shows prices, context size and image support. Transcription can use local Whisper on your computer or one of OpenRouter's Whisper models (Whisper, Whisper Large v3, Whisper Large v3 Turbo). These are the only OpenRouter transcription models that return the per-word timestamps captions need, so other transcription models aren't offered. **Check key** validates the key without making a model request.
- OpenRouter transcription sends five-minute audio chunks so each request finishes inside OpenRouter's 60-second limit. A reply without word timestamps fails with a message saying what to change, rather than producing captions that can't be timed.

### Improved

- The setup wizard no longer shows the unavailable "Claude subscription" card. Claude models can be used through OpenRouter instead.

## [0.13.0] - 2026-09-25

### Added

- Optional editorial ranking (beta) reviews retained speech, surrounding context and sampled frames using common hook, clarity, value, payoff and audience-fit criteria. It marks uncertainty, defers repeated ideas, preserves the old ranking for offline comparison, and shows reasons and evidence in the editor. Extra analysis calls are shown before enabling it.
- Optional **Find visual moments (beta)** scans sampled frames across the source before selecting clips, then inspects promising demonstrations, reveals and reactions more closely. It can suggest clips without spoken audio. Completed scans are cached by source content, transcript, provider/model and instructions; failed scans remain retryable.
- Visual discovery reports show successful and failed source sections, sampling gaps and rejected proposals. The scan uses at most twelve additional analysis calls plus provider retries. Sparse frames can miss brief events; this is not continuous-video understanding or a measured improvement in engagement.
- Offline quality comparisons now support blind publishability decisions, measured repair time, severe defects, reviewer coverage and source-separated summaries. Missing clips and missing reviews remain visible, with a protocol for collecting untouched human-labelled holdouts.

### Improved

- Score badges distinguish editorial assessments from legacy scores. Changed source selections require review again; a high score is not presented as a prediction of virality or certification of the export.
- Visual candidates preserve their observed action and crossing speech boundaries, start with conservative framing, and keep pause removal and auto zoom off. Candidates that cannot fit completely are rejected. Final overlap removal runs after visual-payoff repair.

### Validation

- Automated regressions use scripted model responses; they do not establish human preference or superiority over OpusClip. Run the documented human comparison workflow before making those claims.
- A bounded live ChatGPT check exercised editorial review, visual discovery and refinement. The API route was not live-tested. See `docs/provider-smoke.md` for the recorded results and limits.

## [0.12.1] - 2026-09-23

### Fixed

- If Cutawan couldn't restart itself after updating a source checkout, trying again now finishes the update instead of reporting "already up to date".
- On Windows, a Python or other command launcher (such as one from conda) is no longer mistaken for a broken Codex install.
- AI connections that don't support strict JSON output (some local and OpenAI-compatible models) are now told exactly what shape to reply in, and a malformed reply is retried instead of failing.
- A size-limited export that still ends up over the limit now says so plainly.

## [0.12.0] - 2026-09-23

### Added

- Edit clips on the timeline: split at the playhead (S or ⌘K), click a piece and press Delete to cut it, and click a cut to put it back. Pauses that were removed automatically now show on the timeline; click one to keep it.
- Cut words straight from the transcript: drag across them and press Delete or "Cut selection". Cut words are struck through.
- Undo and redo for clip edits (⌘Z / ⇧⌘Z), plus Premiere-style keys: Space or K to play and pause, J and L to step a second, arrow keys to step a frame, and I and O to set the in and out points.
- Split screen for conversations: when two people trade quick turns in the same shot, both are shown, one above the other. Turn it off per clip in the editor.
- The trim bar shows how long the clip actually plays after pauses and cuts.
- "What's new" after each update, and any time from Settings → Updates. When an update is available, you can read what's in it before downloading.

### Improved

- Clips appear as soon as they're found. Framing for the top clips finishes in the background, marked "Framing…" on each card.
- Following the speaker is about 40% faster, and close-ups where a face fills the frame are now recognised.
- Steadier framing: the crop stays still while the speaker stays near the centre and only moves when they really move, keeping faces centred more reliably.
- Pause removal only cuts where there's actual silence, so it no longer clips the ends of words, laughter or the other person's reactions. Filler words such as "um" are still removed.
- Much faster exports on Apple Silicon Macs, which now use the built-in hardware encoder at the same quality. Split-screen and layout exports are faster on every computer.
- Faster local transcription on Apple Silicon Macs. Re-run local Whisper setup in Settings to turn it on.

### Fixed

- Exported videos could be very slightly squashed horizontally in some players.
- Auto zoom stuttered in the editor preview (exports were not affected).

### Validation

- Measurements, failed trials and remaining limits: `docs/speed-and-framing-validation.md`.

## [0.11.4] - 2026-09-21

### Fixed

- Repair rejected screen/presenter source bounds instead of immediately preserving a letterbox. Supply specific geometric feedback and cap source proposals at two per shot; keep existing quality thresholds.
- Ask for a single contiguous presenter panel rather than combining disconnected webcam overlays.
- Add per-clip **Retry automatic layout** for failed automatic results. Preserve manual corrections, join retries before export, and protect successful retries against stale saves and concurrent trim changes.

### Validation and limits

- Repaired and inspected the reported comparison-slide case. The two-webcam email demo still fails content selection; it is explicitly unresolved. See `docs/rejected-layout-repair.md` for all seven requests, failed trials, timings and remaining work.

## [0.11.3] - 2026-09-21

### Improved

- Detect large screen transitions before composing individual shots, avoiding a failed whole-clip layout attempt first.
- Scan content crop edges locally between ordinary review samples. Reused crops request fresh bounds on an alert; fresh proposals add suspect moments to rendered review so incidental editing guides do not force an unnecessary full-frame fallback.
- Use rejected temporal review frames in one bounded region proposal. Keep decoding, image counts, cancellation and scan duration bounded.

### Validation

- 515 tests plus type checking, lint and build. Tested local scan timing and a targeted repair on the original T3.GG recording. Documented the initial false alarm, revised result, timings and remaining limitations in `docs/temporal-layout-validation.md`. Moving panels, faster events and arbitrary-video quality remain unfinished.

## [0.11.2] - 2026-09-21

### Improved

- Let independent layout reviews overlap without occupying local decoding/inference slots while waiting for cloud responses. Bound analysis requests across API and ChatGPT providers separately from local processing.
- Reuse checked screen compositions from the same source as proposals for recurring layouts. Every candidate requires fresh rendered verification; rejected candidates fall back to ordinary analysis.
- Veto reused crops when sampled local pixels indicate a feature cut at the content boundary. Label comparison panels explicitly to reduce confusion between source references and the actual output.

### Validation

- Tested recurring and changing graph content plus three rearranged presenter-corner variants from the original T3.GG footage. A moving-title failure found by inspection drove the edge guard. Measurements, failed trials and remaining limitations are recorded in `docs/layout-reuse-validation.md`; arbitrary-video quality is not established.

## [0.11.1] - 2026-09-21

### Fixed

- Allow up to two independent ChatGPT analysis requests at once on machines with at least 8 GiB RAM; keep daily-budget reservations serialized, ledger writes atomic, and identical requests deduplicated.
- Screen recordings now choose content and presenter regions during the existing visual review and skip dense active-speaker inference. Camera and mixed footage retain speaker tracking. Proposed panels still require rendered verification.
- Changing screen layouts use a low-resolution local scene-change pass and per-section narration. Brief app/dialog transitions stay intact instead of triggering repeated AI requests and flickering crops.
- Enlarge the content area in presenter layouts, with containment margins around automatically proposed content. Avoid treating unrelated application sidebars as essential content.
- Save each completed clip layout immediately. A later cancellation or failed request keeps those results, and later pipeline saves preserve concurrent framing and manual-region edits.
- Automatically revisit older generated letterbox results when opened or exported, without replacing accepted compositions, custom crops or manual source corrections. Preserve the upgrade when an ordinary edit saves during analysis.

### Validation

- Exercised the automatic path on the original T3.GG recording, including a graph, calculator, posts and a graph-to-dashboard change. Recorded timings and remaining limits in `docs/layout-first-validation.md`; these are bounded examples, not a guarantee for arbitrary footage or every machine.

## [0.11.0] - 2026-09-20

### Added

- Compose a separate presenter inset and screen content into a 9:16 clip, regardless of the inset's source corner. Choose content-first, stacked or content-only layouts, or enter source regions manually without an AI connection.
- Review automatic compositions using actual rendered sample frames, with one alternate layout attempt. Reject invalid regions, excessive presenter enlargement and insufficient content enlargement; uncertain results keep the full scene and show a review notice.
- Keep preview and export on the same crop geometry and one video/audio clock. Reserve space for captions and hide hook titles that would cover the presenter.

### Improved

- Bound concurrent face-analysis, composition and export jobs across projects according to available memory and CPU capacity. Limit FFmpeg threads and prioritize queued exports.
- Spill large face-crop collections to temporary files while retaining the speaker model's temporal context. Stop decoders and clean up temporary crops on cancellation or consumer failure.
- Validate export dimensions, duration, audio presence and complete decoding before replacing an existing output file, including downscaled size-limited encodes.
- Evaluate small insets using native-resolution crops, including 4K sources. Region edits at the trim end retain the other shots.
- Preserve manual source-region corrections when background analysis finishes. If a longer trim exceeds their coverage, keep the full scene and show a review notice instead of reverting to a portrait crop. Refresh paused composition previews when decoded frames arrive.

### Validation and limitations

- 484 automated tests, type checking, lint and production build pass locally. Real FFmpeg tests cover all four inset corners, timed layout switching, single audio output and failed-export preservation. Native Electron checks cover paused preview, manual creation, layout changes, saved corrections, playback, seeking and resizing.
- AI decisions are mocked in automated tests; sampled model review does not certify every frame or editorial quality. Moving/resizing insets, broad category benchmarks and audience-retention improvements remain unproven. Existing completed clips are not automatically reanalysed.
- See [implementation status and remaining work](docs/adaptive-clipping-status.md). The broader adaptive-clipping roadmap remains in progress.

## [0.10.3] - 2026-09-20

### Fixed

- Isolate native face and speaker inference in a child process, and process speaker-model inputs in bounded batches to reduce Mac memory spikes and keep native inference failures from closing the editor.
- Bundle an Apple Silicon native ffprobe and fix audio channel-layout negotiation during Mac exports.
- Prevent update restarts while saves, imports, analysis or exports are active, and show installation failures with a retryable action.

### Improved

- Check for updates on launch and every six hours, with retries after failed checks or reconnection. The toolbar opens Updates directly and shows download progress and readiness.
- Download and SHA-256 verify the correct Mac installer inside the app, with cancel, retry, cached-download recovery and an Open installer action. Mac releases remain unsigned: quit Cutawan and replace the app in Applications to finish; saved projects and settings remain separate.
- Keep update download state in the main process so closing and reopening the window does not lose progress. Windows/Linux installation requires an explicit restart.
- Build and verify all platform installers and update manifests before publishing a release. Verify uploaded installer checksums before making the draft public.

### Validation and requirements

- Unit tests, type checking, lint, packaged Mac inference/export checks and update UI checks passed locally. A real GitHub Mac installer download passed size and checksum verification.
- A full 86-second speaker-analysis segment completed in the isolated worker with a measured peak of approximately 272 MB.
- Mac builds target Apple Silicon and are not Developer ID signed or notarized. Windows/Linux installer replacement still requires an actual old-to-new upgrade test; library lifecycle tests do not replace that validation.

## [0.10.2] - 2026-09-19

### Fixed

- Detect the Codex CLI in the standalone install location on macOS/Linux even when the desktop app does not inherit the terminal's `PATH`; show an actionable path hint if it still cannot be launched.
- Preserve the first-run setup choice across refreshes and check saved local Whisper files so an existing installation is shown as ready instead of appearing to need another download.

## [0.10.1] - 2026-09-19

### Fixed

- Give the first-run wizard a fully opaque backdrop and a solid, bordered panel so setup options remain readable over the app, including on macOS with window vibrancy enabled.

## [0.10.0] - 2026-09-19

### Added

- A first-run setup wizard for ChatGPT sign-in through Codex, an OpenAI-compatible API, or local-only full-video captions. Existing installations keep their settings and skip onboarding.
- In-app local Whisper setup: after Python 3.10+ is installed, Cutawan creates a private environment, installs faster-whisper, and downloads a Small or Large v3 model on request. Setup can be cancelled, retried, and checked without making an AI request.
- Optional local Whisper transcription alongside API-based clip analysis, so API users can keep speech recognition on their computer.

### Changed

- Full-video captions can now be transcribed and exported without an API key when local Whisper is configured. AI clip finding still requires ChatGPT/Codex or an API connection.
- Onboarding explains that Claude subscriptions are not connected to third-party apps through a personal login; Cutawan does not route automated requests against Claude subscription limits.

### Validation and requirements

- 440 tests, typecheck, lint, and the production build passed during release preparation. Project saves now replace JSON atomically, so background readers cannot encounter a half-written file.
- Local Whisper setup requires a separately installed Python 3.10+ and a model download from Hugging Face. The ChatGPT route additionally requires an installed Codex CLI signed in with ChatGPT. The model download itself was not exercised in the test environment.

## [0.9.0] - 2026-09-19

### Improved

- Preserve speech endings and visual demonstration payoffs, and recover omitted speech at long-video transcription joins.
- Improve small-face detection and speaker framing, with conservative layouts when tracking evidence is weak.
- Add shot-specific framing and enlarged screen-detail layouts with consistent preview/export timing.
- Reject incomplete or incoherent clip candidates based on retained content.
- Fix composition analysis for still frames and rotated video.

### Added

- Optional **ChatGPT subscription via Codex (beta)** for analysis, with local Whisper transcription. Requires an installed, signed-in Codex CLI, Python with faster-whisper, and a downloaded speech model; see [setup instructions](https://github.com/JeremySNR/cutawan/blob/main/docs/chatgpt-subscription.md).
- Luna with low reasoning as the subscription default, cached analysis, configurable daily request limits, and no automatic paid-API fallback.

### Validation and known limitations

- 430 tests and CI checks pass. The resumed public-corpus run produced 23 exports; packaged Windows export and copied-project compatibility checks passed.
- Existing projects remain usable. Saved transcripts and completed framing are not automatically regenerated.
- Some slides remain too small, moving speakers can reach crop edges, repeated selections and caption errors remain possible. Review clips before publishing. This release does not claim OpusClip parity.

## [0.8.0] - 2026-09-06

### Changed

- **Clip boundaries are chosen on sentences.** The model now reads the
  transcript as one sentence per line (derived from word punctuation, with
  unpunctuated rambles split at their longest pauses) instead of Whisper's
  segments, which break mid-sentence, and is told to start and end every clip
  on a line. The ending and opening reviews work on the same sentences. When
  a start still lands inside a sentence, the clip opens that sentence rather
  than skipping to the next; an end inside a sentence completes it.
- **Tightened clips keep their tails.** Removing pauses used to trim the room
  after the last word down to 0.3 s, so the export's 0.4 s fade ducked the
  final syllable. Tightening now keeps 0.7 s after the last word and 0.3 s
  before the first.
- **Long videos come back in minutes, not an hour.** Speaker-framing analysis
  (face tracking plus active speaker detection at 25 fps) is the slowest
  per-clip stage by a wide margin. The pipeline now runs it only for the top
  tier of clips (the eight highest-scoring, extended to twelve for scores of
  80 or more) and leaves the rest pending. A pending clip is analysed the
  moment it is opened in the editor, or before it is exported, and the
  editor says so while it waits. The analysis uses the clip's current trim,
  so a clip extended before opening is tracked end to end.
- **Captions lay out by width, not word count.** Groups are broken into lines
  from a per-style character budget derived from the font's measured glyph
  widths and the output aspect ratio, capped at two lines. The same layout
  feeds the preview and the ASS export (which now carries explicit line
  breaks with libass wrapping off), so a caption can no longer wrap
  differently in the file than it did in the editor.
- **Captions hold briefly after a sentence.** A finished group stays up for
  up to 1.5 s, cut short by the next group, instead of leaving an empty frame
  on every pause.
- **Loudness normalisation is two-pass.** Exports measure the clip first and
  apply one linear gain instead of the single-pass gain rider, which pumped
  audibly on speech: through loudnorm's linear mode when the peaks allow it
  (with the range target raised to the measured range, which that mode
  requires), otherwise a plain gain into a true-peak limiter. Falls back to
  single-pass only when the source cannot be measured.

### Fixed

- **The "fit under N MB" field could not be cleared or retyped.** It was bound
  straight to the saved setting, so an empty field snapped back and every
  keystroke rewrote the settings file. It now edits a draft and commits on
  blur or Enter.
- **Exported captions sat higher than the preview.** The ASS style was
  bottom-aligned on the anchor line while the preview centred its block
  there, so two-line captions rendered about half a block too high. Events
  are now positioned middle-centre on the anchor.
- **Whisper hallucinations reached captions and the clip picker.** Segments
  Whisper itself flags as silence (high no-speech probability with
  low-confidence text) or as looped output (high compression ratio) are now
  dropped at stitch time, along with their words, and never primed into the
  next chunk.
- **Words with zero or negative duration never lit up in karaoke captions.**
  Word timings are now made monotonic and given a minimum on-screen duration
  when the transcript is stitched.

### Added

- **`scripts/eval-clips.ts`.** Measures clip boundaries on saved projects
  (mid-sentence opens and closes, clipped or dead-air tails, length spread),
  and with `--rerun` compares them against fresh detection on the same
  transcript, so prompt changes can be checked instead of guessed.

- **"Fit under N MB" export.** A size cap in Settings and the editor export
  panel, so clips land under Discord, email or WhatsApp limits. The encoder
  already knew how; this is the missing control, plus the achieved file size
  (and a note when the planner had to downscale) after export.
- **OpenAI-compatible API endpoints.** Settings now takes a chat base URL
  (Azure, OpenRouter, Groq, LM Studio, Ollama) and an optional separate
  transcription URL, so a local Whisper server can sit next to a hosted LLM.
  Structured-output calls fall back from `json_schema` to `json_object` (and
  then a plain JSON completion) when the provider does not support OpenAI's
  strict schema mode. `OPENAI_BASE_URL` still overrides Settings when set.
- **winget publishing path.** A manifest generator (`scripts/print-winget-manifest.mjs`)
  and a Release workflow job that updates
  [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) once the
  first listing exists. See [docs/winget.md](docs/winget.md).

### Removed

- **The WorkVivo posting integration.** It was specific to one organisation's
  internal comms platform and depended on an undocumented endpoint set, which
  made it an odd fit for a general-purpose tool. Everything it did that was not
  WorkVivo-specific stayed: the size-targeted two-pass encode
  (`src/shared/uploadBudget.ts`) is still here and still tested, and brand voice
  now steers the TikTok/Reels/Shorts post captions rather than only the internal
  ones.

### Changed

- Brand voice settings (name, tone, style, things to avoid) now feed the AI post
  caption writer. Previously they only affected the internal posting captions,
  so the setting appeared to do nothing for most users.

## [0.7.0] - 2026-09-02

### Added

- **"Caption the whole video" mode.** A second way to work alongside AI clip
  finding: give it a 16:9 video and it comes back as one vertical, captioned
  edit you can trim, restyle and export, with optional speaker tracking and
  auto zoom. Both modes work on the same project and share the transcript, so
  switching between them never pays for transcription twice.
- **Full-quality WorkVivo uploads.** Clips now upload through the presigned
  flow rather than inline through the Customer API, which rejected anything
  beyond a few megabytes. Needs a one-off browser sign-in in Settings; the API
  remains the fallback.
- **Custom caption fonts.** Upload any TTF or OTF. Families are matched on the
  name embedded in the file rather than the filename, so previews and exports
  agree.
- **Size-targeted rendering.** When an upload has a hard byte cap, the bitrate
  is planned up front and the clip is encoded once to hit it, instead of
  rendering at a quality target and re-compressing afterwards.

### Fixed

- **Burned-in captions rendered at roughly 58% of their intended size.** CSS
  `font-size` sets the em square, but libass sizes text against the font's OS/2
  window ascent plus descent. Em sizes were being passed straight through as
  ASS `Fontsize`. This was the gap between the live preview and the exported
  file.
- Very long edits could build zoom filter graphs large enough to choke ffmpeg.
  Zoom events are now capped per clip.

## [0.6.18] - 2026-08-03

### Fixed

- Black screen after updating from a source checkout, and the app now reports a
  failed relaunch instead of disappearing silently.
- Source updates no longer rebuild when the pull brought nothing.
- `media://` no longer serves `settings.json` or session cookies to the
  renderer.
- Concurrent project saves could lose edits. Writes are now serialised.
- Every OpenAI request has a per-attempt timeout, so a hung connection no
  longer stalls the pipeline indefinitely.

## [0.6.17] - 2026-07-23

### Fixed

- B-roll image search froze the app on restricted networks (#44).

## [0.6.16] - 2026-07-07

### Added

- **Video type selector.** Tell Cutawan what kind of footage it is and it
  steers 9:16 layout and face tracking accordingly.
- Screencasts are detected and letterboxed for 9:16 rather than cropped into
  unreadable text.

### Fixed

- Face tracking now bails out early when it finds no usable faces, instead of
  producing a bad crop.
- Several active-speaker content classification fixes.

## [0.6.15] - 2026-07-07

### Added

- WorkVivo posting, with brand-voiced AI captions and a settings page.

### Fixed

- WorkVivo caption posting and space pagination.
- Empty captions are now respected rather than replaced.

## Earlier releases

0.6.14 and earlier predate this changelog. See the
[releases page](https://github.com/JeremySNR/cutawan/releases) for the
history.
