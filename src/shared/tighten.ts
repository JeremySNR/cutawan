import type { BrollItem, Clip, SpeechRegion, TimeRange, Transcript } from './types'

/**
 * "Tighten cuts": compute which sub-segments of a clip to keep so that long
 * pauses and filler words are removed. Shared by the export renderer (ffmpeg
 * trim+concat) and the live preview (playback skips the removed spans), so
 * both stay in sync.
 */

export interface KeptSegment {
  /** Absolute source-video seconds. */
  start: number
  end: number
}

/** The parts of a clip that decide what plays. `broll` is optional for callers that predate video inserts. */
export type TightenClip = Pick<Clip, 'edit' | 'visualStory'> & { broll?: BrollItem[] }

/**
 * Source ranges automatic pause removal must leave whole: visual payoffs the
 * story review kept, and every enabled video B-roll insert. Removing a pause
 * inside a video insert would jump its footage forward mid-shot (the preview
 * seeks the insert by source time), so the insert's span stays continuous.
 */
export function tightenProtectedRanges(clip: TightenClip): TimeRange[] {
  const videoInserts = (clip.broll ?? [])
    .filter(b => b.enabled && b.kind === 'video' && b.imagePath !== null)
    .map(b => ({ start: b.start, end: b.end }))
  return [...(clip.visualStory?.protectedRanges ?? []), ...videoInserts]
}

/** Actual playback length, after pause removal and the user's cuts. */
export function editedClipDuration(clip: TightenClip, transcript: Transcript | null): number {
  const kept = clipKeptSegments(clip, transcript)
  return kept ? kept.reduce((sum, range) => sum + range.end - range.start, 0) : clip.edit.end - clip.edit.start
}

/** Pieces shorter than this after cutting are dropped rather than flashed. */
const MIN_PIECE_SEC = 0.08

