import { describe, expect, it } from 'vitest'
import { COLD_OPEN_MAX_SEC, COLD_OPEN_MIN_OFFSET_SEC, COLD_OPEN_MIN_SEC, planColdOpen } from '@shared/coldOpen'
import { ClipTimeline, clipTimeline, clipTimelineParts, mapTimedToOutput, timelineFocusTrack, timelineTranscript } from '@shared/clipTimeline'
import { remapTranscript, TimeMap } from '@shared/tighten'
import type { Clip, Transcript } from '@shared/types'
import { makeTranscript } from './helpers'

const SENTENCES = [
  'Most people start a channel and quit within a month.',
  'They post twice and nobody watches.',
  'Here is what changed for me.',
  'I posted every single day for a year.',
  'Consistency beats talent every time.',
  'And that is the whole secret really.'
]

function clip(edit: Partial<Clip['edit']> = {}, hook = 'Consistency beats talent'): Pick<Clip, 'edit' | 'hook'> {
  return {
    hook,
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', focusX: 0.5, captionsEnabled: true,
      captionStyleId: 'beast', showTitle: false, tightenCuts: false, start: 0, end: 30, coldOpen: true, ...edit
    }
  }
}

const words = (t: Transcript, from: number, to: number): string =>
  t.segments.flatMap((s) => s.words).filter((w) => w.start >= from - 1e-6 && w.end <= to + 1e-6).map((w) => w.text).join(' ')

describe('planning a cold open', () => {
  const t = makeTranscript(SENTENCES, { wordSec: 0.3, gapSec: 0.08, sentenceGapSec: 0.5 })
  const trim = { start: 0, end: t.durationSec }

  it('replays the line that echoes the hook, word-aligned and inside the clip', () => {
    const plan = planColdOpen(t, clip(trim), [trim])!
    expect(plan).not.toBeNull()
    expect(words(t, plan.start, plan.end)).toBe('Consistency beats talent every time.')
    const length = plan.end - plan.start
    expect(length).toBeGreaterThanOrEqual(COLD_OPEN_MIN_SEC * 0.9)
    expect(length).toBeLessThanOrEqual(COLD_OPEN_MAX_SEC + 0.3)
    expect(plan.start).toBeGreaterThanOrEqual(COLD_OPEN_MIN_OFFSET_SEC)
    // Padding stays inside the gaps either side of the words.
    const all = t.segments.flatMap((s) => s.words)
    expect(all.every((w) => w.end <= plan.start + 1e-6 || w.start >= plan.end - 1e-6 || (w.start >= plan.start && w.end <= plan.end))).toBe(true)
  })

  it('falls back to the most energetic line when the hook is not spoken', () => {
    const energetic = structuredClone(t)
    energetic.segments.forEach((s, i) => { s.energy = i === 3 ? 0.95 : 0.3 })
    const plan = planColdOpen(energetic, clip(trim, 'A totally different headline'), [trim])!
    expect(words(energetic, plan.start, plan.end)).toBe('I posted every single day for a year.')
  })

  it('never picks a line in the first seconds of the clip', () => {
    const short = makeTranscript(SENTENCES.slice(0, 3), { wordSec: 0.3, gapSec: 0.08 })
    expect(planColdOpen(short, clip({ end: short.durationSec }), [{ start: 0, end: short.durationSec }])).toBeNull()
  })

  it('stays inside one kept segment, so the teaser has no jump cut', () => {
    const hookLine = t.segments[4]
    // Cut through the middle of the hook line: it can no longer be replayed whole.
    const mid = (hookLine.words[1].end + hookLine.words[2].start) / 2
    const kept = [{ start: 0, end: mid - 0.05 }, { start: mid + 0.05, end: t.durationSec }]
    const plan = planColdOpen(t, clip(trim), kept)
    if (plan) expect(kept.some((k) => plan.start >= k.start - 1e-6 && plan.end <= k.end + 1e-6)).toBe(true)
  })

  it('offers the punchline of a sentence too long to replay whole', () => {
    const slow = makeTranscript(['so here is the thing about growing on video.', 'and then one clip changes everything overnight.'], { wordSec: 0.8, gapSec: 0.1 })
    const plan = planColdOpen(slow, clip({ end: slow.durationSec }, 'changes everything overnight'), [{ start: 0, end: slow.durationSec }])!
    expect(words(slow, plan.start, plan.end)).toBe('clip changes everything overnight.')
  })

  it('is off unless the clip asks for it', () => {
    expect(clipTimelineParts({ ...clip(trim), edit: { ...clip(trim).edit, coldOpen: false }, visualStory: undefined, gapActivity: undefined }, t).coldOpen).toBeNull()
    expect(clipTimelineParts({ ...clip(trim), visualStory: undefined, gapActivity: undefined }, t).coldOpen).not.toBeNull()
  })
})

