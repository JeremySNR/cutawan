import type { SpeakerTurn, SpeechRegion, TranscriptWord } from '@shared/types'

/**
 * Speaker diarization maths: where to take embedding windows, how to cluster
 * the embeddings into voices, and how to turn per-window labels into clean
 * speaker turns on word boundaries. Pure, so it is unit-tested on synthetic
 * embeddings; `diarize.ts` runs the model.
 */

/** 1.5 s windows every 0.75 s: long enough for a stable voice print, short enough to follow a quick exchange. */
export const WINDOW_SEC = 1.5
export const HOP_SEC = 0.75
/** Speech regions shorter than this give no reliable voice print and are labelled from their neighbours. */
export const MIN_WINDOW_SEC = 0.6

export interface EmbeddingWindow { start: number; end: number }

/** Embedding windows over voice activity, the last one in each region aligned to its end. */
export function planWindows(speech: SpeechRegion[], windowSec = WINDOW_SEC, hopSec = HOP_SEC, minSec = MIN_WINDOW_SEC): EmbeddingWindow[] {
  const windows: EmbeddingWindow[] = []
  for (const region of speech) {
    const length = region.end - region.start
    if (length < minSec) continue
    if (length <= windowSec) { windows.push({ start: region.start, end: region.end }); continue }
    let start = region.start
    for (; start + windowSec <= region.end; start += hopSec) windows.push({ start, end: start + windowSec })
    const last = windows[windows.length - 1]
    if (region.end - last.end > hopSec / 3) windows.push({ start: region.end - windowSec, end: region.end })
  }
  return windows.map(w => ({ start: round3(w.start), end: round3(w.end) }))
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000

export function l2normalize(v: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  return v.map(x => x / norm)
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na * nb) || 1)
}

/**
 * Average-linkage agglomerative clustering on cosine distance, cut where the
 * closest pair of clusters is farther apart than `threshold`. Uses the
 * nearest-neighbour chain algorithm (O(n²) time and memory): with the
 * Lance–Williams update average linkage is reducible, so the chain finds
 * the same dendrogram as the naive O(n³) loop, just not in height order —
 * merges are replayed sorted by height and stopped at the threshold.
 */
export function agglomerate(embeddings: Float32Array[], threshold: number): number[] {
  const n = embeddings.length
  if (n === 0) return []
  if (n === 1) return [0]
  const unit = embeddings.map(l2normalize)
  const dist = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dot = 0
      const a = unit[i], b = unit[j]
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k]
      dist[i * n + j] = dist[j * n + i] = 1 - dot
    }
  }
  const size = new Float64Array(n).fill(1)
  const active = new Uint8Array(n).fill(1)
  let remaining = n
  const merges: Array<{ a: number; b: number; height: number }> = []
  const chain: number[] = []
  while (remaining > 1) {
    if (!chain.length) chain.push(active.indexOf(1))
    const a = chain[chain.length - 1]
    const previous = chain.length > 1 ? chain[chain.length - 2] : -1
    let best = previous, bestD = previous >= 0 ? dist[a * n + previous] : Infinity
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === a) continue
      const d = dist[a * n + c]
      if (d < bestD) { best = c; bestD = d }
    }
    if (best !== previous) { chain.push(best); continue }
    chain.pop(); chain.pop()
    merges.push({ a, b: best, height: bestD })
    // Merge `best` into `a`: average linkage via Lance–Williams.
    const na = size[a], nb = size[best]
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === best) continue
      const d = (na * dist[a * n + k] + nb * dist[best * n + k]) / (na + nb)
      dist[a * n + k] = dist[k * n + a] = d
    }
    size[a] = na + nb
    active[best] = 0
    remaining--
  }
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (const merge of merges.sort((x, y) => x.height - y.height)) {
    if (merge.height > threshold) break
    parent[find(merge.b)] = find(merge.a)
  }
  const ids = new Map<number, number>()
  return Array.from({ length: n }, (_, i) => {
    const root = find(i)
    if (!ids.has(root)) ids.set(root, ids.size)
    return ids.get(root)!
  })
}

export interface ClusterOptions {
  /** Average-linkage cut, cosine distance. */
  threshold: number
  /** Clusters smaller than this are not voices of their own (a laugh, a cough, music) and join their nearest voice. */
  minClusterSize: number
  /** Voices whose centroids are closer than this (cosine similarity) are one person heard twice. */
  mergeSimilarity: number
  /** Above this many windows, cluster an even subsample and assign the rest to the nearest centroid. */
  maxClustered: number
}

