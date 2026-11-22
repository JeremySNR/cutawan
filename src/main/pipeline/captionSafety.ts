import type { CaptionSafety, FaceBand, TimeRange } from '@shared/types'
import { streamRawFrames } from './ffmpeg'
import { mediaJobs } from './mediaJobs'

/**
 * Measurements that keep burned-in captions clear of what is already in the
 * picture (consumed by shared/captionPlacement.ts):
 *
 * - the tracked speaker's face, from the boxes active speaker detection
 *   already computes for the focus track;
 * - a band of burned-in text (subtitles, a news ticker) in the lower part of
 *   the frame, found from a handful of keyframes.
 *
 * Both are conservative: a face band needs a steady detection, and a text
 * band needs strong, horizontally dense edges with a clean boundary at the
 * same height in most sampled frames.
 */

export const CAPTION_SAFETY_VERSION = 1

interface BoxedTrack {
  start: number
  centres: number[]
  boxes?: Array<{ x1: number; y1: number; x2: number; y2: number }>
}

/** Seconds of frames summarised into one face band. */
const FACE_BIN_SEC = 1
/** A bin needs a face in at least this share of its frames. */
const FACE_BIN_COVERAGE = 0.6

/**
 * The focused speaker's vertical extent over time: for every analysis frame
 * the box of the track whose centre the focus chose, summarised per second
 * (median top and bottom). Normalised source coordinates, absolute seconds.
 */
export function faceBandsFromTracks(
  tracks: BoxedTrack[],
  centres: Array<number | null>,
  startSec: number,
  fps: number
): FaceBand[] {
  const perFrame: Array<{ top: number; bottom: number } | null> = centres.map((centre, f) => {
    if (centre === null) return null
    for (const track of tracks) {
      const k = f - track.start
      if (k < 0 || k >= track.centres.length || !track.boxes?.[k]) continue
      if (Math.abs(track.centres[k] - centre) < 1e-6) return { top: track.boxes[k].y1, bottom: track.boxes[k].y2 }
    }
    return null
  })
  const bin = Math.max(1, Math.round(FACE_BIN_SEC * fps))
  const bands: FaceBand[] = []
  for (let from = 0; from < perFrame.length; from += bin) {
    const frames = perFrame.slice(from, from + bin).filter((v): v is { top: number; bottom: number } => v !== null)
    if (frames.length < FACE_BIN_COVERAGE * Math.min(bin, perFrame.length - from)) continue
    const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const top = median(frames.map((f) => f.top))
    const bottom = median(frames.map((f) => f.bottom))
    if (!(bottom > top) || top < 0 || bottom > 1.05) continue
    bands.push({
      start: startSec + from / fps,
      end: startSec + Math.min(perFrame.length, from + bin) / fps,
      top: Math.max(0, top),
      bottom: Math.min(1, bottom)
    })
  }
  return bands
}

/** Sampled frame size for text detection (aspect is irrelevant: rows are normalised). */
export const TEXT_SAMPLE_WIDTH = 320
export const TEXT_SAMPLE_HEIGHT = 240
/** Only the lower part of the frame is searched (where subtitles live). */
const SEARCH_FROM = 0.55
const SEARCH_TO = 0.97
/** Horizontal step that counts as a text edge, in 8-bit grey levels. */
const EDGE_STEP = 56
const MIN_BAND = 0.022
const MAX_BAND = 0.14
/** A band has to be in at least this share of the sampled frames. */
const PRESENCE = 0.6
const MIN_FRAMES = 3
const MAX_FRAMES = 16

interface Band { top: number; bottom: number }

/**
 * Text-like bands in one greyscale frame: runs of rows in the lower part whose
 * strong horizontal edges are dense (several times the frame's typical row),
 * that stand out sharply from the rows just above and below, span a fair
 * width, and contain bright glyph pixels. Fractions of the frame height.
 */
