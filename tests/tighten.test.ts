import { describe, expect, it } from 'vitest'
import { computeKeptSegments, isFiller, remapTranscript, retakeRanges, settleSegments, TimeMap } from '@shared/tighten'
import type { TimeRange, Transcript } from '@shared/types'
import { makeTranscript } from './helpers'

describe('computeKeptSegments', () => {
  it.each(['', 'um', 'different caption'])('caption edit %j cannot change speech cuts', (text) => {
    const transcript = makeTranscript(['first thought ends here', 'important', 'and the point lands'], {
      sentenceGapSec: 1.2, wordSec: 0.8
    })
    const before = computeKeptSegments(transcript, 0, transcript.durationSec)
    const word = transcript.segments[1].words[0]
    word.sourceText = word.text
    word.text = text
    expect(computeKeptSegments(transcript, 0, transcript.durationSec)).toEqual(before)
  })

  it('conservatively preserves timed speech hidden in older projects', () => {
    const transcript = makeTranscript(['first thought ends here', 'important', 'and the point lands'], {
      sentenceGapSec: 1.2, wordSec: 0.8
    })
    const before = computeKeptSegments(transcript, 0, transcript.durationSec)
    transcript.segments[1].words[0].text = ''
    expect(computeKeptSegments(transcript, 0, transcript.durationSec)).toEqual(before)
  })
  it('returns null when there is nothing worth cutting', () => {
    const transcript = makeTranscript(['a steady stream of words with no real pauses'], {
      gapSec: 0.05,
      startSec: 0
    })
    expect(computeKeptSegments(transcript, 0, transcript.durationSec)).toBeNull()
  })

  it('cuts a long pause between sentences', () => {
    const transcript = makeTranscript(['first thought ends here', 'second thought starts'], {
      sentenceGapSec: 3
    })
    const segments = computeKeptSegments(transcript, 0, transcript.durationSec)
    expect(segments).not.toBeNull()
    expect(segments!.length).toBe(2)
    const removed =
      transcript.durationSec - segments!.reduce((sum, s) => sum + (s.end - s.start), 0)
    expect(removed).toBeGreaterThan(1.5)
  })

  it('drops filler words so their span can be removed', () => {
    // "um" sits alone between two long pauses; removing it merges nothing.
    const transcript = makeTranscript(['solid opening words here', 'um', 'and the point lands'], {
      sentenceGapSec: 1.2
    })
    const segments = computeKeptSegments(transcript, 0, transcript.durationSec)
    expect(segments).not.toBeNull()
    // The kept spans must not contain the "um" word's midpoint.
    const um = transcript.segments[1].words[0]
    const mid = (um.start + um.end) / 2
    expect(segments!.some((s) => mid >= s.start && mid <= s.end)).toBe(false)
  })

  it('keeps room for the audio fade after the last word and a beat before the first', () => {
    // A long pause to cut, then the clip runs a full second past the last word.
    const transcript = makeTranscript(['first thought ends here', 'second thought lands'], {
      sentenceGapSec: 3
    })
    const words = transcript.segments.flatMap((s) => s.words)
    const first = words[0]
    const last = words[words.length - 1]
    const clipStart = Math.max(0, first.start - 1)
    const clipEnd = last.end + 1
    const segments = computeKeptSegments(transcript, clipStart, clipEnd)!
    expect(segments[0].start).toBeCloseTo(Math.max(clipStart, first.start - 0.3), 5)
    // 0.7 s of tail: the export's 0.4 s fade sits entirely after the speech.
    expect(segments[segments.length - 1].end).toBeCloseTo(last.end + 0.7, 5)
  })

  it('never extends head or tail room beyond the clip itself', () => {
    const transcript = makeTranscript(['first thought ends here', 'second thought lands'], {
      sentenceGapSec: 3
    })
    const words = transcript.segments.flatMap((s) => s.words)
    const last = words[words.length - 1]
    const segments = computeKeptSegments(transcript, words[0].start + 0.1, last.end + 0.2)!
    expect(segments[0].start).toBeCloseTo(words[0].start + 0.1, 5)
    expect(segments[segments.length - 1].end).toBeCloseTo(last.end + 0.2, 5)
  })

  it('returns null for clips with fewer than three words', () => {
    const transcript = makeTranscript(['hi there'])
    expect(computeKeptSegments(transcript, 0, transcript.durationSec)).toBeNull()
  })

  it('does not machine-gun cut dense filler', () => {
    // A word every ~1.2s with an "um" between each. Cutting every filler would
    // produce one jump cut per word (the reported jitter); the anti-jitter
    // pass must collapse that to at most a couple of clean segments.
    const words = []
    const N = 8
    for (let i = 0; i < N; i++) {
      const base = i * 1.2
      words.push({ text: 'word', start: base, end: base + 0.3 })
      words.push({ text: 'um', start: base + 0.5, end: base + 0.9 })
    }
    const last = words[words.length - 1].end
    const transcript = {
      language: 'english',
      durationSec: last,
      segments: [{ id: 0, text: 'x', start: 0, end: last, words }]
    }
    const kept = computeKeptSegments(transcript, 0, last)
    expect(kept === null || kept.length <= 2).toBe(true)
  })

  it('still cuts a genuine long pause amid filler', () => {
    const words = []
    // Stammer block, then a long silence, then a clean run of speech.
    for (let i = 0; i < 3; i++) {
      const b = i * 1.2
      words.push({ text: 'word', start: b, end: b + 0.3 })
      words.push({ text: 'um', start: b + 0.5, end: b + 0.9 })
    }
    for (let i = 0; i < 4; i++) {
      const b = 6 + i * 0.4
      words.push({ text: 'more', start: b, end: b + 0.3 })
    }
    const last = words[words.length - 1].end
    const transcript = {
      language: 'english',
      durationSec: last,
      segments: [{ id: 0, text: 'x', start: 0, end: last, words }]
    }
    const kept = computeKeptSegments(transcript, 0, last)
    expect(kept).not.toBeNull()
    expect(kept!.length).toBe(2)
  })
})

