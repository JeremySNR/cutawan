import type { Clip, TimeRange, Transcript } from '@shared/types'
import {
  activeGapRanges,
  AUDIO_RATE,
  AUDIO_WINDOW_SEC,
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
 */

/** Speech decoded either side of the gaps, for the motion and level baselines. */
const BASELINE_PAD_SEC = 4
/**
 * Most source seconds one clip may decode. An ordinary clip is far below it;
 * a clip trimmed out to many minutes is left unmeasured rather than holding
 * up framing analysis for as long as a full decode takes.
 */
const MAX_DECODE_SEC = 240

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
  if (spans.reduce((sum, span) => sum + span.end - span.start, 0) > MAX_DECODE_SEC) return null

  const { hasAudio } = await probeVideo(videoPath)
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

/** Frame-to-frame motion across `span`, from a 4 fps, 64x36 grayscale decode. */
export function motionSteps(videoPath: string, span: TimeRange, signal?: AbortSignal): Promise<MotionStep[]> {
  return mediaJobs.run(async () => {
    const steps: MotionStep[] = []
    let previous: Uint8Array | null = null
    await streamRawFrames([
      '-v', 'error',
      // Non-reference frames are never needed at 4 fps and skipping them
      // saves ~15% of the decode. (Skipping the loop filter as well saved
      // more but made grainy stills read as motion: deblocking hides noise.)
      '-skip_frame', 'noref',
      '-ss', span.start.toFixed(3), '-t', (span.end - span.start).toFixed(3), '-i', videoPath,
      '-an', '-vf', `fps=${MOTION_FPS},scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:flags=area,format=gray`,
      '-f', 'rawvideo'
    ], MOTION_WIDTH * MOTION_HEIGHT, (frame, index) => {
      // The frame is a view into the decoder's output chunk; keep a copy.
      const current = new Uint8Array(frame)
      if (previous) {
        steps.push({
          from: span.start + (index - 1) / MOTION_FPS,
          to: span.start + index / MOTION_FPS,
          value: frameDifference(previous, current)
        })
      }
      previous = current
    }, signal)
    return steps
  }, signal)
}

/** RMS level of each 0.1 s of `span`, from an 8 kHz mono decode. */
export function levelWindows(videoPath: string, span: TimeRange, signal?: AbortSignal): Promise<LevelWindow[]> {
  const samples = Math.round(AUDIO_RATE * AUDIO_WINDOW_SEC)
  return mediaJobs.run(async () => {
    const windows: LevelWindow[] = []
    await streamRawFrames([
      '-v', 'error',
      '-ss', span.start.toFixed(3), '-t', (span.end - span.start).toFixed(3), '-i', videoPath,
      '-vn', '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le'
    ], samples * 2, (chunk, index) => {
      const pcm = new Int16Array(samples)
      for (let i = 0; i < samples; i++) pcm[i] = chunk.readInt16LE(i * 2)
      windows.push({ start: span.start + index * AUDIO_WINDOW_SEC, db: windowLevels(pcm, samples)[0] })
    }, signal)
    return windows
  }, signal)
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
