import { describe, expect, it } from 'vitest'
import { mergeReframeResult, needsReframe, REFRAME_EXTENSION_TOLERANCE_SEC } from '@shared/reframe'
import { automaticLayoutShots } from '@shared/contentType'
import { focusAt } from '@shared/focusTrack'
import type { Clip } from '@shared/types'

function analysed(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'ext',
    suggestedStart: 10,
    suggestedEnd: 30,
    title: '',
    hook: '',
    summary: '',
    viralityScore: 60,
    viralityReason: '',
    visualSummary: null,
    hashtags: [],
    thumbnailPath: null,
    focusTrack: [{ t: 10, x: 0.3, cut: true }, { t: 29, x: 0.7, cut: true }],
    reframeStatus: 'done',
    reframeAnalysis: { start: 10, end: 30, version: 2 },
    broll: [],
    edit: {
      aspect: '9:16',
      reframeMode: 'crop',
      framing: 'auto',
      tightenCuts: true,
      focusX: 0.5,
      captionsEnabled: true,
      captionStyleId: 'beast',
      showTitle: false,
      start: 10,
      end: 30
    },
    ...overrides
  }
}

describe('small trim extensions', () => {
  it('reuses the analysis for an edge dragged out by up to the tolerance', () => {
    const c = analysed()
    expect(needsReframe({ ...c, edit: { ...c.edit, end: 30 + REFRAME_EXTENSION_TOLERANCE_SEC - 0.1 } })).toBe(false)
    expect(needsReframe({ ...c, edit: { ...c.edit, start: 10 - REFRAME_EXTENSION_TOLERANCE_SEC + 0.1 } })).toBe(false)
  })

  it('analyses again once the extension passes the tolerance, cumulatively', () => {
    const c = analysed()
    expect(needsReframe({ ...c, edit: { ...c.edit, end: 30 + REFRAME_EXTENSION_TOLERANCE_SEC + 0.1 } })).toBe(true)
    // Two drags of a second each add up against the analysed coverage.
    const once = { ...c, edit: { ...c.edit, end: 31 } }
    expect(needsReframe(once)).toBe(false)
    expect(needsReframe({ ...once, edit: { ...once.edit, end: 32 } })).toBe(true)
  })

  it('applies the same margin to the moments of a joined clip', () => {
    const c = analysed({ reframeAnalysis: { start: 10, end: 60, version: 2, ranges: [{ start: 10, end: 20 }, { start: 50, end: 60 }] } })
    c.edit = { ...c.edit, end: 60, cuts: [{ start: 20, end: 50 }] }
    expect(needsReframe(c)).toBe(false)
    // Pulling the join's out-point a second into the skipped stretch.
    expect(needsReframe({ ...c, edit: { ...c.edit, cuts: [{ start: 21, end: 50 }] } })).toBe(false)
    expect(needsReframe({ ...c, edit: { ...c.edit, cuts: [{ start: 25, end: 50 }] } })).toBe(true)
  })

  it('holds the focus track at its edge value over the extension', () => {
    const c = analysed()
    expect(focusAt(c.focusTrack!, 31)).toBe(0.7)
    expect(focusAt(c.focusTrack!, 9)).toBe(0.3)
  })

  it('stretches the edge layout shots instead of dropping the layout', () => {
    const c = analysed({
      visualLayout: { start: 10, end: 30, preserveContext: true, allowZoom: false, reason: '',
        shots: [{ start: 10, end: 20, mode: 'fit' }, { start: 20, end: 30, mode: 'crop' }] }
    })
    const shots = automaticLayoutShots({ ...c, edit: { ...c.edit, start: 9, end: 31 } })
    expect(shots.map(s => [s.start, s.end, s.mode])).toEqual([[9, 20, 'fit'], [20, 31, 'crop']])
    expect(shots.some(s => s.review?.status === 'needs-review')).toBe(false)
    // Past the tolerance the layout no longer covers the trim.
    const far = automaticLayoutShots({ ...c, edit: { ...c.edit, end: 33 } })
    expect(far).toHaveLength(1)
    expect(far[0].review?.status).toBe('needs-review')
  })
})

describe('re-measured gap activity', () => {
  it('prunes removal choices that no longer name an active pause', () => {
    const current = analysed()
    current.edit = { ...current.edit, removedActive: [{ start: 13, end: 16 }, { start: 20, end: 22 }] }
    const result: Clip = { ...current, gapActivity: { version: 1, start: 10, end: 30,
      measured: [{ start: 13, end: 16 }, { start: 20, end: 22 }], active: [{ start: 13.1, end: 15.8 }] } }
    expect(mergeReframeResult(current, result, 'auto').edit.removedActive).toEqual([{ start: 13, end: 16 }])
    const none: Clip = { ...result, gapActivity: { ...result.gapActivity!, active: [] } }
    expect(mergeReframeResult(current, none, 'auto').edit.removedActive).toBeUndefined()
    // No measurement in the result leaves the choices alone.
    expect(mergeReframeResult(current, { ...result, gapActivity: undefined }, 'auto').edit.removedActive).toHaveLength(2)
  })
})
