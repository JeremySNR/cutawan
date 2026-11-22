import { describe, expect, it } from 'vitest'
import type { SpeakerTurn, TranscriptWord } from '@shared/types'
import {
  DEFAULT_CLUSTER, agglomerate, alignTurnsToWords, clusterSpeakers, labelTimeline, mergeAdjacent, planWindows, renumber, smoothTurns
} from '../src/main/pipeline/speakerTurns'

/** Deterministic Gaussian-ish vectors around `centres`, so clustering tests never flake. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

function unit(dim: number, random: () => number): Float32Array {
  const v = Float32Array.from({ length: dim }, () => random() * 2 - 1)
  const n = Math.hypot(...v)
  return v.map(x => x / n)
}

/** Embeddings near a centre with cosine distance ~`spread` to it. */
function near(centre: Float32Array, spread: number, random: () => number): Float32Array {
  const noise = unit(centre.length, random)
  return centre.map((c, k) => c * (1 - spread) + noise[k] * spread * 1.2)
}

const DIM = 64

describe('planWindows', () => {
  it('tiles each speech region with 1.5 s windows every 0.75 s, the last aligned to the end', () => {
    const windows = planWindows([{ start: 0, end: 4.2 }, { start: 10, end: 11 }, { start: 20, end: 20.3 }])
    expect(windows.filter(w => w.end <= 4.2).map(w => [w.start, w.end])).toEqual([[0, 1.5], [0.75, 2.25], [1.5, 3], [2.25, 3.75], [2.7, 4.2]])
    // A remainder under a third of a hop is left to the last window's label.
    expect(planWindows([{ start: 0, end: 4 }]).map(w => w.end)).toEqual([1.5, 2.25, 3, 3.75])
    expect(windows).toContainEqual({ start: 10, end: 11 }) // a short region is one window
    expect(windows.some(w => w.start >= 20)).toBe(false) // too short to embed
  })
})

describe('agglomerate', () => {
  it('separates well-spread clusters and cuts at the threshold', () => {
    const random = rng(3)
    const a = unit(DIM, random), b = unit(DIM, random), c = unit(DIM, random)
    const data = [...Array(10)].flatMap(() => [near(a, 0.2, random), near(b, 0.2, random), near(c, 0.2, random)])
    const labels = agglomerate(data, 0.6)
    expect(new Set(labels).size).toBe(3)
    for (let i = 3; i < data.length; i++) expect(labels[i]).toBe(labels[i % 3])
    expect(new Set(agglomerate(data, 1.5)).size).toBe(1)
    expect(new Set(agglomerate(data, 0.01)).size).toBe(data.length)
  })

  it('handles the trivial cases', () => {
    expect(agglomerate([], 0.5)).toEqual([])
    expect(agglomerate([new Float32Array([1, 0])], 0.5)).toEqual([0])
  })
})

describe('clusterSpeakers', () => {
  it('numbers voices by first appearance', () => {
    const random = rng(5)
    const a = unit(DIM, random), b = unit(DIM, random)
    const data = [...Array(8)].map(() => near(b, 0.2, random)).concat([...Array(8)].map(() => near(a, 0.2, random)))
    const labels = clusterSpeakers(data)
    expect(labels.slice(0, 8)).toEqual(Array(8).fill(0))
    expect(labels.slice(8)).toEqual(Array(8).fill(1))
  })

  it('folds a cluster too small to be a voice into its nearest voice', () => {
    const random = rng(7)
    const a = unit(DIM, random), b = unit(DIM, random), cough = unit(DIM, random)
    const data = [...Array(10)].map(() => near(a, 0.2, random))
      .concat([near(cough, 0.1, random), near(cough, 0.1, random)])
      .concat([...Array(10)].map(() => near(b, 0.2, random)))
    const labels = clusterSpeakers(data)
    expect(new Set(labels).size).toBe(2)
  })

  it('returns one voice for one speaker', () => {
    const random = rng(9)
    const a = unit(DIM, random)
    expect(new Set(clusterSpeakers([...Array(40)].map(() => near(a, 0.3, random))))).toEqual(new Set([0]))
  })

  it('clusters a subsample of a long source and assigns the rest to the nearest voice', () => {
    const random = rng(11)
    const a = unit(DIM, random), b = unit(DIM, random)
    const isB = (i: number): boolean => i % 7 < 2
    const data = [...Array(300)].map((_, i) => near(isB(i) ? b : a, 0.2, random))
    const labels = clusterSpeakers(data, { ...DEFAULT_CLUSTER, maxClustered: 50 })
    expect(labels.every((l, i) => l === (isB(i) ? 0 : 1))).toBe(true)
  })

  it('merges near-twin centroids', () => {
    const random = rng(13)
    const a = unit(DIM, random)
    const twin = near(a, 0.3, random) // cosine similarity ~0.9 to a
    const data = [...Array(10)].map(() => near(a, 0.05, random)).concat([...Array(10)].map(() => near(twin, 0.05, random)))
    // Tight clusters cut apart at 0.05, then merged by centroid similarity.
    expect(new Set(clusterSpeakers(data, { ...DEFAULT_CLUSTER, threshold: 0.05, mergeSimilarity: 0.8 })).size).toBe(1)
    expect(new Set(clusterSpeakers(data, { ...DEFAULT_CLUSTER, threshold: 0.05, mergeSimilarity: 0.999 })).size).toBe(2)
  })
})

