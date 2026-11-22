import type { Clip, FocusKeyframe, TimeRange, Transcript, TranscriptSegment } from './types'
import { clipKeptSegments, TimeMap, type KeptSegment, type TightenClip } from './tighten'
import { planColdOpen } from './coldOpen'
import { focusAt } from './focusTrack'

/**
 * The output timeline of a clip: an optional cold open (a short line replayed
 * first) followed by the kept segments in order. Shared by the export (trim +
 * concat graph, caption/zoom/layout remapping) and the preview (which plays
 * the same pieces in the same order), so both agree on what plays when.
 *
 * Pause removal and cuts stay where they were (`clipKeptSegments`); this only
 * layers the cold open on top. Without a cold open the timeline is exactly
 * the old compacted TimeMap.
 */

export interface TimelinePiece extends KeptSegment {
  /** Output time at which this piece starts playing. */
  outStart: number
  /** True for the replayed cold-open line. */
  coldOpen: boolean
}

export type TimelineClip = TightenClip & Pick<Clip, 'hook'>

export interface ClipTimelineParts {
  /** What plays after any cold open, in order: the kept segments, or the whole trim. */
  main: KeptSegment[]
  /** True when `main` came from pause removal or cuts rather than the plain trim. */
  tightened: boolean
  /** The replayed line, or null when the cold open is off or nothing qualifies. */
  coldOpen: KeptSegment | null
}

/** The pieces a clip plays, before any frame alignment. */
export function clipTimelineParts(clip: TimelineClip, transcript: Transcript | null): ClipTimelineParts {
  const kept = clipKeptSegments(clip, transcript)
  const main = kept ?? [{ start: clip.edit.start, end: clip.edit.end }]
  const coldOpen = clip.edit.coldOpen && main.length ? planColdOpen(transcript, clip, main) : null
  return { main, tightened: kept !== null, coldOpen }
}

export function clipTimeline(clip: TimelineClip, transcript: Transcript | null): ClipTimeline {
  const parts = clipTimelineParts(clip, transcript)
  return new ClipTimeline(parts.main, parts.coldOpen)
}

export class ClipTimeline {
  readonly pieces: TimelinePiece[]
  readonly coldOpenDuration: number
  readonly outputDuration: number
  private readonly mainMap: TimeMap

  constructor(main: KeptSegment[], coldOpen: KeptSegment | null = null) {
    this.mainMap = new TimeMap(main)
    const pieces: TimelinePiece[] = []
    let at = 0
    if (coldOpen && coldOpen.end > coldOpen.start) {
      pieces.push({ ...coldOpen, outStart: 0, coldOpen: true })
      at = coldOpen.end - coldOpen.start
    }
    this.coldOpenDuration = at
    for (const segment of main) {
      pieces.push({ start: segment.start, end: segment.end, outStart: at, coldOpen: false })
      at += segment.end - segment.start
    }
    this.pieces = pieces
    this.outputDuration = at
  }

  get hasColdOpen(): boolean {
    return this.coldOpenDuration > 0
  }

  /**
   * Where source time `t` plays in the main part of the edit (after the cold
   * open). Removed spans clamp to the next kept frame, as TimeMap does.
   */
  toOutput(t: number): number {
    return this.coldOpenDuration + this.mainMap.toOutput(t)
  }

  /** Index of the piece playing at output time `out` (a seam selects the later piece). */
  pieceAt(out: number): number {
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i]
      if (out < p.outStart + p.end - p.start) return i
    }
    return this.pieces.length - 1
  }

  /** The source frame shown at output time `out`. */
  toSource(out: number): number {
    const piece = this.pieces[this.pieceAt(out)]
    if (!piece) return 0
    return Math.min(piece.end, piece.start + Math.max(0, out - piece.outStart))
  }

  /** Output time of source time `t` while piece `index` plays. */
  toOutputIn(index: number, t: number): number {
    const piece = this.pieces[index]
    if (!piece) return this.toOutput(t)
    return piece.outStart + Math.max(0, Math.min(piece.end, t) - piece.start)
  }

  /** True when source time `t` is not played by the main part of the edit. */
  isRemoved(t: number): boolean {
    return this.mainMap.isRemoved(t)
  }

  /** Output spans showing the source range, one per piece it overlaps, in output order. */
  mapRange(range: TimeRange): TimeRange[] {
    const out: TimeRange[] = []
    for (const p of this.pieces) {
      const start = Math.max(range.start, p.start)
      const end = Math.min(range.end, p.end)
      if (end > start) out.push({ start: p.outStart + start - p.start, end: p.outStart + end - p.start })
    }
    return out
  }
}

/** Source-timed items copied onto the output timeline, once per piece they overlap, in output order. */
export function mapTimedToOutput<T extends TimeRange>(items: T[], timeline: ClipTimeline): T[] {
  return items.flatMap((item) => timeline.mapRange(item).map((r) => ({ ...item, start: r.start, end: r.end })))
    .sort((a, b) => a.start - b.start)
}

/**
 * A transcript rewritten onto the output timeline: every word inside a piece
 * (its midpoint decides) appears at its output time, so the cold open's words
 * appear twice. Used so the caption layout runs unchanged on what plays.
 */
export function timelineTranscript(
  transcript: Transcript,
  timeline: ClipTimeline,
  clipStart: number,
  clipEnd: number
): Transcript {
  const segments: TranscriptSegment[] = []
  for (const piece of timeline.pieces) {
    const at = (t: number): number => piece.outStart + Math.max(0, Math.min(piece.end, t) - piece.start)
    for (const seg of transcript.segments) {
      if (seg.end < piece.start || seg.start > piece.end) continue
      const words = seg.words
        .filter((w) => {
          const mid = (w.start + w.end) / 2
          return mid >= clipStart && mid <= clipEnd && mid >= piece.start && mid <= piece.end
        })
        .map((w) => ({ ...w, start: at(w.start), end: at(w.end) }))
      if (!words.length) continue
      segments.push({ ...seg, start: at(Math.max(seg.start, piece.start)), end: at(Math.min(seg.end, piece.end)), words })
    }
  }
  return { ...transcript, segments }
}

/**
 * A source-time focus track on the output timeline. Each piece opens with a
 * snap to the framing at its first frame, then follows the keyframes inside
 * it, so the cold open is framed as the same moment is later in the clip.
 */
export function timelineFocusTrack(track: FocusKeyframe[], timeline: ClipTimeline): FocusKeyframe[] {
  if (!track.length) return []
  const out: FocusKeyframe[] = []
  for (const piece of timeline.pieces) {
    out.push({ t: piece.outStart, x: focusAt(track, piece.start), cut: true })
    for (const kf of track) {
      if (kf.t > piece.start && kf.t < piece.end) out.push({ ...kf, t: piece.outStart + kf.t - piece.start })
    }
  }
  return out
}
