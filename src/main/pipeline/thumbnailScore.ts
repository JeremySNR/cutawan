import type { Clip, TimeRange, Transcript } from '@shared/types'
import { selectedRanges } from '@shared/clipSegments'
import { wordsInRange } from '@shared/captionLayout'

/**
 * Choosing a clip's thumbnail from a handful of candidate frames. Pure, so
 * the scoring can be tested on synthetic frames; the ffmpeg side lives in
 * thumbnail.ts.
 *
 * A thumbnail is the first thing anyone sees of a clip, and the frame 1.5 s
 * in is often a blink, a half-finished gesture, a cut or a fade. Candidates
 * are spread over what the clip plays, weighted towards the end of the hook
 * line and the most energetic delivery, then judged on the pixels: sharp,
 * well exposed, with some contrast and detail, and not caught mid-transition.
 */

/** A small single-channel (luma) frame, row-major. */
export interface GrayFrame {
  width: number
  height: number
  data: Uint8Array
}

export interface FrameMetrics {
  /** Variance of the 4-neighbour Laplacian: high for crisp edges, low for blur. */
  laplacianVariance: number
  /** Mean luma, 0..255. */
  mean: number
  /** Luma standard deviation, 0..255. */
  stdDev: number
  /** Shannon entropy of the luma histogram, 0..8 bits. */
  entropy: number
  /** Share of pixels crushed to black or blown to white. */
  clipped: number
}

export function frameMetrics(frame: GrayFrame): FrameMetrics {
  const { width: w, height: h, data } = frame
  const histogram = new Array<number>(256).fill(0)
  let sum = 0
  let sumSq = 0
  let clipped = 0
  for (let i = 0; i < w * h; i++) {
    const v = data[i]
    histogram[v]++
    sum += v
    sumSq += v * v
    if (v <= 8 || v >= 247) clipped++
  }
  const n = Math.max(1, w * h)
  const mean = sum / n
  const stdDev = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  let entropy = 0
  for (const count of histogram) {
    if (count === 0) continue
    const p = count / n
    entropy -= p * Math.log2(p)
  }
  let lapSum = 0
  let lapSq = 0
  let lapN = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]
      lapSum += l
      lapSq += l * l
      lapN++
    }
  }
  const lapMean = lapN ? lapSum / lapN : 0
  const laplacianVariance = lapN ? Math.max(0, lapSq / lapN - lapMean * lapMean) : 0
  return { laplacianVariance, mean, stdDev, entropy, clipped: clipped / n }
}

