import { describe, expect, it } from 'vitest'
import { bigramDice, findRetakes, normaliseWord, type RetakeWord } from '@shared/retakes'
import { autoRemovedRanges, clipKeptSegments, computeKeptSegments, retakeRanges } from '@shared/tighten'
import { toggleRestored } from '@shared/editOps'
import { isFiller } from '@shared/tighten'
import type { Clip, Transcript } from '@shared/types'

/**
 * Words from a script: tokens 0.3 s long, 0.1 s apart; `/` inserts a 0.5 s
 * hesitation and `//` a 1 s pause before the next word.
 */
function speak(script: string, startSec = 0.5): RetakeWord[] {
  const out: RetakeWord[] = []
  let t = startSec
  for (const token of script.split(/\s+/).filter(Boolean)) {
    if (token === '/') { t += 0.5; continue }
    if (token === '//') { t += 1; continue }
    out.push({ text: token, start: t, end: t + 0.3, filler: isFiller(token) })
    t += 0.4
  }
  return out
}

function transcriptOf(words: RetakeWord[]): Transcript {
  const end = words[words.length - 1].end
  return {
    language: 'en', durationSec: end + 1,
    segments: [{ id: 0, start: words[0].start, end, text: words.map(w => w.text).join(' '),
      words: words.map(w => ({ text: w.text, start: w.start, end: w.end })) }]
  }
}

function clipOf(words: RetakeWord[], tightenCuts = true): Pick<Clip, 'edit' | 'visualStory' | 'gapActivity'> {
  return { edit: { start: 0, end: words[words.length - 1].end + 1, tightenCuts } as Clip['edit'] }
}

/** The text that plays after pause removal. */
function playedText(words: RetakeWord[], clip = clipOf(words)): string {
  const kept = clipKeptSegments(clip, transcriptOf(words))
  return words.filter(w => {
    const mid = (w.start + w.end) / 2
    return !kept || kept.some(r => mid >= r.start && mid <= r.end)
  }).filter(w => !w.filler).map(w => w.text).join(' ')
}

describe('retake detection', () => {
  it('normalises words and scores bigram overlap', () => {
    expect(normaliseWord('We’ve,')).toBe('weve')
    expect(normaliseWord('Café!')).toBe('cafe')
    expect(bigramDice(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1)
    expect(bigramDice(['a', 'b'], ['c', 'd'])).toBe(0)
  })

  it('keeps only the restart of a false start', () => {
    const words = speak('So the reason — sorry, so the reason we did it was cost.')
    expect(findRetakes(words)).toMatchObject([{ first: 0, last: 4, restart: 5, kind: 'false-start' }])
    expect(playedText(words)).toBe('so the reason we did it was cost.')
  })

  it('treats a filler or a hesitation before the restart as abandonment', () => {
    expect(playedText(speak('I think um I think we should ship it today.'))).toBe('I think we should ship it today.')
    expect(playedText(speak('The main thing / the main thing is the price.'))).toBe('the main thing is the price.')
  })

  it('keeps only the last of several restarts', () => {
    const words = speak('So the — so the — so the reason we did it was cost.')
    expect(playedText(words)).toBe('so the reason we did it was cost.')
  })

  it('keeps only the last take of a sentence said twice', () => {
    const words = speak('We launched the product in March last year. // We launched the product in March of last year.')
    expect(findRetakes(words)).toHaveLength(1)
    expect(playedText(words)).toBe('We launched the product in March of last year.')
  })

  it('drops a short aside between two takes along with the first', () => {
    const words = speak('This is the best thing we ever built. Sorry, again. This is the best thing we have ever built.')
    expect(playedText(words)).toBe('This is the best thing we have ever built.')
  })

  it('keeps a take that was cut short only when the restart contains it', () => {
    const words = speak('Our revenue grew by forty — // Our revenue grew by forty percent in a year.')
    expect(playedText(words)).toBe('Our revenue grew by forty percent in a year.')
  })

  describe('leaves rhetorical repetition alone', () => {
    it.each([
      'Never, never give up on the people who believe in you.',
      'We will fight on the beaches. We will fight on the landing grounds. We will fight in the fields.',
      'Again and again and again they told us no.',
      'Never give up, never give up!',
      'Never give up, never give up on your dreams.',
      'Location, location, location is what matters most.',
      'It was the best of times, it was the worst of times.',
      'I came here to win. I came here to win and nothing else.'
    ])('%s', (script) => {
      const words = speak(script)
      expect(findRetakes(words)).toEqual([])
      expect(retakeRanges(transcriptOf(words), 0, 100)).toEqual([])
    })
  })

  it('does not join takes too far apart', () => {
    const filler = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')
    const words = speak(`We launched the product in March. ${filler}. We launched the product in March.`)
    expect(findRetakes(words)).toEqual([])
  })

  it('shows a retake as an automatic removal that can be restored', () => {
    const words = speak('So the reason — sorry, so the reason we did it was cost, and that was all.')
    const clip = clipOf(words)
    const transcript = transcriptOf(words)
    const removed = autoRemovedRanges(clip, transcript)
    const retake = removed.find(r => r.start <= words[0].start + 0.1 && r.end >= words[3].end)
    expect(retake).toBeDefined()
    const restored = { ...clip, edit: toggleRestored(clip.edit, retake!) }
    expect(playedText(words, restored)).toBe('So the reason — sorry, so the reason we did it was cost, and that was all.')
  })

  it('applies only with pause removal on', () => {
    const words = speak('So the reason — sorry, so the reason we did it was cost.')
    expect(clipKeptSegments(clipOf(words, false), transcriptOf(words))).toBeNull()
  })

  it('never cuts into a protected stretch', () => {
    const words = speak('So the reason — sorry, so the reason we did it was cost.')
    const transcript = transcriptOf(words)
    const kept = computeKeptSegments(transcript, 0, 10, [{ start: words[0].start, end: words[3].end }])
    expect(kept === null || kept.some(r => r.start <= words[0].start + 0.01)).toBe(true)
  })
})

describe('false starts after a finished sentence', () => {
  it.each([
    'It was great. / It was amazing, really.',
    'I love this city. / I love the people here and the food.',
    'We need to act. / We need to act now, before it is too late.',
    'This is the plan. / This is how we win the game.'
  ])('keeps both sentences of %s', script => {
    const words = speak(script)
    expect(findRetakes(words)).toEqual([])
    expect(playedText(words)).toBe(script.replace(' / ', ' '))
  })

  it('still drops an unfinished attempt before a pause', () => {
    expect(playedText(speak('The main thing / the main thing is the price.'))).toBe('the main thing is the price.')
  })
})
