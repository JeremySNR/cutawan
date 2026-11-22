import type { SubscriptionSettings } from './subscription'
import type { SourceDiscoveryReport } from './sourceAnalysis'
import type { EditorialAssessment, EditorialRankingReport } from './editorialRanking'
/** Shared domain types used across main, preload and renderer. */

export interface VideoInfo {
  path: string
  fileName: string
  durationSec: number
  width: number
  height: number
  fps: number
  sizeBytes: number
  hasAudio: boolean
}

export interface TranscriptWord {
  text: string
  /** Original ASR text, preserved on the first caption edit. Never used for display. */
  sourceText?: string
  start: number
  end: number
}

export interface TranscriptSegment {
  id: number
  text: string
  start: number
  end: number
  words: TranscriptWord[]
  /** Relative vocal energy 0..1 (percentile within this video); optional. */
  energy?: number
}

/** A span of source time, in seconds. */
export interface TimeRange { start: number; end: number }

/** A span of detected speech, in source seconds. */
export type SpeechRegion = TimeRange

export interface Transcript {
  language: string
  durationSec: number
  segments: TranscriptSegment[]
  /**
   * Voice activity across the whole source (Silero VAD). Pause removal and
   * clip boundaries cut only in silence when present; older projects lack it.
   */
  speech?: SpeechRegion[]
  /**
   * Who speaks when, from on-device speaker diarization of the whole source.
   * Speaker ids are small integers numbered in order of first appearance
   * (0 is whoever speaks first). Absent when diarization did not run or found
   * a single voice only; older projects lack it.
   */
  speakerTurns?: SpeakerTurn[]
  /**
   * Moments of non-speech audio excitement across the whole source
   * (laughter, applause, a crowd, an impact, a music hit), in time order.
   * `strength` is 0..1, relative to this source. Absent on older projects.
   */
  reactions?: AudioReaction[]
}

/** One stretch of one speaker's speech, in source seconds. */
export interface SpeakerTurn {
  start: number
  end: number
  speaker: number
}

/** A stretch of non-speech audio that stands out from the rest of the source. */
export interface AudioReaction {
  start: number
  end: number
  strength: number
  kind?: 'laughter' | 'applause' | 'impact' | 'music' | 'other'
}

export type AspectRatio = '9:16' | '1:1' | '16:9' | 'original'

/** How the source frame is fitted into the target aspect ratio. */
export type ReframeMode = 'crop' | 'fit-blur' | 'fit-letterbox'

/** Detected clip content — steers 9:16 layout (crop + zoom vs letterbox). */
export type ClipContentType = 'speaker' | 'screencast'

/**
 * How a clip came to exist: a moment the AI cut out of a longer video, or the
 * whole source video captioned straight through ("caption whole video" mode).
 * Absent on projects saved before that mode existed; loadProject fills it in.
 */
export type ClipOrigin = 'ai-highlight' | 'whole-video'

/**
 * Which flow last ran on a project. Decides where reopening it lands: the
 * clip grid, or straight into the editor on its full-video edit.
 */
export type ProjectMode = 'clips' | 'whole-video'

/**
 * What kind of source video this project is. Chosen at setup time and steers
 * highlight defaults, face tracking and 9:16 layout (crop vs letterbox).
 */
export type VideoType = 'auto' | 'talking-head' | 'podcast' | 'webinar' | 'product-demo'

/**
 * The kinds of moment clip selection tells apart. A small fixed set, so the
 * list can be varied by kind and the card can label it in a word or two.
 */
export type ClipKind = 'story' | 'insight' | 'opinion' | 'funny' | 'emotional' | 'explainer' | 'other'

/** Auto = follow the AI face track; manual = fixed focusX slider. */
export type FramingMode = 'auto' | 'manual'

/**
 * Whether the on-device reframe analysis (face tracking, active speaker
 * detection, layout classification) has run for a clip. The pipeline runs it
 * eagerly for the top-scoring clips only; the rest are 'pending' until the
 * clip is opened in the editor or exported. Absent on projects saved before
 * this existed, which loadProject treats as 'done'.
 */
