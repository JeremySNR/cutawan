import type { ClipEditState, TimeRange, Transcript } from './types'
import { editedClipDuration, normalizeRanges, type TightenClip } from './tighten'

/**
 * Pure timeline edits shared by keyboard shortcuts, the timeline and the
 * transcript. Each returns a new edit state; the caller saves it (and records
 * undo history). Times are source seconds.
 */

/** Razor points closer than this to an existing point or a clip edge are ignored. */
const SPLIT_TOLERANCE_SEC = 0.05
/** The trim never shrinks below this. */
export const MIN_CLIP_SEC = 1

/** Add a razor point at `t` (inside the trim). */
export function splitAt(edit: ClipEditState, t: number): ClipEditState {
  if (t <= edit.start + SPLIT_TOLERANCE_SEC || t >= edit.end - SPLIT_TOLERANCE_SEC) return edit
  const splits = edit.splits ?? []
  if (splits.some(s => Math.abs(s - t) < SPLIT_TOLERANCE_SEC)) return edit
  return { ...edit, splits: [...splits, t].sort((a, b) => a - b) }
}

/** Pieces between the trim edges and razor points, in order. */
export function timelinePieces(edit: ClipEditState): TimeRange[] {
  const bounds = [edit.start, ...(edit.splits ?? []).filter(s => s > edit.start && s < edit.end).sort((a, b) => a - b), edit.end]
  return bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }))
}

/** The piece containing `t`; none outside the trim. */
export function pieceAt(edit: ClipEditState, t: number): TimeRange | undefined {
  const pieces = timelinePieces(edit)
  return pieces.find(p => t >= p.start && t < p.end) ?? (t === edit.end ? pieces.at(-1) : undefined)
}

/** Remove a source range from playback (ripple: later material closes the gap). */
export function cutRange(edit: ClipEditState, range: TimeRange): ClipEditState {
  return { ...edit, cuts: normalizeRanges([...(edit.cuts ?? []), range], edit.start, edit.end) }
}

/** Put back the user cut containing `t`. */
export function uncutAt(edit: ClipEditState, t: number): ClipEditState {
  const cuts = (edit.cuts ?? []).filter(c => !(t >= c.start && t <= c.end))
  return cuts.length === (edit.cuts ?? []).length ? edit : { ...edit, cuts }
}

/** A cut never shrinks below this; to remove one, restore it instead. */
export const MIN_CUT_SEC = 0.2
/** Playable footage always left between a cut and its neighbour or the trim edge. */
const MIN_PIECE_BESIDE_CUT_SEC = 0.5

/**
 * Move one edge of an existing cut to `t`: the way to let a moment run a
 * little longer into what was cut, or end it a little sooner. The cut is
 * found by its other edge, the one staying put, so a drag can keep naming
 * the cut as it was when grabbed. The edge stops short of the cut's other
 * edge, of the neighbouring cut and of the trim, so no piece is squeezed to
 * nothing.
 */
export function moveCutEdge(edit: ClipEditState, cut: TimeRange, which: 'start' | 'end', t: number): ClipEditState {
  const cuts = normalizeRanges(edit.cuts, edit.start, edit.end)
  const index = cuts.findIndex(c => which === 'start' ? Math.abs(c.end - cut.end) < 1e-6 : Math.abs(c.start - cut.start) < 1e-6)
  if (index === -1 || !Number.isFinite(t)) return edit
  const current = cuts[index]
  const before = (index > 0 ? cuts[index - 1].end : edit.start) + MIN_PIECE_BESIDE_CUT_SEC
  const after = (index < cuts.length - 1 ? cuts[index + 1].start : edit.end) - MIN_PIECE_BESIDE_CUT_SEC
  const moved = which === 'start'
    ? { start: Math.max(before, Math.min(t, current.end - MIN_CUT_SEC)), end: current.end }
    : { start: current.start, end: Math.min(after, Math.max(t, current.start + MIN_CUT_SEC)) }
  if (!(moved.end > moved.start)) return edit
  return { ...edit, cuts: cuts.map((c, i) => (i === index ? moved : c)) }
}

/** Keep a pause that automatic removal took out, or remove it again. */
export function toggleRestored(edit: ClipEditState, pause: TimeRange): ClipEditState {
  const restored = edit.restored ?? []
  const existing = restored.find(r => r.start < pause.end && r.end > pause.start)
  return { ...edit, restored: existing ? restored.filter(r => r !== existing) : [...restored, { ...pause }] }
}

