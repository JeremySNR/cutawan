import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  depthScores,
  detectTopics,
  gapScores,
  hierarchicalTopics,
  smoothScores,
  textTilingBoundaries,
  topicsCacheKey,
  validateTopics,
  type SentenceEmbedder
} from '../src/main/pipeline/topics'
import { transcriptSentences } from '@shared/sentences'
import { makeTranscript } from './helpers'

/** A deterministic pseudo-random generator, so the synthetic noise is the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const DIM = 16

/**
 * Synthetic sentence embeddings: each topic has its own direction, each
 * sentence is that direction plus noise, the way real sentences on one
 * subject share most of their meaning and differ in the rest.
 */
function topicVectors(lengths: number[], noise = 0.6, seed = 7): Float32Array[] {
  const random = rng(seed)
  const out: Float32Array[] = []
  lengths.forEach((length, topic) => {
    for (let i = 0; i < length; i++) {
      const v = new Float32Array(DIM)
      for (let d = 0; d < DIM; d++) v[d] = (random() - 0.5) * noise
      v[topic % DIM] += 1
      out.push(v)
    }
  })
  return out
}

describe('TextTiling scores', () => {
  it('scores similarity across each gap from the windows either side', () => {
    const vectors = topicVectors([10, 10], 0)
    const scores = gapScores(vectors, 3)
    expect(Number.isNaN(scores[0])).toBe(true)
    expect(scores[5]).toBeCloseTo(1, 5)
    expect(scores[10]).toBeCloseTo(0, 5)
    // A window that straddles the change is partly similar.
    expect(scores[9]).toBeGreaterThan(0)
    expect(scores[9]).toBeLessThan(1)
  })

  it('smooths with a moving average and leaves index 0 alone', () => {
    const smoothed = smoothScores([Number.NaN, 1, 0, 1, 1], 1)
    expect(Number.isNaN(smoothed[0])).toBe(true)
    expect(smoothed[1]).toBeCloseTo(0.5)
    expect(smoothed[2]).toBeCloseTo(2 / 3)
    expect(smoothed[4]).toBeCloseTo(1)
  })

  it('measures depth as the climb to the nearest peak on each side', () => {
    const depth = depthScores([Number.NaN, 0.9, 0.8, 0.3, 0.7, 0.6, 0.95])
    // Gap 3: climbs to 0.9 on the left and 0.7 on the right.
    expect(depth[3]).toBeCloseTo(0.6 + 0.4)
    expect(depth[1]).toBeCloseTo(0)
    expect(depth[5]).toBeCloseTo(0.1 + 0.35)
  })
})

describe('textTilingBoundaries', () => {
  it('finds where one topic gives way to the next in noisy embeddings', () => {
    const vectors = topicVectors([30, 25, 40, 20])
    expect(textTilingBoundaries(vectors)).toEqual([30, 55, 95])
  })

  it('finds nothing in one coherent topic, where every dip is shallow', () => {
    // The relative cut alone would still pick the deepest jitter.
    expect(textTilingBoundaries(topicVectors([120], 0.3))).toEqual([])
  })

  it('needs enough sentences, and vectors of one size', () => {
    expect(textTilingBoundaries(topicVectors([5, 5]))).toEqual([])
    const vectors = topicVectors([30, 30])
    vectors[3] = new Float32Array(DIM + 1)
    expect(textTilingBoundaries(vectors)).toEqual([])
  })

  it('keeps every topic at least the minimum length, keeping the deeper boundary', () => {
    // A three-sentence digression is not a topic of its own.
    const vectors = topicVectors([30, 3, 30])
    const found = textTilingBoundaries(vectors)
    expect(found.length).toBeLessThanOrEqual(1)
    for (let i = 1; i < found.length; i++) expect(found[i] - found[i - 1]).toBeGreaterThanOrEqual(8)
    for (const b of found) expect(Math.min(b, vectors.length - b)).toBeGreaterThanOrEqual(8)
  })
})

describe('hierarchicalTopics', () => {
  const lengths = [20, 20, 20, 20, 20, 20, 20, 20]

  it('returns fine boundaries over sentences as line numbers, and coarse ones among them', () => {
    // Pairs of fine topics share a direction partly, so they group into coarse topics.
    const random = rng(3)
    const vectors: Float32Array[] = []
    lengths.forEach((length, topic) => {
      for (let i = 0; i < length; i++) {
        const v = new Float32Array(DIM)
        for (let d = 0; d < DIM; d++) v[d] = (random() - 0.5) * 0.4
        v[topic] += 1
        v[8 + Math.floor(topic / 4)] += 1.6
        out(v)
      }
    })
    function out(v: Float32Array): void { vectors.push(v) }
    const transcript = makeTranscript(Array.from({ length: vectors.length }, (_, i) => `line ${i} here.`))
    // Offset line numbers: the result speaks in each sentence's index.
    const sentences = transcriptSentences(transcript).map((s) => ({ ...s, index: s.index + 1000 }))
    const topics = hierarchicalTopics(sentences, vectors)
    expect(topics.fine).toEqual([1020, 1040, 1060, 1080, 1100, 1120, 1140])
    expect(topics.coarse).toEqual([1080])
    for (const c of topics.coarse) expect(topics.fine).toContain(c)
  })

  it('returns nothing when the vectors do not match the sentences', () => {
    const sentences = transcriptSentences(makeTranscript(['One here.', 'Two here.']))
    expect(hierarchicalTopics(sentences, topicVectors([1]))).toEqual({ fine: [], coarse: [] })
  })
})

