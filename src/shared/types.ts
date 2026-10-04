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
}

export type AspectRatio = '9:16' | '1:1' | '16:9' | 'original'

/** How the source frame is fitted into the target aspect ratio. */
export type ReframeMode = 'crop' | 'fit-blur' | 'fit-letterbox'

/** Detected clip content — steers 9:16 layout (crop + zoom vs letterbox). */
export type ClipContentType = 'speaker' | 'screencast'

/**
 * How a clip came to exist: a moment the AI cut out of a longer video, or the
 * whole source video captioned straight through ("caption whole video" mode),
 * or a shot from an imported Metachlorian package (see docs/metachlorian-handoff.md).
 * Absent on projects saved before that mode existed; loadProject fills it in.
 */
export type ClipOrigin = 'ai-highlight' | 'whole-video' | 'package'

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
  /** Trim overrides (absolute seconds in the source video). */
  start: number
  end: number
}

/** How a B-roll image is composited over the clip. */
export type BrollMode = 'fullscreen' | 'overlay'

/** What a B-roll insert shows: a still image, or a stretch of a video file. */
export type BrollKind = 'image' | 'video'

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
  /** Absent means 'image' (every insert saved before video inserts existed). */
  kind?: BrollKind
  /**
   * Video inserts only: seconds into the media file where the insert starts.
   * The insert plays from here for `end - start` seconds; absent means 0.
   */
  mediaIn?: number
  /**
   * Local path of the downloaded image, or of the video file for a video
   * insert; null if no image was found.
   */
  imagePath: string | null
  /** Where the image came from (page URL) for attribution. */
  sourceUrl: string
  enabled: boolean
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
  /** One-line LLM assessment of what the visuals add/cost; null until scored. */
  visualSummary: string | null
  /** Visual action explicitly retained when speech-based tightening removes pauses. */
  visualStory?: {
    protectedRanges: Array<{ start: number; end: number }>
    reason: string
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
  reframeAnalysis?: { start: number; end: number; version: number; revision?: number }
  /**
   * Whether the clip is mostly a talking head or a screencast/demo/slides.
   * Set during analysis; null on older projects until re-analysed.
   */
  contentType?: ClipContentType | null
  /** AI-suggested image inserts timed to spoken keywords. */
  broll: BrollItem[]
  edit: ClipEditState
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
  /** Set when the project was imported from a Metachlorian handoff package. */
  handoff?: ProjectHandoff
  /**
   * True when the source video no longer exists on disk (moved/deleted).
   * Transient — recomputed on load, never persisted.
   */
  sourceMissing?: boolean
}

/** Rights as Metachlorian decided them when it built the package. */
export interface HandoffRights {
  /** allowed | restricted | blocked | unknown. Anything but allowed is shown as a warning. */
  verdict: string
  /** Credit lines the included footage requires. */
  credits: string[]
  /** Earliest licence expiry across the included footage (YYYY-MM-DD). */
  earliestExpiry?: string
  /** Why the verdict is not allowed, one human-readable line each. */
  reasons?: string[]
}

/** Where an imported project came from, kept for the rights banner and later migrations. */
export interface ProjectHandoff {
  packageId: string
  schemaVersion: string
  /** Base URL of the Metachlorian instance that built the package. */
  instance?: string
  rights: HandoffRights
  /** Package name as Metachlorian recorded it. */
  packageName?: string
  importedAt?: number
  /** Import notes worth keeping visible, e.g. a transcript Cutawan could not use. */
  notes?: string[]
}

/** Status of a package import started from the command line; `importId` ties progress to its outcome. */
export type HandoffEvent =
  | { importId: number; state: 'importing'; progress: number; message: string }
  | { importId: number; state: 'done'; projectId: string }
  | { importId: number; state: 'failed'; message: string }

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
}

export interface PipelineError {
  message: string
  stage: PipelineStage
}

export interface ImportProgress {
  /** 0..1, or -1 when indeterminate. */
  progress: number
  message: string
}

/** Editor timeline data for a window of the source video. */
export interface TimelineData {
  /** Absolute paths of filmstrip frames, in time order. */
  frames: string[]
  /** Normalised 0..1 RMS per bucket across the window (empty when no audio). */
  waveform: number[]
}
