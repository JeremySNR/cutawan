import { writeFile, mkdir, rm, stat, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  AspectRatio,
  BrandingSettings,
  Clip,
  FocusKeyframe,
  QualityPreference,
  Transcript,
  VideoInfo,
  WatermarkPosition
} from '@shared/types'
import type { EncoderPreference, ExportCheckReport } from '@shared/types'
import type { KeptSegment } from '@shared/tighten'
import { ClipTimeline, clipTimeline, clipTimelineParts, mapTimedToOutput, timelineFocusTrack, timelineTranscript } from '@shared/clipTimeline'
import { clipCaptionPositionRanges } from '@shared/captionPlacement'
import {
  MUSIC_BED_LU,
  MUSIC_FADE_IN_SEC,
  MUSIC_FADE_OUT_SEC,
  SFX_EXPRESSIONS,
  SFX_SPECS,
  WHOOSH_BAND,
  WHOOSH_ENVELOPE_EXPR,
  dbToGain,
  type SfxCue
} from '@shared/audioMix'
import { clipCaptionOptions, clipSoundEffects } from '@shared/clipOverlays'
import { SEPARATE_STRETCH_GAP_SEC, limitStretches, sourceStretches } from '@shared/clipSegments'
import type { TimeRange } from '@shared/types'
import { focusPanDuration, focusSnaps } from '@shared/focusTrack'
import { automaticLayoutShots, clipAllowsAutoZoom, compositionHidesTitle, layoutBlocksAutoZoom } from '@shared/contentType'
import { compositionGraph, fitRegionGraph } from './layoutFilters'
import { getCaptionStyle, libassCaptionStyleId, resolveCaptionStyle } from '@shared/captionStyles'
import { animatedCaptionPlan, type AnimatedCaptionPlan } from '@shared/animatedCaptions'
import { planTitle } from '@shared/titleLayout'
import {
  CaptionRendererError,
  captionFallbackNotice,
  captionFrameInputArgs,
  openCaptionFrames,
  writeCaptionFrames,
  type CaptionFrameSession
} from './animatedCaptions'
import { computeZoomEvents, fitZoomEvents, remapZoomEvents, type ZoomEvent } from '@shared/zoom'
import { planUploadEncode, type UploadEncodePlan } from '@shared/uploadBudget'
import { FFMPEG_PATH, probeVideo, runFfmpegWith } from './ffmpeg'
import { timed } from './timing'
import { loudnormFilter, measureLoudness, measureLoudnessOfRanges, normalisationMode, type LoudnessStats } from './loudness'
import { buildAss, fontsDir } from './captions'
import { translatedCaptionPlan } from '@shared/captionTranslation'
import { prepareDubTrack, withDubMix } from './dub'
import { checkExport } from './exportCheck'
import { fontMetricsForFamily } from '../fonts'
import { mediaJobs } from './mediaJobs'
import {
  audioArgs,
  encoderArgs,
  passLogFiles,
  resolveEncoder,
  sizeTargetedVideoArgs
} from './encoders'

/**
 * Put every kept segment's edges on the source's frame grid, so each piece's
 * video and audio are exactly the same length.
 *
 * `trim` keeps whole frames (those whose timestamp falls inside the range)
 * while `atrim` cuts at the exact sample, so a cut between two frames left
 * each piece's video up to a frame longer or shorter than its audio. Concat
 * joins the pieces end to end, so the offset between picture and sound
 * wanders by up to a frame at every cut (the errors partly cancel by the
 * end, which is why the total length looked right). Edges go a quarter frame
 * before a frame's timestamp, so which frames a piece holds is never left to
 * floating-point rounding, and every piece is a whole number of frames long
 * for both streams. The audio then leads its frames by at most a quarter
 * frame, constantly rather than cumulatively. Pieces that vanish are
 * dropped; the first edge never moves before the trim, the last never past
 * it. Exported for tests.
 */
export function alignSegmentsToFrames(
  segments: KeptSegment[] | null,
  fps: number,
  trimStart: number,
  trimEnd: number
): KeptSegment[] | null {
  if (!segments || !(fps > 1 && fps < 240)) return segments
  const edge = (t: number): number => (Math.round(t * fps) - 0.25) / fps
  const out: KeptSegment[] = []
  for (const segment of segments) {
    const start = Math.max(trimStart, edge(segment.start))
    const end = Math.min(trimEnd, edge(segment.end))
    if (end - start < 0.5 / fps) continue
    const last = out[out.length - 1]
    // Two pieces that now meet are one piece.
    if (last && start <= last.end + 1e-9) last.end = Math.max(last.end, end)
    else out.push({ start, end })
  }
  return out
}

/**
 * Gentle audio fade at the clip tail so endings never cut off abruptly —
 * short enough to stay inside the post-roll padding after the last word.
 */
const END_FADE_SEC = 0.4

/**
 * Most times one export opens the source. Past this the shortest gaps are
 * decoded through instead: every input is its own decoder.
 */
const MAX_SOURCE_INPUTS = 6

/**
 * Longest filter graph still passed as a command-line argument. Anything
 * bigger is handed to ffmpeg as a script file — see renderClip.
 */
const FILTER_ARG_MAX_CHARS = 8000

/**
 * Most pieces one ffmpeg expression may hold. Its parser gives up at around
 * 85 — measured on ffmpeg 6.1 and 8.1, and the same however the pieces are
 * arranged, whether nested `if()`s or a flat sum. Long focus tracks and zoom
 * plans are kept within this by other means (see buildFocusPlan,
 * fitZoomEvents).
 */
const MAX_EXPRESSION_PIECES = 64

/**
 * Loudness-normalised master chain: linear normalisation when the source was
 * measured (see loudness.ts), the single-pass filter otherwise; loudnorm
 * resamples internally, so the rate is pinned back to 48 kHz after it.
 */
export function speechSafeFade(transcript: Transcript | null, start: number, end: number): number {
  if (!transcript) return 0
  const words = transcript.segments.flatMap((segment) => segment.words)
    .filter((word) => word.end > start && word.start < end)
  if (!words.length) return 0
  const lastEnd = Math.max(...words.map((word) => word.end))
  // Leave 50 ms after the aligned speech boundary before fading background audio.
  return Math.min(END_FADE_SEC, Math.max(0, end - lastEnd - 0.05))
}

function audioChain(clipDuration: number, loudness: LoudnessStats | null, tailSec = 0): string {
  // FFmpeg 6 on macOS cannot always infer a layout after loudnorm's resampler.
  // Exports use stereo AAC; constrain the filter link too, before the fade.
  const master = `${loudnormFilter(loudness)},aresample=48000,aformat=channel_layouts=stereo`
  const fade = Math.min(END_FADE_SEC, Math.max(0, tailSec))
  if (fade < 0.01 || clipDuration <= fade * 3) return master
  const st = (clipDuration - fade).toFixed(3)
  return `${master},afade=t=out:st=${st}:d=${fade.toFixed(3)}`
}

function targetDims(aspect: AspectRatio, source: VideoInfo): { w: number; h: number } {
  switch (aspect) {
    case '9:16':
      return { w: 1080, h: 1920 }
    case '1:1':
      return { w: 1080, h: 1080 }
    case '16:9':
      return { w: 1920, h: 1080 }
    case 'original': {
      // Cap at 1920 on the long edge, keep even dimensions.
      const scale = Math.min(1, 1920 / Math.max(source.width, source.height))
      const w = Math.round((source.width * scale) / 2) * 2
      const h = Math.round((source.height * scale) / 2) * 2
      return { w, h }
    }
    default: {
      const exhaustive: never = aspect
      return exhaustive
    }
  }
}