/**
 * Thresholds for the CAM++ VoxCeleb embeddings (512-d). The cut and merge
 * values are 3D-Speaker's own for this model family (its AHCluster cuts
 * average linkage at cosine similarity 0.4, i.e. distance 0.6; its
 * clustering merges centroids above 0.8 similarity and drops clusters under
 * 4 embeddings).
 *
 * Measured with scripts/calibrate-diarization.ts on synthesized dialogue
 * (espeak-ng voices, 1.5 s windows): same-voice window distances p50
 * 0.28–0.36, p99 0.46–0.63 (with noise, a music bed and echo); a male and a
 * female voice p1 0.56–0.59, p50 0.70–0.75 — two voices, 0% frame error, and
 * one voice stays one at every setting tried. Three or four voices merge the
 * espeak male variants at 0.6 (their cross distance is p50 ~0.55, closer
 * than distinct people: the same formant synthesizer with small tweaks) and
 * separate perfectly at 0.5 — but a single synthetic voice already reaches
 * 0.49 at p99, and real speakers vary more than espeak, so 0.5 would split
 * real people. Merging two people only loses turns (clip selection falls
 * back to no speaker info); splitting one invents a speaker, so we keep the
 * published 0.6.
 */
export const DEFAULT_CLUSTER: ClusterOptions = {
  threshold: 0.6,
  minClusterSize: 5,
  mergeSimilarity: 0.8,
  maxClustered: 1500
}

function centroid(embeddings: Float32Array[], members: number[]): Float32Array {
  const c = new Float32Array(embeddings[0].length)
  for (const m of members) { const e = l2normalize(embeddings[m]); for (let k = 0; k < c.length; k++) c[k] += e[k] }
  return l2normalize(c)
}

/**
 * Speaker label per embedding, numbered by first appearance. Clusters too
 * small to be a voice are folded into the nearest real one, and near-twin
 * voices merged, so a single speaker comes back as all zeros.
 */
export function clusterSpeakers(embeddings: Float32Array[], options: ClusterOptions = DEFAULT_CLUSTER): number[] {
  const n = embeddings.length
  if (n === 0) return []
  let sample: number[] = Array.from({ length: n }, (_, i) => i)
  if (n > options.maxClustered) {
    const step = n / options.maxClustered
    sample = Array.from({ length: options.maxClustered }, (_, i) => Math.floor(i * step))
  }
  const sampleLabels = agglomerate(sample.map(i => embeddings[i]), options.threshold)
  const groups = new Map<number, number[]>()
  sampleLabels.forEach((label, k) => { const g = groups.get(label) ?? []; g.push(sample[k]); groups.set(label, g) })
  // Scale the size floor with subsampling so it means the same share of speech.
  const minSize = Math.max(1, Math.round(options.minClusterSize * sample.length / n))
  let centroids = [...groups.values()].filter(g => g.length >= minSize).map(g => centroid(embeddings, g))
  if (!centroids.length) return new Array<number>(n).fill(0)

  // Merge near-twin centroids (greedy, closest pair first).
  for (;;) {
    let bi = -1, bj = -1, best = options.mergeSimilarity
    for (let i = 0; i < centroids.length; i++) {
      for (let j = i + 1; j < centroids.length; j++) {
        const s = cosine(centroids[i], centroids[j])
        if (s > best) { best = s; bi = i; bj = j }
      }
    }
    if (bi < 0) break
    const merged = new Float32Array(centroids[bi].length)
    for (let k = 0; k < merged.length; k++) merged[k] = centroids[bi][k] + centroids[bj][k]
    centroids = centroids.filter((_, k) => k !== bi && k !== bj).concat([l2normalize(merged)])
  }

  // Everything (small clusters and unsampled windows included) joins its nearest voice.
  const raw = embeddings.map(e => {
    let best = 0, bestS = -Infinity
    centroids.forEach((c, k) => { const s = cosine(e, c); if (s > bestS) { bestS = s; best = k } })
    return best
  })
  return renumber(raw)
}

/** Relabel so speakers count up from 0 in order of first appearance. */
export function renumber(labels: number[]): number[] {
  const ids = new Map<number, number>()
  return labels.map(l => { if (!ids.has(l)) ids.set(l, ids.size); return ids.get(l)! })
}

/** A speaker change shorter than this is an artefact of 1.5 s windows, not a turn. */
export const MIN_TURN_SEC = 1
/** Same-speaker turns split where nobody speaks for this long. */
export const TURN_GAP_SEC = 2

/**
 * Per-window labels to a speaker timeline. Each window speaks for the middle
 * of its span (half a hop either side of its centre); the region's first and
 * last windows reach its edges. Short flips are then absorbed.
 */
