import { describe, expect, it } from 'vitest'
import {
  applyComparativeScores,
  applyRefinedEnding,
  applyRefinedStart,
  checkClipOpenings,
  dedupeClips,
  extendIntoReactions,
  penaliseHook,
  playedText,
  reviewedTime,
  formatTranscriptForModel,
  lengthPenalty,
  maxDurationFor,
  softMaxDurationFor,
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
  it('writes one numbered sentence per line with start/end and delivery tags', () => {
    const t = makeTranscript(['Loud one.', 'Middle one.', 'Quiet one.'])
    t.segments[0].energy = 0.95
    t.segments[1].energy = 0.5
    t.segments[2].energy = 0.1
    const lines = formatTranscriptForModel(transcriptSentences(t)).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^#0 \[0\.0s - 0\.7s\] Loud one\. \[delivery: energetic\]$/)
    expect(lines[2]).toMatch(/^#2 \[/)
    expect(lines[1]).not.toContain('[delivery')
    expect(lines[2]).toContain('[delivery: subdued]')
  })

  it('numbers each line by its place in the whole transcript, so a window keeps the same numbers', () => {
    const sentences = transcriptSentences(makeTranscript(['One here.', 'Two here.', 'Three here.', 'Four here.']))
    expect(formatTranscriptForModel(sentences.slice(2)).split('\n').map((l) => l.split(' ')[0])).toEqual(['#2', '#3'])
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

  it('stretches each inner window edge outward to a nearby topic change, keeping the coverage', () => {
    const sentences = build(2700)
    const plain = planAnalysisWindows(sentences, 100)
    // A topic change 40 s before each planned start and 30 s after each planned end.
    const lineAt = (t: number): number => sentences.find((s) => s.start >= t)!.index
    const fine = [...new Set(plain.slice(1).map((w) => lineAt(w.from - 40)).concat(plain.slice(0, -1).map((w) => lineAt(w.to + 30))))].sort((a, b) => a - b)
    const windows = planAnalysisWindows(sentences, 100, 0, { fine, coarse: [] })
    expect(windows).toHaveLength(plain.length)
    const changeTime = (line: number): number => (sentences[line - 1].end + sentences[line].start) / 2
    const times = fine.map(changeTime)
    for (let i = 0; i < windows.length; i++) {
      if (i > 0) {
        expect(windows[i].from).toBeLessThan(plain[i].from)
        expect(times.some((t) => Math.abs(t - windows[i].from) < 1e-9)).toBe(true)
      }
      if (i < windows.length - 1) {
        expect(windows[i].to).toBeGreaterThan(plain[i].to)
        expect(times.some((t) => Math.abs(t - windows[i].to) < 1e-9)).toBe(true)
      }
      // Never more than the snap distance beyond the plan.
      expect(plain[i].from - windows[i].from).toBeLessThanOrEqual(90)
      expect(windows[i].to - plain[i].to).toBeLessThanOrEqual(90)
    }
    expect(windows[0].from).toBe(sentences[0].start)
    expect(windows[windows.length - 1].to).toBe(sentences[sentences.length - 1].end)
    for (let start = sentences[0].start; start + 100 <= sentences[sentences.length - 1].end; start += 7.3) {
      expect(windows.some((w) => w.from <= start && start + 100 <= w.to)).toBe(true)
    }
  })

  it('ignores topic changes out of reach, and prefers a coarse change to a nearer fine one', () => {
    const sentences = build(2700)
    const plain = planAnalysisWindows(sentences, 100)
    const lineAt = (t: number): number => sentences.find((s) => s.start >= t)!.index
    const far = plain.slice(0, -1).map((w) => lineAt(w.to + 200))
    expect(planAnalysisWindows(sentences, 100, 0, { fine: far, coarse: [] }).map((w) => w.to)).toEqual(plain.map((w) => w.to))
    const end = plain[0].to
    const near = lineAt(end + 10)
    const major = lineAt(end + 60)
    const [first] = planAnalysisWindows(sentences, 100, 0, { fine: [near, major], coarse: [major] })
    expect(first.to).toBeCloseTo((sentences[major - 1].end + sentences[major].start) / 2, 6)
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

describe('reviewedTime', () => {
  const sentences = transcriptSentences(makeTranscript(['One here now.', 'Two here now.', 'Three here now.']))
  const tagged = new Map(sentences.slice(1).map((s) => [s.index, s]))

  it('maps a tagged line number to its start or end', () => {
    expect(reviewedTime(2, undefined, tagged, 'end')).toBe(sentences[2].end)
    expect(reviewedTime('#1', undefined, tagged, 'start')).toBe(sentences[1].start)
  })

  it('refuses a line that was not tagged for the clip rather than snapping to one', () => {
    expect(reviewedTime(0, 12.3, tagged, 'end')).toBeNull()
    expect(reviewedTime(7, undefined, tagged, 'end')).toBeNull()
    expect(reviewedTime(1.5, undefined, tagged, 'end')).toBeNull()
    expect(reviewedTime(1, undefined, undefined, 'end')).toBeNull()
  })

  it('falls back to seconds only when no line number was given', () => {
    expect(reviewedTime(undefined, 12.3, tagged, 'end')).toBe(12.3)
    expect(reviewedTime(null, 'soon', tagged, 'end')).toBeNull()
  })
})

describe('penaliseHook', () => {
  it('lowers the hook part and recomputes the total from the parts', () => {
    const c = { ...clip('a', 0, 20, 60), scoreBreakdown: { hook: 12, emotion: 20, value: 15, structure: 10, shareability: 5, visual: 80 } }
    const out = penaliseHook(c, 8)
    expect(out.scoreBreakdown).toEqual({ hook: 4, emotion: 20, value: 15, structure: 10, shareability: 5, visual: 80 })
    expect(out.viralityScore).toBe(54)
  })

  it('takes what the hook part cannot absorb off the other parts, so no penalty is lost', () => {
    const c = { ...clip('a', 0, 20, 60), scoreBreakdown: { hook: 5, emotion: 20, value: 15, structure: 10, shareability: 5, visual: 80 } }
    const out = penaliseHook(c, 8)
    expect(out.scoreBreakdown?.hook).toBe(0)
    expect(out.viralityScore).toBe(47)
    expect(out.scoreBreakdown!.emotion + out.scoreBreakdown!.value + out.scoreBreakdown!.structure + out.scoreBreakdown!.shareability).toBe(47)
    expect(out.scoreBreakdown?.visual).toBe(80)
  })

  it('lowers the total itself when there are no parts', () => {
    expect(penaliseHook(clip('a', 0, 20, 60), 8).viralityScore).toBe(52)
    expect(penaliseHook(clip('a', 0, 20, 3), 8).viralityScore).toBe(0)
  })
})

describe('applyComparativeScores', () => {
  const parts = { hook: 20, emotion: 10, value: 10, structure: 10, shareability: 5 }
  const clips = [
    { ...clip('a', 0, 20, 55), scoreBreakdown: parts },
    { ...clip('b', 30, 50, 50), scoreBreakdown: parts },
    clip('c', 60, 80, 45)
  ]

  it('replaces totals, rescales parts to match, and re-sorts', () => {
    const out = applyComparativeScores(clips, [{ index: 0, score: 30 }, { index: 1, score: 81.4 }, { index: 2, score: 60 }])
    expect(out.map((c) => [c.id, c.viralityScore])).toEqual([['b', 81], ['c', 60], ['a', 30]])
    const b = out[0].scoreBreakdown!
    expect(b.hook + b.emotion + b.value + b.structure + b.shareability).toBe(81)
    expect(out[1].scoreBreakdown).toBeUndefined()
  })

  it('keeps the score of a clip the model left out or scored with nonsense', () => {
    const out = applyComparativeScores(clips, [
      { index: 1, score: 'high' }, { index: 7, score: 90 }, { index: 2.5, score: 90 }, { index: 2, score: 140 },
      // A second verdict for the same clip is ignored.
      { index: 2, score: 1 }
    ])
    expect(out.map((c) => [c.id, c.viralityScore])).toEqual([['c', 99], ['a', 55], ['b', 50]])
    expect(out.find((c) => c.id === 'b')).toBe(clips[1])
  })
})

describe('playedText', () => {
  const transcript = makeTranscript(Array.from({ length: 30 }, (_, i) => `sentence ${i} word three four five.`))
  const sentences = transcriptSentences(transcript)

  it('reads only what a joined clip plays, marking the join', () => {
    const c = clip('j', sentences[2].start - 0.2, sentences[20].end + 0.2, 50)
    c.edit.cuts = [{ start: sentences[3].end + 0.2, end: sentences[19].start - 0.2 }]
    expect(playedText(c, sentences)).toBe(`${sentences[2].text} ${sentences[3].text} [cut] ${sentences[19].text} ${sentences[20].text}`)
  })

  it('keeps the opening and the close of a long clip within the budget', () => {
    const c = clip('l', sentences[0].start, sentences[29].end, 50)
    const text = playedText(c, sentences, 200)
    expect(text.length).toBeLessThanOrEqual(203)
    expect(text.startsWith(sentences[0].text)).toBe(true)
    expect(text.endsWith(sentences[29].text)).toBe(true)
    expect(text).toContain(' … ')
  })
})

describe('checkClipOpenings', () => {
  const texts = ['Okay, so.', 'Most people get money completely wrong today.', 'They save first and spend the rest.',
    'Yeah.', 'But the rich do it the other way.', 'That changes everything about it.', 'Try it for one month.']
  const transcript = makeTranscript(texts)
  const sentences = transcriptSentences(transcript)
  const span = (from: number, to: number, score = 50) => clip(`c${from}`, Math.max(0, sentences[from].start - 0.25), sentences[to].end + 0.25, score)

  it('skips the lead-in of a joined clip only while its first part stays long enough', () => {
    // First part: lines 0-2; joined to lines 4-6.
    const joined = span(0, 6)
    joined.edit.cuts = [{ start: sentences[2].end + 0.25, end: sentences[4].start - 0.25 }]
    joined.stitch = { segments: [], reason: 'test' }
    const { clips } = checkClipOpenings(transcript, [joined], 60)
    expect(clips[0].suggestedStart).toBeCloseTo(sentences[1].start - 0.25, 5)

    // A first part that would fall under three seconds keeps its lead-in.
    const tight = span(0, 6)
    tight.edit.cuts = [{ start: sentences[1].start + 1.5, end: sentences[4].start - 0.25 }]
    expect(checkClipOpenings(transcript, [tight], 60).clips[0]).toBe(tight)
  })

  it('reports the clips it penalised for a dangling opener', () => {
    const clean = span(1, 2)
    const { clips, dangling } = checkClipOpenings(transcript, [span(3, 6), clean], 60)
    expect([...dangling]).toEqual(['c3'])
    expect(clips[0].suggestedStart).toBeCloseTo(sentences[4].start - 0.25, 5)
    expect(clips[0].viralityScore).toBe(42)
    expect(clips[0].viralityReason).toBe('Opens on "But", which leans on something said before the clip.')
    expect(clips[1]).toBe(clean)
  })

  it('leaves a clip that opens partway into a sentence alone', () => {
    const mid = clip('mid', sentences[0].start + 0.5, sentences[4].end, 50)
    expect(checkClipOpenings(transcript, [mid], 60).clips[0]).toBe(mid)
  })
})


describe('length targets', () => {
  it('allows a quarter past the target before a clip is trimmed, never past three minutes', () => {
    expect([softMaxDurationFor('short'), maxDurationFor('short')]).toEqual([45, 56])
    expect([softMaxDurationFor('medium'), maxDurationFor('medium')]).toEqual([75, 94])
    expect([softMaxDurationFor('long'), maxDurationFor('long')]).toEqual([100, 125])
    expect([softMaxDurationFor('auto'), maxDurationFor('auto')]).toEqual([100, 125])
  })

  it('costs nothing within the target and a few points past it, at most eight', () => {
    expect(lengthPenalty(100, 100)).toBe(0)
    expect(lengthPenalty(60, 100)).toBe(0)
    expect(lengthPenalty(110, 100)).toBe(3)
    expect(lengthPenalty(125, 100)).toBe(7)
    expect(lengthPenalty(300, 100)).toBe(8)
    expect(lengthPenalty(50, 0)).toBe(0)
  })
})

describe('extendIntoReactions', () => {
  // Ten sentences of 2.3 s, 0.4 s apart: sentence k starts at 2.7k.
  const transcript = makeTranscript(
    Array.from({ length: 10 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const ending = (k: number): Clip => clip('c', sentences[1].start - 0.25, sentences[k].end + 0.25, 60)

  it('runs a clip a beat into the reaction to its last line', () => {
    // A long pause after line 4: shift the rest of the talk 5 s later.
    const t = { ...transcript, segments: transcript.segments.map((seg) => seg.id > 4 ? { ...seg, start: seg.start + 5, end: seg.end + 5, words: seg.words.map((w) => ({ ...w, start: w.start + 5, end: w.end + 5 })) } : seg) }
    const lines = transcriptSentences(t)
    const reaction = { start: lines[4].end + 0.3, end: lines[4].end + 4, strength: 0.8, kind: 'laughter' as const }
    const [out] = extendIntoReactions([ending(4)], { ...t, reactions: [reaction] }, lines, 100, 125)
    expect(out.suggestedEnd).toBeCloseTo(reaction.start + 1.5, 6)
    expect(out.edit.end).toBe(out.suggestedEnd)
  })

  it('never runs into the next word, past the cap, or earlier', () => {
    const reaction = { start: sentences[4].end + 0.1, end: sentences[4].end + 4, strength: 0.8, kind: 'applause' as const }
    const [out] = extendIntoReactions([ending(4)], { ...transcript, reactions: [reaction] }, sentences, 100, 125)
    // The next sentence starts 0.4 s after line 4 ends.
    expect(out.suggestedEnd).toBeCloseTo(sentences[5].start - 0.05, 6)
    const capped = extendIntoReactions([ending(4)], { ...transcript, reactions: [{ ...reaction, start: sentences[4].end + 0.2 }] }, sentences, 100, 10)
    expect(capped[0].suggestedEnd).toBe(ending(4).suggestedEnd)
    const already = { ...ending(4), suggestedEnd: sentences[4].end + 3, edit: { ...ending(4).edit, end: sentences[4].end + 3 } }
    expect(extendIntoReactions([already], { ...transcript, reactions: [reaction] }, sentences, 100, 125)[0]).toBe(already)
  })

  it('leaves clips alone without a reaction to their last line', () => {
    const c = ending(4)
    const quiet = { start: sentences[4].end + 0.1, end: sentences[4].end + 4, strength: 0.1, kind: 'laughter' as const }
    const music = { ...quiet, strength: 0.9, kind: 'music' as const }
    const elsewhere = { ...quiet, strength: 0.9, start: sentences[7].end + 0.1, end: sentences[7].end + 3 }
    expect(extendIntoReactions([c], { ...transcript, reactions: [quiet, music, elsewhere] }, sentences, 100, 125)[0]).toBe(c)
    expect(extendIntoReactions([c], transcript, sentences, 100, 125)[0]).toBe(c)
  })
})