export type ReframeStatus = 'pending' | 'done'

/** One step of the focus track (t in source seconds). */
export interface FocusKeyframe {
  t: number
  /**
   * Horizontal face centre in the source frame, 0 = far left, 1 = far right.
   * Export recentres the crop on this point (see faceCentreCropLeft).
   */
  x: number
  /**
   * True when this keyframe lands on a camera cut or speaker switch, where
   * the crop must snap instantly. Absent/false keyframes are within-shot
   * moves of the same person, which the crop reaches with a smooth pan.
   */
  cut?: boolean
  /** Planned pan duration in seconds for a within-shot move (default FOCUS_PAN_SEC). */
  pan?: number
}

export interface ClipEditState {
  aspect: AspectRatio
  reframeMode: ReframeMode
  framing: FramingMode
  /** A user choice; automatic analysis must not overwrite it. */
  compositionPreference?: 'auto' | 'content-first' | 'stacked' | 'content-only'
  /** False turns detected two-person split-screen ranges back into speaker crops. */
  speakerSplit?: boolean
  /** Source ranges the user cut out (always removed, ripple-closed). */
  cuts?: TimeRange[]
  /** Source ranges automatic pause removal took out that the user put back. */
  restored?: TimeRange[]
  /**
   * Pauses kept automatically because something happens in them (see
   * `Clip.gapActivity`) that the user chose to remove anyway. Any active
   * range overlapping one of these is not protected.
   */
  removedActive?: TimeRange[]
  /** Razor points (source seconds) dividing the timeline into selectable pieces. */
  splits?: number[]
  /** Explicit framing choice, even when its values match generated defaults. */
  layoutChosen?: boolean
  /** Remove long pauses and filler words ("um", "uh") from the clip. */
  tightenCuts: boolean
  /**
   * Scene-aware auto zoom: jump zooms covering tighten-cut joins, fast
   * punch-ins on energetic lines, slow creep on long static stretches.
   */
  autoZoom?: boolean
  /** Manual crop slider: 0 = far left, 0.5 = frame centre, 1 = far right. */
  focusX: number
  captionsEnabled: boolean
  captionStyleId: string
  /** Font family overriding the style's font (a custom uploaded font); null/absent = style default. */
  captionFontFamily?: string | null
  showTitle: boolean
  /**
   * Which captions burn in once the clip has an accepted translation
   * (`Clip.translation`): the original transcript, the translation, or both
   * (translation under the original, smaller). Absent means original.
   */
  captionLanguage?: CaptionLanguageMode
  /** Look of the hook title card; absent = 'card'. */
  titleStyle?: TitleStyleId
  /** Mark the clip's key words in the captions (bigger, accent colour). Absent = on. */
  emphasis?: boolean
  /** Draw a small emoji after some emphasised words. Absent = off. */
  emoji?: boolean
  /**
   * Replay the clip's strongest short line at the very start, then play the
   * clip from its beginning (see shared/coldOpen.ts). Absent = off.
   */
  coldOpen?: boolean
  /** Synthesised sound effects at joins, the cold-open seam and the title. Absent = off. */
  soundEffects?: boolean
  /** Background music from the music folder in Settings, ducked under speech. Absent = off. */
  music?: boolean
  /** File name of the chosen track inside the music folder; absent = picked automatically. */
  musicTrack?: string | null
  /** Trim overrides (absolute seconds in the source video). */
  start: number
  end: number
}

/** How a B-roll image is composited over the clip. */
export type BrollMode = 'fullscreen' | 'overlay'

export interface BrollItem {
  id: string
  /** The spoken word/phrase that triggered this insert, e.g. "Yoda". */
  trigger: string
  /** Image search query used, e.g. "Yoda Star Wars character". */
  query: string
  /** Absolute source-video seconds. */
  start: number
  end: number
  mode: BrollMode
  /** Local path of the downloaded image; null if no image was found. */
  imagePath: string | null
  /** Where the image came from (page URL) for attribution. */
  sourceUrl: string
  enabled: boolean
}