/** Escape a filesystem path for use inside an ffmpeg filter argument. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * A piecewise value over time, as a sum of gated pieces: piece `i` applies
 * while `t_i <= T < t_{i+1}`, the last piece runs to the end, and the first
 * piece's own `from` is ignored — it covers everything before the second
 * piece. Exactly one gate is ever open, so the sum is that piece's value.
 *
 * Flat by design. The obvious shape for this is nested `if(lt(T,…),…,…)`,
 * which is what these expressions used to be, but ffmpeg's expression parser
 * gives up at around a hundred levels of nesting ("Missing ')' or too many
 * args") — and a whole-video focus track or zoom plan runs to hundreds of
 * pieces. A sum stays shallow no matter how many there are.
 *
 * Each piece's value must be a bare number or already parenthesised; the
 * helper wraps it either way so a piece can never swallow the next `+`.
 */
function piecewiseExpression(pieces: Array<{ from: number; value: string }>, time: string): string {
  if (pieces.length === 1) return pieces[0].value
  return pieces
    .map((piece, i) => {
      const next = pieces[i + 1]
      const value = `(${piece.value})`
      if (i === 0) return `lt(${time},${next.from.toFixed(3)})*${value}`
      const opens = `gte(${time},${piece.from.toFixed(3)})`
      return next ? `${opens}*lt(${time},${next.from.toFixed(3)})*${value}` : `${opens}*${value}`
    })
    .join('+')
}

/** Focus keyframes in clip-relative time, or null when framing is manual. */
function focusSteps(clip: Clip): FocusKeyframe[] | null {
  const track = clip.focusTrack
  if (clip.edit.framing !== 'auto' || !track || track.length === 0) return null
  // Keyframes are in source time; renders seek with -ss so t starts at 0.
  const steps: FocusKeyframe[] = track.map((kf) => ({
    ...kf,
    t: kf.t - clip.edit.start,
    x: Math.max(0, Math.min(1, kf.x))
  }))
  // Collapse keyframes at/before the clip start into a single base value.
  while (steps.length > 1 && steps[1].t <= 0) steps.shift()
  return steps
}

/**
 * The focus value at keyframe `i`: a constant where the crop snaps (camera
 * cuts, speaker switches) and a smoothstep pan for within-shot moves of the
 * same person, the same curve as focusAt. (Hard-stepping the crop on every
 * refocus of a moving speaker read as camera shake, magnified further
 * whenever the auto zoom was pushed in.)
 */
function focusValue(steps: FocusKeyframe[], i: number): string {
  const kf = steps[i]
  if (i === 0 || focusSnaps(steps, i)) return kf.x.toFixed(4)
  const previous = steps[i - 1].x
  const dur = focusPanDuration(steps, i)
  const p = `min(1,max(0,(t-${kf.t.toFixed(3)})/${dur.toFixed(3)}))`
  return `(${previous.toFixed(4)}+${(kf.x - previous).toFixed(4)}*${p}*${p}*(3-2*${p}))`
}

/**
 * Wrap a focus value as a crop x offset. Auto tracks store a face centre, so
 * the window is centred on it; manual focusX is already a crop slider along
 * [0,1]. (The preview does the same via object-position.)
 */
function cropXExpression(focus: string, isAutoFace: boolean): string {
  return isAutoFace ? `max(0,min(iw-ow,iw*(${focus})-ow/2))` : `(iw-ow)*${focus}`
}

/**
 * Keep every nth keyframe so at most `max` remain, first one always kept.
 * Only used as a fallback when the crop cannot be driven by commands — see
 * buildFocusPlan.
 */
function thinFocusSteps(steps: FocusKeyframe[], max: number): FocusKeyframe[] {
  if (steps.length <= max) return steps
  const stride = Math.ceil(steps.length / max)
  return steps.filter((_, i) => i % stride === 0)
}

export interface FocusPlan {
  /** Crop x expression the filter is configured with. */
  x: string
  /**
   * sendcmd script retargeting crop x over time, or null when the expression
   * above already covers the whole clip.
   */
  commands: string | null
}

/**
 * How the crop follows the speaker.
 *
 * Short tracks become one piecewise expression. Long ones cannot: ffmpeg's
 * expression parser gives up at roughly 85 pieces however they are arranged
 * (measured on 6.1 and 8.1), and a whole-video track runs to hundreds. Those
 * are driven by a sendcmd script instead — one command per keyframe, each
 * setting a short expression, with no limit on how many there are.
 *
 * sendcmd targets filters by class name, so it would also retarget the crop
 * that fullscreen B-roll uses to cover the frame. When the graph has one of
 * those, `allowCommands` is false and the track is thinned to fit an
 * expression instead.
 */
export function buildFocusPlan(clip: Clip, allowCommands: boolean): FocusPlan {
  const steps = focusSteps(clip)
  if (!steps) {
    const focusX = Math.max(0, Math.min(1, clip.edit.focusX)).toFixed(4)
    return { x: cropXExpression(focusX, false), commands: null }
  }

  const expression = (kfs: FocusKeyframe[]): string =>
    cropXExpression(
      piecewiseExpression(
        kfs.map((kf, i) => ({ from: Math.max(0, kf.t), value: focusValue(kfs, i) })),
        't'
      ),
      true
    )

  if (steps.length <= MAX_EXPRESSION_PIECES) return { x: expression(steps), commands: null }
  if (!allowCommands) return { x: expression(thinFocusSteps(steps, MAX_EXPRESSION_PIECES)), commands: null }

  // One command per keyframe. The filter starts on the first value so the
  // opening frames are framed correctly even before the first command fires.
  const commands = steps
    .map(
      (kf, i) =>
        `${Math.max(0, kf.t).toFixed(3)} crop x '${cropXExpression(focusValue(steps, i), true)}';`
    )
    .join('\n')
  return { x: cropXExpression(steps[0].x.toFixed(4), true), commands }
}