/**
 * Remove a pause that was kept automatically for its activity (see
 * `Clip.gapActivity`), or keep it again. The range only has to overlap the
 * active range: re-measuring may move its edges a little.
 */
export function toggleActiveGap(edit: ClipEditState, pause: TimeRange): ClipEditState {
  const removed = edit.removedActive ?? []
  const overlapping = removed.filter(r => r.start < pause.end && r.end > pause.start)
  return { ...edit, removedActive: overlapping.length
    ? removed.filter(r => !overlapping.includes(r))
    : [...removed, { start: pause.start, end: pause.end }] }
}

/**
 * Clicking a pause that pause removal takes out. One the user removed
 * despite its activity goes back to being kept automatically, so the two
 * clicks are an exact toggle; any other pause is restored as before.
 *
 * `active` is the clip's measured active pauses (`gapActivity.active`). A
 * removal choice counts only while it still names one of them: after a
 * re-measurement an old entry can overlap a pause with nothing active in
 * it, and dropping that entry would change nothing on screen. Such stale
 * entries are cleared and the pause is restored, so the click always does
 * what the timeline shows. Without `active` the entry is trusted as before.
 */
export function toggleRemovedPause(edit: ClipEditState, pause: TimeRange, active?: TimeRange[]): ClipEditState {
  const overlaps = (r: TimeRange): boolean => r.start < pause.end && r.end > pause.start
  const removed = (edit.removedActive ?? []).filter(overlaps)
  if (!removed.length) return toggleRestored(edit, pause)
  const live = active === undefined || removed.some(r => active.some(a => a.start < r.end && a.end > r.start && overlaps(a)))
  if (live) return toggleActiveGap(edit, pause)
  return toggleRestored({ ...edit, removedActive: (edit.removedActive ?? []).filter(r => !removed.includes(r)) }, pause)
}

/**
 * Drop removal choices (`edit.removedActive`) that no longer overlap any
 * measured active pause. Called when gap activity is re-measured; returns
 * the same object when nothing is stale, so callers can compare by identity.
 */
export function pruneRemovedActive(edit: ClipEditState, active: TimeRange[]): ClipEditState {
  const removed = edit.removedActive
  if (!removed?.length) return edit
  const kept = removed.filter(r => active.some(a => a.start < r.end && a.end > r.start))
  if (kept.length === removed.length) return edit
  if (kept.length) return { ...edit, removedActive: kept }
  const { removedActive: _dropped, ...rest } = edit
  return rest
}

/**
 * The source range covering transcript words [first, last] (indices into the
 * clip's words), with each edge halfway into the neighbouring gap so the cut
 * falls between words rather than on them.
 */
export function wordsRange(
  words: Array<{ start: number; end: number }>, first: number, last: number
): TimeRange {
  const a = words[first], b = words[last]
  const before = words[first - 1], after = words[last + 1]
  const start = before ? Math.max(before.end, (before.end + a.start) / 2) : a.start
  const end = after ? Math.min(after.start, (b.end + after.start) / 2) : b.end
  return { start, end }
}

/** Words of `transcript` inside the trim, in order (same set the editor shows). */
export function clipWords(transcript: Transcript, start: number, end: number): Array<{ start: number; end: number; text: string }> {
  return transcript.segments.flatMap(s => s.words).filter(w => {
    const mid = (w.start + w.end) / 2
    return mid >= start && mid <= end
  }).sort((a, b) => a.start - b.start)
}

/** Set the in or out point at `t`, keeping at least MIN_CLIP_SEC. */
export function setTrimEdge(edit: ClipEditState, which: 'start' | 'end', t: number): ClipEditState {
  if (which === 'start') return { ...edit, start: Math.max(0, Math.min(t, edit.end - MIN_CLIP_SEC)) }
  return { ...edit, end: Math.max(t, edit.start + MIN_CLIP_SEC) }
}

/** A cut must leave something to play: never less than MIN_CLIP_SEC. */
export function keepsPlayback(clip: TightenClip, transcript: Transcript | null): boolean {
  return editedClipDuration(clip, transcript) >= MIN_CLIP_SEC
}