/** Per-part scores from the clip-selection rubric, each on its own scale. */
export interface ScoreBreakdown {
  hook: number
  emotion: number
  value: number
  structure: number
  shareability: number
  /** Visual review score (0-99) blended into the final score; absent until it runs. */
  visual?: number
}

export interface Clip {
  id: string
  /**
   * Whether the AI cut this clip out of the video or it is the whole video
   * captioned straight through. Undefined on clips saved before the mode
   * existed, which are all AI highlights.
   */
  origin?: ClipOrigin
  /** Evidence route for this suggestion; not a quality or popularity guarantee. */
  discovery?: { origin: 'transcript' | 'visual'; evidenceTimes?: number[] }
  editorial?: EditorialAssessment
  /**
   * Present when the AI joined separate moments of the source into this
   * clip. The join itself lives in `edit.cuts` like any other cut; this
   * records what was proposed and why, so the clip can say what it is.
   */
  stitch?: { segments: TimeRange[]; reason: string }
  /**
   * What sort of moment the AI judged this to be (a story, a tip, a hot
   * take…), used to vary the top of the list and shown on the clip card.
   * Absent on older clips, visual-only suggestions, and when the model did
   * not say.
   */
  kind?: ClipKind
  /** AI suggested boundaries (absolute seconds in the source video). */
  suggestedStart: number
  suggestedEnd: number
  title: string
  hook: string
  summary: string
  /** AI-generated social post caption (TikTok-style); null until generated. */
  caption?: string | null
  viralityScore: number
  viralityReason: string
  /**
   * The rubric parts behind `viralityScore` (see shared/scoreBreakdown.ts).
   * Absent on clips found before parts were recorded, on visual-only
   * suggestions, and when the model did not return them.
   */
  scoreBreakdown?: ScoreBreakdown
  /** One-line LLM assessment of what the visuals add/cost; null until scored. */
  visualSummary: string | null
  /** Visual action explicitly retained when speech-based tightening removes pauses. */
  visualStory?: {
    protectedRanges: Array<{ start: number; end: number }>
    reason: string
  }
  /**
   * Silent pauses with something happening in them — sustained picture
   * motion, or non-speech sound close to speech level — measured during
   * framing analysis (main/pipeline/gapActivity.ts). `active` is kept by
   * pause removal like `visualStory.protectedRanges`. Source seconds, so a
   * later trim change leaves them valid; gaps that only exist under a new
   * trim are simply unmeasured.
   */
  gapActivity?: {
    version: number
    /** The trim the measurement was taken for. */
    start: number
    end: number
    /** Every gap that was measured, active or not. */
    measured: TimeRange[]
    /** The parts of measured gaps to keep. */
    active: TimeRange[]
  }
  /** Source-frame review; conservative layout constraints for the inspected interval. */
  visualLayout?: {
    /** Incremented by manual source-region edits; protects them from in-flight analysis. */
    revision?: number
    start: number
    end: number
    preserveContext: boolean
    allowZoom: boolean
    reason: string
    /** Screen-only footage can be composed without active-speaker inference. */
    kind?: 'screen' | 'camera' | 'mixed'
    /** A stable proposal from the source review; never used without rendered verification. */
    panels?: { content: ContentRegion; presenter: ContentRegion }
    shots?: LayoutShot[]
  }
  hashtags: string[]
  thumbnailPath: string | null
  /** AI face track for auto reframing; null when no usable faces were found. */
  focusTrack: FocusKeyframe[] | null
  /** See ReframeStatus. Undefined means done (older projects). */
  reframeStatus?: ReframeStatus
  /** Source interval actually analysed; trimming inside it can reuse the result. */
  reframeAnalysis?: {
    start: number
    end: number
    version: number
    revision?: number
    /** The stretches analysed when the trim joins distant moments; absent = all of start..end. */
    ranges?: TimeRange[]
  }
  /**
   * Whether the clip is mostly a talking head or a screencast/demo/slides.
   * Set during analysis; null on older projects until re-analysed.
   */
  contentType?: ClipContentType | null
  /** AI-suggested image inserts timed to spoken keywords. */
  broll: BrollItem[]
  /** AI caption translation, reviewed in the editor before use. */
  translation?: ClipTranslation
  /** AI voice dub of the accepted translation. */
  dub?: ClipDub
  /**
   * Key words to emphasise in the captions, chosen by the visual review.
   * Absent means the deterministic heuristic picks them (shared/captionEmphasis.ts).
   */
  emphasis?: CaptionEmphasis
  /** Where faces and burned-in text sit in the source, so captions can stay clear. */
  captionSafety?: CaptionSafety
  edit: ClipEditState
}

