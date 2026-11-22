import { describe, expect, it } from 'vitest'
import {
  danglingOpener,
  isEnglishLanguage,
  isLeadInFragment,
  reviewOpening,
  rewindOpening,
  type OpeningLine
} from '@shared/clipOpenings'

describe('isEnglishLanguage', () => {
  it('accepts the names and codes Whisper and the app use for English', () => {
    for (const lang of ['english', 'English', 'en', 'EN', 'en-US', 'en_GB', ' english ']) expect(isEnglishLanguage(lang)).toBe(true)
  })

  it('rejects other languages and missing values', () => {
    for (const lang of ['german', 'de', 'spanish', 'eng-ish', 'french', '', undefined]) expect(isEnglishLanguage(lang)).toBe(false)
  })
})

describe('isLeadInFragment', () => {
  it('recognises one- and two-word throwaways', () => {
    for (const text of ['Yeah.', 'Right.', 'So.', 'Okay, so.', 'I mean.', 'Um.', 'Yeah, yeah.', 'Right, exactly.',
      'All right.', 'Good question.', 'Thank you.', 'Mhm.', '"Okay."', 'Alright, cool.', 'Oh, well.', 'You know.']) {
      expect(isLeadInFragment(text)).toBe(true)
    }
  })

  it('leaves short sentences that say something', () => {
    for (const text of ['No.', 'Wow.', 'Oh no.', 'Never.', 'Listen.', 'Money.', 'Turn right.', 'I quit.', 'Exactly wrong.',
      'Why?', 'Yeah, I quit my job.', 'So here is the thing.', '']) {
      expect(isLeadInFragment(text)).toBe(false)
    }
  })
})

describe('danglingOpener', () => {
  it('flags conjunctions and back-references that need what came before', () => {
    expect(danglingOpener('And then he just walked out.')).toBe('and')
    expect(danglingOpener('But nobody listened to him.')).toBe('but')
    expect(danglingOpener('Because the bank had already closed.')).toBe('because')
    expect(danglingOpener('Which is exactly what happened next.')).toBe('which')
    expect(danglingOpener("That's why I never invest in crypto.")).toBe("that's why")
    expect(danglingOpener('That’s why it failed.')).toBe("that's why")
    expect(danglingOpener('So that\'s why we moved to Berlin.')).toBe("that's why")
    expect(danglingOpener('As I said, the market always recovers.')).toBe('as i said')
    expect(danglingOpener('Like I mentioned earlier, sleep matters.')).toBe('like i mentioned')
    expect(danglingOpener('That is because nobody checks.')).toBe('that is because')
    expect(danglingOpener('Yeah, because it was free.')).toBe('because')
    expect(danglingOpener('Um, and that was the end of it.')).toBe('and')
    expect(danglingOpener("That's how they got rich.")).toBe("that's how")
  })

  it('does not flag questions, whatever they start with', () => {
    expect(danglingOpener('But why would anyone do that?')).toBeNull()
    expect(danglingOpener('And what happened next?')).toBeNull()
    expect(danglingOpener('Which one would you pick?')).toBeNull()
  })

  it('does not flag "So" in front of a complete statement, or ordinary openers', () => {
    for (const text of [
      'So I quit my job at Google.',
      'So, this is the biggest mistake people make.',
      'Most people get this completely wrong.',
      'This is why you are broke.',
      'He told me I would never walk again.',
      'They lied to us about everything.',
      'Andrew was the first to notice.',
      'Butter is better than oil.',
      'Like most people, I hated running.',
      'Anyway, the point is simple.',
      'The answer is no.'
    ]) {
      expect(danglingOpener(text)).toBeNull()
    }
  })
})