/** Deterministic pseudo-random numbers (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Word timings built to provoke fragments: bursts of very short words, gaps
 * straddling every threshold, fillers, voice activity that disagrees with
 * the words, and protected stretches landing anywhere.
 */
function adversarial(seed: number): { transcript: Transcript; end: number; protectedRanges: TimeRange[] } {
  const next = random(seed)
  const pick = <T,>(items: T[]): T => items[Math.floor(next() * items.length)]
  const words: Transcript['segments'][number]['words'] = []
  let t = next() * 0.5
  for (let i = 0; i < 60; i++) {
    const length = pick([0.02, 0.05, 0.1, 0.2, 0.35, 0.6])
    // A small vocabulary, so false starts and repeated takes turn up too.
    words.push({ text: next() < 0.2 ? pick(['um', 'uh', 'erm']) : pick(['so', 'the', 'reason', 'we', 'did', 'it', 'sorry', 'so—']), start: t, end: t + length })
    t += length + pick([0.01, 0.1, 0.3, 0.34, 0.36, 0.5, 0.53, 0.7, 0.9, 1.2, 1.5, 1.6, 2.5])
  }
  const end = t + next()
  const speech: TimeRange[] = []
  for (let s = 0; s < end;) {
    const length = 0.1 + next() * 2
    speech.push({ start: s, end: Math.min(end, s + length) })
    s += length + 0.05 + next() * 0.6
  }
  const protectedRanges = Array.from({ length: Math.floor(next() * 3) }, () => {
    const start = next() * end
    return { start, end: start + 0.05 + next() * 1.5 }
  })
  return {
    transcript: { language: 'en', durationSec: end, speech, segments: [{ id: 0, text: '', start: 0, end, words }] },
    end, protectedRanges
  }
}

