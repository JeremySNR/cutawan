import { describe, expect, it } from 'vitest'
import {
  SCORE_PARTS,
  normalizeScoreParts,
  rescaleScoreParts,
  scoreFromParts,
  scoreGrade,
  scorePartFraction,
  visualFraction
} from '@shared/scoreBreakdown'

describe('score breakdown', () => {
  it('covers the 0-99 scale exactly', () => {
    expect(SCORE_PARTS.reduce((sum, part) => sum + part.max, 0)).toBe(99)
  })

  it('clamps each part to its own scale and rounds it', () => {
    const parts = normalizeScoreParts({ hook: 99, emotion: -4, value: 12.6, structure: 15, shareability: 9 })
    expect(parts).toEqual({ hook: 30, emotion: 0, value: 13, structure: 15, shareability: 9 })
    expect(scoreFromParts(parts!)).toBe(67)
  })

  it('rejects parts that are missing or not numbers', () => {
    expect(normalizeScoreParts(undefined)).toBeNull()
    expect(normalizeScoreParts({ hook: 20, emotion: 10, value: 10, structure: 10 })).toBeNull()
    expect(normalizeScoreParts({ hook: '20', emotion: 10, value: 10, structure: 10, shareability: 5 })).toBeNull()
    expect(normalizeScoreParts({ hook: NaN, emotion: 10, value: 10, structure: 10, shareability: 5 })).toBeNull()
  })

  it('reports how much of each scale was earned', () => {
    const parts = { hook: 15, emotion: 25, value: 0, structure: 15, shareability: 9 }
    expect(scorePartFraction(parts, SCORE_PARTS[0])).toBe(0.5)
    expect(scorePartFraction(parts, SCORE_PARTS[1])).toBe(1)
    expect(visualFraction(parts)).toBeNull()
    expect(visualFraction({ ...parts, visual: 99 })).toBe(1)
  })

  it('grades coarsely and monotonically', () => {
    const grades = [1, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.1].map(scoreGrade)
    expect(grades).toEqual(['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'])
  })
})

describe('rescaleScoreParts', () => {
  const withinScales = (parts: ReturnType<typeof rescaleScoreParts>) =>
    SCORE_PARTS.every((part) => Number.isInteger(parts[part.key]) && parts[part.key] >= 0 && parts[part.key] <= part.max)

  it('scales every part by the same factor when nothing hits its maximum', () => {
    const parts = { hook: 20, emotion: 10, value: 10, structure: 6, shareability: 4 }
    expect(rescaleScoreParts(parts, 25)).toEqual({ hook: 10, emotion: 5, value: 5, structure: 3, shareability: 2 })
  })

  it('sums to the new total exactly, with whole numbers, for every total', () => {
    const parts = { hook: 17, emotion: 9, value: 13, structure: 7, shareability: 3 }
    for (let total = 0; total <= 99; total++) {
      const out = rescaleScoreParts(parts, total)
      expect(scoreFromParts(out)).toBe(total)
      expect(withinScales(out)).toBe(true)
    }
  })

  it('gives what a full part cannot hold to the parts with room', () => {
    // Doubling would put hook at 56 and emotion at 30: both cap, the rest absorbs it.
    const out = rescaleScoreParts({ hook: 28, emotion: 15, value: 4, structure: 2, shareability: 1 }, 90)
    expect(out.hook).toBe(30)
    expect(out.emotion).toBe(25)
    expect(scoreFromParts(out)).toBe(90)
    expect(withinScales(out)).toBe(true)
    // Parts keep their order relative to each other.
    expect(out.value).toBeGreaterThanOrEqual(out.structure)
  })

  it('fills parts scored 0 only when the total cannot be reached without them', () => {
    expect(rescaleScoreParts({ hook: 10, emotion: 10, value: 0, structure: 0, shareability: 0 }, 40))
      .toEqual({ hook: 20, emotion: 20, value: 0, structure: 0, shareability: 0 })
    const full = rescaleScoreParts({ hook: 10, emotion: 0, value: 0, structure: 0, shareability: 0 }, 60)
    expect(full.hook).toBe(30)
    expect(scoreFromParts(full)).toBe(60)
    expect(withinScales(full)).toBe(true)
  })

  it('spreads a total over all-zero parts by their scales', () => {
    const out = rescaleScoreParts({ hook: 0, emotion: 0, value: 0, structure: 0, shareability: 0 }, 50)
    expect(scoreFromParts(out)).toBe(50)
    expect(out.hook).toBeGreaterThan(out.shareability)
  })

  it('clamps the total to 0-99, rounds it, and keeps the visual score untouched', () => {
    const parts = { hook: 15, emotion: 10, value: 10, structure: 5, shareability: 5, visual: 70 }
    expect(scoreFromParts(rescaleScoreParts(parts, 140))).toBe(99)
    expect(rescaleScoreParts(parts, 140)).toEqual({ hook: 30, emotion: 25, value: 20, structure: 15, shareability: 9, visual: 70 })
    expect(scoreFromParts(rescaleScoreParts(parts, -5))).toBe(0)
    expect(scoreFromParts(rescaleScoreParts(parts, 44.6))).toBe(45)
    expect(scoreFromParts(rescaleScoreParts(parts, Number.NaN))).toBe(0)
  })
})
