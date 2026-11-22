import { describe, expect, it } from 'vitest'
import {
  captionHalfHeight,
  clipCaptionPositionRanges,
  facePlacements,
  sourceToOutputY,
  textBandPosition
} from '@shared/captionPlacement'
import { captionPositionAt } from '@shared/contentRegion'
import type { CaptionSafety, Clip } from '@shared/types'

const crop = { aspect: '9:16' as const, reframeMode: 'crop' as const }
const letterbox = { aspect: '9:16' as const, reframeMode: 'fit-letterbox' as const }
const SCALE = 0.052 // Beast
const Y = 0.72

function safety(partial: Partial<CaptionSafety>): CaptionSafety {
  return { version: 1, start: 0, end: 30, faces: [], textBand: null, ...partial }
}

function clip(edit: Partial<Clip['edit']>, captionSafety?: CaptionSafety): Pick<Clip, 'edit' | 'visualLayout' | 'captionSafety'> {
  return {
    captionSafety,
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', focusX: 0.5, captionsEnabled: true,
      captionStyleId: 'beast', showTitle: false, tightenCuts: false, start: 0, end: 30, ...edit
    }
  }
}

describe('where a source row lands in the frame', () => {
  it('keeps rows in place for a crop of a wider source', () => {
    expect(sourceToOutputY(0.8, crop, 1920, 1080)).toBe(0.8)
  })
  it('squeezes rows into the middle band when letterboxing', () => {
    // A 16:9 frame fitted to 9:16 occupies the middle 31.6% of the height.
    expect(sourceToOutputY(0, letterbox, 1920, 1080)).toBeCloseTo(0.342, 3)
    expect(sourceToOutputY(1, letterbox, 1920, 1080)).toBeCloseTo(0.658, 3)
  })
  it('drops rows cropped away from a taller source', () => {
    expect(sourceToOutputY(0.02, { aspect: '16:9', reframeMode: 'crop' }, 1080, 1920)).toBeNull()
  })
})

describe('burned-in subtitles', () => {
  it('lifts captions above a subtitle band they would cover', () => {
    const y = textBandPosition(safety({ textBand: { top: 0.7, bottom: 0.8 } }), crop, 1920, 1080, Y, SCALE)
    expect(y + captionHalfHeight(SCALE)).toBeLessThanOrEqual(0.7)
    expect(y).toBeGreaterThanOrEqual(0.3)
  })
  it('leaves captions alone when the band is elsewhere', () => {
    expect(textBandPosition(safety({ textBand: { top: 0.9, bottom: 0.96 } }), crop, 1920, 1080, Y, SCALE)).toBe(Y)
    expect(textBandPosition(safety({}), crop, 1920, 1080, Y, SCALE)).toBe(Y)
  })
  it('follows the band into a letterboxed frame', () => {
    // Rows 0.6-0.8 of the source sit at 0.53-0.60 of a letterboxed 9:16 frame: no clash at 0.72.
    expect(textBandPosition(safety({ textBand: { top: 0.6, bottom: 0.8 } }), letterbox, 1920, 1080, Y, SCALE)).toBe(Y)
  })
})

describe('faces', () => {
  it('moves captions below the chin of a face that covers them', () => {
    const moves = facePlacements([{ start: 2, end: 6, top: 0.4, bottom: 0.66 }], crop, 1920, 1080, 0.62, SCALE)
    expect(moves).toHaveLength(1)
    expect(moves[0].positionY - captionHalfHeight(SCALE)).toBeGreaterThan(0.66)
    expect(moves[0].positionY + captionHalfHeight(SCALE)).toBeLessThanOrEqual(0.9)
  })
  it('moves above the head when there is no room below', () => {
    const moves = facePlacements([{ start: 2, end: 6, top: 0.55, bottom: 0.85 }], crop, 1920, 1080, Y, SCALE)
    expect(moves).toHaveLength(1)
    expect(moves[0].positionY + captionHalfHeight(SCALE)).toBeLessThan(0.55)
  })
  it('stays put when no place is clear, for faces that barely touch, and for brief overlaps', () => {
    expect(facePlacements([{ start: 0, end: 6, top: 0.1, bottom: 0.95 }], crop, 1920, 1080, Y, SCALE)).toEqual([])
    expect(facePlacements([{ start: 0, end: 6, top: 0.2, bottom: 0.66 }], crop, 1920, 1080, Y, SCALE)).toEqual([])
    expect(facePlacements([{ start: 0, end: 1, top: 0.4, bottom: 0.66 }], crop, 1920, 1080, 0.62, SCALE)).toEqual([])
  })
  it('merges neighbouring seconds into one steady move', () => {
    const moves = facePlacements([
      { start: 2, end: 3, top: 0.4, bottom: 0.64 },
      { start: 3, end: 4, top: 0.41, bottom: 0.66 },
      { start: 4, end: 5, top: 0.4, bottom: 0.65 }
    ], crop, 1920, 1080, 0.62, SCALE)
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ start: 2, end: 5 })
  })
})

describe('caption position ranges for a clip', () => {
  it('is empty without measurements, so nothing changes for older clips', () => {
    expect(clipCaptionPositionRanges(clip({}), Y, SCALE, 1920, 1080)).toEqual([])
  })
  it('combines the text band base and face moves over the clip', () => {
    const c = clip({}, safety({ textBand: { top: 0.86, bottom: 0.93 }, faces: [{ start: 10, end: 14, top: 0.5, bottom: 0.78 }] }))
    const ranges = clipCaptionPositionRanges(c, 0.8, 0.038, 1920, 1080)
    const at = (t: number): number => captionPositionAt(ranges, t, 0.8)
    // The band lifts the base above it; while the close-up covers that, captions go above the head.
    expect(at(2)).toBeLessThan(0.8)
    expect(at(2) + captionHalfHeight(0.038)).toBeLessThanOrEqual(0.86)
    expect(at(12)).toBeLessThan(0.5)
    expect(at(20)).toBe(at(2))
    expect(ranges.every((r) => r.end > r.start)).toBe(true)
  })
})
