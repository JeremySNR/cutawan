import type { ClipKind } from './types'

/**
 * Variety at the top of the clip list. Clip selection scores every moment on
 * its own, so a video with one strong vein (six stories, say) fills the first
 * page with the same kind of clip, and a creator picking three to post gets
 * three of a kind. The selection pass labels each clip with a kind, and the
 * final order is nudged so the first few clips cover different kinds — never
 * far, and never over a clip that is clearly better.
 */

export const CLIP_KINDS: readonly ClipKind[] = ['story', 'insight', 'opinion', 'funny', 'emotional', 'explainer', 'other']

/** The words a clip card shows for each kind. */
export const CLIP_KIND_LABELS: Record<ClipKind, string> = {
  story: 'Story',
  insight: 'Tip',
  opinion: 'Hot take',
  funny: 'Funny',
  emotional: 'Emotional',
  explainer: 'Explainer',
  other: 'Other'
}

/**
 * Words a non-strict provider uses for a kind instead of the enum value,
 * mapped onto the fixed set. Anything else is no kind at all rather than a
 * guess: a wrong label would steer the reorder.
 */
const KIND_SYNONYMS: Record<string, ClipKind> = {
  story: 'story', anecdote: 'story', storytelling: 'story',
  insight: 'insight', tip: 'insight', tips: 'insight', advice: 'insight', 'insight/tip': 'insight', 'tip/insight': 'insight', lesson: 'insight',
  opinion: 'opinion', 'hot take': 'opinion', 'hot-take': 'opinion', hottake: 'opinion', take: 'opinion', 'opinion/hot take': 'opinion', controversy: 'opinion', controversial: 'opinion',
  funny: 'funny', humor: 'funny', humour: 'funny', comedy: 'funny', joke: 'funny',
  emotional: 'emotional', emotion: 'emotional', inspiring: 'emotional', inspirational: 'emotional', vulnerable: 'emotional',
  explainer: 'explainer', explanation: 'explainer', tutorial: 'explainer', 'how-to': 'explainer', 'how to': 'explainer', educational: 'explainer',
  other: 'other'
}

/** A kind from a reply, tolerating case, spacing and common synonyms; undefined for anything else. */
export function parseClipKind(value: unknown): ClipKind | undefined {
  if (typeof value !== 'string') return undefined
  return KIND_SYNONYMS[value.trim().toLowerCase().replace(/\s+/g, ' ')]
}

/** First clips the reorder tries to make distinct. */
export const VARIETY_SLOTS = 5
/** Most places a clip may climb to fill a slot with a new kind. */
export const MAX_VARIETY_PROMOTION = 3
/** A clip never climbs above one scoring more than this many points higher. */
export const MAX_VARIETY_SCORE_GAP = 10

export interface VarietyItem {
  kind?: ClipKind
  viralityScore: number
}

/**
 * Reorder a list sorted best first so its first N kinded items (N = the
 * smaller of `slots` and the number of distinct kinds in the list), within
 * the first `slots` places, cover distinct kinds
 * where that is possible within two bounds: no item climbs more than
 * `maxPromotion` places from where it started, and none climbs above an item
 * scoring more than `maxScoreGap` points higher. Slot by slot, an item whose
 * kind is already covered gives way to the first item further down with an
 * uncovered kind that the bounds allow; when none qualifies the slot keeps
 * its item. Items without a kind are never moved up and keep their slot, as
 * nothing says they repeat anything. 'other' counts as a kind like the rest.
 * Pure; returns a new array of the same items. Exported for tests.
 */
export function diversifyClipOrder<T extends VarietyItem>(
  items: T[],
  opts: { slots?: number; maxPromotion?: number; maxScoreGap?: number } = {}
): T[] {
  const slots = opts.slots ?? VARIETY_SLOTS
  const maxPromotion = opts.maxPromotion ?? MAX_VARIETY_PROMOTION
  const maxScoreGap = opts.maxScoreGap ?? MAX_VARIETY_SCORE_GAP
  const out = [...items]
  const distinct = new Set(items.flatMap((item) => (item.kind ? [item.kind] : [])))
  const n = Math.min(slots, distinct.size)
  if (n < 2) return out
  const original = new Map(items.map((item, i) => [item, i]))
  const covered = new Set<ClipKind>()
  // A kindless item keeps its slot without covering a kind, so the walk goes
  // on past it, but never beyond the first `slots` places.
  for (let p = 0; p < Math.min(slots, out.length) && covered.size < n; p++) {
    const here = out[p]
    if (!here.kind || !covered.has(here.kind)) {
      if (here.kind) covered.add(here.kind)
      continue
    }
    let jumped = -Infinity
    for (let q = p; q < out.length; q++) {
      const candidate = out[q]
      if (q > p && candidate.kind && !covered.has(candidate.kind) &&
        (original.get(candidate) ?? q) - p <= maxPromotion &&
        jumped - candidate.viralityScore <= maxScoreGap) {
        out.splice(q, 1)
        out.splice(p, 0, candidate)
        break
      }
      jumped = Math.max(jumped, candidate.viralityScore)
      // An item is pushed down at most once per earlier slot, so nothing past
      // here started within reach.
      if (q - p >= maxPromotion + p) break
    }
    if (out[p].kind) covered.add(out[p].kind as ClipKind)
  }
  return out
}