describe('turn smoothing', () => {
  it('absorbs flips shorter than a second into the longer neighbour', () => {
    const turns: SpeakerTurn[] = [
      { start: 0, end: 5, speaker: 0 }, { start: 5, end: 5.6, speaker: 1 }, { start: 5.6, end: 9, speaker: 0 },
      { start: 9, end: 14, speaker: 1 }, { start: 14, end: 14.4, speaker: 0 }, { start: 14.4, end: 15, speaker: 2 }
    ]
    expect(smoothTurns(turns, 1)).toEqual([{ start: 0, end: 9, speaker: 0 }, { start: 9, end: 15, speaker: 1 }])
  })

  it('keeps a short turn that has no neighbour within reach', () => {
    const turns: SpeakerTurn[] = [{ start: 0, end: 5, speaker: 0 }, { start: 9, end: 9.5, speaker: 1 }]
    expect(smoothTurns(turns, 1)).toEqual(turns)
  })

  it('joins same-speaker pieces across short pauses only', () => {
    expect(mergeAdjacent([{ start: 0, end: 2, speaker: 0 }, { start: 3, end: 4, speaker: 0 }, { start: 7, end: 8, speaker: 0 }], 2))
      .toEqual([{ start: 0, end: 4, speaker: 0 }, { start: 7, end: 8, speaker: 0 }])
  })

  it('renumbers by first appearance', () => {
    expect(renumber([3, 3, 1, 3, 0, 1])).toEqual([0, 0, 1, 0, 2, 1])
  })
})

describe('labelTimeline and word alignment', () => {
  const speech = [{ start: 0, end: 6 }, { start: 6.4, end: 12 }]
  const windows = planWindows(speech)
  // Speaker A for the first region, B for the second.
  const labels = windows.map(w => (w.start < 6.2 ? 0 : 1))

  it('gives each window the middle of its span and reaches region edges', () => {
    expect(labelTimeline(windows, labels, speech)).toEqual([{ start: 0, end: 6, speaker: 0 }, { start: 6.4, end: 12, speaker: 1 }])
  })

  it('puts turn boundaries between words and drops one-voice results', () => {
    const words: TranscriptWord[] = []
    for (let t = 0.1; t < 11.6; t += 0.5) words.push({ text: 'w', start: t, end: t + 0.35 })
    // A timeline whose boundary falls inside the word at 6.1–6.45.
    const timeline: SpeakerTurn[] = [{ start: 0, end: 6.3, speaker: 4 }, { start: 6.3, end: 12, speaker: 2 }]
    const turns = alignTurnsToWords(timeline, words)
    expect(turns.map(t => t.speaker)).toEqual([0, 1])
    // The first turn ends exactly where a word ends (the one the timeline cut through).
    expect(words.some(w => Math.abs(w.end - turns[0].end) < 1e-6 && w.start < 6.3 && w.end > 6.3)).toBe(true)
    expect(turns[1].start).toBeGreaterThanOrEqual(turns[0].end)
    expect(words.some(w => w.start < turns[0].end && w.end > turns[1].start)).toBe(false)
    expect(alignTurnsToWords([{ start: 0, end: 12, speaker: 3 }], words)).toEqual([])
  })

  it('uses the timeline as is when there are no words', () => {
    expect(alignTurnsToWords([{ start: 0, end: 6, speaker: 1 }, { start: 6.4, end: 12, speaker: 0 }], []))
      .toEqual([{ start: 0, end: 6, speaker: 0 }, { start: 6.4, end: 12, speaker: 1 }])
  })
})