/** Hook title looks, shared by the preview and the burned-in ASS. */
export type TitleStyleId = 'card' | 'bold' | 'banner'

export interface CaptionEmphasisWord {
  /** One spoken word, as transcribed (matched case- and punctuation-insensitively). */
  text: string
  /** Optional emoji from the bundled set (CAPTION_EMOJI) drawn after the word. */
  emoji?: string
}

export interface CaptionEmphasis {
  source: 'ai'
  words: CaptionEmphasisWord[]
}

/** A face's vertical extent over a stretch of source time (normalised source y). */
export interface FaceBand { start: number; end: number; top: number; bottom: number }

export interface CaptionSafety {
  version: number
  /** The source span the measurement covers. */
  start: number
  end: number
  /** The tracked speaker's face over time; empty when no faces were tracked. */
  faces: FaceBand[]
  /**
   * A band of persistent burned-in text (subtitles, a ticker) in the lower
   * part of the source frame, normalised source y; null when none was seen.
   */
  textBand: { top: number; bottom: number } | null
}

/** Normalized source rectangle; fit it intact instead of discarding its edges. */
export interface ContentRegion { x: number; y: number; width: number; height: number }

/** Independent crops of one source frame, rendered on one playback clock. */
export interface Composition {
  version: 1
  /** `speakers`: two people from one wide shot, stacked, during a quick exchange. */
  preset: 'content-first' | 'stacked' | 'content-only' | 'speakers'
  layers: Array<{ role: 'content' | 'presenter' | 'speaker'; source: ContentRegion; target: ContentRegion }>
  captionY: number
}

export interface LayoutShot {
  start: number
  end: number
  mode: 'crop' | 'fit'
  region?: ContentRegion
  overview?: boolean
  composition?: Composition
  /** Sampled layout review only, never a claim of verified editorial quality. */
  review?: { status: 'checked' | 'needs-review'; reason: string }
}

export interface Project {
  /** Increments on relink so in-flight analysis of an older source cannot land. */
  sourceRevision?: number
  id: string
  createdAt: number
  updatedAt: number
  name: string
  video: VideoInfo
  transcript: Transcript | null
  clips: Clip[]
  /** Custom instructions the user gave the AI, if any. */
  prompt: string
  /** Source format chosen at setup; steers layout and face-tracking behaviour. */
  videoType: VideoType
  /** Opt-in source-wide sampled visual discovery used for this generation. */
  visualDiscovery?: boolean
  discoveryReport?: SourceDiscoveryReport
  rankingEnabled?: boolean
  /** Identifies the generation that produced the current highlight list. */
  clipsGenerationId?: string
  editorialRanking?: EditorialRankingReport
  /** Flow that last ran on this project; absent on clip-finding projects. */
  mode?: ProjectMode
  /** Reuse licence reported for a URL import; absent for local files. */
  importLicence?: ImportLicence
  /**
   * Set when the current clip list was re-ranked from the user's own
   * export and edit history (see shared/personalisation.ts).
   */
  personalised?: { generationId: string; positives: number }
  /**
   * True when the source video no longer exists on disk (moved/deleted).
   * Transient — recomputed on load, never persisted.
   */
  sourceMissing?: boolean
}

/** What a URL import's source said about reuse. */
export interface ImportLicence {
  url: string
  /** The licence as the site reports it; null when it reports none. */
  license: string | null
  /** True for Creative Commons and public-domain licences. */
  reusable: boolean
}

export interface ProjectSummary {
  id: string
  createdAt: number
  updatedAt: number
  name: string
  videoPath: string
  videoFileName: string
  durationSec: number
  /** AI-found clips only; the full-video edit is not one of them. */
  clipCount: number
  thumbnailPath: string | null
  mode: ProjectMode
}

