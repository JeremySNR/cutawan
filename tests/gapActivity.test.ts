import { describe, expect, it } from 'vitest'
import type { Clip, Transcript, TranscriptSegment } from '@shared/types'
import {
  activeGapRanges,
  audioExtent,
  blurFrame,
  frameDifference,
  speechLevel,
  measurableGaps,
  measurementSpans,
  motionExtent,
  windowLevels,
  type LevelWindow,
  type MotionStep
} from '@shared/gapActivity'
import { activityKeptRanges, autoRemovedRanges, clipKeptSegments, editedClipDuration } from '@shared/tighten'
import { keepsPlayback, toggleActiveGap, toggleRemovedPause, toggleRestored } from '@shared/editOps'
import { mergeClipSave, mergeReframeResult } from '@shared/reframe'

/** Speech 0-3 s, a pause 3-6 s, speech 6-9 s, a pause 9-12 s, speech 12-15 s. */
function transcript(extra: Array<{ text: string; start: number; end: number }> = []): Transcript {
  const section = (from: number, id: number): TranscriptSegment => {
    const words = Array.from({ length: 6 }, (_, k) => ({ text: `w${id}${k}`, start: from + 0.2 + k * 0.4, end: from + 0.5 + k * 0.4 }))
    return { id, text: '', start: words[0].start, end: words[5].end, words }
  }
  const segments = [section(0, 0), section(6, 1), section(12, 2)]
  if (extra.length) segments.push({ id: 3, text: '', start: extra[0].start, end: extra.at(-1)!.end, words: extra })
  return { language: 'english', durationSec: 15, segments,
    speech: [{ start: 0, end: 3 }, { start: 6, end: 9 }, { start: 12, end: 15 }] }
}

function clip(edit: Partial<Clip['edit']> = {}, extra: Partial<Clip> = {}): Clip {
  return {
    id: 'c', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: 15, viralityScore: 0, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 0, end: 15, captionsEnabled: false, autoZoom: false, tightenCuts: true, ...edit
    },
    ...extra
  }
}

const measured = (active: Array<{ start: number; end: number }>): Clip['gapActivity'] =>
  ({ version: 1, start: 0, end: 15, measured: [{ start: 3, end: 6 }, { start: 9, end: 12 }], active })

/** Motion steps at 4 fps over [from, to), each with the value `value(t)`. */
function steps(from: number, to: number, value: (t: number) => number): MotionStep[] {
  return Array.from({ length: Math.round((to - from) * 4) }, (_, i) => {
    const t = from + i / 4
    return { from: t, to: t + 0.25, value: value(t) }
  })
}

/** 0.1 s level windows over [from, to). */
function windows(from: number, to: number, db: (t: number) => number): LevelWindow[] {
  return Array.from({ length: Math.round((to - from) * 10) }, (_, i) => {
    const t = Math.round((from + i / 10) * 10) / 10
    return { start: t, db: db(t) }
  })
}

/** Speech around -18 dBFS that dips to `dipDb` between words, as real speech does. */
const speaking = (t: number, dipDb = -55): number => (Math.round(t * 10) % 4 === 3 ? dipDb : -18)

