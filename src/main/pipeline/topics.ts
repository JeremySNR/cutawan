import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pruneDirectory } from './analysisCache'
import type { Sentence } from '@shared/sentences'

/**
 * Where the subject changes in a transcript, found without a request:
 * hierarchical TextTiling (Hearst 1997) over sentence embeddings. Each
 * sentence is embedded by a small local model (see sentenceEmbedder.ts); the
 * similarity of the k sentences before each gap to the k after it dips where
 * one topic gives way to the next, and the deepest dips are the boundaries.
 * A second, coarser pass runs the same test over the fine topics themselves.
 *
 * Clip selection uses the boundaries three ways: analysis windows of a long
 * video are stretched to end on one rather than cutting a topic in half, the
 * model sees a separator line where the topic changes, and the join review is
 * told when a join crosses one. All of it is optional; without the model the
 * pipeline runs exactly as before.
 */

/** Bump when the algorithm, its parameters or the embedding model change. */
export const TOPICS_VERSION = 'topics-1'

/** Topic boundaries as line numbers: each is the first line of a new topic. */
export interface TopicBoundaries {
  /** Every boundary found over sentences, ascending. */
  fine: number[]
  /** The subset that also separates the coarser topics, ascending. */
  coarse: number[]
}

/** Turns sentences into vectors; one vector per text, in order. */
export interface SentenceEmbedder {
  /** Identifies the model, for the cache key. */
  readonly id: string
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface TextTilingOptions {
  /** Sentences averaged either side of each gap. */
  window?: number
  /** Half-width of the moving average over gap scores. */
  smoothing?: number
  /** Fewest sentences a topic may hold. */
  minTopic?: number
}

/** Sentences either side of a gap: about half a minute of speech each way. */
const FINE_WINDOW = 6
const FINE_SMOOTHING = 1
/** A topic shorter than this many sentences is a digression, not a topic. */
const FINE_MIN_TOPIC = 8
/** The coarse pass compares this many fine topics either side. */
const COARSE_WINDOW = 2
const COARSE_SMOOTHING = 0
const COARSE_MIN_TOPIC = 2
/**
 * The shallowest valley that can be a boundary, in cosine similarity. The
 * mean + std cut is relative, so on its own it finds "boundaries" in any
 * transcript, a single-subject monologue included; this floor stops the
 * jitter of one topic passing for a change. Measured with all-MiniLM-L6-v2
 * on synthetic talk: changes of subject 0.8 to 1.1 deep, the deepest dip
 * inside one subject 0.3. Real speech drifts more gently than that, so the
 * floor sits well below both.
 */
const MIN_DEPTH = 0.1

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

/** Mean of vectors[from, to). */
function meanVector(vectors: Float32Array[], from: number, to: number): Float32Array {
  const out = new Float32Array(vectors[0].length)
  for (let i = from; i < to; i++) {
    const v = vectors[i]
    for (let d = 0; d < out.length; d++) out[d] += v[d]
  }
  const n = Math.max(1, to - from)
  for (let d = 0; d < out.length; d++) out[d] /= n
  return out
}

/**
 * Similarity across each gap: gap i (1 ≤ i < n) sits before vector i, and
 * scores the cosine of the mean of up to `k` vectors before it with the mean
 * of up to `k` after it. Index 0 is unused (NaN). Exported for tests.
 */
export function gapScores(vectors: Float32Array[], k: number): number[] {
  const n = vectors.length
  const scores = new Array<number>(n).fill(Number.NaN)
  for (let i = 1; i < n; i++) {
    scores[i] = cosine(meanVector(vectors, Math.max(0, i - k), i), meanVector(vectors, i, Math.min(n, i + k)))
  }
  return scores
}

/** Moving average of gap scores 1..n-1 with half-width `w` (index 0 stays NaN). Exported for tests. */
export function smoothScores(scores: number[], w: number): number[] {
  const out = [...scores]
  for (let i = 1; i < scores.length; i++) {
    let sum = 0, count = 0
    for (let j = Math.max(1, i - w); j <= Math.min(scores.length - 1, i + w); j++) {
      sum += scores[j]
      count++
    }
    out[i] = sum / count
  }
  return out
}

/**
 * TextTiling depth of each gap: how far the score climbs to the nearest peak
 * on its left plus how far it climbs to the nearest peak on its right. A gap
 * in the middle of a topic sits on a plateau and scores near zero; a gap
 * between two topics sits in a valley. Index 0 is 0. Exported for tests.
 */
export function depthScores(scores: number[]): number[] {
  const n = scores.length
  const depth = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    let left = scores[i]
    for (let j = i - 1; j >= 1 && scores[j] >= left; j--) left = scores[j]
    let right = scores[i]
    for (let j = i + 1; j < n && scores[j] >= right; j++) right = scores[j]
    depth[i] = (left - scores[i]) + (right - scores[i])
  }
  return depth
}