export type PipelineStage =
  | 'probe'
  | 'audio'
  | 'transcribe'
  | 'analyze'
  | 'reframe'
  | 'broll'
  | 'thumbnails'
  | 'done'

export interface PipelineProgress {
  stage: PipelineStage
  /** 0..1 within the whole pipeline. */
  progress: number
  message: string
}

export interface AnalyzeOptions {
  /** Optional user steering prompt ("ClipAnything" style). */
  prompt: string
  clipLength: ClipLengthPreference
  /** Generate AI B-roll image inserts timed to spoken keywords. */
  broll: boolean
  /** Trim each clip's start so it opens on its hook line instead of setup. */
  hookFirst: boolean
  /** Source format; steers per-clip layout and whether face tracking runs. */
  videoType: VideoType
  /** Additional bounded source-frame analysis through the configured provider. */
  visualDiscovery?: boolean
  /** Explicit opt-in while provider behavior and quality are being evaluated. */
  editorialRanking?: boolean
  /**
   * Let a clip join two or three separate moments (a question and its answer
   * with the tangent between removed, a setup and its later payoff). Every
   * join is reviewed for coherence and for keeping the speaker's meaning.
   */
  stitch?: boolean
}

export type ClipLengthPreference = 'auto' | 'short' | 'medium' | 'long'

/**
 * Options for "caption whole video": no clip finding, no virality scoring —
 * transcribe the video, reframe it and caption it end to end.
 */
export interface CaptionVideoOptions {
  /** Output shape the whole video is reframed to (9:16 for vertical). */
  aspect: AspectRatio
  /**
   * Run active-speaker face tracking across the whole video so the crop
   * follows whoever is talking. Local, on-device and slow — it samples at
   * 25 fps, so long videos take minutes.
   */
  followSpeaker: boolean
  /** Scene-aware punch-ins and slow creep, same plan the clip editor uses. */
  autoZoom: boolean
}

export interface ExportOptions {
  clipId: string
  /** Target directory; a file name is derived from the clip title. */
  outputDir: string
}

/** Editing-timeline formats offered by "Export edit for…". */
export type NleFormat = 'fcpxml' | 'xmeml'

export interface NleExportOptions {
  clipId: string
  format: NleFormat
  /** Target directory; file names are derived from the clip title. */
  outputDir: string
}

export interface NleExportResult {
  clipId: string
  format: NleFormat
  /** The timeline file (.fcpxml or .xml). */
  outputPath: string
  /** Caption sidecar, when the project has a transcript with words in the clip. */
  srtPath: string | null
  /** Clips on the timeline (kept segments after pause removal and cuts). */
  segments: number
}

/** Local learning from which clips the user keeps (see shared/personalisation.ts). */
export interface PersonalisationSummary {
  enabled: boolean
  /** Distinct clips exported or edited. */
  positives: number
  /** Clips recorded in all. */
  recorded: number
  /** Positives needed before re-ranking starts. */
  minPositives: number
  /** True when new runs are being re-ranked. */
  active: boolean
}

export type BatchItemSource = { kind: 'file'; path: string } | { kind: 'url'; url: string }

export type BatchItemStatus = 'queued' | 'importing' | 'analysing' | 'done' | 'failed' | 'cancelled'

export interface BatchItem {
  id: string
  source: BatchItemSource
  /** File name or URL, until the import names the project. */
  label: string
  /** Settings snapshot taken when the item was added. */
  options: AnalyzeOptions
  status: BatchItemStatus
  /** 0..1 within this item, or -1 when indeterminate. */
  progress: number
  message: string
  error?: string
  /** Set once the import has created the project. */
  projectId?: string
  clipCount?: number
  /** Reuse licence of a URL import, once known. */
  licence?: ImportLicence
  addedAt: number
}

export interface BatchQueueState {
  items: BatchItem[]
  /** True while the queue works through its items. */
  running: boolean
}

export interface ExportProgress {
  clipId: string
  progress: number
  message: string
}

