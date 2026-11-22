import type { ClipEditState, TimeRange } from './types'
import { normalizeRanges } from './tighten'

/**
 * How the editor's timeline lays source time out along its width.
 *
 * Normally that is a straight line. A clip joined from two moments five
 * minutes apart breaks it: drawn to scale, each twenty-second moment would be
 * a sliver either side of a huge cut, too small to trim. So the middle of a
 * long cut is folded into a narrow fixed-width marker, and the footage that
 * matters gets the width. A little of the cut stays visible on each side of
 * the fold, so the edges of a join can be dragged into it.
 */

/** Cuts at least this long are folded. */
export const FOLD_MIN_CUT_SEC = 30
/** How much of a folded cut stays drawn to scale at each of its edges. */
export const FOLD_CONTEXT_SEC = 8
/** Share of the timeline width one fold takes. */
export const FOLD_WIDTH = 0.06
/** Most folds on one timeline; beyond this only the longest cuts are folded. */
export const MAX_FOLDS = 4

/** The stretches of the window's cuts that are folded away, in order. */
export function timelineFolds(
  edit: Pick<ClipEditState, 'start' | 'end' | 'cuts'>, windowStart: number, windowEnd: number
): TimeRange[] {
  return normalizeRanges(edit.cuts, Math.max(windowStart, edit.start), Math.min(windowEnd, edit.end))
    .filter((cut) => cut.end - cut.start >= FOLD_MIN_CUT_SEC)
    // A timeline of mostly markers is no easier to read than one of slivers.
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, MAX_FOLDS)
    .sort((a, b) => a.start - b.start)
    .map((cut) => ({ start: cut.start + FOLD_CONTEXT_SEC, end: cut.end - FOLD_CONTEXT_SEC }))
}

/** A stretch of the timeline and the share of its width it occupies. */
export interface TimelineSpan extends TimeRange {
  left: number
  width: number
}

export interface TimelineScale {
  /** Stretches drawn to scale, each with its own filmstrip. */
  panes: TimelineSpan[]
  /** Folded stretches between them. */
  folds: TimelineSpan[]
  /** Position of a source time along the timeline, 0..1. */
  toFrac: (t: number) => number
  /** Source time at a position along the timeline. */
  fromFrac: (frac: number) => number
}

/**
 * Lay a window out with the given stretches folded. Panes share the width
 * left over in proportion to their length, so time runs at one speed through
 * all of them; inside a fold it runs much faster but still forwards, which
 * keeps every position on the timeline a valid time to seek or drag to.
 */
export function buildTimelineScale(windowStart: number, windowEnd: number, folds: TimeRange[] = []): TimelineScale {
  const end = Math.max(windowEnd, windowStart + 0.1)
  const inside = normalizeRanges(folds, windowStart, end)
    .filter((fold) => fold.start > windowStart && fold.end < end)
  const bounds = [windowStart, ...inside.flatMap((fold) => [fold.start, fold.end]), end]
  const paneSeconds = bounds.reduce((sum, bound, i) => (i % 2 === 1 ? sum + bound - bounds[i - 1] : sum), 0)
  const paneWidth = 1 - inside.length * FOLD_WIDTH

  const spans: Array<TimelineSpan & { fold: boolean }> = []
  let left = 0
  for (let i = 0; i < bounds.length - 1; i++) {
    const fold = i % 2 === 1
    const width = fold ? FOLD_WIDTH : ((bounds[i + 1] - bounds[i]) / paneSeconds) * paneWidth
    spans.push({ start: bounds[i], end: bounds[i + 1], left, width, fold })
    left += width
  }

  const toFrac = (t: number): number => {
    if (t <= windowStart) return 0
    if (t >= end) return 1
    const span = spans.find((s) => t <= s.end) ?? spans[spans.length - 1]
    return span.left + ((t - span.start) / (span.end - span.start)) * span.width
  }
  const fromFrac = (frac: number): number => {
    const f = Math.max(0, Math.min(1, frac))
    const span = spans.find((s) => f <= s.left + s.width) ?? spans[spans.length - 1]
    return span.start + ((f - span.left) / span.width) * (span.end - span.start)
  }
  const strip = ({ start, end: spanEnd, left: spanLeft, width }: TimelineSpan): TimelineSpan =>
    ({ start, end: spanEnd, left: spanLeft, width })
  return {
    panes: spans.filter((s) => !s.fold).map(strip),
    folds: spans.filter((s) => s.fold).map(strip),
    toFrac,
    fromFrac
  }
}
