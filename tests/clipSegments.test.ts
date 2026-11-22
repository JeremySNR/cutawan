import { describe, expect, it } from 'vitest'
import {
  joinedMoments,
  limitStretches,
  mergeNearbyRanges,
  rangesCovered,
  selectedDuration,
  selectedRanges,
  selectedWords,
  sourceStretches
} from '@shared/clipSegments'
import { markReframeComplete, needsReframe } from '@shared/reframe'
import { mergeStretchAnalyses } from '../src/main/pipeline/stretchAnalysis'
import type { Clip } from '@shared/types'
import { makeTranscript } from './helpers'

const edit = (start: number, end: number, cuts?: Array<{ start: number; end: number }>) => ({ start, end, cuts })

describe('selected ranges of a trim', () => {
  it('is the whole trim without cuts', () => {
    expect(selectedRanges(edit(10, 40))).toEqual([{ start: 10, end: 40 }])
    expect(selectedDuration(edit(10, 40))).toBe(30)
  })

  it('is what lies between the cuts, in order, whatever order they were made in', () => {
    const ranges = selectedRanges(edit(300, 620, [{ start: 500, end: 600 }, { start: 320, end: 330 }]))
    expect(ranges).toEqual([{ start: 300, end: 320 }, { start: 330, end: 500 }, { start: 600, end: 620 }])
    expect(selectedDuration(edit(300, 620, [{ start: 320, end: 600 }]))).toBe(40)
  })

  it('ignores cuts outside the trim and survives an empty trim', () => {
    expect(selectedRanges(edit(10, 40, [{ start: 50, end: 60 }, { start: 0, end: 12 }]))).toEqual([{ start: 12, end: 40 }])
    expect(selectedRanges(edit(40, 40))).toEqual([])
  })

  it('keeps only the words inside the selected ranges', () => {
    const transcript = makeTranscript(['one two three.', 'four five six.', 'seven eight nine.'])
    const second = transcript.segments[1]
    const words = selectedWords(transcript, edit(0, transcript.durationSec, [{ start: second.start - 0.05, end: second.end + 0.05 }]))
    expect(words.map((w) => w.text).join(' ')).toBe('one two three. seven eight nine.')
  })
})

describe('source stretches', () => {
  it('reads through short cuts and separately across long ones', () => {
    expect(sourceStretches(edit(0, 100, [{ start: 20, end: 25 }]))).toEqual([{ start: 0, end: 100 }])
    expect(sourceStretches(edit(300, 620, [{ start: 320, end: 600 }, { start: 605, end: 608 }])))
      .toEqual([{ start: 300, end: 320 }, { start: 600, end: 620 }])
  })

  it('merges without touching its input', () => {
    const ranges = [{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 21, end: 30 }]
    expect(mergeNearbyRanges(ranges, 3)).toEqual([{ start: 0, end: 5 }, { start: 10, end: 30 }])
    expect(ranges[0]).toEqual({ start: 10, end: 20 })
  })

  it('knows when ranges are inside analysed footage', () => {
    const analysed = [{ start: 300, end: 320 }, { start: 600, end: 620 }]
    expect(rangesCovered([{ start: 302, end: 318 }, { start: 600, end: 620 }], analysed)).toBe(true)
    expect(rangesCovered([{ start: 300, end: 620 }], analysed)).toBe(false)
    expect(rangesCovered([{ start: 600, end: 625 }], analysed)).toBe(false)
  })
})

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', suggestedStart: 300, suggestedEnd: 620, title: '', hook: '', summary: '', viralityScore: 50,
    viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
    reframeStatus: 'pending',
    stitch: { segments: [{ start: 300, end: 320 }, { start: 600, end: 620 }], reason: 'skips a tangent' },
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: true, focusX: 0.5,
      captionsEnabled: true, captionStyleId: 'beast', showTitle: false,
      start: 300, end: 620, cuts: [{ start: 320, end: 600 }]
    },
    ...overrides
  }
}