/** Layout analysis for a clip running after the clip list is shown. */
export type BackgroundReframeEvent =
  | { projectId: string; clipId: string; state: 'running' }
  | { projectId: string; clipId: string; state: 'done'; clip: Clip }
  | { projectId: string; clipId: string; state: 'failed'; message: string }

export interface ExportResult {
  clipId: string
  outputPath: string
  /** Size of the finished file, in bytes. */
  bytes: number
  /**
   * Byte cap the encode was planned against, when size-targeted export is on.
   * Absent for ordinary quality-targeted renders.
   */
  sizeTargetBytes?: number
  /** True when the planner had to shrink the frame to hit the cap. */
  downscaled?: boolean
  /**
   * True when even the minimum scale could not reach a healthy bits-per-pixel
   * at this duration — the picture will look soft. Does not guarantee the
   * file stays under the cap; compare `bytes` to `sizeTargetBytes`.
   */
  overBudget?: boolean
  /** What the check after the render found and repaired (main/pipeline/exportCheck.ts). */
  check?: ExportCheckReport
  /**
   * Set when the clip's animated caption style could not be drawn and the
   * file has its libass equivalent instead: one sentence saying so and why.
   */
  captionNotice?: string
}

/** One thing the post-export check noticed. Times are seconds into the exported file. */
export interface ExportCheckFinding {
  kind: 'black' | 'freeze' | 'silence-start' | 'silence-end' | 'loudness' | 'true-peak' | 'mid-word'
  /** One plain sentence for the person exporting. */
  message: string
  at?: number
  duration?: number
  /** Fixed in the saved file; reported so the change is not a surprise. */
  repaired?: boolean
}

export interface ExportCheckReport {
  /** 'skipped' when the check could not run (it never fails an export). */
  status: 'checked' | 'skipped'
  findings: ExportCheckFinding[]
  /** Wall-clock seconds the check and any repair added to the export. */
  seconds: number
  /** Measured on the saved file. */
  loudness?: { integratedLufs: number; truePeakDb: number }
  /** Why the check was skipped. */
  note?: string
}

export type EncoderPreference = 'auto' | 'cpu' | 'gpu'
export type QualityPreference = 'draft' | 'standard' | 'high'

/** Corner where the branding watermark is composited. */
export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * Saved brand palette applied as defaults across caption styles when enabled.
 * Primary is the main pop colour (word highlight or pill fill); secondary is
 * the active-word text on pill/box presets.
 */
export interface BrandColors {
  enabled: boolean
  primaryColor: string
  secondaryColor: string
  /** When set, overrides the preset base caption text colour. */
  textColor: string | null
  /** When set, overrides the preset caption outline colour. */
  outlineColor: string | null
  hookTextColor: string
  hookBackgroundColor: string
}

/**
 * Editable brand tone-of-voice and style guidance that steers AI caption
 * generation. All fields are free text; an empty string means "no preference"
 * and the generator falls back to sensible defaults.
 */
export interface BrandVoiceSettings {
  /** Organisation/brand name, woven into captions where it reads naturally. */
  brandName: string
  /** How the brand should sound, e.g. "warm, upbeat, human, never salesy". */
  tone: string
  /** Writing style/format rules, e.g. "British English, short sentences, no emojis". */
  style: string
  /** Things to avoid, e.g. "no hashtags, no hype, no corporate jargon". */
  avoid: string
}

/** App-wide branding applied to the preview and burned into exports. */
export interface BrandingSettings {
  enabled: boolean
  /** Absolute path of the watermark/logo image (copied into userData); null = none. */
  imagePath: string | null
  position: WatermarkPosition
  /** 0..1 watermark opacity. */
  opacity: number
  /** Watermark width as a fraction of the output video width. */
  scale: number
  colors: BrandColors
}

/**
 * Browser whose cookie store yt-dlp borrows for URL imports that need a
 * login (private/unlisted videos, enterprise Vimeo behind SSO). Empty string
 * = no login. Values map 1:1 to yt-dlp's --cookies-from-browser.
 */
export type BrowserCookieSource =
  | ''
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'brave'
  | 'opera'
  | 'vivaldi'
  | 'safari'

