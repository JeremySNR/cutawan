import { describe, expect, it } from 'vitest'
import {
  applyRefinedEnding,
  applyRefinedStart,
  dedupeClips,
  formatTranscriptForModel,
  planAnalysisWindows,
  snapClipEnd,
  snapClipStart,
  targetClipCount
} from '../src/main/pipeline/highlights'
import { transcriptSentences } from '@shared/sentences'
import { makeTranscript } from './helpers'
import { DEFAULT_CAPTION_STYLE_ID } from '@shared/captionStyles'
import type { Clip } from '@shared/types'

function clip(id: string, start: number, end: number, score: number): Clip {
  return {
    id,
    suggestedStart: start,
    suggestedEnd: end,
    title: id,
    hook: '',
    summary: '',
    viralityScore: score,
    viralityReason: '',
    visualSummary: null,
    hashtags: [],
    thumbnailPath: null,
    focusTrack: null,
    broll: [],
    edit: {
      aspect: '9:16',
      reframeMode: 'crop',
      framing: 'manual',
      tightenCuts: false,
      focusX: 0.5,
      captionsEnabled: true,
      captionStyleId: DEFAULT_CAPTION_STYLE_ID,
      showTitle: false,
      start,
      end
    }
  }
}

describe('dedupeClips', () => {
  it('keeps non-overlapping clips', () => {
    const clips = [clip('a', 0, 20, 90), clip('b', 30, 50, 80)]
    expect(dedupeClips(clips).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('drops a clip that substantially overlaps a higher-scored one', () => {
    const clips = [clip('winner', 0, 30, 90), clip('dupe', 5, 32, 70)]
    expect(dedupeClips(clips).map((c) => c.id)).toEqual(['winner'])
  })

  it('keeps clips with small overlaps', () => {
    // 5s overlap on 30s/25s clips = 20% of the shorter clip, under the 40% cap.
    const clips = [clip('a', 0, 30, 90), clip('b', 25, 50, 70)]
    expect(dedupeClips(clips).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('measures overlap against the shorter clip', () => {
    // The short clip sits fully inside the long one: 100% of the short clip.
    const clips = [clip('long', 0, 60, 90), clip('short', 20, 30, 85)]
    expect(dedupeClips(clips).map((c) => c.id)).toEqual(['long'])
  })
})

describe('targetClipCount', () => {
  it('asks for roughly one clip per minute of source', () => {
    expect(targetClipCount(600)).toBe(10)
    expect(targetClipCount(1800)).toBe(30)
  })

  it('never asks for fewer than 4 or more than 40', () => {
    expect(targetClipCount(30)).toBe(4)
    expect(targetClipCount(6 * 3600)).toBe(40)
  })
})

describe('applyRefinedEnding', () => {
  it('rejects an extension beyond the requested duration rather than chopping its payoff', () => {
    const original = clip('a', 0, 44, 90)
    expect(applyRefinedEnding(original, 80, [80], 300, 45)).toBe(original)
    expect(applyRefinedEnding(original, 44.5, [44.5], 300, 45)).toBe(original)
  })
  const sentenceEnds = [10, 20, 30, 38.5, 47, 60]
  const VIDEO_DUR = 300

  it('extends the clip to the sentence that carries the payoff', () => {
    const c = applyRefinedEnding(clip('a', 5, 30.6, 90), 38.4, sentenceEnds, VIDEO_DUR)
    // Snapped to the 38.5s sentence end plus the 0.6s post-roll.
    expect(c.suggestedEnd).toBeCloseTo(39.1, 3)
    expect(c.edit.end).toBeCloseTo(39.1, 3)
    expect(c.suggestedStart).toBe(5)
  })

  it('can trim back to an earlier, stronger closer', () => {
    const c = applyRefinedEnding(clip('a', 5, 47.6, 90), 38.5, sentenceEnds, VIDEO_DUR)
    expect(c.suggestedEnd).toBeCloseTo(39.1, 3)
  })

  it('ignores no-op and implausible suggestions', () => {
    const original = clip('a', 5, 30.6, 90)
    // Same ending re-suggested: below the 1s change threshold.
    expect(applyRefinedEnding(original, 30, sentenceEnds, VIDEO_DUR)).toBe(original)
    // Extension beyond the 45s cap.
    expect(applyRefinedEnding(clip('a', 5, 30.6, 90), 200, [200], VIDEO_DUR)).toEqual(
      clip('a', 5, 30.6, 90)
    )
    // Trim that would leave the clip shorter than the minimum.
    expect(applyRefinedEnding(clip('a', 5, 20.6, 90), 10, sentenceEnds, VIDEO_DUR)).toEqual(
      clip('a', 5, 20.6, 90)
    )
    // Nonsense values.
    expect(applyRefinedEnding(original, Number.NaN, sentenceEnds, VIDEO_DUR)).toBe(original)
  })

  it('clamps to the end of the video', () => {
    const c = applyRefinedEnding(clip('a', 270, 290, 90), 299.8, [299.8], 300)
    expect(c.suggestedEnd).toBe(300)
  })
})

describe('applyRefinedStart', () => {
  const sentenceStarts = [5, 12, 20, 40]

  it('advances the start to the sentence where the hook begins', () => {
    const c = applyRefinedStart(clip('a', 5, 60, 90), 12.3, sentenceStarts)
    // Snapped to the 12s sentence start minus the 0.25s pre-roll.
    expect(c.suggestedStart).toBeCloseTo(11.75, 3)
    expect(c.edit.start).toBeCloseTo(11.75, 3)
    expect(c.suggestedEnd).toBe(60)
  })

  it('never rewinds the start to add setup', () => {
    const original = clip('a', 12, 60, 90)
    expect(applyRefinedStart(original, 5, sentenceStarts)).toBe(original)
  })

  it('ignores no-op, too-far and too-short suggestions', () => {
    // Same start re-suggested: below the change threshold.
    const original = clip('a', 5, 60, 90)
    expect(applyRefinedStart(original, 5, sentenceStarts)).toBe(original)
    // Advance beyond the 20s cap.
    expect(applyRefinedStart(clip('a', 5, 60, 90), 40, sentenceStarts)).toEqual(
      clip('a', 5, 60, 90)
    )
    // Trim that would leave the clip shorter than the minimum.
    expect(applyRefinedStart(clip('a', 5, 15, 90), 12, sentenceStarts)).toEqual(
      clip('a', 5, 15, 90)
    )
    // Nonsense values.
    expect(applyRefinedStart(original, Number.NaN, sentenceStarts)).toBe(original)
  })
})

describe('snapClipStart / snapClipEnd', () => {
  // Three sentences of five words at 0.4 s per word: [0,1.9] [2.3,4.2] [4.6,6.5] …
  const transcript = makeTranscript(
    ['one two three four five.', 'six seven eight nine ten.', 'eleven twelve thirteen fourteen fifteen.', 'sixteen seventeen eighteen nineteen twenty.'],
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const words = sentences.flatMap((s) => s.words)
  const wordStarts = words.map((w) => w.start)
  const wordEnds = words.map((w) => w.end)

  it('opens the sentence the moment falls inside rather than skipping it', () => {
    // 1.0 s into sentence 1 (which starts at 2.3): nearest-boundary logic
    // would have jumped forward to sentence 2; we open sentence 1.
    expect(snapClipStart(sentences[1].start + 1.0, sentences, wordStarts)).toBe(sentences[1].start)
  })

  it('moves a start that lands in a pause onto the next sentence', () => {
    const gap = (sentences[0].end + sentences[1].start) / 2
    expect(snapClipStart(gap, sentences, wordStarts)).toBe(sentences[1].start)
  })

  it('stays inside a long sentence near its end instead of jumping to the next one', () => {
    // 15 s sentence followed by another; a start 1.6 s before the next
    // sentence begins is still this sentence's thought.
    const words = Array.from({ length: 30 }, (_, i) => ({ text: 'w', start: i * 0.5, end: i * 0.5 + 0.4 }))
    words[29].text = 'w.'
    const more = Array.from({ length: 6 }, (_, i) => ({ text: 'n', start: 15.4 + i * 0.5, end: 15.8 + i * 0.5 }))
    more[5].text = 'n.'
    const all = [...words, ...more]
    const t = { language: 'english', durationSec: 20, segments: [{ id: 0, text: 'x.', start: 0, end: 20, words: all }] }
    const s = transcriptSentences(t)
    expect(s.map((x) => x.start)).toEqual([0, 15.4])
    const snapped = snapClipStart(13.8, s, all.map((w) => w.start))
    expect(snapped).toBeLessThan(15.4)
    expect(snapped).toBeCloseTo(14.0, 5)
  })

  it('falls back to a word boundary deep inside a long sentence', () => {
    const words = Array.from({ length: 30 }, (_, i) => ({ text: 'w', start: i * 0.5, end: i * 0.5 + 0.4 }))
    const long = { language: 'english', durationSec: 15, segments: [{ id: 0, text: 'x.', start: 0, end: 15, words }] }
    long.segments[0].words[29].text = 'w.'
    const s = transcriptSentences(long)
    expect(s).toHaveLength(1)
    // 6 s in: too far from the start to rewind, so the nearest word start.
    expect(snapClipStart(6.1, s, words.map((w) => w.start))).toBe(6)
  })

  it('completes the sentence a moment ends inside', () => {
    expect(snapClipEnd(sentences[1].start + 0.5, sentences, wordEnds)).toBe(sentences[1].end)
  })

  it('closes on the sentence just finished when the moment lands in the pause after it', () => {
    const gap = sentences[1].end + 0.2
    expect(snapClipEnd(gap, sentences, wordEnds)).toBe(sentences[1].end)
  })

  it('leaves the model exactly on a sentence end alone', () => {
    expect(snapClipEnd(sentences[2].end, sentences, wordEnds)).toBe(sentences[2].end)
  })
})

describe('formatTranscriptForModel', () => {
  it('writes one sentence per line with start/end and delivery tags', () => {
    const t = makeTranscript(['Loud one.', 'Middle one.', 'Quiet one.'])
    t.segments[0].energy = 0.95
    t.segments[1].energy = 0.5
    t.segments[2].energy = 0.1
    const lines = formatTranscriptForModel(transcriptSentences(t)).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\[0\.0s - 0\.7s\] Loud one\. \[delivery: energetic\]$/)
    expect(lines[1]).not.toContain('[delivery')
    expect(lines[2]).toContain('[delivery: subdued]')
  })
})

describe('planAnalysisWindows', () => {
  const build = (count: number) => transcriptSentences(makeTranscript(
    Array.from({ length: count }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  ))

  it('keeps a short transcript in one window', () => {
    const sentences = build(300) // 13.5 minutes
    const windows = planAnalysisWindows(sentences, 100)
    expect(windows).toHaveLength(1)
    expect(windows[0].sentences).toBe(sentences)
  })

  it('returns nothing for an empty transcript', () => {
    expect(planAnalysisWindows([], 100)).toEqual([])
  })

  it('covers a long transcript with equal windows that overlap by more than a clip', () => {
    const sentences = build(2700) // about two hours
    const windows = planAnalysisWindows(sentences, 100)
    expect(windows.length).toBeGreaterThan(8)
    expect(windows[0].from).toBe(sentences[0].start)
    expect(windows[windows.length - 1].to).toBe(sentences[sentences.length - 1].end)
    const lengths = windows.map((w) => w.to - w.from)
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(12 * 60 + 1)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i - 1].to - windows[i].from).toBeGreaterThanOrEqual(130 - 1e-6)
    }
    // Any clip up to the cap, wherever it sits, is wholly inside some window.
    for (let start = sentences[0].start; start + 100 <= sentences[sentences.length - 1].end; start += 7.3) {
      expect(windows.some((w) => w.from <= start && start + 100 <= w.to)).toBe(true)
    }
    // Every sentence is shown to the model at least once.
    const shown = new Set(windows.flatMap((w) => w.sentences.map((s) => s.index)))
    expect(shown.size).toBe(sentences.length)
  })

  it('drops a window that holds no speech', () => {
    const first = makeTranscript(Array.from({ length: 200 }, (_, i) => `early ${i} word three four five.`))
    const later = makeTranscript(Array.from({ length: 200 }, (_, i) => `late ${i} word three four five.`), { startSec: 3600 })
    const sentences = transcriptSentences({
      ...first,
      durationSec: later.durationSec,
      segments: [...first.segments, ...later.segments.map((seg) => ({ ...seg, id: seg.id + 200 }))]
    })
    const windows = planAnalysisWindows(sentences, 100)
    expect(windows.every((w) => w.sentences.length > 0)).toBe(true)
    expect(windows.map((w) => w.index)).toEqual(windows.map((_, i) => i))
    expect(windows.length).toBeLessThan(Math.ceil(later.durationSec / (12 * 60 - 130)))
  })
})