describe('settleSegments', () => {
  it('fills hairline cuts and drops slivers until nothing changes', () => {
    expect(settleSegments([
      { start: 0, end: 2 }, { start: 2.1, end: 2.2 }, { start: 2.3, end: 4 }, { start: 5, end: 5.1 }, { start: 6, end: 8 }
    ])).toEqual([{ start: 0, end: 4 }, { start: 6, end: 8 }])
  })

  it('never fills a hard removal, and keeps protected slivers', () => {
    const out = settleSegments([{ start: 0, end: 2 }, { start: 2.2, end: 2.3 }, { start: 3, end: 4 }], {
      hard: [{ start: 2, end: 2.2 }], keep: s => s.start === 2.2
    })
    expect(out).toEqual([{ start: 0, end: 2 }, { start: 2.2, end: 2.3 }, { start: 3, end: 4 }])
  })

  it('leaves no fragment whatever the word timings', () => {
    let withRetakes = 0
    for (let seed = 1; seed <= 300; seed++) {
      const { transcript, end, protectedRanges } = adversarial(seed)
      const kept = computeKeptSegments(transcript, 0, end, protectedRanges)
      if (!kept) continue
      const fillers = transcript.segments[0].words.filter(w => isFiller(w.text))
      const retakes = retakeRanges(transcript, 0, end)
      if (retakes.length) withRetakes++
      const isProtected = (r: TimeRange): boolean => protectedRanges.some(p => p.start < r.end && p.end > r.start)
      for (let i = 0; i < kept.length; i++) {
        const piece = kept[i]
        expect(piece.end, `seed ${seed}`).toBeGreaterThan(piece.start)
        if (!isProtected(piece)) expect(piece.end - piece.start, `seed ${seed} piece ${i}`).toBeGreaterThanOrEqual(0.25 - 1e-9)
        if (i === 0) continue
        const gap = { start: kept[i - 1].end, end: piece.start }
        const hard = [...fillers, ...retakes].some(f => f.start < gap.end && f.end > gap.start)
        if (!hard) expect(gap.end - gap.start, `seed ${seed} gap ${i}`).toBeGreaterThanOrEqual(0.35 - 1e-9)
      }
    }
    expect(withRetakes).toBeGreaterThan(30)
  })
})

describe('TimeMap', () => {
  const segments = [
    { start: 10, end: 12 },
    { start: 15, end: 18 }
  ]
  const map = new TimeMap(segments)

  it('computes the compacted duration', () => {
    expect(map.outputDuration).toBe(5)
  })

  it('maps kept times linearly and clamps removed spans', () => {
    expect(map.toOutput(10)).toBe(0)
    expect(map.toOutput(11)).toBe(1)
    expect(map.toOutput(12)).toBe(2)
    expect(map.toOutput(13.5)).toBe(2) // inside the removed gap
    expect(map.toOutput(15)).toBe(2)
    expect(map.toOutput(18)).toBe(5)
    expect(map.toOutput(99)).toBe(5)
    expect(map.toOutput(0)).toBe(0) // before the first kept span
  })

  it('identifies removed spans and the next kept start', () => {
    expect(map.isRemoved(11)).toBe(false)
    expect(map.isRemoved(13)).toBe(true)
    expect(map.nextKeptStart(13)).toBe(15)
    expect(map.nextKeptStart(16)).toBeNull()
    expect(map.nextKeptStart(20)).toBeNull()
  })
})

describe('remapTranscript', () => {
  it('drops words in removed spans and shifts the rest', () => {
    const transcript = makeTranscript(['keep these words', 'cut me', 'keep the ending'], {
      wordSec: 0.5,
      gapSec: 0.1
    })
    const cutSegment = transcript.segments[1]
    const kept = [
      { start: 0, end: cutSegment.start - 0.01 },
      { start: cutSegment.end + 0.01, end: transcript.durationSec }
    ]
    const map = new TimeMap(kept)
    const out = remapTranscript(transcript, map, 0, transcript.durationSec)

    const words = out.segments.flatMap((s) => s.words.map((w) => w.text))
    expect(words).toContain('keep')
    expect(words).toContain('ending')
    expect(words).not.toContain('cut')
    // Remapped times stay within the compacted duration.
    for (const seg of out.segments) {
      for (const w of seg.words) {
        expect(w.start).toBeGreaterThanOrEqual(0)
        expect(w.end).toBeLessThanOrEqual(map.outputDuration + 0.01)
      }
    }
  })
})
