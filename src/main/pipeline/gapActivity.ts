import type { Clip, TimeRange, Transcript } from '@shared/types'
import {
  activeGapRanges,
  AUDIO_RATE,
  AUDIO_WINDOW_SEC,
  blurFrame,
  frameDifference,
  GAP_ACTIVITY_VERSION,
  measurableGaps,
  measurementSpans,
  MOTION_FPS,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  speakingRanges,
  speechRanges,
  windowLevels,
  type LevelWindow,
  type MotionStep
} from '@shared/gapActivity'
import { probeVideo, streamRawFrames } from './ffmpeg'
import { mediaJobs } from './mediaJobs'
import { ensureSeries, loadSeries, type SeriesKind } from './analysisCache'

/**
 * Decoding for the gap-activity measurement (see shared/gapActivity.ts).
 *
 * Cost: one tiny video decode and one audio decode per stretch of the clip,
 * covering only the part of the stretch that holds gaps plus a little speech
 * either side for the baselines. The minutes a joined clip skips are never
 * read. Measured on a 4-core VM: a 60 s 1080p30 H.264 clip with six pauses
 * takes about 4 s end to end with the two decoder threads mediaThreads
 * allows there. With four threads the bare video decode is 2.6 s, or 3.1 s
 * without skipping non-reference frames; the audio decode is about 0.1 s.
 * Framing analysis of the same clip takes tens of seconds.
 *
 * Both measurements are kept per source file on disk (analysisCache.ts), on
 * a fixed grid of the source's timeline: motion step k runs from k/4 s to
 * (k+1)/4 s, level window k from k/10 s. A re-analysis after a trim change
 * decodes only footage no earlier analysis of the source has read, and a
 * threshold change decodes nothing. Measured on the 36 s synthetic source
 * in tests/gapActivityMedia.test.ts (640x360): 0.29 s to measure, 0.01 s
 * again from the cache with nothing decoded.
 */

/** Speech decoded either side of the gaps, for the motion and level baselines. */
const BASELINE_PAD_SEC = 4
/**
 * Most source seconds one clip may decode. An ordinary clip is far below it;
 * a clip trimmed out to many minutes is left unmeasured rather than holding
 * up framing analysis for as long as a full decode takes. Footage already
 * measured (cached) does not count.
 */
const MAX_DECODE_SEC = 240

/** Has ffmpeg logged a decode problem? (`-v error` prints nothing for a clean decode.) */
function stderrWatch(): { onStderr: (text: string) => void; clean: () => boolean } {
  let errors = false
  return { onStderr: text => { if (text.trim()) errors = true }, clean: () => !errors }
}

/**
 * Frame-to-frame motion: value k is the blurred, cored difference between
 * the frames at k/4 s and (k+1)/4 s. The values depend on MOTION_CORE and
 * the blur too, which GAP_ACTIVITY_VERSION covers.
 */
const MOTION_SERIES: SeriesKind = {
  kind: 'gap-motion',
  rate: MOTION_FPS,
  params: { version: GAP_ACTIVITY_VERSION, fps: MOTION_FPS, width: MOTION_WIDTH, height: MOTION_HEIGHT },
  decimals: 3,
  decode: (videoPath, from, to, signal) => {
    // Steps from..to-1 need frames from..to; a half-frame of slack keeps
    // the last one in despite rounding.
    const watch = stderrWatch()
    return mediaJobs.run(async () => {
      const values: number[] = []
      let previous: Float32Array | null = null
      await streamRawFrames([
        '-v', 'error',
        // Non-reference frames are never needed at 4 fps and skipping them
        // saves ~15% of the decode. (Skipping the loop filter as well saved
        // more but made grainy stills read as motion: deblocking hides noise.)
        '-skip_frame', 'noref',
        '-ss', (from / MOTION_FPS).toFixed(3), '-t', ((to - from + 0.5) / MOTION_FPS).toFixed(3), '-i', videoPath,
        '-an', '-vf', `fps=${MOTION_FPS},scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:flags=area,format=gray`,
        '-f', 'rawvideo'
      ], MOTION_WIDTH * MOTION_HEIGHT, (frame) => {
        // The frame is a view into the decoder's output chunk; the blur copies it.
        const current = blurFrame(frame, MOTION_WIDTH, MOTION_HEIGHT)
        if (previous && values.length < to - from) values.push(frameDifference(previous, current))
        previous = current
      }, signal, watch.onStderr)
      return { values, clean: watch.clean() }
    }, signal)
  }
}

