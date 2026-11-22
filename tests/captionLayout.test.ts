import { describe, expect, it } from 'vitest'
import {
  CAPTION_HOLD_SEC,
  captionLayoutBudget,
  captionWordText,
  groupDisplayEnd,
  groupWords,
  wordsInRange,
  type CaptionLayoutBudget
} from '@shared/captionLayout'
import { getCaptionStyle } from '@shared/captionStyles'
import { makeTranscript } from './helpers'
import type { TranscriptWord } from '@shared/types'

const word = (text: string, start: number, end: number): TranscriptWord => ({ text, start, end })

/** A budget wide enough that only the word cap, pauses and punctuation break groups. */
const wide = (maxWords: number): CaptionLayoutBudget => ({
  maxWords,
  lineWidthEm: 1000,
  glyphWidthEm: 0.5,
  maxLines: 2
})

describe('wordsInRange', () => {
  it('selects words whose midpoint falls inside the clip', () => {
    const transcript = makeTranscript(['one two three four five'], { wordSec: 1, gapSec: 0 })
    // Words at [0,1] [1,2] [2,3] [3,4] [4,5]; clip [1.6, 3.9] catches midpoints 2.5 and 3.5.
    const words = wordsInRange(transcript, 1.6, 3.9)
    expect(words.map((w) => w.text)).toEqual(['three', 'four'])
  })

  it('skips empty words (cleared in the transcript editor)', () => {
    const transcript = makeTranscript(['a b c'])
    transcript.segments[0].words[1].text = ''
    const words = wordsInRange(transcript, 0, transcript.durationSec)
    expect(words.map((w) => w.text)).toEqual(['a', 'c'])
  })

  it('returns words sorted by start time across segments', () => {
    const transcript = makeTranscript(['later words', 'earlier words'])
    // Swap segment order to prove sorting.
    transcript.segments.reverse()
    const words = wordsInRange(transcript, 0, transcript.durationSec)
    const starts = words.map((w) => w.start)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })
})

describe('groupWords', () => {
  it('respects the max group size', () => {
    const words = [
      word('a', 0, 0.2),
      word('b', 0.3, 0.5),
      word('c', 0.6, 0.8),
      word('d', 0.9, 1.1)
    ]
    const groups = groupWords(words, wide(3))
    expect(groups.map((g) => g.words.length)).toEqual([3, 1])
  })

  it('breaks groups on long pauses', () => {
    const words = [word('before', 0, 0.3), word('after', 2, 2.3)]
    const groups = groupWords(words, wide(5))
    expect(groups.length).toBe(2)
  })

  it('breaks groups after sentence-ending punctuation', () => {
    const words = [word('done.', 0, 0.3), word('next', 0.5, 0.8)]
    const groups = groupWords(words, wide(5))
    expect(groups.length).toBe(2)
  })

  it('records group start/end from its words', () => {
    const words = [word('a', 1, 1.4), word('b', 1.5, 2)]
    const [group] = groupWords(words, wide(5))
    expect(group.start).toBe(1)
    expect(group.end).toBe(2)
  })

  it('starts a new line when the next word would overflow the line budget', () => {
    // Five letters at 0.5em = 2.5em per word plus a 0.26em space; a 5.5em
    // line holds two words, the third has to drop down.
    const words = [word('aaaaa', 0, 0.2), word('bbbbb', 0.3, 0.5), word('ccccc', 0.6, 0.8)]
    const [group] = groupWords(words, { maxWords: 6, lineWidthEm: 5.5, glyphWidthEm: 0.5, maxLines: 2 })
    expect(group.lines.map((l) => l.map((w) => w.text))).toEqual([['aaaaa', 'bbbbb'], ['ccccc']])
    expect(group.words.map((w) => w.text)).toEqual(['aaaaa', 'bbbbb', 'ccccc'])
  })

  it('never uses a third line: the group breaks instead', () => {
    const words = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map((t, i) => word(t, i * 0.3, i * 0.3 + 0.2))
    // One word per line (2 letters = 1em, line holds 1.2em).
    const groups = groupWords(words, { maxWords: 10, lineWidthEm: 1.2, glyphWidthEm: 0.5, maxLines: 2 })
    expect(groups.map((g) => g.lines.length)).toEqual([2, 2, 2])
    expect(groups.every((g) => g.lines.every((l) => l.length === 1))).toBe(true)
  })

  it('gives a word wider than a whole line its own line rather than dropping it', () => {
    const words = [word('a', 0, 0.2), word('supercalifragilistic', 0.3, 0.8), word('b', 0.9, 1)]
    const groups = groupWords(words, { maxWords: 10, lineWidthEm: 3, glyphWidthEm: 0.5, maxLines: 2 })
    const texts = groups.flatMap((g) => g.words.map((w) => w.text))
    expect(texts).toEqual(['a', 'supercalifragilistic', 'b'])
    const longLine = groups.flatMap((g) => g.lines).find((l) => l[0].text.startsWith('super'))
    expect(longLine).toHaveLength(1)
  })

  it('lines always concatenate back to the group words, in order', () => {
    const words = Array.from({ length: 40 }, (_, i) =>
      word(i % 3 === 0 ? 'longerword' : 'go', i * 0.25, i * 0.25 + 0.2)
    )
    const groups = groupWords(words, { maxWords: 6, lineWidthEm: 6, glyphWidthEm: 0.5, maxLines: 2 })
    for (const g of groups) expect(g.lines.flat()).toEqual(g.words)
    expect(groups.flatMap((g) => g.words)).toEqual(words)
  })
})