export function textBandsInFrame(frame: Uint8Array, width: number, height: number): Band[] {
  const density = new Float64Array(height)
  for (let y = 0; y < height; y++) {
    let edges = 0
    const row = y * width
    for (let x = 0; x < width - 1; x++) if (Math.abs(frame[row + x + 1] - frame[row + x]) > EDGE_STEP) edges++
    density[y] = edges / width
  }
  const smooth = Float64Array.from(density, (_, y) =>
    (density[Math.max(0, y - 1)] + density[y] + density[Math.min(height - 1, y + 1)]) / 3)
  const sorted = Array.from(smooth.slice(Math.floor(height * 0.2), Math.floor(height * SEARCH_TO))).sort((a, b) => a - b)
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0
  const threshold = Math.max(0.07, typical * 3)
  const bands: Band[] = []
  const from = Math.floor(height * SEARCH_FROM), to = Math.floor(height * SEARCH_TO)
  let y = from
  while (y < to) {
    if (smooth[y] < threshold) { y++; continue }
    let end = y
    let gap = 0
    while (end + 1 < to && (smooth[end + 1] >= threshold || gap < 2)) {
      end++
      gap = smooth[end] >= threshold ? 0 : gap + 1
    }
    end -= gap
    const top = y, bottom = end + 1
    y = end + 1
    const size = (bottom - top) / height
    if (size < MIN_BAND || size > MAX_BAND) continue
    let inside = 0
    for (let r = top; r < bottom; r++) inside += smooth[r]
    inside /= bottom - top
    const span = bottom - top
    let outside = 0, count = 0
    for (let r = Math.max(0, top - span); r < top; r++) { outside += smooth[r]; count++ }
    for (let r = bottom; r < Math.min(height, bottom + span); r++) { outside += smooth[r]; count++ }
    if (count && outside / count > inside * 0.4) continue
    // Glyphs span a fair width and include bright pixels (white or yellow text).
    let left = width, right = 0, bright = 0
    for (let r = top; r < bottom; r++) {
      for (let x = 0; x < width - 1; x++) {
        const v = frame[r * width + x]
        if (v > 200) bright++
        if (Math.abs(frame[r * width + x + 1] - v) > EDGE_STEP) { left = Math.min(left, x); right = Math.max(right, x) }
      }
    }
    if (right - left < width * 0.15 || bright < 0.02 * (right - left) * span) continue
    bands.push({ top: top / height, bottom: bottom / height })
  }
  return bands
}

/**
 * A text band present at the same height in most sampled frames, or null.
 * The result is widened slightly, since the frames are a sample.
 */
export function persistentTextBand(frames: Uint8Array[], width: number, height: number): Band | null {
  if (frames.length < MIN_FRAMES) return null
  const perFrame = frames.map((f) => textBandsInFrame(f, width, height))
  const overlaps = (a: Band, b: Band): boolean =>
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top)
  let best: { band: Band; members: Band[] } | null = null
  for (const candidate of perFrame.flat()) {
    const members = perFrame.map((bands) => bands.find((b) => overlaps(b, candidate))).filter((b): b is Band => Boolean(b))
    if (!best || members.length > best.members.length) best = { band: candidate, members }
  }
  if (!best || best.members.length < Math.max(MIN_FRAMES, Math.ceil(PRESENCE * frames.length))) return null
  const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  return {
    top: Math.max(0, median(best.members.map((b) => b.top)) - 0.01),
    bottom: Math.min(1, median(best.members.map((b) => b.bottom)) + 0.01)
  }
}

/**
 * Look for burned-in text across a clip's stretches. Decodes keyframes only
 * (fast even on long footage) at a small fixed size. Never throws: a decode
 * failure just means no band.
 */
export async function detectBurnedInText(videoPath: string, ranges: TimeRange[], signal?: AbortSignal): Promise<Band | null> {
  const frames: Uint8Array[] = []
  const bytes = TEXT_SAMPLE_WIDTH * TEXT_SAMPLE_HEIGHT
  try {
    await mediaJobs.run(async () => {
      for (const range of ranges) {
        if (range.end - range.start < 0.5) continue
        await streamRawFrames([
          '-v', 'error',
          '-skip_frame', 'nokey',
          '-ss', range.start.toFixed(3), '-t', (range.end - range.start).toFixed(3), '-i', videoPath,
          '-an', '-vf', `scale=${TEXT_SAMPLE_WIDTH}:${TEXT_SAMPLE_HEIGHT}:flags=area,format=gray`,
          '-fps_mode', 'passthrough', '-f', 'rawvideo'
        ], bytes, (frame) => { frames.push(new Uint8Array(frame)) }, signal)
      }
    }, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    console.error('Burned-in text detection failed (captions keep their position):', err)
    return null
  }
  // Spread the sample evenly when there are many keyframes.
  const step = Math.max(1, frames.length / MAX_FRAMES)
  const sample = Array.from({ length: Math.min(frames.length, MAX_FRAMES) }, (_, i) => frames[Math.floor(i * step)])
  return persistentTextBand(sample, TEXT_SAMPLE_WIDTH, TEXT_SAMPLE_HEIGHT)
}

export function captionSafety(range: TimeRange, faces: FaceBand[], textBand: Band | null): CaptionSafety {
  return { version: CAPTION_SAFETY_VERSION, start: range.start, end: range.end, faces, textBand }
}
