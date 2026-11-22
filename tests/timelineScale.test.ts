import { describe, expect, it } from 'vitest'
import { FOLD_CONTEXT_SEC, FOLD_WIDTH, MAX_FOLDS, buildTimelineScale, timelineFolds } from '@shared/timelineScale'
import { moveCutEdge } from '@shared/editOps'
import type { ClipEditState } from '@shared/types'

const edit = (start: number, end: number, cuts?: Array<{ start: number; end: number }>): ClipEditState => ({
  aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5,
  captionsEnabled: true, captionStyleId: 'beast', showTitle: false, start, end, cuts
})

describe('timeline folds', () => {
  it('folds the middle of a long cut and leaves its edges in view', () => {
    const folds = timelineFolds(edit(300, 620, [{ start: 320, end: 600 }]), 285, 635)
    expect(folds).toEqual([{ start: 320 + FOLD_CONTEXT_SEC, end: 600 - FOLD_CONTEXT_SEC }])
  })

  it('folds only the longest cuts when there are many', () => {
    const cuts = Array.from({ length: 8 }, (_, i) => ({ start: i * 200 + 20, end: i * 200 + 60 + i * 10 }))
    const folds = timelineFolds(edit(0, 1700, cuts), 0, 1700)
    expect(folds).toHaveLength(MAX_FOLDS)
    expect(folds.map((f) => f.start)).toEqual(cuts.slice(-MAX_FOLDS).map((c) => c.start + FOLD_CONTEXT_SEC))
    const scale = buildTimelineScale(0, 1700, folds)
    expect(scale.panes.reduce((sum, pane) => sum + pane.width, 0)).toBeCloseTo(1 - MAX_FOLDS * FOLD_WIDTH)
  })

  it('leaves ordinary cuts alone', () => {
    expect(timelineFolds(edit(0, 60, [{ start: 20, end: 25 }, { start: 30, end: 55 }]), 0, 75)).toEqual([])
  })
})

describe('timeline scale', () => {
  it('is a straight line when nothing is folded', () => {
    const scale = buildTimelineScale(100, 200)
    expect(scale.panes).toEqual([{ start: 100, end: 200, left: 0, width: 1 }])
    expect(scale.folds).toEqual([])
    expect(scale.toFrac(150)).toBeCloseTo(0.5)
    expect(scale.fromFrac(0.25)).toBeCloseTo(125)
    expect(scale.toFrac(50)).toBe(0)
    expect(scale.toFrac(900)).toBe(1)
  })

  it('gives the moments the width and the skipped stretch a marker', () => {
    // Two 43-second panes either side of a 264-second fold.
    const scale = buildTimelineScale(285, 635, [{ start: 328, end: 592 }])
    expect(scale.panes).toHaveLength(2)
    expect(scale.folds).toHaveLength(1)
    expect(scale.folds[0].width).toBe(FOLD_WIDTH)
    expect(scale.panes[0].width).toBeCloseTo((1 - FOLD_WIDTH) / 2)
    expect(scale.panes[1].left).toBeCloseTo(scale.panes[0].width + FOLD_WIDTH)
    // Drawn to scale, each moment would have had about an eighth of the bar.
    expect(scale.panes[0].width).toBeGreaterThan(0.45)
  })

  it('maps every position to a time and back, always forwards', () => {
    const scale = buildTimelineScale(285, 635, [{ start: 328, end: 592 }])
    let previous = -Infinity
    for (let i = 0; i <= 200; i++) {
      const t = scale.fromFrac(i / 200)
      expect(t).toBeGreaterThanOrEqual(previous)
      expect(scale.toFrac(t)).toBeCloseTo(i / 200, 6)
      previous = t
    }
    expect(scale.fromFrac(0)).toBe(285)
    expect(scale.fromFrac(1)).toBe(635)
    // Time runs at the same speed in both panes.
    const speed = (a: number, b: number): number => (scale.toFrac(b) - scale.toFrac(a)) / (b - a)
    expect(speed(290, 300)).toBeCloseTo(speed(600, 610), 8)
    expect(speed(400, 500)).toBeLessThan(speed(290, 300) / 10)
  })

  it('ignores a fold that would swallow an edge of the window', () => {
    const scale = buildTimelineScale(100, 200, [{ start: 90, end: 150 }])
    expect(scale.folds).toEqual([])
  })
})

describe('moveCutEdge', () => {
  const joined = edit(300, 620, [{ start: 320, end: 600 }])
  const cut = { start: 320, end: 600 }

  it('lets a moment run on into the cut, or start earlier out of it', () => {
    expect(moveCutEdge(joined, cut, 'start', 324.5).cuts).toEqual([{ start: 324.5, end: 600 }])
    expect(moveCutEdge(joined, cut, 'end', 596).cuts).toEqual([{ start: 320, end: 596 }])
  })

  it('shortens a moment when the edge is dragged the other way', () => {
    expect(moveCutEdge(joined, cut, 'start', 312).cuts).toEqual([{ start: 312, end: 600 }])
    expect(moveCutEdge(joined, cut, 'end', 607).cuts).toEqual([{ start: 320, end: 607 }])
  })

  it('never squeezes a piece to nothing or turns the cut inside out', () => {
    expect(moveCutEdge(joined, cut, 'start', 100).cuts).toEqual([{ start: 300.5, end: 600 }])
    expect(moveCutEdge(joined, cut, 'end', 900).cuts).toEqual([{ start: 320, end: 619.5 }])
    expect(moveCutEdge(joined, cut, 'start', 700).cuts).toEqual([{ start: 599.8, end: 600 }])
  })

  it('stops at a neighbouring cut', () => {
    const two = edit(300, 620, [{ start: 310, end: 315 }, { start: 320, end: 600 }])
    expect(moveCutEdge(two, cut, 'start', 300).cuts).toEqual([{ start: 310, end: 315 }, { start: 315.5, end: 600 }])
  })

  it('leaves the edit alone when the cut is not one of its cuts', () => {
    expect(moveCutEdge(joined, { start: 1, end: 2 }, 'start', 5)).toBe(joined)
  })
})