describe('which gaps are measured', () => {
  it('measures exactly the pauses pause removal cuts', () => {
    expect(measurableGaps(clip(), transcript())).toEqual([{ start: 3, end: 6 }, { start: 9, end: 12 }])
    // Whether or not pause removal is on right now.
    expect(measurableGaps(clip({ tightenCuts: false }), transcript())).toEqual([{ start: 3, end: 6 }, { start: 9, end: 12 }])
  })

  it('skips a removal that exists only because a filler word came out', () => {
    // "w w w w w w um w w w w w w w": removing the "um" cuts a stretch that
    // is not a pause, and keeping that stretch would bring the "um" back.
    const word = (k: number, from: number) => ({ text: `w${k}`, start: from + k * 0.4, end: from + k * 0.4 + 0.3 })
    const words = [...Array.from({ length: 6 }, (_, k) => word(k, 0.2)), { text: 'um', start: 3, end: 3.4 },
      ...Array.from({ length: 7 }, (_, k) => word(k, 3.8))]
    const t: Transcript = { language: 'english', durationSec: 7, segments: [{ id: 0, text: '', start: 0.2, end: 6.5, words }] }
    const c = clip({ end: 7 })
    const removed = autoRemovedRanges(c, t)
    expect(removed.some(r => r.start < 3.4 && r.end > 3)).toBe(true)
    expect(measurableGaps(c, t)).toEqual([])
  })

  it('leaves out what the user cut and pauses too short to judge', () => {
    expect(measurableGaps(clip({ cuts: [{ start: 8.5, end: 12.5 }] }), transcript())).toEqual([{ start: 3, end: 6 }])
    expect(measurableGaps(clip({ cuts: [{ start: 3.5, end: 5.8 }] }), transcript())).toEqual([{ start: 9, end: 12 }])
  })

  it('decodes each moment of a joined clip separately, around its gaps only', () => {
    const edit = clip({ start: 0, end: 100, cuts: [{ start: 15, end: 80 }] }).edit
    const spans = measurementSpans(edit, [{ start: 3, end: 6 }, { start: 9, end: 12 }, { start: 90, end: 92 }], 4)
    expect(spans.map(s => [s.start, s.end])).toEqual([[0, 15], [86, 96]])
    expect(spans[1].gaps).toEqual([{ start: 90, end: 92 }])
  })
})

describe('picture motion', () => {
  it('ignores compression noise below the core', () => {
    const a = new Uint8Array(64 * 36).fill(100)
    const b = a.map((v, i) => v + (i % 2 ? 3 : -3))
    expect(frameDifference(a, b)).toBe(0)
    expect(frameDifference(a, a.map(v => v + 14))).toBe(11)
  })

  it('blurs away pixel-level shimmer but keeps a moving shape', () => {
    const blur = (f: Uint8Array): Float32Array => blurFrame(f, 64, 36)
    // A checkerboard flicker of ±8 levels: what compression noise does on a still.
    const still = new Uint8Array(64 * 36).fill(100)
    const shimmer = still.map((v, i) => v + ((i + Math.floor(i / 64)) % 2 ? 8 : -8))
    expect(frameDifference(still, shimmer)).toBeGreaterThan(4)
    expect(frameDifference(blur(still), blur(shimmer))).toBe(0)
    // A bright 8x8 block moving 8 px still reads as motion.
    const block = (x0: number): Uint8Array => still.map((v, i) => (i % 64 >= x0 && i % 64 < x0 + 8 && Math.floor(i / 64) >= 10 && Math.floor(i / 64) < 18 ? 200 : v))
    expect(frameDifference(blur(block(10)), blur(block(18)))).toBeGreaterThan(2)
    // Flat frames are unchanged by it, edges included.
    expect([...blur(still)].every(v => v === 100)).toBe(true)
  })

  it('needs sustained motion: a hard cut is one spike', () => {
    const gap = { start: 3, end: 6 }
    expect(motionExtent(steps(3, 6, t => (Math.abs(t - 4.5) < 0.01 ? 70 : 0)), gap, 0)).toBeNull()
    // Two moving steps in a row is still too short; three is enough.
    expect(motionExtent(steps(3, 6, t => (t >= 4 && t < 4.5 ? 5 : 0)), gap, 0)).toBeNull()
    expect(motionExtent(steps(3, 6, t => (t >= 4 && t < 4.75 ? 5 : 0)), gap, 0)).toEqual({ start: 3.75, end: 5 })
  })

  it('must clearly exceed the motion while speaking', () => {
    const gap = { start: 3, end: 6 }
    const moving = steps(3, 6, () => 2)
    expect(motionExtent(moving, gap, 0)).toEqual(gap)
    // A handheld camera that moves this much all the time is not "activity".
    expect(motionExtent(moving, gap, 1)).toBeNull()
    expect(motionExtent(steps(3, 6, () => 0.8), gap, 0)).toBeNull()
  })
})