describe('reviewOpening', () => {
  /** Lines of `sec` seconds each, half a second apart, starting at 10 s. */
  const lines = (texts: string[], sec = 3): OpeningLine[] =>
    texts.map((text, i) => ({ text, start: 10 + i * (sec + 0.5), end: 10 + i * (sec + 0.5) + sec }))
  const limits = { clipStart: 9.75, firstPartEnd: 60, playedSec: 50.25, minPlayedSec: 8, minFirstPartSec: 0 }

  it('skips lead-ins and opens on the first substantive line', () => {
    const verdict = reviewOpening(lines(['Yeah.', 'Okay, so.', 'Most people get this wrong.'], 1), limits)
    expect(verdict).toEqual({ skip: 2, dangling: null })
  })

  it('leaves a clip that opens well alone', () => {
    expect(reviewOpening(lines(['Most people get this wrong.', 'Yeah.']), limits)).toEqual({ skip: 0, dangling: null })
  })

  it('flags a dangling opener after the lead-ins without skipping it', () => {
    expect(reviewOpening(lines(['Right.', 'And that is why it failed.', 'More.'], 1), limits)).toEqual({ skip: 1, dangling: 'and' })
    expect(reviewOpening(lines(['But nobody listened.', 'More.']), limits)).toEqual({ skip: 0, dangling: 'but' })
  })

  it('never skips more than three lead-ins', () => {
    const verdict = reviewOpening(lines(['Yeah.', 'So.', 'Right.', 'Okay.', 'Real start.'], 0.4), limits)
    expect(verdict.skip).toBe(3)
    // The opener is still a lead-in, so it is not read as a dangling sentence either.
    expect(verdict.dangling).toBeNull()
  })

  it('never skips more than a few seconds', () => {
    // The next line starts 5.25 s after the clip does.
    expect(reviewOpening(lines(['Yeah.', 'Real start here.'], 4.5), limits).skip).toBe(0)
  })

  it('keeps the clip above its minimum length', () => {
    const short = { ...limits, firstPartEnd: 19, playedSec: 9.25 }
    expect(reviewOpening(lines(['Yeah.', 'Real start here.', 'And more.']), short).skip).toBe(0)
  })

  it('keeps the first part of a joined clip above its minimum', () => {
    const joined = { ...limits, firstPartEnd: 16.5, playedSec: 30, minFirstPartSec: 3 }
    // Skipping would leave 3 s of first part (13.5 to 16.5): allowed at exactly the minimum.
    expect(reviewOpening(lines(['Yeah.', 'Real start here.']), joined).skip).toBe(1)
    expect(reviewOpening(lines(['Yeah.', 'Real start here.']), { ...joined, firstPartEnd: 16 }).skip).toBe(0)
  })

  it('never skips into or past the end of the first part', () => {
    expect(reviewOpening(lines(['Yeah.', 'Next part.']), { ...limits, firstPartEnd: 13.5 }).skip).toBe(0)
  })

  it('does nothing with no lines', () => {
    expect(reviewOpening([], limits)).toEqual({ skip: 0, dangling: null })
  })
})

describe('rewindOpening', () => {
  const line = (start: number, text: string) => ({ start, end: start + 2, text })
  const limits = { playedSec: 30, maxPlayedSec: 60, firstLineStart: 20 }

  it('steps back to the line a dangling opening continues', () => {
    expect(rewindOpening([line(10, 'Unrelated.'), line(16, 'The rich do it the other way around.')], limits)).toBe(1)
  })

  it('steps past a line that leans back too, but no further than two', () => {
    expect(rewindOpening([line(12, 'Most people get this one thing wrong.'), line(16, 'But they never notice.')], limits)).toBe(2)
    expect(rewindOpening([line(6, 'Clean.'), line(12, 'And another.'), line(16, 'But they never notice.')], limits)).toBe(0)
  })

  it('skips throwaway lead-ins rather than opening on them', () => {
    expect(rewindOpening([line(14, 'Here is the real point we need.'), line(18, 'Yeah.')], limits)).toBe(2)
  })

  it('will not open on a short reaction', () => {
    expect(rewindOpening([line(16, 'Oh no.')], limits)).toBe(0)
    expect(rewindOpening([line(16, 'Delightful, but terrifying.')], limits)).toBe(0)
  })

  it('refuses when the clip would break its cap or reach too far back', () => {
    expect(rewindOpening([line(16, 'The rich do it the other way around.')], { ...limits, maxPlayedSec: 33 })).toBe(0)
    expect(rewindOpening([line(2, 'Long ago.')], limits)).toBe(0)
    expect(rewindOpening([], limits)).toBe(0)
  })
})