/** Maps `[inputLabel]` to [reframed] according to the clip's aspect/reframe settings. */
function reframeGraph(
  clip: Clip,
  source: VideoInfo,
  inputLabel: string,
  focus: FocusPlan,
  focusCommandsPath?: string
): string {
  const { w, h } = targetDims(clip.edit.aspect, source)
  const ratio = (w / h).toFixed(6)

  const fitShots = automaticLayoutShots(clip).filter((shot) => shot.mode === 'fit')
  if (fitShots.length) {
    const plain = { ...clip, visualLayout: undefined }
    const cropped = reframeGraph(plain, source, 'layoutCropInput', focus, focusCommandsPath)
      .replace('[reframed]', '[layoutCrop]')
    const groups = new Map<string, typeof fitShots>()
    for (const shot of fitShots) {
      const key = JSON.stringify([shot.region ?? null, shot.overview ?? false, shot.composition])
      groups.set(key, [...(groups.get(key) ?? []), shot])
    }
    const parts = [`[${inputLabel}]split=${groups.size + 1}[layoutCropInput]${[...groups.keys()].map((_, i) => `[layoutFitInput${i}]`).join('')}`, cropped]
    let current = 'layoutCrop'
    for (const [i, shots] of [...groups.values()].entries()) {
      const region = shots[0].region
      // Every branch must produce every frame: dropping hidden frames (select)
      // made overlay buffer the main stream through each gap, ~1.5 GB for a
      // minute of 1080x1920, and was slower once the canvas fill was cheap.
      parts.push(shots[0].composition
        ? compositionGraph(`layoutFitInput${i}`, `layoutFit${i}`, `layout${i}`, source, w, h, shots[0].composition)
        : fitRegionGraph(`layoutFitInput${i}`, `layoutFit${i}`, `layout${i}`, source, w, h, region, shots[0].overview))
      const enabled = shots.map((shot) =>
        `gte(t,${Math.max(0, shot.start - clip.edit.start).toFixed(3)})*lt(t,${(shot.end - clip.edit.start).toFixed(3)})`).join('+')
      const output = i === groups.size - 1 ? 'reframed' : `layoutOverlay${i}`
      parts.push(`[${current}][layoutFit${i}]overlay=0:0:enable='${enabled}':eof_action=pass[${output}]`)
      current = output
    }
    return parts.join(';')
  }

  if (clip.edit.aspect === 'original') {
    return `[${inputLabel}]scale=${w}:${h}:flags=lanczos[reframed]`
  }
  if (clip.edit.reframeMode === 'fit-blur') {
    // Blurred, darkened cover background with the full frame fitted on top.
    return (
      `[${inputLabel}]split=2[bg][fg];` +
      `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=24,eq=brightness=-0.12[bgb];` +
      `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[reframed]`
    )
  }
  if (clip.edit.reframeMode === 'fit-letterbox') {
    return (
      `[${inputLabel}]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black[reframed]`
    )
  }
  // Crop to the target ratio around the horizontal focus point, then scale.
  // A long focus track arrives as a sendcmd script that retargets the crop as
  // it goes, rather than as one expression covering the whole clip.
  const driver = focusCommandsPath
    ? `sendcmd=f='${escapeFilterPath(focusCommandsPath)}',`
    : ''
  return (
    `[${inputLabel}]${driver}crop=w='min(iw,floor(ih*${ratio}/2)*2)':h='min(ih,floor(iw/${ratio}/2)*2)':x='${focus.x}':y='(ih-oh)/2',` +
    `scale=${w}:${h}:flags=lanczos[reframed]`
  )
}

/**
 * Fade applied to the audio either side of every internal cut. Two pieces
 * butted together jump from one waveform to another mid-cycle: a click on
 * room tone or music, and a step in level wherever a filler word came out.
 * 15 ms of raised-cosine fade (a 720-sample ramp at 48 kHz) takes the jump
 * to zero without being heard as a dip — the out-and-in pair is 30 ms,
 * under the ~50 ms at which a break in sound starts to read as a pause —
 * and stays inside the breathing room pause removal leaves around speech.
 * The fades sit inside each piece, so no duration changes: captions, zoom
 * and focus are timed against the exact sum of the kept segments.
 */
export const CUT_FADE_SEC = 0.015
/** A short piece is faded over at most this share of its length at each end. */
const CUT_FADE_MAX_SHARE = 0.25

/**
 * The per-piece audio fade filters for the piece `i` of `segments`, lasting
 * `duration` seconds once trimmed: a fade in where it follows a cut and a
 * fade out where one follows it. Never at the clip's own start or end (the
 * end has its own fade, see audioChain), and never between pieces that touch
 * in the source. A cold open's seam is a cut too, although the clip's start
 * lies before the replayed line in the source. Exported for tests.
 */
export function cutFades(segments: KeptSegment[], i: number, duration: number): string {
  const fade = Math.min(CUT_FADE_SEC, duration * CUT_FADE_MAX_SHARE)
  if (fade < 0.001) return ''
  const d = fade.toFixed(4)
  const filters: string[] = []
  const previous = segments[i - 1], next = segments[i + 1]
  if (previous && Math.abs(segments[i].start - previous.end) > 0.001) filters.push(`afade=t=in:d=${d}:curve=hsin`)
  if (next && Math.abs(next.start - segments[i].end) > 0.001) {
    filters.push(`afade=t=out:st=${Math.max(0, duration - fade).toFixed(4)}:d=${d}:curve=hsin`)
  }
  return filters.map((f) => `,${f}`).join('')
}

/**
 * Trim+concat prefix for tightened clips: cuts the kept segments out of the
 * (already -ss seeked, so clip-relative) input and concatenates them.
 * Produces [vcat] and, when audio is present, [acat]. Each audio piece is
 * faded in and out at the cuts (cutFades), never across them.
 *
 * A clip joined from distant moments is opened once per moment (`sources`,
 * one input each, in order), so the minutes between them are never decoded;
 * each segment is then cut from the input that holds it.
 *
 * A cold open replays a line from later in the clip first. Cutting it from
 * the same input would make ffmpeg hold every frame between the clip's start
 * and that line in memory until the concat reached them, so the line has an
 * input of its own (`coldOpen`), and is the first segment.
 */
function tightenGraph(
  segments: KeptSegment[],
  clipStart: number,
  hasAudio: boolean,
  sources?: TimeRange[],
  coldOpen?: { input: number; origin: number }
): string {
  const parts: string[] = []
  const vLabels: string[] = []
  const aLabels: string[] = []
  segments.forEach((seg, i) => {
    // By midpoint: frame alignment can move a piece's edge a fraction of a
    // frame outside its stretch, and an edge lookup would then pick the wrong
    // input and cut the wrong footage.
    const middle = (seg.start + seg.end) / 2
    const own = i === 0 ? coldOpen : undefined
    const input = own ? own.input : sources ? Math.max(0, sources.findIndex((r) => middle >= r.start && middle <= r.end)) : 0
    const origin = own ? own.origin : sources ? sources[input].start : clipStart
    const s = Math.max(0, seg.start - origin).toFixed(3)
    const e = Math.max(0, seg.end - origin).toFixed(3)
    parts.push(`[${input}:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[vs${i}]`)
    vLabels.push(`[vs${i}]`)
    if (hasAudio) {
      const fades = cutFades(segments, i, Number(e) - Number(s))
      parts.push(`[${input}:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS${fades}[as${i}]`)
      aLabels.push(`[as${i}]`)
    }
  })
  parts.push(`${vLabels.join('')}concat=n=${segments.length}:v=1:a=0[vcat]`)
  if (hasAudio) parts.push(`${aLabels.join('')}concat=n=${segments.length}:v=0:a=1[acat]`)
  return parts.join(';')
}

const BROLL_FADE_SEC = 0.25

function fmtZ(v: number): string {
  return v.toFixed(4)
}

/**
 * Piecewise zoom factor z(t) as an ffmpeg expression. Events are
 * clip-relative and sorted; between events the level holds at the previous
 * event's target. `in` is the input frame index, so t = in/fps.
 */
export function zoomExpression(rawEvents: ZoomEvent[], fps: number): string {
  const T = `(in/${fps.toFixed(3)})`
  const events = fitZoomEvents(rawEvents)
  if (events.length === 0) return '1'
  const ramp = (e: ZoomEvent): string => {
    if (e.end - e.start < 0.01) return fmtZ(e.to)
    const p = `min(1,max(0,(${T}-${e.start.toFixed(3)})/${(e.end - e.start).toFixed(3)}))`
    // Punches ease out; creeps and anything else stay linear.
    const eased = e.style === 'punch' ? `(${p}*(2-${p}))` : p
    // The clamp on p means this already holds at `to` once the transition
    // window has passed, so holding needs no branch of its own.
    return `(${fmtZ(e.from)}+${fmtZ(e.to - e.from)}*${eased})`
  }
  // Before the first event the frame is unzoomed; from each event's start the
  // ramp takes over and holds its target until the next one.
  return piecewiseExpression(
    [
      { from: events[0].start, value: '1' },
      ...events.map((e) => ({ from: e.start, value: ramp(e) }))
    ],
    T
  )
}