describe('validateTopics', () => {
  it('accepts ascending line numbers inside the transcript, coarse among fine', () => {
    expect(validateTopics({ fine: [3, 9], coarse: [9] }, 12)).toEqual({ fine: [3, 9], coarse: [9] })
  })

  it('refuses anything else', () => {
    expect(validateTopics({ fine: [9, 3], coarse: [] }, 12)).toBeNull()
    expect(validateTopics({ fine: [0, 3], coarse: [] }, 12)).toBeNull()
    expect(validateTopics({ fine: [3, 12], coarse: [] }, 12)).toBeNull()
    expect(validateTopics({ fine: [3], coarse: [4] }, 12)).toBeNull()
    expect(validateTopics({ fine: [3.5], coarse: [] }, 12)).toBeNull()
    expect(validateTopics(null, 12)).toBeNull()
  })
})

describe('detectTopics', () => {
  const transcript = makeTranscript(Array.from({ length: 60 }, (_, i) => `topic ${Math.floor(i / 20)} sentence ${i} here.`))
  const sentences = transcriptSentences(transcript)
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  /** Embeds "topic N …" along direction N, counting what it was asked. */
  function fakeEmbedder(): SentenceEmbedder & { calls: number; texts: number } {
    const random = rng(11)
    const embedder = {
      id: 'fake-1',
      calls: 0,
      texts: 0,
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedder.calls++
        embedder.texts += texts.length
        return texts.map((t) => {
          const v = new Float32Array(DIM)
          for (let d = 0; d < DIM; d++) v[d] = (random() - 0.5) * 0.4
          v[Number(t.match(/topic (\d+)/)?.[1] ?? 0)] += 1
          return v
        })
      }
    }
    return embedder
  }

  it('embeds every sentence in small batches and finds the topic changes', async () => {
    const embedder = fakeEmbedder()
    const topics = await detectTopics({ sentences, embedder })
    expect(topics?.fine).toEqual([20, 40])
    expect(embedder.texts).toBe(60)
    expect(embedder.calls).toBe(2)
  })

  it('caches the boundaries and reuses them without embedding again', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-topics-'))
    const first = fakeEmbedder()
    const topics = await detectTopics({ sentences, embedder: first, cacheDir: dir })
    expect(await readdir(dir)).toEqual([`topics-${topicsCacheKey(sentences, 'fake-1')}.json`])
    const second = fakeEmbedder()
    expect(await detectTopics({ sentences, embedder: second, cacheDir: dir })).toEqual(topics)
    expect(second.calls).toBe(0)
    // Another model, or other sentences, is another key.
    expect(topicsCacheKey(sentences, 'fake-2')).not.toBe(topicsCacheKey(sentences, 'fake-1'))
    expect(topicsCacheKey(sentences.slice(1), 'fake-1')).not.toBe(topicsCacheKey(sentences, 'fake-1'))
  })

  it('prunes old topic files but leaves the outline cache alone', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-topics-'))
    const old = new Date(Date.now() - 86_400_000)
    for (let i = 0; i < 12; i++) {
      await writeFile(join(dir, `topics-old${i}.json`), '{}')
      await utimes(join(dir, `topics-old${i}.json`), old, old)
    }
    await writeFile(join(dir, 'outline-a.json'), '{}')
    await detectTopics({ sentences, embedder: fakeEmbedder(), cacheDir: dir })
    const names = await readdir(dir)
    expect(names.filter((n) => n.startsWith('topics-'))).toHaveLength(8)
    expect(names).toContain(`topics-${topicsCacheKey(sentences, 'fake-1')}.json`)
    expect(names).toContain('outline-a.json')
  })

  it('ignores a damaged cache file and rebuilds it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-topics-'))
    await writeFile(join(dir, `topics-${topicsCacheKey(sentences, 'fake-1')}.json`), '{"key": "nope"')
    const embedder = fakeEmbedder()
    expect((await detectTopics({ sentences, embedder, cacheDir: dir }))?.fine).toEqual([20, 40])
    expect(embedder.calls).toBe(2)
  })

  it('returns null without an embedder, for a short transcript, or when embedding fails', async () => {
    expect(await detectTopics({ sentences, embedder: null })).toBeNull()
    expect(await detectTopics({ sentences: sentences.slice(0, 10), embedder: fakeEmbedder() })).toBeNull()
    const failing: SentenceEmbedder = { id: 'x', embed: async () => { throw new Error('model broke') } }
    expect(await detectTopics({ sentences, embedder: failing })).toBeNull()
    const short: SentenceEmbedder = { id: 'x', embed: async (texts) => texts.slice(1).map(() => new Float32Array(DIM)) }
    expect(await detectTopics({ sentences, embedder: short })).toBeNull()
  })

  it('still stops when the run is cancelled', async () => {
    const controller = new AbortController()
    const embedder: SentenceEmbedder = {
      id: 'x',
      embed: async (texts) => {
        controller.abort()
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        return texts.map(() => new Float32Array(DIM))
      }
    }
    await expect(detectTopics({ sentences, embedder, signal: controller.signal })).rejects.toThrow()
  })
})