describe('sound level', () => {
  it('reads RMS level in dBFS', () => {
    const tone = Int16Array.from({ length: 800 }, (_, i) => Math.round(16384 * Math.sin(2 * Math.PI * i / 80)))
    expect(windowLevels(tone, 800)[0]).toBeCloseTo(-9.03, 1)
    expect(windowLevels(new Int16Array(1600), 800)).toEqual([-100, -100])
  })

  it('takes non-speech sound near speech level, not breaths or room tone', () => {
    const speech = [{ start: 0, end: 3 }, { start: 6, end: 9 }]
    const level = (gapDb: number): LevelWindow[] => windows(0, 9, t => (t >= 3 && t < 6 ? gapDb : speaking(t)))
    const extent = (gapDb: number) => audioExtent(level(gapDb), { start: 3, end: 6 }, speechLevel(level(gapDb), speech)!)
    expect(speechLevel(level(-20), speech)).toBe(-18)
    expect(extent(-20)).toEqual({ start: 3, end: 6 })
    expect(extent(-23.5)).not.toBeNull()
    expect(extent(-25)).toBeNull()
    expect(extent(-60)).toBeNull()
  })

  it('is not fooled by a loud bed under the whole clip', () => {
    const speech = [{ start: 0, end: 3 }, { start: 6, end: 9 }]
    // Music at -22 dBFS throughout: it fills the gap and the dips between words.
    const bed = windows(0, 9, t => (t >= 3 && t < 6 ? -22 : speaking(t, -22)))
    expect(audioExtent(bed, { start: 3, end: 6 }, speechLevel(bed, speech)!)).toBeNull()
  })

  it('needs a few loud windows, and keeps only the loud part of a long gap', () => {
    const speech = [{ start: 0, end: 3 }, { start: 9, end: 12 }]
    const click = windows(0, 12, t => (t >= 3 && t < 9 ? (t === 5 ? -18 : -70) : speaking(t)))
    expect(audioExtent(click, { start: 3, end: 9 }, speechLevel(click, speech)!)).toBeNull()
    const laugh = windows(0, 12, t => (t >= 3 && t < 9 ? (t >= 3.5 && t < 4.5 ? -19 : -70) : speaking(t)))
    const extent = audioExtent(laugh, { start: 3, end: 9 }, speechLevel(laugh, speech)!)!
    expect(extent.start).toBeCloseTo(3.35)
    expect(extent.end).toBeCloseTo(4.65)
  })

  it('makes no judgement without enough speech to compare against', () => {
    expect(speechLevel(windows(0, 3, () => -18), [{ start: 0, end: 0.3 }])).toBeNull()
  })
})

describe('active gaps', () => {
  it('joins both signals into one kept stretch per gap', () => {
    const ranges = activeGapRanges({
      gaps: [{ start: 3, end: 6 }, { start: 9, end: 12 }],
      speaking: [{ start: 0, end: 3 }, { start: 6, end: 9 }, { start: 12, end: 15 }],
      steps: steps(0, 15, t => (t >= 3.5 && t < 4.5 ? 3 : 0)),
      windows: windows(0, 15, t => (t >= 5 && t < 5.6 ? -18 : (t >= 3 && t < 6) || (t >= 9 && t < 12) ? -70 : speaking(t))),
      speech: [{ start: 0, end: 3 }, { start: 6, end: 9 }, { start: 12, end: 15 }]
    })
    expect(ranges).toHaveLength(1)
    expect(ranges[0].start).toBeCloseTo(3.25)
    expect(ranges[0].end).toBeCloseTo(5.75)
  })

  it('works on picture alone when the source has no sound', () => {
    expect(activeGapRanges({ gaps: [{ start: 3, end: 6 }], speaking: [{ start: 0, end: 3 }],
      steps: steps(0, 6, t => (t >= 3 ? 4 : 0)), windows: [], speech: [] })).toEqual([{ start: 3, end: 6 }])
  })
})