/**
 * Maps [reframed] to [zoomed]: per-frame zoom via the perspective filter,
 * which samples the source window with subpixel (cubic) interpolation. The
 * previous zoompan-based stage rounded the crop window to whole pixels every
 * frame, which turned the slow creep ramps into visible shake.
 *
 * The window is centred horizontally and anchored slightly above middle
 * (42% from the top), where faces sit in vertical framing.
 */
function zoomGraph(events: ZoomEvent[], fps: number): string {
  const safeFps = fps > 1 && fps < 240 ? fps : 30
  const z = `(${zoomExpression(events, safeFps)})`
  const left = `(W-W/${z})/2`
  const right = `W-(W-W/${z})/2`
  const top = `(H-H/${z})*0.42`
  const bottom = `H-(H-H/${z})*0.58`
  return (
    `[reframed]perspective=` +
    `x0='${left}':y0='${top}':x1='${right}':y1='${top}':` +
    `x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':` +
    `interpolation=cubic:eval=frame[zoomed]`
  )
}

/** Watermark corner margin as a fraction of the output width. */
const WATERMARK_MARGIN = 0.03

function watermarkOverlayXY(position: WatermarkPosition, margin: number): string {
  switch (position) {
    case 'top-left':
      return `${margin}:${margin}`
    case 'top-right':
      return `W-w-${margin}:${margin}`
    case 'bottom-left':
      return `${margin}:H-h-${margin}`
    case 'bottom-right':
      return `W-w-${margin}:H-h-${margin}`
    default: {
      const exhaustive: never = position
      return exhaustive
    }
  }
}

/** Sound effects and background music mixed under the speech (see shared/audioMix.ts). */
export interface AudioMixPlan {
  /** Synthesised effects, output seconds. */
  sfx: SfxCue[]
  /** Background music file, looped to the clip's length; null for none. */
  musicPath: string | null
  /** Music level in dB before ducking. */
  musicGainDb: number
  /** Loudness of the speech before normalisation (LUFS): sets the effect levels and the duck threshold. */
  speechLufs: number
}

/** Speech loudness assumed when the source was not measured. */
export const DEFAULT_SPEECH_LUFS = -20
/** Short-term loudness of the synthesised effects at full scale, roughly. */
const SFX_REFERENCE_LUFS = -10
const MIX_FORMAT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'

/** ffmpeg source filters synthesising one effect (from the shared recipes). Exported for tests. */
export function sfxSource(kind: SfxCue['kind']): string {
  const spec = SFX_SPECS[kind]
  if (kind === 'whoosh') {
    return `anoisesrc=d=${spec.duration}:c=pink:r=48000:a=0.8:s=7,highpass=f=${WHOOSH_BAND.highpassHz},` +
      `lowpass=f=${WHOOSH_BAND.lowpassHz},aeval='val(0)*(${WHOOSH_ENVELOPE_EXPR})':c=same`
  }
  return `aevalsrc='${SFX_EXPRESSIONS[kind]}':s=48000:d=${spec.duration}`
}

/**
 * Music bed and effects mixed under the speech, ahead of the master chain so
 * the loudness normalisation covers the finished mix. The music loops to the
 * clip's length, fades in and out, and a sidechain compressor keyed on the
 * speech ducks it whenever someone talks. `amix` ends with its first input
 * (the speech), so the mix is exactly as long as the kept segments.
 */
function audioMixGraph(voice: string, mix: AudioMixPlan, musicInput: number | null, duration: number, master: string): string {
  const parts = [`[${voice}]${MIX_FORMAT}[vfmt]`]
  const inputs: string[] = []
  if (musicInput !== null) {
    parts.push('[vfmt]asplit=2[vmain][vkey]')
    inputs.push('[vmain]')
    const fadeIn = Math.min(MUSIC_FADE_IN_SEC, duration / 3)
    const fadeOut = Math.min(MUSIC_FADE_OUT_SEC, duration / 3)
    parts.push(
      `[${musicInput}:a]atrim=end=${duration.toFixed(3)},asetpts=PTS-STARTPTS,${MIX_FORMAT},` +
      `volume=${mix.musicGainDb.toFixed(2)}dB,afade=t=in:d=${fadeIn.toFixed(3)},` +
      `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[mbed]`
    )
    // Speech 12 dB over the threshold at ratio 6 takes the music down ~10 dB.
    const threshold = Math.min(1, Math.max(0.001, dbToGain(mix.speechLufs - 12)))
    parts.push(`[mbed][vkey]sidechaincompress=threshold=${threshold.toFixed(5)}:ratio=6:attack=20:release=400:makeup=1[mduck]`)
    inputs.push('[mduck]')
  } else {
    inputs.push('[vfmt]')
  }
  mix.sfx.forEach((cue, i) => {
    const db = Math.min(0, mix.speechLufs + SFX_SPECS[cue.kind].gainDb - SFX_REFERENCE_LUFS)
    const delay = Math.round(cue.start * 1000)
    parts.push(`${sfxSource(cue.kind)},${MIX_FORMAT},volume=${db.toFixed(2)}dB,adelay=delays=${delay}:all=1[sfx${i}]`)
    inputs.push(`[sfx${i}]`)
  })
  parts.push(`${inputs.join('')}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0,${master}[aout]`)
  return parts.join(';')
}

interface FilterGraph {
  filterComplex: string
  /** Extra `-i` input args for the B-roll images (after the main input). */
  extraInputs: string[]
  /** Label of the final audio stream, or null when the source has no audio. */
  audioLabel: string | null
  /**
   * sendcmd script the graph expects at `focusCommandsPath`, or null when the
   * crop needs no commands. The caller must write it before running ffmpeg.
   */
  focusCommands: string | null
}

/**
 * Full filter graph: optional tighten trim+concat -> reframe -> timed B-roll
 * image overlays (fade in/out) -> branding watermark -> caption burn-in on
 * top, plus the loudness-normalised audio chain with an end fade-out.
 * Exported for tests.
 */
