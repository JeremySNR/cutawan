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
import type { EncoderPreference } from '@shared/types'
import { clipKeptSegments, remapTranscript, TimeMap, type KeptSegment } from '@shared/tighten'
import { focusPanDuration, focusSnaps } from '@shared/focusTrack'
import { automaticLayoutShots, clipAllowsAutoZoom, compositionHidesTitle, detailCaptionRanges, layoutBlocksAutoZoom } from '@shared/contentType'
import { compositionGraph, fitRegionGraph } from './layoutFilters'
import { resolveCaptionStyle } from '@shared/captionStyles'
import { computeZoomEvents, fitZoomEvents, remapZoomEvents, type ZoomEvent } from '@shared/zoom'
import { planUploadEncode, type UploadEncodePlan } from '@shared/uploadBudget'
import { FFMPEG_PATH, probeVideo, runFfmpegWith } from './ffmpeg'
import { timed } from './timing'
import { STEREO, loudnormFilter, measureLoudness, normalisationMode, type LoudnessStats } from './loudness'
import { buildAss, fontsDir } from './captions'
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
 * Gentle audio fade at the clip tail so endings never cut off abruptly —
 * short enough to stay inside the post-roll padding after the last word.
 */
const END_FADE_SEC = 0.4

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
  // Normalise the stereo mix the export carries, as it was measured. FFmpeg 6
  // on macOS cannot always infer a layout after loudnorm's resampler, so the
  // link is constrained again after it, before the fade.
  const master = `${STEREO},${loudnormFilter(loudness)},aresample=48000,${STEREO}`
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
 * Trim+concat prefix for tightened clips: cuts the kept segments out of the
 * (already -ss seeked, so clip-relative) input and concatenates them.
 * Produces [vcat] and, when audio is present, [acat].
 */