describe('protected gaps in the edit', () => {
  it('keeps an active gap in what plays, so preview, export and durations agree', () => {
    const plain = clip()
    expect(clipKeptSegments(plain, transcript())).toHaveLength(3)
    const active = clip({}, { gapActivity: measured([{ start: 3, end: 6 }]) })
    const kept = clipKeptSegments(active, transcript())!
    expect(kept).toHaveLength(2)
    expect(kept[0]).toEqual({ start: 0, end: 9 })
    expect(editedClipDuration(active, transcript())).toBeCloseTo(editedClipDuration(plain, transcript()) + 3)
    expect(autoRemovedRanges(active, transcript())).toEqual([{ start: 9, end: 12 }])
    // The timeline shows it as kept automatically.
    expect(activityKeptRanges(active, transcript())).toEqual([{ start: 3, end: 6 }])
  })

  it('keeps only the active part of a long pause', () => {
    const active = clip({}, { gapActivity: measured([{ start: 3.2, end: 4.4 }]) })
    const kept = clipKeptSegments(active, transcript())!
    // Speech runs into the kept stretch; the dead air after it is still cut.
    expect(kept[0].start).toBe(0)
    expect(kept[0].end).toBeCloseTo(4.4)
    expect(kept[1].start).toBe(6)
  })

  it('does nothing while pause removal is off', () => {
    expect(clipKeptSegments(clip({ tightenCuts: false }, { gapActivity: measured([{ start: 3, end: 6 }]) }), transcript())).toBeNull()
    expect(activityKeptRanges(clip({ tightenCuts: false }, { gapActivity: measured([{ start: 3, end: 6 }]) }), transcript())).toEqual([])
  })

  it('lets the user remove a protected pause, and put it back with one more click', () => {
    const t = transcript()
    const c = clip({}, { gapActivity: measured([{ start: 3, end: 6 }]) })
    const [shown] = activityKeptRanges(c, t)
    const removed = { ...c, edit: toggleActiveGap(c.edit, shown) }
    expect(removed.edit.removedActive).toEqual([{ start: 3, end: 6 }])
    expect(clipKeptSegments(removed, t)).toEqual(clipKeptSegments(clip(), t))
    expect(activityKeptRanges(removed, t)).toEqual([])
    // It is now an ordinary removed pause; clicking it returns it to "kept
    // automatically" rather than adding a restore on top.
    const [pause] = autoRemovedRanges(removed, t)
    const back = toggleRemovedPause(removed.edit, pause)
    expect(back.removedActive).toEqual([])
    expect(back.restored).toBeUndefined()
    expect(clipKeptSegments({ ...c, edit: back }, t)).toEqual(clipKeptSegments(c, t))
    // Any other removed pause is restored, as before.
    const other = autoRemovedRanges(c, t)[0]
    expect(toggleRemovedPause(c.edit, other)).toEqual(toggleRestored(c.edit, other))
  })

  it('stays valid in source time when the trim changes', () => {
    const t = transcript()
    const c = clip({}, { gapActivity: measured([{ start: 9, end: 12 }]) })
    // Trimmed tighter: the active gap is still where it was.
    const shorter = clip({ start: 2, end: 15 }, { gapActivity: c.gapActivity })
    expect(clipKeptSegments(shorter, t)!.some(k => k.start <= 9 && k.end >= 12)).toBe(true)
    // Trimmed past it: it cannot keep anything outside the trim.
    const before = clip({ start: 0, end: 8.8 }, { gapActivity: c.gapActivity })
    expect(clipKeptSegments(before, t)!.every(k => k.end <= 8.8)).toBe(true)
    // A pause that only exists under the new trim is unmeasured and cut.
    const grown = clip({ start: 0, end: 20 }, { gapActivity: c.gapActivity })
    const tail = transcript()
    expect(autoRemovedRanges(grown, tail).at(-1)!.end).toBe(20)
  })

  it('applies the same guard as other edits', () => {
    expect(keepsPlayback(clip({}, { gapActivity: measured([{ start: 3, end: 6 }]) }), transcript())).toBe(true)
  })
})

describe('carrying the measurement with the framing analysis', () => {
  it('takes the analysis result over the edited copy and keeps it through a save', () => {
    const current = clip({ start: 0, end: 15 }, { reframeStatus: 'pending' })
    const analysed = clip({ start: 0, end: 15 }, { reframeStatus: 'done',
      reframeAnalysis: { start: 0, end: 15, version: 2 }, gapActivity: measured([{ start: 3, end: 6 }]) })
    const merged = mergeReframeResult(current, analysed, 'auto')
    expect(merged.gapActivity).toEqual(analysed.gapActivity)
    // An ordinary save from a renderer that has not seen the result yet.
    const saved = mergeClipSave({ ...current, reframeStatus: 'done', reframeAnalysis: analysed.reframeAnalysis }, merged, 'auto')
    expect(saved.gapActivity).toEqual(analysed.gapActivity)
  })
})