/** Sorted, merged ranges clipped to [from, to]. */
export function normalizeRanges(ranges: TimeRange[] | undefined, from: number, to: number): TimeRange[] {
  const clipped = (ranges ?? [])
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map(r => ({ start: Math.max(from, Math.min(r.start, r.end)), end: Math.min(to, Math.max(r.start, r.end)) }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const r of clipped) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** `ranges` minus `remove`, both normalized. */
export function subtractRanges(ranges: TimeRange[], remove: TimeRange[]): TimeRange[] {
  let out = ranges.map(r => ({ ...r }))
  for (const cut of remove) {
    out = out.flatMap(r => cut.end <= r.start || cut.start >= r.end ? [r]
      : [{ start: r.start, end: cut.start }, { start: cut.end, end: r.end }].filter(p => p.end > p.start))
  }
  return out
}

/**
 * The single source of truth for what plays: automatic pause removal (when
 * enabled), plus pauses the user restored, minus the user's cuts. Null means
 * the whole trim plays untouched. Export, preview, durations and the AI's
 * view of the edit all go through here.
 */
export function clipKeptSegments(clip: TightenClip, transcript: Transcript | null): KeptSegment[] | null {
  const { start, end } = clip.edit
  const auto = clip.edit.tightenCuts && transcript
    ? computeKeptSegments(transcript, start, end, tightenProtectedRanges(clip))
    : null
  const cuts = normalizeRanges(clip.edit.cuts, start, end)
  const restored = auto ? normalizeRanges(clip.edit.restored, start, end) : []
  if (!cuts.length && !restored.length) return auto
  const base = normalizeRanges([...(auto ?? [{ start, end }]), ...restored], start, end)
  const kept = subtractRanges(base, cuts).filter(r => r.end - r.start >= MIN_PIECE_SEC)
  if (kept.length === 1 && kept[0].start <= start + 1e-6 && kept[0].end >= end - 1e-6) return null
  return kept
}

/** What automatic pause removal takes out of the trim, for display and restore. */
export function autoRemovedRanges(clip: TightenClip, transcript: Transcript | null): TimeRange[] {
  if (!clip.edit.tightenCuts || !transcript) return []
  const auto = computeKeptSegments(transcript, clip.edit.start, clip.edit.end, tightenProtectedRanges(clip))
  return auto ? subtractRanges([{ start: clip.edit.start, end: clip.edit.end }], auto) : []
}

/** Pause longer than this (between words) gets cut down. */
const MAX_PAUSE_SEC = 0.7
/** Breathing room kept around speech when a pause is trimmed. */
const PRE_ROLL_SEC = 0.18
const POST_ROLL_SEC = 0.3
/**
 * Room kept before the first word and after the last one. This preserves
 * breathing space where the selected clip boundaries permit it. The export
 * separately limits any audio fade to the available speech-free tail.
 */
const HEAD_ROLL_SEC = 0.3
const TAIL_ROLL_SEC = 0.7
/** Ignore removals shorter than this — not worth a visible jump cut. */
const MIN_REMOVAL_SEC = 0.35
const MIN_SEGMENT_SEC = 0.25
/**
 * Minimum length of a kept run between two cuts. A dense run of "um"s produces
 * many short kept spans separated by tiny removals; cutting each one makes the
 * clip jitter. When a kept run is shorter than this, we'd rather keep the
 * small removed gap before it than add another jump cut.
 */
const MIN_KEPT_SEC = 1.2
/**
 * …but only bridge a short kept run back over a *small* gap. A genuinely long
 * pause is still worth one clean cut even if the speech after it is short, so
 * removals larger than this are never bridged away.
 */
const BRIDGE_MAX_GAP_SEC = 1.5

const FILLER_WORDS = new Set(['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'ah', 'mmm', 'hmm', 'mhm'])

function isFiller(text: string): boolean {
  return FILLER_WORDS.has(text.toLowerCase().replace(/[^a-z]/g, ''))
}

/**
 * Returns the kept segments for a clip, or null when there is nothing worth
 * cutting (render should then use the simple single-span path).
 */
export function computeKeptSegments(
  transcript: Transcript,
  clipStart: number,
  clipEnd: number,
  protectedRanges: KeptSegment[] = []
): KeptSegment[] | null {
  // Caption edits change presentation, not what was spoken. Keep legacy blank
  // words too: their original text is unknown, but their speech timing is not.
  const words = transcript.segments.flatMap((s) => s.words)
    .filter((w) => {
      const mid = (w.start + w.end) / 2
      return mid >= clipStart && mid <= clipEnd && !isFiller(w.sourceText ?? w.text)
    })
    .sort((a, b) => a.start - b.start)
  const protectedIntervals = protectedRanges.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) &&
    r.end > r.start && r.start < clipEnd && r.end > clipStart)
    .map(r => ({ start: Math.max(clipStart, r.start), end: Math.min(clipEnd, r.end) }))
  if (words.length < 3 && !protectedIntervals.length) return null

  // Build keep-intervals around each retained word, then merge.
  const intervals: KeptSegment[] = words.map((w) => ({
    start: Math.max(clipStart, w.start - PRE_ROLL_SEC),
    end: Math.min(clipEnd, w.end + POST_ROLL_SEC)
  }))
  if (words.length) {
    intervals[0].start = Math.max(clipStart, words[0].start - HEAD_ROLL_SEC)
    intervals[intervals.length - 1].end = Math.min(clipEnd, words[words.length - 1].end + TAIL_ROLL_SEC)
  }
  // Protected visual intervals participate in the same time map as speech.
  // In particular, a wordless payoff must survive after the last spoken word.
  intervals.push(...protectedIntervals)
  intervals.sort((a, b) => a.start - b.start)
  const merged: KeptSegment[] = []
  for (const iv of intervals) {
    const last = merged[merged.length - 1]
    // Merge unless the true gap between speech is worth cutting.
    if (last && iv.start - last.end < Math.max(MIN_REMOVAL_SEC, MAX_PAUSE_SEC - PRE_ROLL_SEC - POST_ROLL_SEC)) {
      last.end = Math.max(last.end, iv.end)
    } else {
      merged.push({ ...iv })
    }
  }

  // Anti-jitter: bridge short kept runs back over small removed gaps so dense
  // filler ("word um word uh word") doesn't turn into a burst of jump cuts.
  // Long pauses (gap > BRIDGE_MAX_GAP_SEC) are preserved as single clean cuts.
  const spaced: KeptSegment[] = []
  for (const seg of merged) {
    const prev = spaced[spaced.length - 1]
    const gapToPrev = prev ? seg.start - prev.end : Infinity
    if (prev && seg.end - seg.start < MIN_KEPT_SEC && gapToPrev <= BRIDGE_MAX_GAP_SEC) {
      prev.end = seg.end
    } else {
      spaced.push({ ...seg })
    }
  }

  const fillers = transcript.segments.flatMap((s) => s.words)
    .filter((w) => w.end > clipStart && w.start < clipEnd && isFiller(w.sourceText ?? w.text))
  const kept = snapToSilence(spaced, transcript.speech, fillers).filter((s) => s.end - s.start >= MIN_SEGMENT_SEC ||
    protectedIntervals.some(r => r.start < s.end && r.end > s.start))
  if (kept.length === 0) return null

  const keptDuration = kept.reduce((sum, s) => sum + (s.end - s.start), 0)
  const removed = clipEnd - clipStart - keptDuration
  // Nothing meaningful to remove -> keep the untouched clip.
  if (removed < 0.4) return null
  return kept
}

/**
 * Move internal cut points out of detected speech. Word timestamps are
 * approximate, so a padded word boundary can still land inside a syllable or
 * an untranscribed laugh; voice activity marks where sound actually stops.
 * A removal left shorter than MIN_REMOVAL_SEC is not cut at all.
 *
 * Removals that take out a filler word keep their word-timed edges: "um" is
 * voiced, so voice activity cannot separate it from the speech around it,
 * and snapping would cancel the removal.
 */
export function snapToSilence(
  segments: KeptSegment[], speech?: SpeechRegion[], fillers: KeptSegment[] = []
): KeptSegment[] {
  if (!speech?.length || segments.length < 2) return segments
  const inside = (t: number): SpeechRegion | undefined => speech.find(r => r.start < t && t < r.end)
  const out: KeptSegment[] = [{ ...segments[0] }]
  for (const next of segments.slice(1)) {
    const previous = out[out.length - 1]
    if (fillers.some(f => f.start < next.start && f.end > previous.end)) {
      out.push({ ...next })
      continue
    }
    let end = previous.end, start = next.start
    const ending = inside(end)
    if (ending) end = Math.min(ending.end, start)
    const starting = inside(start)
    if (starting) start = Math.max(starting.start, end)
    if (start - end < MIN_REMOVAL_SEC) previous.end = next.end
    else { previous.end = end; out.push({ start, end: next.end }) }
  }
  return out
}

/** Monotonic mapping from source time to the compacted output timeline. */
export class TimeMap {
  private readonly offsets: number[] = []

  constructor(private readonly segments: KeptSegment[]) {
    let acc = 0
    for (const seg of segments) {
      this.offsets.push(acc)
      acc += seg.end - seg.start
    }
  }

  get outputDuration(): number {
    const last = this.segments.length - 1
    return last < 0 ? 0 : this.offsets[last] + (this.segments[last].end - this.segments[last].start)
  }

  /** Map a source time to output time (clamping removed spans to boundaries). */
  toOutput(t: number): number {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]
      if (t < seg.start) return this.offsets[i]
      if (t <= seg.end) return this.offsets[i] + (t - seg.start)
    }
    return this.outputDuration
  }

  /** Invert an output timestamp; at a cut, select the following kept frame. */
  toSource(t: number): number {
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i]
      if (t < this.offsets[i] + segment.end - segment.start) {
        return segment.start + Math.max(0, t - this.offsets[i])
      }
    }
    return this.segments.at(-1)?.end ?? 0
  }

  /** True when the source time falls inside a removed span. */
  isRemoved(t: number): boolean {
    return !this.segments.some((seg) => t >= seg.start && t <= seg.end)
  }

  /** The start of the next kept segment at/after t, or null at the end. */
  nextKeptStart(t: number): number | null {
    for (const seg of this.segments) {
      if (t < seg.start) return seg.start
      if (t <= seg.end) return null
    }
    return null
  }
}

/**
 * Rewrite a transcript into the compacted output timeline (only content
 * within the clip, with word/segment times remapped). Used so the caption
 * generator can run unchanged against the tightened clip.
 */
export function remapTranscript(
  transcript: Transcript,
  map: TimeMap,
  clipStart: number,
  clipEnd: number
): Transcript {
  const segments = transcript.segments
    .filter((seg) => seg.end >= clipStart && seg.start <= clipEnd)
    .map((seg) => ({
      ...seg,
      start: map.toOutput(Math.max(seg.start, clipStart)),
      end: map.toOutput(Math.min(seg.end, clipEnd)),
      words: seg.words
        .filter((w) => {
          const mid = (w.start + w.end) / 2
          return mid >= clipStart && mid <= clipEnd && !map.isRemoved(mid)
        })
        .map((w) => ({ ...w, start: map.toOutput(w.start), end: map.toOutput(w.end) }))
    }))
    .filter((seg) => seg.words.length > 0 || seg.end > seg.start)
  return { ...transcript, segments }
}