function tightenGraph(segments: KeptSegment[], clipStart: number, hasAudio: boolean): string {
  const parts: string[] = []
  const vLabels: string[] = []
  const aLabels: string[] = []
  segments.forEach((seg, i) => {
    const s = Math.max(0, seg.start - clipStart).toFixed(3)
    const e = Math.max(0, seg.end - clipStart).toFixed(3)
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[vs${i}]`)
    vLabels.push(`[vs${i}]`)
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[as${i}]`)
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
  tighten: { segments: KeptSegment[]; clipStart: number } | null,
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
  }
): FilterGraph {
  const { w, h } = targetDims(clip.edit.aspect, source)
  const parts: string[] = []
  const extraInputs: string[] = []

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
  if (tighten) {
    parts.push(tightenGraph(tighten.segments, tighten.clipStart, source.hasAudio))
    parts.push(reframeGraph(clip, source, 'vcat', focus, focusCommandsPath))
    if (source.hasAudio) {
      parts.push(`[acat]${audioChain(clipDuration, options?.loudness ?? null, options?.audioTailSec)}[aout]`)
      audioLabel = 'aout'
    }
  } else {
    parts.push(reframeGraph(clip, source, '0:v', focus, focusCommandsPath))
    if (source.hasAudio) {
      parts.push(`[0:a]${audioChain(clipDuration, options?.loudness ?? null, options?.audioTailSec)}[aout]`)
      audioLabel = 'aout'
    }
  }

  const zoomEvents = options?.zoomEvents
  let current = 'reframed'
  if (zoomEvents && zoomEvents.length > 0) {
    parts.push(zoomGraph(zoomEvents, source.fps))
    current = 'zoomed'
  }

  items.forEach((item, i) => {
    const input = i + 1
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
    const input = items.length + 1
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
  if (assPath) {
    const fontsDirPath = options?.fontsDirPath ?? fontsDir()
    parts.push(
      `[${current}]ass=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDirPath)}',setsar=1[vout]`
    )
  } else {
    parts.push(`[${current}]setsar=1[vout]`)
  }

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
}

export function renderClip(job: RenderJob): Promise<RenderResult> {
  return mediaJobs.run(async () => {
    const temporary = `${job.outputPath}.partial-${randomUUID()}.mp4`
    try {
      const result = await timed('export/render', () => render({ ...job, outputPath: temporary,
        onProgress: progress => job.onProgress?.(progress * .95) }))
      // Preserve any previous export until the new file passes a complete decode.
      await timed('export/validate', () => runFfmpegWith(FFMPEG_PATH, ['-v', 'error', '-xerror', '-i', temporary,
        '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], { signal: job.signal,
        onProgress: seconds => job.onProgress?.(.95 + .05 * Math.min(1, seconds / Math.max(.1, job.clip.edit.end - job.clip.edit.start))) }))
      job.signal?.throwIfAborted()
      await rename(temporary, job.outputPath)
      job.onProgress?.(1)
      return { ...result, outputPath: job.outputPath }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }, job.signal, 1)
}

async function render(job: RenderJob): Promise<RenderResult> {
  const { clip, transcript } = job
  // Projects store probe results; refresh them for rotated or relinked source
  // files before translating normalized regions into decoded-frame pixels.
  const source = await probeVideo(job.source.path)
  const quality = job.quality ?? 'standard'
  const start = clip.edit.start
  const duration = Math.max(0.5, clip.edit.end - clip.edit.start)
  const { w, h } = targetDims(clip.edit.aspect, source)

  // Tighten cuts: figure out the kept segments and remap everything that is
  // timed against the source (captions, B-roll, face track) into the
  // compacted output timeline.
  const segments = clipKeptSegments(clip, transcript)
  if (segments && segments.length === 0) {
    throw new Error('Nothing is left to export: every part of this clip has been cut. Undo a cut or widen the trim.')
  }
  const map = segments ? new TimeMap(segments) : null
  const outputDuration = map ? map.outputDuration : duration

  let effectiveClip = clip
  let captionTranscript = transcript
  let captionStart = start
  let captionEnd = clip.edit.end
  if (map && segments) {
    effectiveClip = {
      ...clip,
      edit: { ...clip.edit, start: 0, end: outputDuration },
      visualLayout: clip.visualLayout ? {
        ...clip.visualLayout, start: 0, end: outputDuration,
        shots: automaticLayoutShots(clip).map((shot) => ({ ...shot,
          start: map.toOutput(Math.max(start, shot.start)),
          end: map.toOutput(Math.min(clip.edit.end, shot.end))
        })).filter((shot) => shot.end > shot.start)
      } : undefined,
      broll: clip.broll
        .map((b) => ({ ...b, start: map.toOutput(b.start), end: map.toOutput(b.end) }))
        .filter((b) => b.end - b.start > 0.6),
      focusTrack: clip.focusTrack
        ? clip.focusTrack.map((kf) => ({ ...kf, t: map.toOutput(kf.t) }))
        : null
    }
    if (transcript) {
      captionTranscript = remapTranscript(transcript, map, start, clip.edit.end)
      captionStart = 0
      captionEnd = outputDuration
    }
  }

  let assPath: string | null = null
  if (clip.edit.captionsEnabled && captionTranscript) {
    // libass sizes text against the font's win ascent+descent, not the em
    // square the preview uses, so the ASS needs the resolved font's metrics
    // to come out the same size on screen (see assFontSize).
    const captionStyle = resolveCaptionStyle(
      clip.edit.captionStyleId,
      job.branding?.colors,
      clip.edit.captionFontFamily ?? undefined
    )
    const fontMetrics = await fontMetricsForFamily(
      job.fontsDirPath ?? fontsDir(),
      captionStyle.fontFamily
    )
    const ass = buildAss(captionTranscript, {
      fontMetrics,
      styleId: clip.edit.captionStyleId,
      width: w,
      height: h,
      clipStart: captionStart,
      clipEnd: captionEnd,
      title: clip.edit.showTitle && !compositionHidesTitle(effectiveClip) ? clip.hook || clip.title : undefined,
      fontFamily: clip.edit.captionFontFamily ?? undefined,
      brandColors: job.branding?.colors,
      positionRanges: detailCaptionRanges(effectiveClip)
    })
    const dir = join(tmpdir(), 'cutawan')
    await mkdir(dir, { recursive: true })
    assPath = join(dir, `captions-${randomUUID()}.ass`)
    await writeFile(assPath, ass, 'utf8')
  }

  // Auto zoom: plan in source time (shared with the preview), then remap to
  // the clip-relative output timeline the filters run on.
  let zoomEvents: ZoomEvent[] | null = null
  if (clipAllowsAutoZoom(clip.edit) && !layoutBlocksAutoZoom(clip)) {
    const planned = computeZoomEvents(transcript, start, clip.edit.end, segments)
    zoomEvents = remapZoomEvents(planned, (t) => (map ? map.toOutput(t) : t - start))
    if (zoomEvents.length === 0) zoomEvents = null
  }

  // Measure the span's loudness so the master gain is one linear value rather
  // than a gain rider (see loudness.ts). Measured on the untightened span:
  // integrated loudness gates out silence anyway, so removing pauses changes
  // the reading by a fraction of a dB — not worth a second trim+concat graph.
  const loudness = source.hasAudio
    ? await timed('export/loudness', () => measureLoudness(source.path, start, duration, job.signal))
    : null
  if (process.env.CUTAWAN_DEBUG) {
    console.error(`[render] loudness normalisation: ${normalisationMode(loudness)}`, loudness)
  }

  const tempDir = join(tmpdir(), 'cutawan')
  await mkdir(tempDir, { recursive: true })
  // Named up front because the graph has to reference the file; it is only
  // written if the graph comes back needing crop commands.
  const focusCommandsPath = join(tempDir, `focus-${randomUUID()}.cmd`)
  const graph = buildFilterGraph(
    effectiveClip,
    source,
    assPath,
    outputDuration,
    segments ? { segments, clipStart: start } : null,
    {
      branding: job.branding,
      fontsDirPath: job.fontsDirPath,
      zoomEvents,
      focusCommandsPath,
      loudness,
      audioTailSec: speechSafeFade(captionTranscript, captionStart, captionEnd)
    }
  )
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
    '-ss', start.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', source.path,
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
    signal: job.signal
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
  } finally {
    // Temp files this render created (captions, crop commands, filter script,
    // two-pass stats); never leave them behind.
    const temps = [
      assPath,
      graph.focusCommands ? focusCommandsPath : null,
      filterScriptPath,
      ...(passLogPrefix ? passLogFiles(passLogPrefix) : [])
    ]
    await Promise.all(
      temps.filter((p): p is string => p !== null).map((p) => rm(p, { force: true }).catch(() => undefined))
    )
  }
  const bytes = (await stat(job.outputPath)).size
  const exported = await probeVideo(job.outputPath)
  if (exported.width !== (plan?.width ?? w) || exported.height !== (plan?.height ?? h) || exported.hasAudio !== source.hasAudio ||
    Math.abs(exported.durationSec - outputDuration) > Math.max(.25, 2 / Math.max(1, source.fps))) {
    throw new Error('Export validation failed: unexpected dimensions, duration or audio stream.')
  }
  return { outputPath: job.outputPath, bytes, sizePlan: plan }
}