/** Result of comparing the running app against the latest GitHub release. */
export interface UpdateCheckResult {
  currentVersion: string
  /** Version of the latest published release; null when none exist. */
  latestVersion: string | null
  updateAvailable: boolean
  /** GitHub release page to download the update from. */
  releaseUrl: string | null
  /** The latest release's notes (its CHANGELOG section), when published. */
  releaseNotes?: string | null
  /**
   * True when the app can download and install the update itself. Unsigned
   * packaged Macs use a manual download; source checkouts pull and rebuild.
   */
  autoUpdateSupported: boolean
  /** Download a verified installer; user replaces the unsigned Mac app. */
  manualDownloadSupported?: boolean
  availabilityMessage?: string
  /**
   * True when this copy is a git checkout the app can update in place by
   * pulling and rebuilding itself (the one-click path for source installs).
   */
  sourceUpdateSupported: boolean
  /** Human-readable failure (offline, rate limited); null on success. */
  error: string | null
  checkedAt: number
}

export interface UpdateDownloadState {
  status: 'idle' | 'downloading' | 'downloaded' | 'error'
  progress: number
  version?: string
  mode?: 'restart' | 'manual'
  error?: string
}

/** A user-uploaded caption font stored in userData/fonts. */
export interface CustomFont {
  /** Family name parsed from the font file (what libass and CSS match on). */
  family: string
  fileName: string
  /** Absolute path for renderer @font-face loading via media://. */
  path: string
}

export interface GpuEncoderStatus {
  /** True when a working hardware encoder was verified with a test encode. */
  available: boolean
  /** Human-readable status, e.g. "NVENC ready via system ffmpeg". */
  detail: string
  /** True when a GPU-capable ffmpeg build can be downloaded to enable it. */
  canDownloadFfmpeg: boolean
}

export interface AppSettings {
  /** False only on a fresh installation until onboarding is finished or skipped. */
  setupComplete: boolean
  subscription: SubscriptionSettings
  /** Masked key for display, e.g. "sk-...abcd". Empty string when unset. */
  apiKeyMasked: string
  hasApiKey: boolean
  /**
   * True when the OS keychain (Electron safeStorage) protects the API key;
   * false when it is stored only obfuscated on disk (e.g. headless Linux).
   */
  keyStorageSecure: boolean
  transcriptionModel: string
  /**
   * Language for Whisper transcription: an ISO-639-1 code (e.g. 'en') that is
   * sent to Whisper so it does not auto-detect and occasionally guess wrong
   * (e.g. labelling English as Welsh). 'auto' lets Whisper detect per video.
   */
  transcriptionLanguage: string
  analysisModel: string
  /** True when an OpenRouter key is stored (or OPENROUTER_API_KEY is set). */
  hasOpenRouterKey: boolean
  /** Masked OpenRouter key for display. Empty string when unset. */
  openRouterKeyMasked: string
  /** OpenRouter model id used for clip analysis, e.g. "openai/gpt-5.4-mini". */
  openRouterModel: string
  /**
   * OpenRouter transcription model id, e.g. "openai/whisper-1". Unused while
   * `subscription.localTranscription` is on.
   */
  openRouterTranscriptionModel: string
  /**
   * OpenAI-compatible chat base URL (Azure, OpenRouter, Groq, LM Studio,
   * Ollama). Empty string means the OpenAI default, unless OPENAI_BASE_URL
   * is set in the environment.
   */
  openaiBaseUrl: string
  /**
   * Optional Whisper transcription base URL, for a local Whisper server
   * next to a hosted LLM. Empty string means "same as the chat base".
   */
  transcriptionBaseUrl: string
  /**
   * True when OPENAI_BASE_URL is set, so the Settings fields are ignored
   * for the chat (and, unless OPENAI_TRANSCRIPTION_BASE_URL is also set,
   * transcription) endpoint.
   */
  openaiBaseUrlFromEnv: boolean
  encoder: EncoderPreference
  quality: QualityPreference
  /**
   * Hard file-size cap for exports, in megabytes. Null means ordinary
   * quality-targeted encoding (the quality tier above applies).
   */
  sizeTargetMb: number | null
  gpu: GpuEncoderStatus
  branding: BrandingSettings
  brandVoice: BrandVoiceSettings
  appVersion: string
  /** Browser to borrow login cookies from for URL imports ('' = none). */
  importCookiesBrowser: BrowserCookieSource
  /** True when a Netscape cookies.txt file is stored for URL imports. */
  hasImportCookiesFile: boolean
  /** Folder background music is picked from; null when none was chosen. */
  musicFolder: string | null
}