/**
 * Boundaries in a sequence of vectors, as the indices of the vectors that
 * open a new topic: gaps whose depth is above both mean + one standard
 * deviation of all depths and MIN_DEPTH, and is a local maximum (each settled
 * on the lowest raw score within the smoothing width), taken deepest first
 * while each topic keeps at least `minTopic` vectors. Too short a sequence
 * has no boundaries.
 * Pure. Exported for tests.
 */
export function textTilingBoundaries(vectors: Float32Array[], opts: TextTilingOptions = {}): number[] {
  const k = opts.window ?? FINE_WINDOW
  const smoothing = opts.smoothing ?? FINE_SMOOTHING
  const minTopic = Math.max(1, opts.minTopic ?? FINE_MIN_TOPIC)
  const n = vectors.length
  if (n < 2 * minTopic || n < 2 * k || vectors.some((v) => v.length !== vectors[0].length)) return []
  const raw = gapScores(vectors, k)
  const scores = smoothScores(raw, smoothing)
  const depth = depthScores(scores)
  const gaps = depth.slice(1)
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const std = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length)
  const cutoff = mean + std
  const candidates: number[] = []
  const depthAt = new Map<number, number>()
  for (let i = 1; i < n; i++) {
    // A plateau of equal depths keeps its first gap only.
    const localMax = depth[i] >= (depth[i + 1] ?? -Infinity) && depth[i] > (depth[i - 1] ?? -Infinity)
    if (!(depth[i] > cutoff && depth[i] >= MIN_DEPTH && localMax)) continue
    // Smoothing finds the valley but blurs where its floor is: settle on the
    // lowest unsmoothed score within the smoothing width.
    let best = i
    for (let j = Math.max(1, i - smoothing); j <= Math.min(n - 1, i + smoothing); j++) if (raw[j] < raw[best]) best = j
    if (!candidates.includes(best)) candidates.push(best)
    depthAt.set(best, Math.max(depthAt.get(best) ?? 0, depth[i]))
  }
  candidates.sort((a, b) => (depthAt.get(b) ?? 0) - (depthAt.get(a) ?? 0) || a - b)
  const chosen: number[] = []
  for (const i of candidates) {
    if (i < minTopic || n - i < minTopic) continue
    if (chosen.some((c) => Math.abs(c - i) < minTopic)) continue
    chosen.push(i)
  }
  return chosen.sort((a, b) => a - b)
}

/**
 * Both levels: fine boundaries over the sentences, then coarse boundaries
 * found by tiling the fine topics (each one's mean vector) and mapped back to
 * the sentence that opens each coarse topic. Returns line numbers (the
 * sentences' `index`). Pure. Exported for tests.
 */
export function hierarchicalTopics(sentences: Sentence[], vectors: Float32Array[]): TopicBoundaries {
  if (sentences.length !== vectors.length) return { fine: [], coarse: [] }
  const fineAt = textTilingBoundaries(vectors)
  const starts = [0, ...fineAt]
  const segmentVectors = starts.map((from, i) => meanVector(vectors, from, starts[i + 1] ?? vectors.length))
  const coarseAt = textTilingBoundaries(segmentVectors, { window: COARSE_WINDOW, smoothing: COARSE_SMOOTHING, minTopic: COARSE_MIN_TOPIC })
  return {
    fine: fineAt.map((i) => sentences[i].index),
    coarse: coarseAt.map((segment) => sentences[starts[segment]].index)
  }
}

/** A cached boundary file larger than this is not read (a two-hour transcript's is a few KB). */
const MAX_CACHE_BYTES = 1024 * 1024
/** Topic files kept per project (one per transcript and embedding model). */
const TOPICS_CACHE_ENTRIES = 8

/**
 * The cache key: boundaries depend on the sentence texts, their count, the
 * embedding model and the algorithm, and on nothing chosen per run. Exported
 * for tests.
 */