describe('a joined clip', () => {
  it('reports its moments, until the join is restored', () => {
    expect(joinedMoments(clip())).toEqual([{ start: 300, end: 320 }, { start: 600, end: 620 }])
    const restored = clip()
    restored.edit = { ...restored.edit, cuts: [] }
    expect(joinedMoments(restored)).toBeNull()
    expect(joinedMoments(clip({ stitch: undefined }))).toBeNull()
  })

  it('is analysed where it plays and needs analysis again once the skipped stretch comes back', () => {
    const analysed = clip()
    markReframeComplete(analysed)
    expect(analysed.reframeAnalysis?.ranges).toEqual([{ start: 300, end: 320 }, { start: 600, end: 620 }])
    expect(needsReframe(analysed)).toBe(false)
    // Trimming inside a moment, or cutting more out, reuses the analysis.
    expect(needsReframe({ ...analysed, edit: { ...analysed.edit, start: 303, end: 615 } })).toBe(false)
    expect(needsReframe({ ...analysed, edit: { ...analysed.edit, cuts: [{ start: 310, end: 600 }] } })).toBe(false)
    // Restoring the join, or part of it, shows footage nothing has tracked.
    expect(needsReframe({ ...analysed, edit: { ...analysed.edit, cuts: [] } })).toBe(true)
    expect(needsReframe({ ...analysed, edit: { ...analysed.edit, cuts: [{ start: 320, end: 560 }] } })).toBe(true)
  })

  it('leaves an ordinary clip with the coverage rule it always had', () => {
    const ordinary = clip({ stitch: undefined, suggestedStart: 10, suggestedEnd: 40 })
    ordinary.edit = { ...ordinary.edit, start: 10, end: 40, cuts: undefined }
    markReframeComplete(ordinary)
    expect(ordinary.reframeAnalysis).toEqual({ start: 10, end: 40, version: 2 })
    expect(needsReframe({ ...ordinary, edit: { ...ordinary.edit, start: 12, end: 38 } })).toBe(false)
    expect(needsReframe({ ...ordinary, edit: { ...ordinary.edit, end: 45 } })).toBe(true)
    // A long cut made by hand inside analysed footage needs nothing new.
    expect(needsReframe({ ...ordinary, edit: { ...ordinary.edit, cuts: [{ start: 15, end: 35 }] } })).toBe(false)
  })
})

describe('mergeStretchAnalyses', () => {
  const stretches = [{ start: 300, end: 320 }, { start: 600, end: 620 }]

  it('returns a lone analysis untouched', () => {
    const only = { focusTrack: [{ t: 300, x: 0.4 }], contentType: 'speaker' as const }
    expect(mergeStretchAnalyses([only], [stretches[0]])).toBe(only)
  })

  it('snaps the crop at the join instead of panning across it', () => {
    const merged = mergeStretchAnalyses([
      { focusTrack: [{ t: 300, x: 0.3 }, { t: 310, x: 0.35 }], contentType: 'speaker', sceneCuts: [305] },
      { focusTrack: [{ t: 600, x: 0.7 }, { t: 610, x: 0.72, pan: 0.5 }], contentType: 'speaker', sceneCuts: [612],
        lowDetailShots: [{ start: 600, end: 604 }] }
    ], stretches)
    expect(merged.focusTrack).toEqual([
      { t: 300, x: 0.3 }, { t: 310, x: 0.35 }, { t: 600, x: 0.7, cut: true }, { t: 610, x: 0.72, pan: 0.5 }
    ])
    expect(merged.sceneCuts).toEqual([305, 600, 612])
    expect(merged.lowDetailShots).toEqual([{ start: 600, end: 604 }])
    expect(merged.contentType).toBe('speaker')
  })

  it('frames for the speaker when only one stretch has one, and for the screen when none does', () => {
    const mixed = mergeStretchAnalyses([
      { focusTrack: null, contentType: 'screencast' },
      { focusTrack: [{ t: 600, x: 0.6 }], contentType: 'speaker' }
    ], stretches)
    expect(mixed.contentType).toBe('speaker')
    expect(mixed.focusTrack).toEqual([{ t: 600, x: 0.6, cut: true }])
    const screen = mergeStretchAnalyses([
      { focusTrack: null, contentType: 'screencast' }, { focusTrack: null, contentType: 'screencast' }
    ], stretches)
    expect(screen).toMatchObject({ focusTrack: null, contentType: 'screencast' })
  })
})

describe('limitStretches', () => {
  const many = [{ start: 0, end: 10 }, { start: 30, end: 40 }, { start: 400, end: 410 }, { start: 430, end: 440 }, { start: 900, end: 910 }]

  it('leaves a short list alone', () => {
    expect(limitStretches(many, 6)).toEqual(many)
  })

  it('reads through the shortest gaps first and keeps the long skips', () => {
    expect(limitStretches(many, 3)).toEqual([{ start: 0, end: 40 }, { start: 400, end: 440 }, { start: 900, end: 910 }])
    expect(limitStretches(many, 1)).toEqual([{ start: 0, end: 910 }])
    expect(many[0]).toEqual({ start: 0, end: 10 })
  })
})
