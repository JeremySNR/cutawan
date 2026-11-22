import { describe, expect, it } from 'vitest'
import {
  CAPTION_EMOJI,
  emphasisScores,
  normalizeEmoji,
  pickGroupEmphasis,
  thinEmoji,
  validateEmphasisWords
} from '@shared/captionEmphasis'
import { captionGroupsFor, captionLayoutBudget } from '@shared/captionLayout'
import { getCaptionStyle } from '@shared/captionStyles'
import type { TranscriptWord } from '@shared/types'
import { makeTranscript } from './helpers'

const words = (text: string): TranscriptWord[] =>
  text.split(' ').map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.3 }))

describe('validating AI emphasis words', () => {
  const spoken = words('So we made 40 million dollars selling Notion templates, um, honestly.')

  it('keeps only single words actually spoken in the clip', () => {
    const valid = validateEmphasisWords([
      { word: 'million', emoji: '💰' },
      { word: 'Notion', emoji: '' },
      { word: 'billion', emoji: '🔥' }, // never said
      { word: 'Notion templates', emoji: '' }, // a phrase, not one word
      { word: 'templates', emoji: '🦄' } // emoji outside the bundled font
    ], spoken)
    expect(valid).toEqual([{ text: 'million', emoji: '💰' }, { text: 'Notion' }, { text: 'templates' }])
  })

  it('never keeps filler or function words, and drops duplicates', () => {
    const valid = validateEmphasisWords([
      { word: 'um', emoji: '' }, { word: 'we', emoji: '' }, { word: 'So', emoji: '' },
      { word: '40', emoji: '' }, { word: '40', emoji: '' }
    ], spoken)
    expect(valid).toEqual([{ text: '40' }])
  })

  it('survives malformed output', () => {
    expect(validateEmphasisWords(null, spoken)).toEqual([])
    expect(validateEmphasisWords([1, 'x', { emoji: '🔥' }], spoken)).toEqual([])
  })

  it('accepts emoji with a variation selector as the bundled glyph', () => {
    expect(normalizeEmoji('❤️')).toBe('❤')
    expect(normalizeEmoji('🦄')).toBeNull()
    expect(CAPTION_EMOJI).toContain('🔥')
  })
})

describe('choosing emphasis without AI', () => {
  it('scores numbers, strong words, proper nouns and hook words, and never filler', () => {
    const w = words('the secret is that Alex made 10 videos um every week')
    const scores = emphasisScores(w, { hook: 'Why weekly videos win' })
    const at = (text: string): number => scores[w.findIndex((x) => x.text === text)]
    expect(at('10')).toBeGreaterThan(at('secret') - 1)
    expect(at('secret')).toBeGreaterThanOrEqual(2.5)
    expect(at('Alex')).toBeGreaterThanOrEqual(2.5)
    expect(at('videos')).toBeGreaterThanOrEqual(2.5) // in the hook
    expect(at('um')).toBe(0)
    expect(at('the')).toBe(0)
    expect(at('every')).toBe(0)
  })

  it('does not treat a sentence-initial capital as a name', () => {
    const w = words('Honestly this works. Really it does')
    const scores = emphasisScores(w, {})
    expect(scores[0]).toBe(0)
    expect(scores[3]).toBe(0)
  })

  it('uses AI keywords alone when they exist', () => {
    const w = words('we made 10 million dollars')
    const scores = emphasisScores(w, { words: [{ text: 'dollars' }] })
    expect(scores.filter((s) => s > 0)).toHaveLength(1)
    expect(scores[4]).toBeGreaterThan(0)
  })

  it('marks at most one word per group, the strongest', () => {
    const w = words('one secret worth 10 million')
    const scores = new Map(w.map((x, i) => [x, emphasisScores(w, {})[i]]))
    expect(pickGroupEmphasis([w], scores)).toEqual([3])
    expect(pickGroupEmphasis([w.slice(0, 1)], scores)).toEqual([-1])
  })

  it('keeps emoji occasional', () => {
    const kept = thinEmoji([
      { at: 0, emoji: '🔥' }, { at: 2, emoji: '💰' }, { at: 7, emoji: '🚀' }, { at: 8, emoji: null },
      { at: 14, emoji: '💡' }, { at: 21, emoji: '🎯' }, { at: 30, emoji: '🧠' }
    ])
    expect(kept).toEqual(['🔥', null, '🚀', null, '💡', '🎯', null])
  })
})

describe('caption groups with emphasis', () => {
  const style = getCaptionStyle('beast')
  const budget = captionLayoutBudget(style, 9 / 16)

  it('marks at most one word per group and only spoken words', () => {
    const t = makeTranscript(['we made 10 million dollars with Notion templates last year', 'it was insane honestly'])
    const groups = captionGroupsFor(t, 0, t.durationSec, budget, { emphasis: true, hook: 'Notion templates' })
    expect(groups.some((g) => (g.emphasis ?? -1) >= 0)).toBe(true)
    for (const g of groups) {
      expect(g.emphasis).toBeLessThan(g.words.length)
      if ((g.emphasis ?? -1) >= 0) expect(g.words[g.emphasis!].text).not.toMatch(/^(we|it|was|with)$/)
    }
  })

  it('switches off cleanly', () => {
    const t = makeTranscript(['we made 10 million dollars'])
    const groups = captionGroupsFor(t, 0, t.durationSec, budget, { emphasis: false })
    expect(groups.every((g) => g.emphasis === -1 && g.emoji === null)).toBe(true)
  })

  it('gives emoji only with the toggle on, and only to emphasised words', () => {
    const t = makeTranscript(['we made so much money this year'])
    const ai = [{ text: 'money', emoji: '💰' }]
    const off = captionGroupsFor(t, 0, t.durationSec, budget, { emphasis: true, keywords: ai })
    expect(off.every((g) => g.emoji === null)).toBe(true)
    const on = captionGroupsFor(t, 0, t.durationSec, budget, { emphasis: true, emoji: true, keywords: ai })
    const marked = on.find((g) => g.emoji)!
    expect(marked.emoji).toBe('💰')
    expect(marked.words[marked.emphasis!].text).toBe('money')
  })

  it('never lets a group span a cold-open seam', () => {
    const t = makeTranscript(['one two three four five six'], { wordSec: 0.3, gapSec: 0.05 })
    const seam = t.segments[0].words[2].end + 0.01
    const groups = captionGroupsFor(t, 0, t.durationSec, captionLayoutBudget(getCaptionStyle('whisper'), 9 / 16), { breaks: [seam] })
    expect(groups.every((g) => g.end <= seam || g.start >= seam)).toBe(true)
  })
})
