import type { ScoreBreakdown } from './types'

/**
 * The parts of the clip-selection rubric, shared by the model request (main
 * process) and the score display (renderer).
 *
 * The model scores each part on its own scale and the total is summed here,
 * in code. Asking a model for one number "using the rubric" gets a single
 * overall impression rounded to a familiar value, so most clips land within a
 * few points of each other; scoring the parts separately spreads them out and
 * leaves a reason for the number that a creator can read.
 */
export interface ScorePart {
  key: Exclude<keyof ScoreBreakdown, 'visual'>
  label: string
  max: number
  /** What the model is asked to judge. */
  rubric: string
}

export const SCORE_PARTS: readonly ScorePart[] = [
  { key: 'hook', label: 'Hook', max: 30, rubric: 'Hook strength in the first sentence: curiosity gap, bold claim or open question' },
  { key: 'emotion', label: 'Emotion', max: 25, rubric: 'High-arousal emotion: awe, amusement, excitement, anger, anxiety, surprise' },
  { key: 'value', label: 'Value', max: 20, rubric: 'Practical utility or novel insight' },
  { key: 'structure', label: 'Flow', max: 15, rubric: 'Hook, build and an ending that lands; 0 when the final sentence is setup' },
  { key: 'shareability', label: 'Share', max: 9, rubric: 'Would someone tag a friend, argue in the comments or repost it' }
]

/**
 * Clamp a model's rubric parts to their scales, or null when any part is
 * missing or not a number (a provider that ignored the schema).
 */
export function normalizeScoreParts(raw: unknown): ScoreBreakdown | null {
  if (!raw || typeof raw !== 'object') return null
  const values = raw as Record<string, unknown>
  const parts = {} as ScoreBreakdown
  for (const part of SCORE_PARTS) {
    const value = values[part.key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    parts[part.key] = Math.max(0, Math.min(part.max, Math.round(value)))
  }
  return parts
}

/** Total of the rubric parts, 0-99. */
export function scoreFromParts(parts: ScoreBreakdown): number {
  return Math.max(0, Math.min(99, SCORE_PARTS.reduce((sum, part) => sum + parts[part.key], 0)))
}

/**
 * Rubric parts rescaled to a new total: each part keeps its share of the
 * total as far as its own maximum allows, the whole numbers sum exactly to
 * the (clamped, rounded) total, and no part leaves its scale. Used when a
 * later, comparative judgement replaces a clip's score, so the breakdown a
 * creator reads still adds up to the number on the card. A part the model
 * scored 0 stays 0 unless the total cannot be reached without it. `visual`
 * is not a rubric part and is carried over unchanged.
 */
export function rescaleScoreParts(parts: ScoreBreakdown, total: number): ScoreBreakdown {
  const capacity = SCORE_PARTS.reduce((sum, part) => sum + part.max, 0)
  const target = Math.max(0, Math.min(99, capacity, Math.round(Number.isFinite(total) ? total : 0)))
  const exact = new Map<ScorePart['key'], number>()
  // Water-filling: share what remains among the parts that have not hit their
  // maximum, in proportion to their weights, until none overflows.
  let free = [...SCORE_PARTS]
  let remaining = target
  const weightOf = (part: ScorePart, byScore: boolean): number => (byScore ? Math.max(0, parts[part.key]) : part.max)
  while (free.length > 0 && remaining > 1e-9) {
    // Weight by the current scores; when the free parts are all 0, by their scales.
    const byScore = free.some((part) => parts[part.key] > 0)
    const weight = free.reduce((sum, part) => sum + weightOf(part, byScore), 0)
    const over = free.filter((part) => (remaining * weightOf(part, byScore)) / weight > part.max)
    if (over.length === 0) {
      for (const part of free) exact.set(part.key, (remaining * weightOf(part, byScore)) / weight)
      remaining = 0
      break
    }
    for (const part of over) {
      exact.set(part.key, part.max)
      remaining -= part.max
    }
    free = free.filter((part) => !over.includes(part))
  }
  // Whole numbers: round down, then hand the leftover points to the largest
  // remainders that still have room on their scale.
  const out = { ...parts }
  for (const part of SCORE_PARTS) out[part.key] = Math.floor(exact.get(part.key) ?? 0)
  let leftover = target - SCORE_PARTS.reduce((sum, part) => sum + out[part.key], 0)
  const byRemainder = [...SCORE_PARTS].sort((a, b) =>
    ((exact.get(b.key) ?? 0) % 1) - ((exact.get(a.key) ?? 0) % 1))
  while (leftover > 0) {
    const part = byRemainder.find((p) => out[p.key] < p.max)
    if (!part) break
    out[part.key]++
    leftover--
    // Each part takes at most one extra point per round, largest remainder first.
    byRemainder.push(byRemainder.splice(byRemainder.indexOf(part), 1)[0])
  }
  return out
}

/** Share of a part's scale that was earned, 0..1. */
export function scorePartFraction(parts: ScoreBreakdown, part: ScorePart): number {
  return part.max > 0 ? parts[part.key] / part.max : 0
}

/** The visual review's score as a share of its scale, or null before it ran. */
export function visualFraction(parts: ScoreBreakdown): number | null {
  return parts.visual === undefined ? null : Math.max(0, Math.min(1, parts.visual / 99))
}

/**
 * A letter for how much of a scale was earned. Deliberately coarse: the
 * underlying numbers are a model's estimate, and a letter does not invite
 * reading meaning into a one-point difference.
 */
export function scoreGrade(fraction: number): string {
  if (fraction >= 0.9) return 'A+'
  if (fraction >= 0.8) return 'A'
  if (fraction >= 0.7) return 'A-'
  if (fraction >= 0.6) return 'B+'
  if (fraction >= 0.5) return 'B'
  if (fraction >= 0.4) return 'B-'
  if (fraction >= 0.3) return 'C+'
  return 'C'
}