describe('captionLayoutBudget', () => {
  it('fits far fewer characters on a 9:16 frame than on 16:9 at the same style', () => {
    const style = getCaptionStyle('beast')
    const vertical = captionLayoutBudget(style, 9 / 16)
    const wide = captionLayoutBudget(style, 16 / 9)
    expect(wide.lineWidthEm).toBeGreaterThan(vertical.lineWidthEm * 3)
    expect(vertical.maxWords).toBe(style.wordsPerGroup)
    expect(vertical.maxLines).toBe(2)
  })

  it('keeps a vertical Beast caption to roughly twenty characters per line', () => {
    // Anton at 5.2% of the frame height on a 1080-wide frame: about 21 glyphs.
    const budget = captionLayoutBudget(getCaptionStyle('beast'), 9 / 16)
    const chars = budget.lineWidthEm / budget.glyphWidthEm
    expect(chars).toBeGreaterThan(17)
    expect(chars).toBeLessThan(24)
  })

  it('uses the wider uppercase glyph average for shouting styles', () => {
    const shouting = captionLayoutBudget(getCaptionStyle('crimson'), 1) // Poppins, uppercase
    const quiet = captionLayoutBudget(getCaptionStyle('karaoke'), 1) // Poppins, mixed case
    expect(shouting.glyphWidthEm).toBeGreaterThan(quiet.glyphWidthEm)
  })

  it('falls back to a conservative width for unknown (uploaded) fonts', () => {
    const custom = captionLayoutBudget({ ...getCaptionStyle('karaoke'), fontFamily: 'My Brand Font' }, 1)
    const known = captionLayoutBudget(getCaptionStyle('karaoke'), 1)
    expect(custom.glyphWidthEm).toBeGreaterThan(known.glyphWidthEm)
  })
})

describe('groupDisplayEnd', () => {
  const groups = groupWords(
    [word('one', 0, 0.3), word('two.', 0.4, 0.7), word('three', 5, 5.3), word('four', 5.4, 5.7)],
    wide(4)
  )

  it('holds a finished group on screen for the hold time', () => {
    expect(groups).toHaveLength(2)
    expect(groupDisplayEnd(groups, 0, 100)).toBeCloseTo(0.7 + CAPTION_HOLD_SEC)
  })

  it('never holds into the next group', () => {
    const close = groupWords([word('a.', 0, 0.3), word('b', 0.6, 0.9)], wide(4))
    expect(groupDisplayEnd(close, 0, 100)).toBe(0.6)
  })

  it('never holds past the clip end', () => {
    expect(groupDisplayEnd(groups, 1, 6)).toBe(6)
  })
})

describe('captionWordText', () => {
  const punchy = { wordsPerGroup: 3, uppercase: false }
  const draw = (text: string): string => captionWordText(text, punchy)

  it('drops trailing commas and full stops on big-word styles', () => {
    expect(draw('works.')).toBe('works')
    expect(draw('so,')).toBe('so')
    expect(draw('end;')).toBe('end')
    expect(draw('this:')).toBe('this')
    expect(draw('$5,000.')).toBe('$5,000')
  })

  it('keeps marks that carry tone', () => {
    expect(draw('what?')).toBe('what?')
    expect(draw('no!')).toBe('no!')
    expect(draw('why?!')).toBe('why?!')
    expect(draw('wait...')).toBe('wait...')
    expect(draw('hmm…')).toBe('hmm…')
  })

  it('leaves punctuation inside a word alone', () => {
    expect(draw('3.5')).toBe('3.5')
    expect(draw("don't")).toBe("don't")
    expect(draw('U.S.')).toBe('U.S.')
    expect(draw('U.S.,')).toBe('U.S.')
    expect(draw('e.g.')).toBe('e.g.')
  })

  it('strips inside closing quotes and brackets', () => {
    expect(draw('"done."')).toBe('"done"')
    expect(draw('(yes).')).toBe('(yes)')
    expect(draw("goin',")).toBe("goin'")
  })

  it('never empties a word that is only punctuation', () => {
    expect(draw('.')).toBe('.')
    expect(draw('—')).toBe('—')
  })

  it('keeps punctuation on subtitle-like styles and applies the style case', () => {
    expect(captionWordText('works.', { wordsPerGroup: 6, uppercase: false })).toBe('works.')
    expect(captionWordText('works.', { wordsPerGroup: 6, uppercase: true })).toBe('WORKS.')
    expect(captionWordText('works.', { wordsPerGroup: 3, uppercase: true })).toBe('WORKS')
  })

  it('agrees with every bundled style about which kind it is', () => {
    expect(captionWordText('so,', getCaptionStyle('beast'))).toBe('SO')
    expect(captionWordText('so,', getCaptionStyle('minimal'))).toBe('so,')
  })
})