export function labelTimeline(windows: EmbeddingWindow[], labels: number[], speech: SpeechRegion[]): SpeakerTurn[] {
  const pieces: SpeakerTurn[] = []
  for (const region of speech) {
    const inside = windows.map((w, i) => ({ w, label: labels[i] })).filter(({ w }) => w.start >= region.start - 1e-6 && w.end <= region.end + 1e-6)
    if (!inside.length) continue
    inside.forEach(({ w, label }, k) => {
      const centre = (w.start + w.end) / 2
      const prevCentre = k > 0 ? (inside[k - 1].w.start + inside[k - 1].w.end) / 2 : -Infinity
      const nextCentre = k < inside.length - 1 ? (inside[k + 1].w.start + inside[k + 1].w.end) / 2 : Infinity
      const start = k === 0 ? region.start : (prevCentre + centre) / 2
      const end = k === inside.length - 1 ? region.end : (centre + nextCentre) / 2
      pieces.push({ start, end, speaker: label })
    })
  }
  return smoothTurns(mergeAdjacent(pieces, TURN_GAP_SEC), MIN_TURN_SEC)
}

/** Join consecutive pieces of the same speaker separated by less than `maxGap`. */
export function mergeAdjacent(turns: SpeakerTurn[], maxGap: number): SpeakerTurn[] {
  const out: SpeakerTurn[] = []
  for (const turn of [...turns].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && last.speaker === turn.speaker && turn.start - last.end < maxGap) last.end = Math.max(last.end, turn.end)
    else out.push({ ...turn })
  }
  return out
}

/**
 * Absorb turns shorter than `minSec`: shortest first, each relabelled to the
 * neighbour it touches for longer (or the only neighbour), then merged. A
 * genuine "yeah" between two of the other speaker's sentences is lost too —
 * the windows cannot resolve it reliably, and a spurious flip is worse for
 * clip boundaries than a missed interjection.
 */
export function smoothTurns(turns: SpeakerTurn[], minSec: number): SpeakerTurn[] {
  let out = turns.map(t => ({ ...t }))
  for (;;) {
    let shortest = -1
    for (let i = 0; i < out.length; i++) {
      const d = out[i].end - out[i].start
      if (d >= minSec) continue
      const touching = (j: number): boolean => j >= 0 && j < out.length && out[j].speaker !== out[i].speaker &&
        Math.abs(j < i ? out[i].start - out[j].end : out[j].start - out[i].end) < TURN_GAP_SEC
      if (!touching(i - 1) && !touching(i + 1)) continue
      if (shortest < 0 || d < out[shortest].end - out[shortest].start) shortest = i
    }
    if (shortest < 0) return out
    const i = shortest
    const prev = out[i - 1], next = out[i + 1]
    const near = (t: SpeakerTurn | undefined, gap: number): boolean => !!t && gap < TURN_GAP_SEC
    const prevOk = near(prev, prev ? out[i].start - prev.end : Infinity)
    const nextOk = near(next, next ? next.start - out[i].end : Infinity)
    const target = prevOk && nextOk ? (prev.end - prev.start >= next.end - next.start ? prev : next) : prevOk ? prev : next
    out[i].speaker = target.speaker
    out = mergeAdjacent(out, TURN_GAP_SEC)
  }
}

/**
 * Snap a speaker timeline to the transcript: each word goes to the speaker
 * whose turn covers most of it (or the nearest turn within a second), and
 * turns are rebuilt from runs of words, so every boundary falls between two
 * words rather than inside one. Without words the timeline is returned as is.
 * Speakers are renumbered by first appearance; one voice gives [].
 */
export function alignTurnsToWords(timeline: SpeakerTurn[], words: TranscriptWord[]): SpeakerTurn[] {
  if (!timeline.length) return []
  let turns: SpeakerTurn[]
  if (!words.length) {
    turns = timeline.map(t => ({ ...t }))
  } else {
    const labelled: SpeakerTurn[] = []
    for (const word of [...words].sort((a, b) => a.start - b.start)) {
      let best = -1, bestOverlap = 0, nearest = -1, nearestGap = 1
      timeline.forEach((t, k) => {
        const overlap = Math.min(t.end, word.end) - Math.max(t.start, word.start)
        if (overlap > bestOverlap) { bestOverlap = overlap; best = k }
        const gap = Math.max(t.start - word.end, word.start - t.end, 0)
        if (gap < nearestGap) { nearestGap = gap; nearest = k }
      })
      const k = best >= 0 ? best : nearest
      if (k < 0) continue
      labelled.push({ start: word.start, end: word.end, speaker: timeline[k].speaker })
    }
    turns = smoothTurns(mergeAdjacent(labelled, TURN_GAP_SEC), MIN_TURN_SEC)
  }
  const ids = renumber(turns.map(t => t.speaker))
  if (new Set(ids).size < 2) return []
  return turns.map((t, i) => ({ start: round3(t.start), end: round3(t.end), speaker: ids[i] }))
}
