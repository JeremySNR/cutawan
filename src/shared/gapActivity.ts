import type { Clip, TimeRange, Transcript } from './types'
import { sourceStretches } from './clipSegments'
import { computeKeptSegments, isFiller, normalizeRanges, retakeRanges, subtractRanges, type TightenClip } from './tighten'

/**
 * "Gap activity": should a silent pause survive pause removal because
 * something is happening in it? Pause removal only knows about words, so a
 * silent demonstration, a reaction, someone pointing at a screen, or a laugh
 * or sting with no words is cut like dead air. Each gap pause removal would
 * cut is judged on two signals, both relative to the rest of the clip:
 *
 * - picture motion, from a 4 fps, 64x36 grayscale decode, lightly blurred;
 * - sound level, from an 8 kHz mono decode, against the clip's speech level.
 *
 * Everything here is pure; main/pipeline/gapActivity.ts does the decoding.
 * The thresholds were chosen on synthetic ffmpeg sources (1280x720 x264 at
 * CRF 30, measured with the same decode); the numbers are recorded beside
 * each one. Where in doubt they lean towards leaving a gap cut: dead air
 * kept in a short clip is the worse failure.
 */

/** Bumped when the measurement changes (2: frames blurred before differencing). */
export const GAP_ACTIVITY_VERSION = 2

/** Gaps shorter than this are not measured: keeping one would barely show. */
export const MIN_MEASURED_GAP_SEC = 0.6
/** Room left around a removed filler word, so the "um" itself is never heard as sound in a gap. */
const FILLER_PAD_SEC = 0.15

/**
 * The gaps pause removal would cut from this clip and that are worth
 * judging, in source seconds. Measured as if pause removal were on (the user
 * can switch it on later) and without any earlier activity protection, so a
 * re-measure sees every gap again. Leaves out:
 * - stretches that are cut only because a filler word was removed ("um"
 *   plus its padding): keeping them would bring the "um" back;
 * - retakes (a restarted or repeated sentence): they are speech, so they
 *   would always measure as loud, and keeping them would undo the removal;
 * - what the user cut, including the skipped middle of a joined clip.
 */
export function measurableGaps(clip: Pick<Clip, 'edit' | 'visualStory'>, transcript: Transcript): TimeRange[] {
  const { start, end } = clip.edit
  if (!(end > start)) return []
  const kept = computeKeptSegments(transcript, start, end, clip.visualStory?.protectedRanges)
  if (!kept) return []
  const removed = subtractRanges([{ start, end }], kept)
  const fillers = normalizeRanges(transcript.segments.flatMap(s => s.words)
    .filter(w => w.end > start && w.start < end && isFiller(w.sourceText ?? w.text))
    .map(w => ({ start: w.start - FILLER_PAD_SEC, end: w.end + FILLER_PAD_SEC })), start, end)
  const cuts = normalizeRanges(clip.edit.cuts, start, end)
  const retakes = retakeRanges(transcript, start, end)
  return subtractRanges(subtractRanges(subtractRanges(removed, fillers), retakes), cuts)
    .filter(r => r.end - r.start >= MIN_MEASURED_GAP_SEC)
}

/**
 * What to decode to judge `gaps`: per stretch of the clip (one for an
 * ordinary clip, one per moment of a joined clip, never the source between
 * them), the part from the first gap to the last plus `padSec` of speech
 * either side for the baselines.
 */
export function measurementSpans(
  edit: Clip['edit'], gaps: TimeRange[], padSec: number
): Array<TimeRange & { gaps: TimeRange[] }> {
  return sourceStretches(edit).flatMap((stretch) => {
    const inside = gaps.filter(g => g.start >= stretch.start - 1e-3 && g.end <= stretch.end + 1e-3)
    if (!inside.length) return []
    return [{
      start: Math.max(stretch.start, inside[0].start - padSec),
      end: Math.min(stretch.end, inside[inside.length - 1].end + padSec),
      gaps: inside
    }]
  })
}

/** The kept stretches the motion and level baselines are read from. */
export function speakingRanges(clip: TightenClip, transcript: Transcript): TimeRange[] {
  const { start, end } = clip.edit
  return computeKeptSegments(transcript, start, end, clip.visualStory?.protectedRanges) ?? [{ start, end }]
}

// ---------------------------------------------------------------------------
// Motion

export const MOTION_FPS = 4
export const MOTION_WIDTH = 64
export const MOTION_HEIGHT = 36

/**
 * Per-pixel differences up to this many grey levels are treated as noise,
 * after the blur below. Measured at 64x36, as the plain mean absolute
 * difference of blurred frames, a static still with heavy temporal grain
 * (noise=alls=25, CRF 30) reads 0.43-0.54 and a worse one (alls=40 at CRF
 * 38, blocks shimmering) 0.65-1.31; with 3 levels cored off they read 0.00
 * and 0.00-0.12. Without the blur the second still reads 0.02-0.15 even
 * with 4 levels cored off, which is why both changed together: the blur
 * takes the shimmer, so the core can be lower and keep more real motion.
 */