describe('the output timeline', () => {
  it('plays the cold open first, then the clip from its start', () => {
    const tl = new ClipTimeline([{ start: 10, end: 20 }, { start: 22, end: 30 }], { start: 25, end: 27 })
    expect(tl.coldOpenDuration).toBe(2)
    expect(tl.outputDuration).toBe(20)
    expect(tl.pieces.map((p) => [p.start, p.outStart, p.coldOpen])).toEqual([[25, 0, true], [10, 2, false], [22, 12, false]])
    expect(tl.toSource(1)).toBe(26)
    expect(tl.toSource(2)).toBe(10)
    expect(tl.toSource(13)).toBe(23)
    // Source time maps into the clip proper.
    expect(tl.toOutput(26)).toBe(2 + 10 + 4)
    expect(tl.toOutputIn(0, 26)).toBe(1)
    expect(tl.pieceAt(2)).toBe(1)
    // A source range shows wherever its footage plays.
    expect(tl.mapRange({ start: 24, end: 26 })).toEqual([{ start: 0, end: 1 }, { start: 14, end: 16 }])
  })

  it('equals the old compacted map without a cold open', () => {
    const t = makeTranscript(['alpha beta gamma.', 'delta epsilon zeta eta.'], { sentenceGapSec: 2 })
    const kept = [{ start: 0, end: 1.3 }, { start: 3, end: t.durationSec }]
    const tl = new ClipTimeline(kept)
    const map = new TimeMap(kept)
    for (const s of [0, 0.5, 1.3, 2, 3, 4.1]) expect(tl.toOutput(s)).toBeCloseTo(map.toOutput(s), 9)
    for (const o of [0, 1, 1.4, 2.5]) expect(tl.toSource(o)).toBeCloseTo(map.toSource(o), 9)
    const a = timelineTranscript(t, tl, 0, t.durationSec).segments.flatMap((s) => s.words)
    const b = remapTranscript(t, map, 0, t.durationSec).segments.flatMap((s) => s.words)
    expect(a).toEqual(b)
  })

  it('repeats the cold open words at the start of the transcript', () => {
    const t = makeTranscript(['one two three four five six seven eight'], { wordSec: 0.4, gapSec: 0.1 })
    const tl = new ClipTimeline([{ start: 0, end: t.durationSec }], { start: 2.0, end: 3.0 })
    const out = timelineTranscript(t, tl, 0, t.durationSec).segments.flatMap((s) => s.words)
    expect(out.slice(0, 2).map((w) => w.text)).toEqual(['five', 'six'])
    expect(out[0].start).toBeCloseTo(0, 9)
    expect(out[2].text).toBe('one')
    expect(out[2].start).toBeCloseTo(1, 9)
    expect(out).toHaveLength(10)
  })

  it('frames the cold open as the same moment is framed later', () => {
    const tl = new ClipTimeline([{ start: 0, end: 10 }], { start: 6, end: 8 })
    const track = timelineFocusTrack([{ t: 0, x: 0.2 }, { t: 5, x: 0.7, cut: true }, { t: 7, x: 0.4, cut: true }], tl)
    expect(track[0]).toMatchObject({ t: 0, x: 0.7, cut: true })
    expect(track[1]).toMatchObject({ t: 1, x: 0.4 })
    expect(track[2]).toMatchObject({ t: 2, x: 0.2, cut: true })
    expect(track.find((k) => k.t === 9)).toMatchObject({ x: 0.4 })
  })

  it('maps layout shots once per piece and in output order', () => {
    const tl = new ClipTimeline([{ start: 0, end: 10 }], { start: 6, end: 8 })
    const shots = mapTimedToOutput([{ start: 0, end: 7, mode: 'crop' as const }, { start: 7, end: 10, mode: 'fit' as const }], tl)
    expect(shots.map((s) => [s.start, s.end, s.mode])).toEqual([[0, 1, 'crop'], [1, 2, 'fit'], [2, 9, 'crop'], [9, 12, 'fit']])
  })

  it('builds from a clip the same way the export does', () => {
    const t = makeTranscript(SENTENCES, { wordSec: 0.3, gapSec: 0.08, sentenceGapSec: 0.5 })
    const c = { ...clip({ end: t.durationSec }), visualStory: undefined, gapActivity: undefined }
    const tl = clipTimeline(c, t)
    expect(tl.hasColdOpen).toBe(true)
    expect(tl.outputDuration).toBeCloseTo(t.durationSec + tl.coldOpenDuration, 9)
  })
})
