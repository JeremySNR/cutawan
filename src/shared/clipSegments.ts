import type { Clip, ClipEditState, TimeRange, Transcript, TranscriptWord } from './types'
import { wordsInRange } from './captionLayout'
import { normalizeRanges, subtractRanges } from './tighten'

/**
 * A clip is one trim (`edit.start`..`edit.end`) with ranges cut out of it. A
 * clip joined from separate moments of the source is the same thing with a
 * long cut in the middle: nothing about it is special to the editor, which
 * can restore the cut or add more like any other.
 *
 * What does change is the cost of treating the trim as one stretch of video.
 * Two moments five minutes apart make a five-minute trim, and tracking faces
 * across it, measuring its loudness or decoding it for export would spend
 * minutes on footage that never plays. These helpers give the stretches that
 * are actually used.
 */

/**
 * Gaps shorter than this are not worth a separate seek or analysis run: the
 * footage between is cheaper to read through than to restart on.
 */
export const SEPARATE_STRETCH_GAP_SEC = 15

type Trim = Pick<ClipEditState, 'start' | 'end' | 'cuts'>

/** The source ranges the trim keeps: everything between its cuts, in order. */
export function selectedRanges(edit: Trim): TimeRange[] {
  if (!(edit.end > edit.start)) return []
  return subtractRanges([{ start: edit.start, end: edit.end }], normalizeRanges(edit.cuts, edit.start, edit.end))
}

/** Seconds of source the trim keeps, before automatic pause removal. */
export function selectedDuration(edit: Trim): number {
  return selectedRanges(edit).reduce((sum, range) => sum + range.end - range.start, 0)
}

/** The transcript words inside the trim's selected ranges, in order. */
export function selectedWords(transcript: Transcript, edit: Trim): TranscriptWord[] {
  const ranges = selectedRanges(edit)
  return wordsInRange(transcript, edit.start, edit.end).filter((word) => {
    const mid = (word.start + word.end) / 2
    return ranges.some((range) => mid >= range.start && mid <= range.end)
  })
}

/** Ranges merged across every gap shorter than `minGapSec`. */
export function mergeNearbyRanges(ranges: TimeRange[], minGapSec: number): TimeRange[] {
  const out: TimeRange[] = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && range.start - last.end < minGapSec) last.end = Math.max(last.end, range.end)
    else out.push({ ...range })
  }
  return out
}

/**
 * The stretches of source a clip needs read: its selected ranges, joined
 * across the short cuts. One stretch for an ordinary clip.
 */
export function sourceStretches(edit: Trim, minGapSec = SEPARATE_STRETCH_GAP_SEC): TimeRange[] {
  return mergeNearbyRanges(selectedRanges(edit), minGapSec)
}

/**
 * At most `max` stretches, by reading through the shortest gaps first. Each
 * stretch an export opens is another decoder on the same file; a long edit
 * with dozens of cuts must not open dozens of them.
 */
export function limitStretches(stretches: TimeRange[], max: number): TimeRange[] {
  const out = stretches.map((stretch) => ({ ...stretch }))
  while (out.length > Math.max(1, max)) {
    let smallest = 1
    for (let i = 2; i < out.length; i++) {
      if (out[i].start - out[i - 1].end < out[smallest].start - out[smallest - 1].end) smallest = i
    }
    out[smallest - 1].end = out[smallest].end
    out.splice(smallest, 1)
  }
  return out
}

/** Whether every one of `ranges` lies inside one of `covering`. */
export function rangesCovered(ranges: TimeRange[], covering: TimeRange[], toleranceSec = 0.001): boolean {
  return ranges.every((range) =>
    covering.some((cover) => range.start >= cover.start - toleranceSec && range.end <= cover.end + toleranceSec))
}

/**
 * The separate moments a clip plays, when it joins more than one. An
 * AI-joined clip whose cut the user has since restored is one moment again.
 */
export function joinedMoments(clip: Pick<Clip, 'edit' | 'stitch'>): TimeRange[] | null {
  if (!clip.stitch) return null
  const moments = mergeNearbyRanges(selectedRanges(clip.edit), MIN_JOIN_GAP_SEC)
  return moments.length > 1 ? moments : null
}

/**
 * Two picks closer than this are one moment with a pause in it, which pause
 * removal already handles; they are merged rather than joined.
 */
export const MIN_JOIN_GAP_SEC = 3