const MOTION_CORE = 3
/**
 * A frame step "moves" when its cored difference reaches this. Measured
 * (blurred, cored, per 0.25 s step, 1280x720 x264 at CRF 30, min/median/max):
 * static or grainy still 0.00; shimmering grain at CRF 38 0.00/0.00/0.12; a
 * face-sized box swaying 8 px on a detailed still 0.00/0.11/0.30; a 20 px
 * nod 0.01/0.24/0.84; a hand-sized (2% of frame) object moving
 * 0.32/0.89/1.62; a person-sized box crossing the frame 1.34/5.26/14.6; a
 * slow 60 px/s screen scroll 0.86/1.41/1.99; the moving test card
 * (testsrc2) 1.52/2.17/4.71. (Before the blur, with a 4-level core and a
 * 1.0 bar: hand 0.40/0.97/1.68, scroll 1.33/2.07/3.28, nod up to 0.99.)
 */
const MOTION_MIN = 0.9
/**
 * …and at least this multiple of the clip's typical motion while speaking.
 * A handheld camera or a gesturing speaker moves all through the clip; a
 * pause is only "active" when it moves clearly more than the talking does.
 * (A ±3 px handshake on the sharp test card measures 0.04/0.79/1.55 — it
 * was 0.36/1.47/2.31 before the blur — and the baseline lifts the bar above
 * it.)
 */
const MOTION_BASELINE_RATIO = 2.5
/**
 * Consecutive moving steps needed (0.75 s at 4 fps). A hard cut is one big
 * spike (70 on the test card) between two still steps, not sustained motion.
 */
const MOTION_RUN = 3
/** Padding around the moving stretch: one sample period either side. */
const MOTION_PAD_SEC = 1 / MOTION_FPS

/**
 * A light blur, applied to every frame before differencing: a 3x3 binomial
 * kernel ([1 2 1] each way, edges clamped). Compression shimmer — blocks and
 * ringing that flicker from frame to frame on a still picture — is high
 * frequency and averages out; anything big enough to be a real movement at
 * 64x36 barely changes.
 */
export function blurFrame(frame: ArrayLike<number>, width: number, height: number): Float32Array {
  const across = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const left = frame[row + Math.max(0, x - 1)], right = frame[row + Math.min(width - 1, x + 1)]
      across[row + x] = (left + 2 * frame[row + x] + right) / 4
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width, down = Math.min(height - 1, y + 1) * width, row = y * width
    for (let x = 0; x < width; x++) out[row + x] = (across[up + x] + 2 * across[row + x] + across[down + x]) / 4
  }
  return out
}

/** Mean absolute difference of two grayscale frames, ignoring noise-level changes. */
export function frameDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]) - MOTION_CORE
    if (d > 0) sum += d
  }
  return sum / n
}

/** One frame-to-frame step: `value` is the difference between the frames at `from` and `to`. */
export interface MotionStep { from: number; to: number; value: number }

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function within(range: TimeRange, outer: TimeRange): boolean {
  return range.start >= outer.start - 1e-3 && range.end <= outer.end + 1e-3
}

/** The typical motion while speaking: median step inside the kept stretches. */
export function motionBaseline(steps: MotionStep[], speaking: TimeRange[]): number {
  return median(steps.filter(s => speaking.some(r => within({ start: s.from, end: s.to }, r))).map(s => s.value))
}

/** The stretch of `gap` with sustained motion, padded, or null when there is none. */
export function motionExtent(steps: MotionStep[], gap: TimeRange, baseline: number): TimeRange | null {
  const threshold = Math.max(MOTION_MIN, MOTION_BASELINE_RATIO * baseline)
  const inside = steps.filter(s => within({ start: s.from, end: s.to }, gap))
  let first = Infinity, last = -Infinity
  let run: MotionStep[] = []
  const close = (): void => {
    if (run.length >= MOTION_RUN) {
      first = Math.min(first, run[0].from)
      last = Math.max(last, run[run.length - 1].to)
    }
    run = []
  }
  for (const step of inside) {
    if (step.value >= threshold) run.push(step)
    else close()
  }
  close()
  if (!(last > first)) return null
  return { start: Math.max(gap.start, first - MOTION_PAD_SEC), end: Math.min(gap.end, last + MOTION_PAD_SEC) }
}

// ---------------------------------------------------------------------------
// Sound

export const AUDIO_RATE = 8000
export const AUDIO_WINDOW_SEC = 0.1
/** Level given to digital silence, so it still sorts and subtracts. */
const SILENCE_DB = -100