export function buildFilterGraph(
  clip: Clip,
  source: VideoInfo,
  assPath: string | null,
  clipDuration: number,
  tighten: {
    segments: KeptSegment[]
    clipStart: number
    /**
     * The stretches of source opened as separate inputs, in order, when the
     * clip joins distant moments. Absent means one input from `clipStart`.
     */
    sources?: TimeRange[]
    /**
     * A line replayed before `segments` (the cold open). It plays first and
     * is opened as an input of its own, after the source inputs.
     */
    coldOpen?: KeptSegment | null
  } | null,
  options?: {
    branding?: BrandingSettings | null
    fontsDirPath?: string
    /** Clip-relative auto-zoom plan; null/empty disables the zoom stage. */
    zoomEvents?: ZoomEvent[] | null
    /**
     * Where the caller will write the returned `focusCommands`. Without it a
     * long focus track is thinned into a plain expression instead.
     */
    focusCommandsPath?: string
    /**
     * Measured loudness of the source span, for linear normalisation. Null or
     * absent falls back to single-pass dynamic normalisation.
     */
    loudness?: LoudnessStats | null
    audioTailSec?: number
    /** Effects and music to mix under the speech; absent or empty mixes nothing. */
    audioMix?: AudioMixPlan | null
    /**
     * Animated captions: frames arrive as raw RGBA on stdin (see
     * animatedCaptions.ts) and are overlaid instead of burning `assPath`.
     */
    captionFrames?: { width: number; height: number; fps: number } | null
  }
): FilterGraph {
  const { w, h } = targetDims(clip.edit.aspect, source)
  const parts: string[] = []
  const extraInputs: string[] = []
  /** Image inputs (B-roll, watermark) come after the source input or inputs and any cold-open input. */
  const coldOpen = tighten?.coldOpen ?? null
  const sourceInputs = (tighten?.sources?.length ?? 1) + (coldOpen ? 1 : 0)
  // Caption frames (animated styles) are the first input after the sources,
  // so every image input after them moves up by one.
  const captionFrames = options?.captionFrames ?? null
  const captionInput = captionFrames ? sourceInputs : -1
  if (captionFrames) extraInputs.push(...captionFrameInputArgs(captionFrames.width, captionFrames.height, captionFrames.fps))
  const imageInputs = sourceInputs + (captionFrames ? 1 : 0)

  const items = clip.broll.filter(
    (b) =>
      b.enabled &&
      b.imagePath !== null &&
      // A downloaded image can go missing (project folder moved, cache cleared);
      // handing a non-existent path to ffmpeg would fail the whole export.
      existsSync(b.imagePath) &&
      b.end > clip.edit.start &&
      b.start < clip.edit.end
  )

  // A fullscreen B-roll insert brings a second crop filter into the graph, and
  // sendcmd addresses filters by class name (instance names are not honoured
  // across the ffmpeg versions this ships against), so crop commands are only
  // safe when there is no other crop to hit.
  const allowFocusCommands =
    Boolean(options?.focusCommandsPath) && !items.some((b) => b.mode === 'fullscreen') &&
    !automaticLayoutShots(clip).some(shot => shot.region || shot.composition)
  const focus = buildFocusPlan(clip, allowFocusCommands)
  const focusCommandsPath = focus.commands ? options?.focusCommandsPath : undefined

  let audioLabel: string | null = null
  let voice = '0:a'
  if (tighten) {
    const segments = coldOpen ? [coldOpen, ...tighten.segments] : tighten.segments
    const coldInput = coldOpen ? { input: sourceInputs - 1, origin: coldOpen.start } : undefined
    parts.push(tightenGraph(segments, tighten.clipStart, source.hasAudio, tighten.sources, coldInput))
    parts.push(reframeGraph(clip, source, 'vcat', focus, focusCommandsPath))
    voice = 'acat'
  } else {
    parts.push(reframeGraph(clip, source, '0:v', focus, focusCommandsPath))
  }
  // The music file is the last input, after every image (B-roll, watermark).
  const mix = options?.audioMix
  const mixing = source.hasAudio && mix && (mix.sfx.length > 0 || mix.musicPath)
  const watermarked = Boolean(options?.branding?.enabled && options.branding.imagePath)
  const musicInput = mixing && mix.musicPath ? imageInputs + items.length + (watermarked ? 1 : 0) : null
  if (source.hasAudio) {
    const master = audioChain(clipDuration, options?.loudness ?? null, options?.audioTailSec)
    if (mixing) {
      parts.push(audioMixGraph(voice, mix, musicInput, clipDuration, master))
    } else {
      parts.push(`[${voice}]${master}[aout]`)
    }
    audioLabel = 'aout'
  }

  const zoomEvents = options?.zoomEvents
  let current = 'reframed'
  if (zoomEvents && zoomEvents.length > 0) {
    parts.push(zoomGraph(zoomEvents, source.fps))
    current = 'zoomed'
  }

  items.forEach((item, i) => {
    const input = i + imageInputs
    const s = Math.max(0, item.start - clip.edit.start)
    const e = Math.min(clipDuration, item.end - clip.edit.start)
    extraInputs.push('-loop', '1', '-t', clipDuration.toFixed(3), '-i', item.imagePath!)

    const fades =
      `format=rgba,` +
      `fade=t=in:st=${s.toFixed(3)}:d=${BROLL_FADE_SEC}:alpha=1,` +
      `fade=t=out:st=${Math.max(s, e - BROLL_FADE_SEC).toFixed(3)}:d=${BROLL_FADE_SEC}:alpha=1`

    if (item.mode === 'fullscreen') {
      parts.push(
        `[${input}:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},${fades}[b${i}]`
      )
      parts.push(
        `[${current}][b${i}]overlay=0:0:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})':eof_action=pass[v${i}]`
      )
    } else {
      // Picture-in-picture panel over the speaker, upper-centre, white border.
      const panelW = Math.floor((w * 0.62) / 2) * 2
      parts.push(
        `[${input}:v]scale=${panelW}:-2:flags=lanczos,pad=w=iw+16:h=ih+16:x=8:y=8:color=white,${fades}[b${i}]`
      )
      parts.push(
        `[${current}][b${i}]overlay=(W-w)/2:${Math.round(h * 0.1)}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})':eof_action=pass[v${i}]`
      )
    }
    current = `v${i}`
  })

  const branding = options?.branding
  if (branding?.enabled && branding.imagePath) {
    const input = items.length + imageInputs
    extraInputs.push('-loop', '1', '-t', clipDuration.toFixed(3), '-i', branding.imagePath)
    const wmWidth = Math.max(2, Math.round(w * Math.min(0.5, Math.max(0.04, branding.scale))))
    const opacity = Math.min(1, Math.max(0.05, branding.opacity))
    const margin = Math.round(w * WATERMARK_MARGIN)
    parts.push(
      `[${input}:v]format=rgba,scale=${wmWidth}:-1:flags=lanczos,colorchannelmixer=aa=${opacity.toFixed(3)}[wm]`
    )
    parts.push(
      `[${current}][wm]overlay=${watermarkOverlayXY(branding.position, margin)}[wmk]`
    )
    current = 'wmk'
  }

  // Square pixels: an even-rounded crop scaled to exact output dimensions
  // otherwise carries a sample aspect like 404:405 that players honour.
  if (captionFrames) {
    // Straight-alpha RGBA over the picture, exactly where libass would draw.
    parts.push(`[${current}][${captionInput}:v]overlay=0:0:eof_action=repeat:format=auto,setsar=1[vout]`)
  } else if (assPath) {
    const fontsDirPath = options?.fontsDirPath ?? fontsDir()
    parts.push(
      `[${current}]ass=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDirPath)}',setsar=1[vout]`
    )
  } else {
    parts.push(`[${current}]setsar=1[vout]`)
  }

  if (musicInput !== null && mix?.musicPath) extraInputs.push('-stream_loop', '-1', '-i', mix.musicPath)

  return {
    filterComplex: parts.join(';'),
    extraInputs,
    audioLabel,
    focusCommands: focusCommandsPath ? focus.commands : null
  }
}