/** RMS level of each 0.1 s window, from an 8 kHz mono decode: value k covers [k/10, (k+1)/10) s. */
const LEVEL_SERIES: SeriesKind = {
  kind: 'gap-levels',
  rate: 1 / AUDIO_WINDOW_SEC,
  params: { version: GAP_ACTIVITY_VERSION, rate: AUDIO_RATE, window: AUDIO_WINDOW_SEC },
  decimals: 2,
  decode: (videoPath, from, to, signal) => {
    const samples = Math.round(AUDIO_RATE * AUDIO_WINDOW_SEC)
    const watch = stderrWatch()
    return mediaJobs.run(async () => {
      const values: number[] = []
      await streamRawFrames([
        '-v', 'error',
        '-ss', (from * AUDIO_WINDOW_SEC).toFixed(3), '-t', ((to - from) * AUDIO_WINDOW_SEC).toFixed(3), '-i', videoPath,
        '-vn', '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le'
      ], samples * 2, (chunk) => {
        const pcm = new Int16Array(samples)
        for (let i = 0; i < samples; i++) pcm[i] = chunk.readInt16LE(i * 2)
        values.push(windowLevels(pcm, samples)[0])
      }, signal, watch.onStderr)
      return { values, clean: watch.clean() }
    }, signal)
  }
}

/** Step indices covering `span`: steps that lie wholly inside it. */
function motionIndices(span: TimeRange): { from: number; to: number } {
  return { from: Math.ceil(span.start * MOTION_FPS - 1e-6), to: Math.floor(span.end * MOTION_FPS + 1e-6) }
}
function levelIndices(span: TimeRange): { from: number; to: number } {
  return { from: Math.ceil(span.start / AUDIO_WINDOW_SEC - 1e-6), to: Math.floor(span.end / AUDIO_WINDOW_SEC + 1e-6) }
}

/**
 * Measure which pauses in the clip have something happening in them.
 * Resolves to null when the clip is not measured at all: a whole-video edit
 * (hundreds of gaps across the full source, and a long silent stretch in a
 * full-length video is rarely a moment worth keeping), or a trim too long to
 * decode cheaply. Rejects on a decode failure or abort; the caller decides.
 */
export async function measureGapActivity(
  videoPath: string, clip: Clip, transcript: Transcript, signal?: AbortSignal
): Promise<NonNullable<Clip['gapActivity']> | null> {
  if (clip.origin === 'whole-video') return null
  const { start, end } = clip.edit
  const gaps = measurableGaps(clip, transcript)
  const result = { version: GAP_ACTIVITY_VERSION, start, end, measured: gaps, active: [] as TimeRange[] }
  if (!gaps.length) return result

  const spans = measurementSpans(clip.edit, gaps, BASELINE_PAD_SEC)
  const { hasAudio } = await probeVideo(videoPath)
  const { series: cached } = await loadSeries(MOTION_SERIES, videoPath)
  const uncached = spans.reduce((sum, span) => {
    const { from, to } = motionIndices(span)
    return sum + cached.missing(from, to).reduce((n, gap) => n + gap.to - gap.from, 0) / MOTION_FPS
  }, 0)
  if (uncached > MAX_DECODE_SEC) return null

  const speaking = speakingRanges(clip, transcript)
  const speech = speechRanges(transcript, start, end)
  for (const span of spans) {
    signal?.throwIfAborted()
    const steps = await motionSteps(videoPath, span, signal)
    const windows = hasAudio ? await levelWindows(videoPath, span, signal) : []
    result.active.push(...activeGapRanges({ gaps: span.gaps, speaking, steps, windows, speech }))
  }
  return result
}

/** Frame-to-frame motion across `span`, from a 4 fps, 64x36 grayscale decode (cached per source). */
export function motionSteps(videoPath: string, span: TimeRange, signal?: AbortSignal): Promise<MotionStep[]> {
  const range = motionIndices(span)
  return ensureSeries(MOTION_SERIES, videoPath, [range], signal).then(series => series.range(range.from, range.to)
    .map(({ k, value }) => ({ from: k / MOTION_FPS, to: (k + 1) / MOTION_FPS, value })))
}

/** RMS level of each 0.1 s of `span`, from an 8 kHz mono decode (cached per source). */
export function levelWindows(videoPath: string, span: TimeRange, signal?: AbortSignal): Promise<LevelWindow[]> {
  const range = levelIndices(span)
  return ensureSeries(LEVEL_SERIES, videoPath, [range], signal).then(series => series.range(range.from, range.to)
    .map(({ k, value }) => ({ start: k * AUDIO_WINDOW_SEC, db: value })))
}

/**
 * Measure and store the clip's gap activity as part of framing analysis.
 * Never fails the analysis: a decode error is logged and the clip is left
 * with no protected gaps, cut exactly as before this existed. An abort still
 * propagates.
 */
export async function refreshGapActivity(
  videoPath: string, clip: Clip, transcript: Transcript | undefined, signal?: AbortSignal
): Promise<void> {
  if (!transcript) return
  const started = performance.now()
  try {
    const measured = await measureGapActivity(videoPath, clip, transcript, signal)
    if (!measured) return
    clip.gapActivity = measured
    console.info('[gaps]', JSON.stringify({ clipId: clip.id, measured: measured.measured.length,
      active: measured.active.length, seconds: Math.round((performance.now() - started) / 100) / 10 }))
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('[gaps] measurement failed; no pauses protected for this clip:', error)
    clip.gapActivity = undefined
  }
}
