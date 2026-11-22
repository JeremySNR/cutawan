import { describe, expect, it } from 'vitest'
import { CLIP_KINDS, CLIP_KIND_LABELS, diversifyClipOrder, parseClipKind, type VarietyItem } from '@shared/clipVariety'
import type { ClipKind } from '@shared/types'

type Item = VarietyItem & { id: string }
const item = (id: string, viralityScore: number, kind?: ClipKind): Item => ({ id, viralityScore, ...(kind ? { kind } : {}) })
const ids = (items: Item[]): string[] => items.map((i) => i.id)

describe('parseClipKind', () => {
  it('accepts every kind in the fixed set, in any case or spacing', () => {
    for (const kind of CLIP_KINDS) expect(parseClipKind(` ${kind.toUpperCase()} `)).toBe(kind)
  })

  it('maps the words a non-strict provider uses onto the set', () => {
    expect(parseClipKind('Hot take')).toBe('opinion')
    expect(parseClipKind('insight/tip')).toBe('insight')
    expect(parseClipKind('humour')).toBe('funny')
    expect(parseClipKind('how-to')).toBe('explainer')
  })

  it('treats anything else as no kind rather than guessing', () => {
    expect(parseClipKind('banana')).toBeUndefined()
    expect(parseClipKind(3)).toBeUndefined()
    expect(parseClipKind(undefined)).toBeUndefined()
  })

  it('has a card label for every kind', () => {
    for (const kind of CLIP_KINDS) expect(CLIP_KIND_LABELS[kind]).toBeTruthy()
  })
})

describe('diversifyClipOrder', () => {
  it('brings a different kind into the first slots when scores are close', () => {
    const list = [item('a', 90, 'story'), item('b', 88, 'story'), item('c', 86, 'story'), item('d', 85, 'funny'), item('e', 84, 'insight')]
    expect(ids(diversifyClipOrder(list))).toEqual(['a', 'd', 'e', 'b', 'c'])
  })

  it('leaves a list that is already varied alone', () => {
    const list = [item('a', 90, 'story'), item('b', 80, 'funny'), item('c', 70, 'insight'), item('d', 60, 'story')]
    expect(ids(diversifyClipOrder(list))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never moves a clip above one scoring more than ten points higher', () => {
    const list = [item('a', 90, 'story'), item('b', 89, 'story'), item('c', 75, 'funny')]
    // c would have to pass b (14 points higher): no move.
    expect(ids(diversifyClipOrder(list))).toEqual(['a', 'b', 'c'])
    const close = [item('a', 90, 'story'), item('b', 85, 'story'), item('c', 75, 'funny')]
    expect(ids(diversifyClipOrder(close))).toEqual(['a', 'c', 'b'])
  })

  it('never promotes a clip by more than three places', () => {
    const list = [
      item('a', 90, 'story'), item('b', 90, 'story'), item('c', 90, 'story'), item('d', 90, 'story'), item('e', 90, 'story'),
      item('f', 90, 'funny')
    ]
    // f sits four places below slot 1, out of reach; it climbs three, to slot 2.
    expect(ids(diversifyClipOrder(list))).toEqual(['a', 'b', 'f', 'c', 'd', 'e'])
    const far = [...'abcdefg'].map((id) => item(id, 90, 'story')).concat(item('z', 90, 'funny'))
    // z starts at 7; the last varied slot is 4, three places up.
    expect(ids(diversifyClipOrder(far))).toEqual(['a', 'b', 'c', 'd', 'z', 'e', 'f', 'g'])
    const beyond = [...'abcdefgh'].map((id) => item(id, 90, 'story')).concat(item('z', 90, 'funny'))
    expect(ids(diversifyClipOrder(beyond)).at(-1)).toBe('z')
    const reachable = [item('a', 90, 'story'), item('b', 90, 'story'), item('c', 90, 'story'), item('d', 90, 'funny')]
    expect(ids(diversifyClipOrder(reachable))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('counts the promotion from where a clip started, so no clip climbs further than the bound', () => {
    const list = [
      item('a', 90, 'story'), item('b', 90, 'story'), item('c', 90, 'funny'), item('d', 90, 'funny'), item('e', 90, 'insight'),
      item('f', 90, 'insight'), item('g', 90, 'opinion')
    ]
    const out = diversifyClipOrder(list)
    out.forEach((it, p) => expect(list.indexOf(it) - p).toBeLessThanOrEqual(3))
    expect(out.slice(0, 4).map((i) => i.kind)).toEqual(['story', 'funny', 'insight', 'opinion'])
  })

  it('fills only as many slots as there are kinds, and at most five', () => {
    const two = [item('a', 90, 'story'), item('b', 89, 'story'), item('c', 88, 'funny'), item('d', 87, 'funny')]
    expect(ids(diversifyClipOrder(two))).toEqual(['a', 'c', 'b', 'd'])
    const many = [item('s1', 90, 'story'), item('s2', 89, 'story'), ...CLIP_KINDS.slice(1).map((kind, k) => item(kind, 88 - k, kind))]
    const out = diversifyClipOrder(many)
    expect(out.slice(0, 5).map((i) => i.kind)).toEqual(['story', 'insight', 'opinion', 'funny', 'emotional'])
    // Past the five slots the order is untouched.
    expect(ids(out.slice(5))).toEqual(['s2', 'explainer', 'other'])
  })

  it('keeps clips without a kind where they are and never promotes them', () => {
    const list = [item('a', 90, 'story'), item('x', 89), item('b', 88, 'story'), item('c', 87, 'funny')]
    expect(ids(diversifyClipOrder(list))).toEqual(['a', 'x', 'c', 'b'])
    expect(ids(diversifyClipOrder([item('x', 90), item('y', 80)]))).toEqual(['x', 'y'])
  })

  it('returns the same items and does not change the input', () => {
    const list = [item('a', 90, 'story'), item('b', 88, 'story'), item('c', 86, 'funny')]
    const before = [...list]
    const out = diversifyClipOrder(list)
    expect(list).toEqual(before)
    expect(new Set(out)).toEqual(new Set(list))
    expect(diversifyClipOrder([])).toEqual([])
  })
})