export interface RenderJob {
  clip: Clip
  source: VideoInfo
  transcript: Transcript | null
  outputPath: string
  /**
   * The music track for this clip (resolved from the music folder), or
   * null/absent for none. Only used while the clip's music toggle is on.
   */
  musicPath?: string | null
  encoder?: EncoderPreference
  quality?: QualityPreference
  /** App-wide watermark/logo composited under the captions. */
  branding?: BrandingSettings | null
  /** Directory libass loads fonts from; defaults to the bundled fonts. */
  fontsDirPath?: string
  /**
   * Hard ceiling for the finished file, in bytes. When set, the render becomes
   * a single size-targeted two-pass encode at the largest frame size the
   * budget can carry, instead of a quality-targeted one — see
   * `@shared/uploadBudget`. `quality` and `encoder` are ignored: the byte cap
   * decides the bitrate, and the encode is always CPU x264.
   */
  sizeTargetBytes?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface RenderResult {
  outputPath: string
  bytes: number
  sizePlan: UploadEncodePlan | null
  /** The check after the render; see exportCheck.ts. */
  check?: ExportCheckReport
  /** Set when an animated caption style was burned with its libass equivalent, and why. */
  captionNotice?: string
}

/**
 * The effects and music for one export: effects by the shared rules at the
 * cold-open seam, the title and any joins; music levelled from its measured
 * loudness to sit MUSIC_BED_LU under the speech. Null when neither is on.
 */
async function planAudioMix(
  clip: Clip,
  timeline: ClipTimeline | null,
  outputDuration: number,
  titleAt: number | null,
  loudness: LoudnessStats | null,
  job: RenderJob
): Promise<AudioMixPlan | null> {
  const speechLufs = loudness && Number.isFinite(loudness.inputI) && loudness.inputI > -70 ? loudness.inputI : DEFAULT_SPEECH_LUFS
  // Same cues as the preview (clipSoundEffects), on the same timeline.
  const sfx = clipSoundEffects(clip, timeline ?? new ClipTimeline([{ start: clip.edit.start, end: clip.edit.start + outputDuration }]), titleAt)
  const musicPath = clip.edit.music && job.musicPath && existsSync(job.musicPath) ? job.musicPath : null
  if (!sfx.length && !musicPath) return null
  let musicGainDb = 0
  if (musicPath) {
    // Read the track's own loudness (its first minute is plenty) so quiet and
    // loud tracks both land at the same bed level under the speech.
    const music = await measureLoudness(musicPath, 0, 60, job.signal).catch(() => null)
    const musicLufs = music && Number.isFinite(music.inputI) && music.inputI > -70 ? music.inputI : -14
    musicGainDb = Math.max(-40, Math.min(6, speechLufs + MUSIC_BED_LU - musicLufs))
  }
  return { sfx, musicPath, musicGainDb, speechLufs }
}

export function renderClip(job: RenderJob): Promise<RenderResult> {
  return mediaJobs.run(async () => {
    const temporary = `${job.outputPath}.partial-${randomUUID()}.mp4`
    try {
      const result = await timed('export/render', () => renderWithCaptionFallback({ ...job, outputPath: temporary,
        onProgress: progress => job.onProgress?.(progress * .95) }))
      // Preserve any previous export until the new file passes a complete decode.
      await timed('export/validate', () => runFfmpegWith(FFMPEG_PATH, ['-v', 'error', '-xerror', '-i', temporary,
        '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], { signal: job.signal,
        // Against what plays, not the trim span: a joined clip's trim includes
        // the minutes it skips, which left the bar stuck at 95%.
        onProgress: seconds => job.onProgress?.(.95 + .05 * Math.min(1, seconds / Math.max(.1, clipTimeline(job.clip, job.transcript).outputDuration))) }))
      // Black, freezes, dead air, level and mid-word cuts; repaired in place when safe. Never fatal.
      const check = await timed('export/check', () => checkExport(temporary, job, result))
      job.signal?.throwIfAborted()
      await rename(temporary, job.outputPath)
      job.onProgress?.(1)
      return { ...result, outputPath: job.outputPath, bytes: (await stat(job.outputPath)).size, check }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }, job.signal, 1)
}

/** What renderWithCaptionFallback adds to a job for its libass retry. */
interface InternalRenderJob extends RenderJob {
  forceLibassCaptions?: boolean
  captionNotice?: string
}

async function render(job: InternalRenderJob, cleanup: Array<() => void>): Promise<RenderResult> {
  const { clip, transcript } = job
  // Projects store probe results; refresh them for rotated or relinked source
  // files before translating normalized regions into decoded-frame pixels.
  const source = await probeVideo(job.source.path)
  const quality = job.quality ?? 'standard'
  const start = clip.edit.start
  const duration = Math.max(0.5, clip.edit.end - clip.edit.start)
  const { w, h } = targetDims(clip.edit.aspect, source)

  // What plays, in order (shared with the preview): an optional cold open,
  // then the kept segments. Everything timed against the source (captions,
  // B-roll, face track, layout) is remapped onto that output timeline.
  const parts = clipTimelineParts(clip, transcript)
  const kept = alignSegmentsToFrames(parts.tightened ? parts.main : null, source.fps, start, clip.edit.end)
  if (kept && kept.length === 0) {
    throw new Error('Nothing is left to export: every part of this clip has been cut. Undo a cut or widen the trim.')
  }
  const coldOpen = parts.coldOpen
    ? alignSegmentsToFrames([parts.coldOpen], source.fps, start, clip.edit.end)?.[0] ?? null
    : null
  // A cold open needs the trim+concat graph even when nothing else is cut.
  const segments = kept ?? (coldOpen ? alignSegmentsToFrames([{ start, end: clip.edit.end }], source.fps, start, clip.edit.end) : null)
  const timeline = segments ? new ClipTimeline(segments, coldOpen) : null
  const outputDuration = timeline ? timeline.outputDuration : duration
  // Moments far apart are each opened with their own seek. One input reading
  // from the first to the last would decode everything between them too.
  const stretches = segments ? limitStretches(sourceStretches(clip.edit), MAX_SOURCE_INPUTS) : []
  // A single stretch well inside the trim (a long cut at its start or end)
  // also gets its own seek, so the cut footage is neither decoded nor
  // measured for loudness.
  const inset = stretches.length === 1 &&
    (stretches[0].start - start > SEPARATE_STRETCH_GAP_SEC || clip.edit.end - stretches[0].end > SEPARATE_STRETCH_GAP_SEC)
  const sources = stretches.length > 1 || inset ? stretches : null

  let effectiveClip = clip
  let captionTranscript = transcript
  let captionStart = start
  let captionEnd = clip.edit.end
  if (timeline) {
    const shots = automaticLayoutShots(clip).map((shot) => ({ ...shot,
      start: Math.max(start, shot.start), end: Math.min(clip.edit.end, shot.end) })).filter((shot) => shot.end > shot.start)
    effectiveClip = {
      ...clip,
      edit: { ...clip.edit, start: 0, end: outputDuration },
      visualLayout: clip.visualLayout ? {
        ...clip.visualLayout, start: 0, end: outputDuration,
        // Each shot plays wherever its footage does: a cold open repeats it.
        shots: timeline.hasColdOpen
          ? mapTimedToOutput(shots, timeline)
          : shots.map((shot) => ({ ...shot, start: timeline.toOutput(shot.start), end: timeline.toOutput(shot.end) }))
            .filter((shot) => shot.end > shot.start)
      } : undefined,
      // B-roll illustrates the clip proper; the cold open plays clean.
      broll: clip.broll
        .map((b) => ({ ...b, start: timeline.toOutput(b.start), end: timeline.toOutput(b.end) }))
        .filter((b) => b.end - b.start > 0.6),
      focusTrack: clip.focusTrack
        ? timeline.hasColdOpen
          ? timelineFocusTrack(clip.focusTrack, timeline)
          : clip.focusTrack.map((kf) => ({ ...kf, t: timeline.toOutput(kf.t) }))
        : null
    }
    if (transcript) {
      captionTranscript = timelineTranscript(transcript, timeline, start, clip.edit.end)
      captionStart = 0
      captionEnd = outputDuration
    }
  }

  const chosenStyle = resolveCaptionStyle(
    clip.edit.captionStyleId,
    job.branding?.colors,
    clip.edit.captionFontFamily ?? undefined
  )
  const titleText = clip.edit.showTitle && !compositionHidesTitle(effectiveClip) ? (clip.hook || clip.title).trim() : ''
  // The title appears once the cold open has played.
  const titleStart = timeline?.coldOpenDuration ?? 0
  const captions = clip.edit.captionsEnabled && captionTranscript !== null
  const captionTimeline = timeline ?? new ClipTimeline([{ start, end: clip.edit.end }])

  // Animated styles are drawn frame by frame in a hidden Chromium window and
  // overlaid (animatedCaptions.ts). If that cannot start, the export burns
  // the style's nearest libass look instead and says so; it never fails.
  let animated: { session: CaptionFrameSession; plan: AnimatedCaptionPlan } | null = null
  let captionNotice = job.captionNotice
  if (chosenStyle.animation && (captions || titleText) && !job.forceLibassCaptions) {
    const sourceRanges = clipCaptionPositionRanges(clip, chosenStyle.positionY, chosenStyle.fontScale, source.width, source.height)
    const plan = animatedCaptionPlan({
      transcript,
      clip,
      timeline: captionTimeline,
      style: chosenStyle,
      aspectRatio: w / h,
      captions,
      title: titleText
        ? planTitle(titleText, {
            styleId: clip.edit.titleStyle,
            captionStyle: chosenStyle,
            brandColors: job.branding?.colors,
            aspectRatio: w / h,
            start: titleStart,
            duration: outputDuration
          })
        : null,
      translation: clip.edit.captionsEnabled
        ? translatedCaptionPlan(clip, transcript, segments, chosenStyle, w / h, process.platform, timeline?.coldOpenDuration ?? 0)
        : null,
      positionRanges: mapTimedToOutput(sourceRanges, captionTimeline)
    })
    try {
      const session = await timed('export/caption-window', () =>
        openCaptionFrames({ plan, width: w, height: h, fontsDir: job.fontsDirPath ?? fontsDir() }, job.signal))
      cleanup.push(() => session.close())
      animated = { session, plan }
    } catch (error) {
      job.signal?.throwIfAborted()
      console.error('Animated captions unavailable, burning the libass equivalent:', error)
      captionNotice = animatedFallbackNotice(chosenStyle.id, error)
    }
  }
  // Caption frames follow the picture's frame rate: frame n shows time n / fps.
  const captionFps = source.fps > 0 && Number.isFinite(source.fps) ? source.fps : 30
  const libassStyleId = animated ? chosenStyle.id : libassCaptionStyleId(clip.edit.captionStyleId)
  const captionStyle = libassStyleId === chosenStyle.id
    ? chosenStyle
    : resolveCaptionStyle(libassStyleId, job.branding?.colors, clip.edit.captionFontFamily ?? undefined)

  let assPath: string | null = null
  if ((captions || titleText) && !animated) {
    // libass sizes text against the font's win ascent+descent, not the em
    // square the preview uses, so the ASS needs the resolved font's metrics
    // to come out the same size on screen (see assFontSize).
    const fontMetrics = await fontMetricsForFamily(
      job.fontsDirPath ?? fontsDir(),
      captionStyle.fontFamily
    )
    // Caption moves (detail views, faces, burned-in text) are planned in
    // source time, shared with the preview, then follow the footage.
    const sourceRanges = clipCaptionPositionRanges(clip, captionStyle.positionY, captionStyle.fontScale, source.width, source.height)
    const positionRanges = timeline ? mapTimedToOutput(sourceRanges, timeline) : sourceRanges
    const ass = buildAss(captions && captionTranscript ? captionTranscript : { language: '', durationSec: 0, segments: [] }, {
      fontMetrics,
      styleId: libassStyleId,
      width: w,
      height: h,
      clipStart: captionStart,
      clipEnd: captionEnd,
      title: titleText || undefined,
      titleStyle: clip.edit.titleStyle,
      titleStart,
      fontFamily: clip.edit.captionFontFamily ?? undefined,
      brandColors: job.branding?.colors,
      positionRanges,
      // Translated captions are captions: off with them, as in the preview.
      translation: captions ? translatedCaptionPlan(clip, transcript, segments, captionStyle, w / h, process.platform, timeline?.coldOpenDuration ?? 0) : null,
      // Seams and emphasis exactly as the preview lays them out.
      ...clipCaptionOptions(clip, captionTimeline, captionStart)
    })
    const dir = join(tmpdir(), 'cutawan')
    await mkdir(dir, { recursive: true })
    assPath = join(dir, `captions-${randomUUID()}.ass`)
    await writeFile(assPath, ass, 'utf8')
  }

  // Auto zoom: plan in source time (shared with the preview), then remap to
  // the clip-relative output timeline the filters run on. The cold open
  // plays unzoomed.
  let zoomEvents: ZoomEvent[] | null = null
  if (clipAllowsAutoZoom(clip.edit) && !layoutBlocksAutoZoom(clip)) {
    const planned = computeZoomEvents(transcript, start, clip.edit.end, kept)
    zoomEvents = remapZoomEvents(planned, (t) => (timeline ? timeline.toOutput(t) : t - start))
    if (zoomEvents.length === 0) zoomEvents = null
  }

  // Measure the span's loudness so the master gain is one linear value rather
  // than a gain rider (see loudness.ts). Measured on the untightened span:
  // integrated loudness gates out silence anyway, so removing pauses changes
  // the reading by a fraction of a dB — not worth a second trim+concat graph.
  const loudness = source.hasAudio
    ? await timed('export/loudness', () => sources
        ? measureLoudnessOfRanges(source.path, sources, job.signal)
        : measureLoudness(source.path, start, duration, job.signal))
    : null
  if (process.env.CUTAWAN_DEBUG) {
    console.error(`[render] loudness normalisation: ${normalisationMode(loudness)}`, loudness)
  }

  // Sound effects by rule and the music bed, mixed under the speech.
  const audioMix = source.hasAudio
    ? await planAudioMix(clip, timeline, outputDuration, titleText ? titleStart : null, loudness, job)
    : null

  const tempDir = join(tmpdir(), 'cutawan')
  await mkdir(tempDir, { recursive: true })
  // Named up front because the graph has to reference the file; it is only
  // written if the graph comes back needing crop commands.
  const focusCommandsPath = join(tempDir, `focus-${randomUUID()}.cmd`)
  // AI voice dub (dub.ts): one pre-mixed track, mixed over the ducked voice.
  const dub = await prepareDubTrack(clip, transcript, segments, outputDuration, tempDir, job.signal, timeline?.coldOpenDuration ?? 0)
  const baseGraph = buildFilterGraph(
    effectiveClip,
    source,
    assPath,
    outputDuration,
    segments ? { segments, clipStart: start, ...(sources ? { sources } : {}), coldOpen } : null,
    {
      branding: job.branding,
      fontsDirPath: job.fontsDirPath,
      zoomEvents,
      focusCommandsPath,
      loudness,
      audioTailSec: speechSafeFade(captionTranscript, captionStart, captionEnd),
      audioMix,
      captionFrames: animated ? { width: w, height: h, fps: captionFps } : null
    }
  )
  // The cold open is opened as one more source input, before the graph's own.
  const graph = withDubMix(baseGraph, dub, (sources?.length ?? 1) + (coldOpen ? 1 : 0))
  if (graph.focusCommands) await writeFile(focusCommandsPath, graph.focusCommands, 'utf8')

  // Whole-video renders can produce a filter graph far larger than a
  // command-line argument may be (Windows caps a command line at ~32k
  // characters): a focus track or zoom plan spanning ten minutes becomes a
  // very long piecewise expression. Past a safe size the graph goes to a temp
  // file that ffmpeg reads instead, which it parses identically.
  // Size-targeted render: work the bitrate and frame size back from the byte
  // cap before encoding, so this render is the ONLY lossy generation. The
  // alternative — render at quality, then transcode down to fit — makes the
  // second encoder spend its budget reproducing the first one's artefacts.
  const plan = job.sizeTargetBytes
    ? planUploadEncode({
        capBytes: job.sizeTargetBytes,
        durationSec: outputDuration,
        width: w,
        height: h,
        sourceFps: source.fps,
        hasAudio: graph.audioLabel !== null
      })
    : null

  // The downscale and frame-rate cap go on the end of the graph rather than
  // into targetDims: captions are then rasterised at full size and scaled down
  // with the picture, which keeps text far cleaner than asking libass to draw
  // it small in the first place.
  let videoLabel = 'vout'
  let filterComplex = graph.filterComplex
  if (plan) {
    const fit: string[] = []
    if (plan.width !== w || plan.height !== h) {
      fit.push(`scale=${plan.width}:${plan.height}:flags=lanczos`)
    }
    if (plan.fps < source.fps - 0.01) fit.push(`fps=${plan.fps}`)
    if (fit.length > 0) {
      filterComplex = `${filterComplex};[vout]${fit.join(',')}[vfit]`
      videoLabel = 'vfit'
    }
  }

  if (process.env.CUTAWAN_DEBUG_GRAPH) await writeFile(process.env.CUTAWAN_DEBUG_GRAPH, filterComplex, 'utf8')
  let filterArgs = ['-filter_complex', filterComplex]
  let filterScriptPath: string | null = null
  if (filterComplex.length > FILTER_ARG_MAX_CHARS) {
    filterScriptPath = join(tempDir, `filter-${randomUUID()}.txt`)
    await writeFile(filterScriptPath, filterComplex, 'utf8')
    filterArgs = ['-filter_complex_script', filterScriptPath]
  }

  /**
   * The audio output is always mapped when the graph produces one: leaving it
   * unconnected makes ffmpeg refuse the whole graph, so a two-pass analysis
   * run maps it and lets the null muxer throw it away (`audioCodec: []`).
   */
  const buildArgs = (opts: {
    videoArgs: string[]
    audioCodec: string[]
    output: string[]
  }): string[] => [
    ...[...(sources ?? [{ start, end: start + duration }]), ...(coldOpen ? [coldOpen] : [])].flatMap((range) => [
      '-ss', range.start.toFixed(3),
      '-t', (range.end - range.start).toFixed(3),
      '-i', source.path
    ]),
    ...graph.extraInputs,
    ...filterArgs,
    '-map', `[${videoLabel}]`,
    ...(graph.audioLabel ? ['-map', `[${graph.audioLabel}]`] : []),
    ...opts.videoArgs,
    ...opts.audioCodec,
    ...opts.output
  ]

  const fileOutput = ['-movflags', '+faststart', job.outputPath]

  // Progress over a span of the whole job, so two passes read as one bar.
  const runOpts = (from: number, to: number): Parameters<typeof runFfmpegWith>[2] => ({
    onProgress: (t: number) =>
      job.onProgress?.(from + Math.min(1, t / outputDuration) * (to - from)),
    signal: job.signal,
    // Animated captions: every run (both passes of a size-capped export, a
    // CPU retry) is fed the same frames, drawn afresh from the same plan.
    ...(animated
      ? {
          stdin: (stream) => writeCaptionFrames(animated.session, animated.plan, { width: w, height: h, fps: captionFps }, stream, job.signal)
        }
      : {})
  })

  const passLogPrefix = plan ? join(tempDir, `x264-${randomUUID()}`) : null

  try {
    if (plan && passLogPrefix) {
      // Pass 1 analyses (video only, discarded); pass 2 encodes to the target.
      await runFfmpegWith(
        FFMPEG_PATH,
        buildArgs({
          videoArgs: sizeTargetedVideoArgs(1, plan.videoKbps, passLogPrefix),
          audioCodec: [],
          output: ['-f', 'null', '-']
        }),
        runOpts(0, 0.5)
      )
      await runFfmpegWith(
        FFMPEG_PATH,
        buildArgs({
          videoArgs: sizeTargetedVideoArgs(2, plan.videoKbps, passLogPrefix),
          audioCodec:
            plan.audioKbps > 0 ? ['-c:a', 'aac', '-b:a', `${plan.audioKbps}k`] : [],
          output: fileOutput
        }),
        runOpts(0.5, 1)
      )
    } else {
      const resolved = await resolveEncoder(job.encoder ?? 'auto')
      try {
        await runFfmpegWith(
          resolved.bin,
          buildArgs({
            videoArgs: encoderArgs(resolved.kind, quality),
            audioCodec: audioArgs(quality),
            output: fileOutput
          }),
          runOpts(0, 1)
        )
      } catch (err) {
        // Hardware encoders can fail at runtime (driver updates, GPU busy, session
        // limits). Unless the user explicitly demanded GPU, fall back to CPU.
        if (resolved.kind !== 'cpu' && job.encoder !== 'gpu' && !job.signal?.aborted) {
          console.error(`${resolved.kind} render failed, retrying on CPU:`, err)
          await rm(job.outputPath, { force: true }).catch(() => undefined)
          await runFfmpegWith(
            resolved.bin,
            buildArgs({
              videoArgs: encoderArgs('cpu', quality),
              audioCodec: audioArgs(quality),
              output: fileOutput
            }),
            runOpts(0, 1)
          )
        } else {
          throw err
        }
      }
    }
  } catch (err) {
    // Any failure with animated captions on is retried with libass by
    // renderWithCaptionFallback: the animated renderer must never be the
    // reason an export fails.
    if (animated && !job.signal?.aborted) {
      throw err instanceof CaptionRendererError ? err : new CaptionRendererError(err instanceof Error ? err.message : String(err), { cause: err })
    }
    throw err
  } finally {
    // Temp files this render created (captions, crop commands, filter script,
    // two-pass stats); never leave them behind.
    const temps = [
      assPath,
      graph.focusCommands ? focusCommandsPath : null,
      filterScriptPath,
      dub?.trackPath ?? null,
      ...(passLogPrefix ? passLogFiles(passLogPrefix) : [])
    ]
    await Promise.all(
      temps.filter((p): p is string => p !== null).map((p) => rm(p, { force: true }).catch(() => undefined))
    )
  }
  const bytes = (await stat(job.outputPath)).size
  const exported = await probeVideo(job.outputPath)
  if (exported.width !== (plan?.width ?? w) || exported.height !== (plan?.height ?? h) || exported.hasAudio !== (graph.audioLabel !== null) ||
    Math.abs(exported.durationSec - outputDuration) > Math.max(.25, 2 / Math.max(1, source.fps))) {
    throw new Error('Export validation failed: unexpected dimensions, duration or audio stream.')
  }
  return { outputPath: job.outputPath, bytes, sizePlan: plan, ...(captionNotice ? { captionNotice } : {}) }
}

/** The export note for an animated style that had to be burned with libass. */
function animatedFallbackNotice(styleId: string, error: unknown): string {
  const style = getCaptionStyle(styleId)
  const fallback = getCaptionStyle(libassCaptionStyleId(styleId))
  const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
  return captionFallbackNotice(style.name, fallback.name, reason)
}

/**
 * Render, and if the animated caption renderer fails part-way (the window
 * crashed, ffmpeg rejected its frames), render again with the style's libass
 * equivalent, noting why in the result.
 */
async function renderWithCaptionFallback(job: RenderJob): Promise<RenderResult> {
  const attempt = async (internal: InternalRenderJob): Promise<RenderResult> => {
    const cleanup: Array<() => void> = []
    try {
      return await render(internal, cleanup)
    } finally {
      for (const close of cleanup) close()
    }
  }
  try {
    return await attempt(job)
  } catch (error) {
    if (!(error instanceof CaptionRendererError) || job.signal?.aborted) throw error
    console.error('Animated captions failed during the export, burning the libass equivalent:', error)
    await rm(job.outputPath, { force: true }).catch(() => undefined)
    return attempt({ ...job, forceLibassCaptions: true, captionNotice: animatedFallbackNotice(job.clip.edit.captionStyleId, error) })
  }
}