/** Mean absolute luma difference between two same-sized frames, 0..1. */
export function frameDifference(a: GrayFrame, b: GrayFrame): number {
  if (a.data.length !== b.data.length || a.data.length === 0) return 1
  let total = 0
  for (let i = 0; i < a.data.length; i++) total += Math.abs(a.data[i] - b.data[i])
  return total / (a.data.length * 255)
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** 0..1 picture quality from the metrics, before context (hook, energy, face). */
export function frameQuality(m: FrameMetrics): number {
  // log scale: a 160 px frame of real footage sits around 50 (soft) to 2000 (crisp).
  const sharpness = clamp01(Math.log10(1 + m.laplacianVariance) / 3.3)
  const contrast = clamp01(m.stdDev / 60)
  const detail = clamp01(m.entropy / 7.5)
  // Mid-tones are ideal; a dark or blown frame falls away to nothing.
  const exposure = m.mean < 60 ? clamp01((m.mean - 15) / 45) : m.mean > 195 ? clamp01((240 - m.mean) / 45) : 1
  const clipping = 1 - clamp01((m.clipped - 0.2) / 0.5)
  return (0.35 * sharpness + 0.2 * contrast + 0.15 * detail + 0.3 * exposure) * clipping
}

/**
 * Below this mean difference from either neighbour (frames ~0.17 s apart) a
 * frame is ordinary motion; by twice it, it is a cut, a flash or a fade.
 */
export const TRANSITION_DIFF = 0.08

/** 1 for a steady frame, falling to 0 as it differs from its neighbours like a cut. */
export function steadiness(neighbourDiffs: number[]): number {
  const worst = Math.max(0, ...neighbourDiffs)
  return 1 - clamp01((worst - TRANSITION_DIFF) / TRANSITION_DIFF)
}

export interface ThumbnailCandidate {
  /** Source seconds. */
  time: number
  /**
   * 0..1 editorial preference before looking at pixels: just after the
   * hook line and the most energetic delivery rank highest.
   */
  prior: number
  /** Whether face tracking places a face here; undefined when there is no face data. */
  face?: boolean
}

export interface ScoredCandidate extends ThumbnailCandidate {
  score: number
}

/** Final score: picture quality, held down by transitions, lifted by context. */
export function scoreCandidate(
  candidate: ThumbnailCandidate,
  frame: GrayFrame,
  neighbours: GrayFrame[]
): number {
  const quality = frameQuality(frameMetrics(frame))
  const steady = steadiness(neighbours.map((n) => frameDifference(frame, n)))
  const face = candidate.face === undefined ? 1 : candidate.face ? 1.1 : 0.85
  return quality * steady * (0.75 + 0.25 * clamp01(candidate.prior)) * face
}

/**
 * The best candidate, or null when none is usable (every frame black,
 * blown out or mid-transition): the caller then keeps the plain frame.
 */
export function pickThumbnail(scored: ScoredCandidate[], minScore = 0.12): ScoredCandidate | null {
  let best: ScoredCandidate | null = null
  for (const c of scored) if (!best || c.score > best.score) best = c
  return best && best.score >= minScore ? best : null
}

/** How many candidates one ffmpeg call decodes. */
export const THUMBNAIL_CANDIDATES = 6
/** Candidates closer than this are one moment. */
const MIN_CANDIDATE_GAP_SEC = 0.75
/** Keep away from range edges: cuts and fades live there. */
const EDGE_MARGIN_SEC = 0.4

/** Today's frame: 1.5 s into what the clip plays. Also the fallback. */
export function defaultThumbnailTime(clip: Pick<Clip, 'edit' | 'suggestedStart' | 'suggestedEnd'>): number {
  const ranges = selectedRanges(clip.edit)
  const first = ranges[0] ?? { start: clip.suggestedStart, end: clip.suggestedEnd }
  return first.start + Math.min(1.5, (first.end - first.start) / 2)
}

/** Source time `offset` seconds into the played ranges. */
function playedToSource(ranges: TimeRange[], offset: number): number {
  let left = offset
  for (const r of ranges) {
    if (left <= r.end - r.start) return r.start + left
    left -= r.end - r.start
  }
  return ranges.at(-1)?.end ?? 0
}

/** Pull `t` inside the played range nearest it, off its edges where there is room. */
function clampIntoPlayed(ranges: TimeRange[], t: number): number {
  let best = t
  let bestDist = Infinity
  for (const r of ranges) {
    const margin = Math.min(EDGE_MARGIN_SEC, (r.end - r.start) / 3)
    const c = Math.max(r.start + margin, Math.min(r.end - margin, t))
    const d = Math.abs(c - t)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/**
 * Candidate times inside what the clip plays, highest prior first after
 * de-duplication. Always includes today's frame, so the picker can only
 * improve on it.
 */
export function thumbnailCandidates(
  clip: Pick<Clip, 'edit' | 'suggestedStart' | 'suggestedEnd' | 'focusTrack'>,
  transcript: Transcript | null,
  count = THUMBNAIL_CANDIDATES
): ThumbnailCandidate[] {
  const ranges = selectedRanges(clip.edit)
  if (!ranges.length) return []
  const played = ranges.reduce((sum, r) => sum + r.end - r.start, 0)
  const raw: ThumbnailCandidate[] = [{ time: defaultThumbnailTime(clip), prior: 0.55 }]

  if (transcript) {
    // Just after the hook: the end of the first sentence, if it ends early.
    const words = wordsInRange(transcript, ranges[0].start, ranges.at(-1)!.end)
      .filter((w) => ranges.some((r) => w.start >= r.start && w.end <= r.end))
    const firstStop = words.find((w) => /[.!?]["')\]]?$/.test(w.text))
    if (firstStop && firstStop.end - ranges[0].start < 12) {
      raw.push({ time: firstStop.end + 0.3, prior: 0.85 })
    }
    // The most energetic spoken lines inside the clip.
    const energetic = transcript.segments
      .filter((s) => s.energy !== undefined && ranges.some((r) => s.start < r.end && s.end > r.start))
      .sort((a, b) => (b.energy ?? 0) - (a.energy ?? 0))
      .slice(0, 2)
    for (const s of energetic) raw.push({ time: (s.start + s.end) / 2, prior: 0.45 + 0.5 * (s.energy ?? 0) })
  }

  // An even spread over the rest, so a strong frame anywhere has a chance.
  const spread = Math.max(0, count - raw.length)
  for (let i = 0; i < spread; i++) {
    raw.push({ time: playedToSource(ranges, played * ((i + 1) / (spread + 1))), prior: 0.35 })
  }

  const track = clip.focusTrack?.length ? clip.focusTrack : null
  const out: ThumbnailCandidate[] = []
  for (const c of raw.sort((a, b) => b.prior - a.prior)) {
    const time = clampIntoPlayed(ranges, c.time)
    if (out.some((o) => Math.abs(o.time - time) < MIN_CANDIDATE_GAP_SEC)) continue
    const face = track ? time >= track[0].t - 0.5 && time <= track[track.length - 1].t + 0.5 : undefined
    out.push({ ...c, time, ...(face === undefined ? {} : { face }) })
    if (out.length >= count) break
  }
  return out.sort((a, b) => a.time - b.time)
}