/**
 * A window counts as loud when it is within this of the clip's typical
 * speech window: laughter, applause, music or a sound effect played at
 * speech loudness. Breaths and room tone sit 20-40 dB below speech.
 * Measured on the synthetic source in tests/gapActivityMedia.test.ts (AAC,
 * 8 kHz decode): speech median -18.8 dBFS; a tone at speech level in a gap
 * -17.0 (kept); a breath-level tone -35.1 and room tone -62 (both cut).
 */
const SPEECH_MARGIN_DB = 6
/**
 * …and this far above the clip's quiet floor: the 10th-percentile window of
 * everything decoded outside the gap being judged (other pauses, and the
 * dips between words). A music bed or a noisy room under the whole clip
 * lifts the floor with it, so it never makes every pause look active.
 */
const FLOOR_MARGIN_DB = 10
/** …and never quieter than this, whatever the clip's speech level. */
const ABSOLUTE_MIN_DB = -50
/** Loud windows needed in one gap (0.3 s): a single click or cough is not enough. */
const AUDIO_MIN_WINDOWS = 3
/** Gap edges sit next to speech; windows this close to them are not read. */
const AUDIO_EDGE_SEC = 0.1
const AUDIO_PAD_SEC = 0.15

/** RMS level, in dBFS, of each whole window of signed 16-bit mono samples. */
export function windowLevels(pcm: Int16Array, samplesPerWindow: number): number[] {
  const out: number[] = []
  for (let offset = 0; offset + samplesPerWindow <= pcm.length; offset += samplesPerWindow) {
    let sum = 0
    for (let i = offset; i < offset + samplesPerWindow; i++) sum += pcm[i] * pcm[i]
    const rms = Math.sqrt(sum / samplesPerWindow) / 32768
    out.push(rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB)
  }
  return out
}

/** One level window: `db` is the RMS level of [start, start + AUDIO_WINDOW_SEC). */
export interface LevelWindow { start: number; db: number }

/**
 * The clip's typical speech level: the median window inside detected
 * speech. Null when too little speech was decoded to say.
 */
export function speechLevel(windows: LevelWindow[], speech: TimeRange[]): number | null {
  const speaking = windows.filter(w => speech.some(r => w.start >= r.start - 1e-6 && w.start + AUDIO_WINDOW_SEC <= r.end + 1e-6))
  return speaking.length < 5 ? null : median(speaking.map(w => w.db))
}

/** The stretch of `gap` with sound near speech level, padded, or null when there is none. */
export function audioExtent(windows: LevelWindow[], gap: TimeRange, speechDb: number): TimeRange | null {
  const outside = windows.filter(w => w.start + AUDIO_WINDOW_SEC <= gap.start || w.start >= gap.end)
    .map(w => w.db).sort((a, b) => a - b)
  if (!outside.length) return null
  const floorDb = outside[Math.floor(outside.length * 0.1)]
  const threshold = Math.max(speechDb - SPEECH_MARGIN_DB, floorDb + FLOOR_MARGIN_DB, ABSOLUTE_MIN_DB)
  const loud = windows.filter(w => w.start >= gap.start + AUDIO_EDGE_SEC - 1e-6 &&
    w.start + AUDIO_WINDOW_SEC <= gap.end - AUDIO_EDGE_SEC + 1e-6 && w.db >= threshold)
  if (loud.length < AUDIO_MIN_WINDOWS) return null
  return {
    start: Math.max(gap.start, loud[0].start - AUDIO_PAD_SEC),
    end: Math.min(gap.end, loud[loud.length - 1].start + AUDIO_WINDOW_SEC + AUDIO_PAD_SEC)
  }
}

/**
 * The part of each gap to keep: from the first to the last moment either
 * signal holds. A gap that is active all through comes back whole; one with
 * a short laugh at the start keeps the laugh and still loses the dead air
 * after it (pause removal then cuts what is left, if it is long enough).
 */
export function activeGapRanges(input: {
  gaps: TimeRange[]
  speaking: TimeRange[]
  steps: MotionStep[]
  windows: LevelWindow[]
  speech: TimeRange[]
}): TimeRange[] {
  const baseline = motionBaseline(input.steps, input.speaking)
  const speechDb = input.windows.length ? speechLevel(input.windows, input.speech) : null
  const out: TimeRange[] = []
  for (const gap of input.gaps) {
    const parts = [
      input.steps.length ? motionExtent(input.steps, gap, baseline) : null,
      speechDb !== null ? audioExtent(input.windows, gap, speechDb) : null
    ].filter((r): r is TimeRange => r !== null)
    if (!parts.length) continue
    out.push({ start: Math.min(...parts.map(r => r.start)), end: Math.max(...parts.map(r => r.end)) })
  }
  return out
}

/** Speech the level reference is read from: voice activity when known, else the words. */
export function speechRanges(transcript: Transcript, start: number, end: number): TimeRange[] {
  if (transcript.speech?.length) return normalizeRanges(transcript.speech, start, end)
  return normalizeRanges(transcript.segments.flatMap(s => s.words)
    .filter(w => !isFiller(w.sourceText ?? w.text)), start, end)
}