export function topicsCacheKey(sentences: Sentence[], embedderId: string): string {
  const hash = createHash('sha256').update(JSON.stringify({ version: TOPICS_VERSION, embedderId, lineCount: sentences.length }))
  for (const s of sentences) hash.update(JSON.stringify(s.text))
  return hash.digest('hex')
}

/** A stored boundary list, checked again before use. Exported for tests. */
export function validateTopics(value: unknown, lineCount: number): TopicBoundaries | null {
  if (typeof value !== 'object' || value === null) return null
  const { fine, coarse } = value as Record<string, unknown>
  const ascending = (list: unknown): list is number[] => Array.isArray(list) &&
    list.every((v, i) => Number.isInteger(v) && v > 0 && v < lineCount && (i === 0 || v > list[i - 1]))
  if (!ascending(fine) || !ascending(coarse)) return null
  if (!coarse.every((c) => fine.includes(c))) return null
  return { fine, coarse }
}

async function readCachedTopics(path: string, key: string, lineCount: number, signal?: AbortSignal): Promise<TopicBoundaries | null> {
  try {
    if ((await stat(path)).size > MAX_CACHE_BYTES) return null
    const cached: unknown = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
    if (typeof cached !== 'object' || cached === null || (cached as { key?: unknown }).key !== key) return null
    return validateTopics((cached as { topics?: unknown }).topics, lineCount)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function writeCachedTopics(dir: string, path: string, key: string, topics: TopicBoundaries, signal?: AbortSignal): Promise<void> {
  // Written beside the target and renamed over it, so a crash mid-write
  // never leaves a half file behind.
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temporary, JSON.stringify({ key, topics }), { signal })
    signal?.throwIfAborted()
    await rename(temporary, path)
    // The outline cache prunes only its own files; these would otherwise
    // pile up with every transcript edit or embedding model change.
    await pruneDirectory(dir, { maxEntries: TOPICS_CACHE_ENTRIES, match: name => name.startsWith('topics-') })
  } catch (err) {
    signal?.throwIfAborted()
    // A cache that cannot be written costs the next run an embedding pass, nothing more.
    console.error('Could not save the topic boundary cache:', err)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Sentences embedded per call; keeps each inference request small. */
const EMBED_BATCH = 32

export interface DetectTopicsOptions {
  sentences: Sentence[]
  /** Null or absent: no model, so no boundaries. */
  embedder: SentenceEmbedder | null | undefined
  /** Where to keep the boundaries between runs; no caching without it. */
  cacheDir?: string
  signal?: AbortSignal
}

/**
 * Topic boundaries for a transcript, from the cache when a valid entry is
 * there, otherwise by embedding every sentence. Null when there is no
 * embedder or embedding fails: topic boundaries refine clip selection, they
 * are never worth failing it for. Cancellation propagates.
 */
export async function detectTopics(opts: DetectTopicsOptions): Promise<TopicBoundaries | null> {
  const { sentences, embedder, signal } = opts
  if (!embedder || sentences.length < 2 * FINE_MIN_TOPIC) return null
  const key = topicsCacheKey(sentences, embedder.id)
  const cachePath = opts.cacheDir ? join(opts.cacheDir, `topics-${key}.json`) : null
  if (cachePath) {
    const cached = await readCachedTopics(cachePath, key, sentences.length, signal)
    if (cached) return cached
  }
  let topics: TopicBoundaries
  try {
    const vectors: Float32Array[] = []
    for (let i = 0; i < sentences.length; i += EMBED_BATCH) {
      signal?.throwIfAborted()
      const batch = sentences.slice(i, i + EMBED_BATCH).map((s) => s.text)
      const embedded = await embedder.embed(batch, signal)
      if (embedded.length !== batch.length) throw new Error(`The embedder returned ${embedded.length} vectors for ${batch.length} sentences.`)
      vectors.push(...embedded)
    }
    topics = hierarchicalTopics(sentences, vectors)
  } catch (err) {
    signal?.throwIfAborted()
    console.error('Topic detection failed; clips are chosen without topic boundaries:', err)
    return null
  }
  if (process.env.CUTAWAN_DEBUG) console.error(`[topics] ${topics.fine.length} fine, ${topics.coarse.length} coarse boundaries:`, JSON.stringify(topics))
  if (opts.cacheDir && cachePath) await writeCachedTopics(opts.cacheDir, cachePath, key, topics, signal)
  return topics
}