export interface SettingsUpdate {
  setupComplete?: boolean
  subscription?: Partial<SubscriptionSettings>
  apiKey?: string
  transcriptionModel?: string
  transcriptionLanguage?: string
  analysisModel?: string
  /** Stored encrypted; an empty string removes the stored key. */
  openRouterKey?: string
  openRouterModel?: string
  openRouterTranscriptionModel?: string
  openaiBaseUrl?: string
  transcriptionBaseUrl?: string
  encoder?: EncoderPreference
  quality?: QualityPreference
  /** Megabyte cap for size-targeted export; null/0 clears it. */
  sizeTargetMb?: number | null
  branding?: Partial<BrandingSettings>
  brandVoice?: Partial<BrandVoiceSettings>
  importCookiesBrowser?: BrowserCookieSource
  clearImportCookiesFile?: boolean
  /** Background music folder; null clears it. */
  musicFolder?: string | null
}

export interface PipelineError {
  message: string
  stage: PipelineStage
}

export interface ImportProgress {
  /** 0..1, or -1 when indeterminate. */
  progress: number
  message: string
  /** A URL import's reuse licence, sent once the metadata is read. */
  licence?: ImportLicence
}

/** Editor timeline data for a window of the source video. */
export interface TimelineData {
  /** Absolute paths of filmstrip frames, in time order. */
  frames: string[]
  /** Normalised 0..1 RMS per bucket across the window (empty when no audio). */
  waveform: number[]
}

/** See `ClipEditState.captionLanguage`. */
export type CaptionLanguageMode = 'original' | 'translated' | 'both'

/**
 * One translated sentence. `start`/`end` span the source sentence's played
 * words (absolute source seconds): the translation plays in that slot.
 */
export interface TranslationLine {
  start: number
  end: number
  /** The original sentence as it was sent (only the words that played). */
  source: string
  /** The translation (or the original, when the model skipped the line). */
  text: string
  /** The model returned nothing usable for this line; `text` is the original. */
  untranslated?: boolean
  /** The user changed `text` in the review panel. */
  edited?: boolean
  /** Protected terms or numbers from the source that `text` lost. */
  warnings?: string[]
}

export interface ClipTranslation {
  version: 1
  /** Target language as the user chose or typed it, e.g. "Spanish". */
  language: string
  /** BCP-47 code when the language came from the list (e.g. "es"). */
  languageCode?: string
  /** Terms the creator asked to keep unchanged. */
  doNotTranslate?: string[]
  lines: TranslationLine[]
  /** True once any line was edited by hand. */
  edited: boolean
  /** Reviewed and accepted in the editor; until then it is not displayed. */
  accepted: boolean
  createdAt: number
}

/** How a synthesised line was made to fit its slot. */
export type DubFit = 'natural' | 'faster' | 'stretched' | 'truncated'

export interface DubLine {
  /** Source slot of the translation line it voices (absolute seconds). */
  start: number
  end: number
  /** The text synthesised; a later edit to the line makes it stale. */
  text: string
  /** Cached synthesised audio in the project folder. */
  audioPath: string
  /** Length of the synthesised audio at normal tempo, in seconds. */
  audioSec: number
  /** Tempo applied on playback and export (1 = none, at most DUB_MAX_TEMPO). */
  tempo: number
  fit: DubFit
}

export interface ClipDub {
  version: 1
  provider: 'openai' | 'openrouter'
  model: string
  voice: string
  /** Mix the dub into the preview and the export. */
  enabled: boolean
  lines: DubLine[]
  createdAt: number
}
