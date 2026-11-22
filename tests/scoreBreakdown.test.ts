import { describe, expect, it } from 'vitest'
import {
  SCORE_PARTS,
  normalizeScoreParts,
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
