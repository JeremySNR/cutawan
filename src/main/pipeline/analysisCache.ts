import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Per-source analysis cache on disk: what decoding a source file measured
 * (voice activity probabilities, gap-activity motion and sound levels), kept
 * between runs so re-tightening, re-analysing a clip after a trim change, or
 * changing a threshold never decodes the same footage again.
 *
 * - Keyed by the source's path, size and modification time, the analysis
 *   parameters, and ANALYSIS_CACHE_VERSION: replacing or editing the file,
 *   or changing how it is measured, simply misses.
 * - Callers store raw measurements, not decisions, so thresholds applied on
 *   top of them can change freely.
 * - Writes go to a temporary file renamed into place, so a crash never
 *   leaves a half entry; callers skip the write when the decode reported
 *   errors, so a damaged read is not remembered.
 * - Bounded: past MAX_CACHE_BYTES the least recently used entries go (a read
 *   refreshes an entry's time).
 *
 * Every failure here is a cache miss or a skipped write, never an error for
 * the analysis that asked.
 */

/** Bump to drop every entry written by an older format. */
export const ANALYSIS_CACHE_VERSION = 1
/** Total size the cache may grow to before old entries are pruned. */
const MAX_CACHE_BYTES = 256 * 1024 * 1024
/** Entries untouched for this long go whatever the total. */
const MAX_AGE_MS = 60 * 24 * 3600 * 1000
/** A single entry larger than this is not read back (a corrupt or foreign file). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

let rootOverride: string | null | undefined

/** Tests point the cache somewhere private, or pass null to turn it off. */
export function setAnalysisCacheRoot(root: string | null | undefined): void {
  rootOverride = root
  prunedRoots.clear()
  loaded.clear()
}

function cacheRoot(): string | null {
  if (rootOverride !== undefined) return rootOverride
  const base = app?.getPath?.('userData') ?? join(process.cwd(), '.tmp', 'userData')
  return join(base, 'analysis-cache')
}

/** What identifies a source file's contents, cheaply. */
export interface SourceIdentity { path: string; size: number; mtimeMs: number }

export async function sourceIdentity(path: string): Promise<SourceIdentity | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? { path, size: info.size, mtimeMs: Math.round(info.mtimeMs) } : null
  } catch {
    return null
  }
}

function entryPath(root: string, kind: string, source: SourceIdentity, params: unknown, ext: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([ANALYSIS_CACHE_VERSION, kind, source.path, source.size, source.mtimeMs, params]))
    .digest('hex').slice(0, 32)
  return join(root, `${kind}-${key}.${ext}`)
}

/** The cached bytes for this source and parameters, or null on a miss. */
export async function readAnalysis(kind: string, source: SourceIdentity, params: unknown, ext = 'json'): Promise<Buffer | null> {
  const root = cacheRoot()
  if (!root) return null
  const path = entryPath(root, kind, source, params, ext)
  try {
    const info = await stat(path)
    if (info.size > MAX_ENTRY_BYTES) return null
    const data = await readFile(path)
    // Least recently used, not least recently written.
    const now = new Date()
    await utimes(path, now, now).catch(() => undefined)
    return data
  } catch {
    return null
  }
}

/** Store bytes for this source and parameters; best-effort. */
export async function writeAnalysis(
  kind: string, source: SourceIdentity, params: unknown, data: Buffer | string, ext = 'json'
): Promise<void> {
  const root = cacheRoot()
  if (!root) return
  const path = entryPath(root, kind, source, params, ext)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(root, { recursive: true })
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    console.warn('[analysis-cache] could not save an entry:', error)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  void pruneOnce(root)
}

const prunedRoots = new Map<string, number>()
/** Prune at most this often per directory: listing it is not free. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

async function pruneOnce(root: string): Promise<void> {
  const last = prunedRoots.get(root) ?? 0
  if (Date.now() - last < PRUNE_INTERVAL_MS) return
  prunedRoots.set(root, Date.now())
  await pruneDirectory(root, { maxBytes: MAX_CACHE_BYTES, maxAgeMs: MAX_AGE_MS })
}

/**
 * Keep a cache directory within bounds: entries older than `maxAgeMs` go,
 * then the least recently used ones until the total is under `maxBytes`
 * and at most `maxEntries` remain. An entry may be a file or a directory
 * (sized by its files, timed by its own mtime). Leftover temporary files
 * from an interrupted write go once they are an hour old. `match` limits
 * all of this to the entries it accepts, for a directory other things
 * share. Best-effort: nothing here throws.
 */
export async function pruneDirectory(
  dir: string, limits: { maxBytes?: number; maxAgeMs?: number; maxEntries?: number; match?: (name: string) => boolean }
): Promise<void> {
  try {
    const now = Date.now()
    const entries: Array<{ path: string; bytes: number; used: number }> = []
    for (const name of await readdir(dir)) {
      if (limits.match && !limits.match(name)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      if (name.endsWith('.tmp') && now - info.mtimeMs > 3600_000) {
        await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      let bytes = info.size
      if (info.isDirectory()) {
        bytes = 0
        for (const child of await readdir(path).catch(() => [] as string[])) {
          bytes += (await stat(join(path, child)).catch(() => null))?.size ?? 0
        }
      }
      entries.push({ path, bytes, used: info.mtimeMs })
    }
    entries.sort((a, b) => b.used - a.used)
    let total = 0
    let kept = 0
    for (const entry of entries) {
      const tooOld = limits.maxAgeMs !== undefined && now - entry.used > limits.maxAgeMs
      const tooBig = limits.maxBytes !== undefined && total + entry.bytes > limits.maxBytes
      const tooMany = limits.maxEntries !== undefined && kept >= limits.maxEntries
      if (tooOld || tooBig || tooMany) {
        await rm(entry.path, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      total += entry.bytes
      kept++
    }
  } catch {
    /* pruning is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Sampled series

/**
 * Measurements on a fixed grid of a source's timeline (sample k is at
 * k / rate seconds), with the parts that have been measured. Decoding only
 * the parts not yet covered and merging them in means overlapping clips,
 * re-trims and re-analyses of one source share every sample.
 */
export class SampleSeries {
  private readonly values = new Map<number, number>()
  /** First index past the end of the source, once a clean decode has run into it. */
  limit = Number.POSITIVE_INFINITY

  constructor(readonly rate: number) {}

  get size(): number { return this.values.size }

  get(k: number): number | undefined { return this.values.get(k) }

  set(k: number, value: number): void { this.values.set(k, value) }

  /** Index ranges [from, to) within [from, to) not measured yet. */
  missing(from: number, to: number): Array<{ from: number; to: number }> {
    const out: Array<{ from: number; to: number }> = []
    to = Math.min(to, this.limit)
    let start = -1
    for (let k = from; k < to; k++) {
      const has = this.values.has(k)
      if (!has && start < 0) start = k
      if (has && start >= 0) { out.push({ from: start, to: k }); start = -1 }
    }
    if (start >= 0) out.push({ from: start, to })
    return out
  }

  /** Samples in [from, to), in order; gaps left out. */
  range(from: number, to: number): Array<{ k: number; value: number }> {
    const out: Array<{ k: number; value: number }> = []
    for (let k = from; k < to; k++) {
      const value = this.values.get(k)
      if (value !== undefined) out.push({ k, value })
    }
    return out
  }

  merge(other: SampleSeries): void {
    for (const [k, v] of other.values) if (!this.values.has(k)) this.values.set(k, v)
    this.limit = Math.min(this.limit, other.limit)
  }

  /** Contiguous runs, rounded to `decimals`, as compact JSON. */
  serialize(decimals: number): string {
    const keys = [...this.values.keys()].sort((a, b) => a - b)
    const runs: Array<{ k: number; v: number[] }> = []
    const scale = 10 ** decimals
    for (const k of keys) {
      const value = Math.round(this.values.get(k)! * scale) / scale
      const last = runs[runs.length - 1]
      if (last && last.k + last.v.length === k) last.v.push(value)
      else runs.push({ k, v: [value] })
    }
    return JSON.stringify({ rate: this.rate, ...(Number.isFinite(this.limit) ? { limit: this.limit } : {}), runs })
  }

  static parse(text: string, rate: number): SampleSeries | null {
    try {
      const data = JSON.parse(text) as { rate?: unknown; limit?: unknown; runs?: unknown }
      if (data.rate !== rate || !Array.isArray(data.runs)) return null
      const series = new SampleSeries(rate)
      if (Number.isSafeInteger(data.limit)) series.limit = data.limit as number
      for (const run of data.runs as Array<{ k?: unknown; v?: unknown }>) {
        if (!Number.isSafeInteger(run.k) || !Array.isArray(run.v)) return null
        run.v.forEach((value, i) => {
          if (typeof value === 'number' && Number.isFinite(value)) series.set((run.k as number) + i, value)
        })
      }
      return series
    } catch {
      return null
    }
  }
}

/** How one kind of series is measured: decode indices [from, to) of a source. */
export interface SeriesKind {
  kind: string
  rate: number
  /** Everything the values depend on besides the source itself. */
  params: unknown
  /** Decimals kept on disk. */
  decimals: number
  /**
   * Values for indices from, from + 1, … (fewer at the end of the source),
   * and whether ffmpeg decoded the span without reporting an error.
   */
  decode: (videoPath: string, from: number, to: number, signal?: AbortSignal) => Promise<{ values: number[]; clean: boolean }>
}

/** Series recently read or measured, so the clips of one source share them in memory too. */
const loaded = new Map<string, SampleSeries>()
const LOADED_MAX = 6

function loadedKey(kind: SeriesKind, source: SourceIdentity): string {
  return JSON.stringify([kind.kind, source.path, source.size, source.mtimeMs, kind.params])
}

/** A source's series as far as it has been measured (from memory, then disk). */
export async function loadSeries(kind: SeriesKind, videoPath: string): Promise<{ series: SampleSeries; source: SourceIdentity | null }> {
  const source = await sourceIdentity(videoPath)
  if (!source) return { series: new SampleSeries(kind.rate), source }
  const key = loadedKey(kind, source)
  const memo = loaded.get(key)
  if (memo) return { series: memo, source }
  const bytes = await readAnalysis(kind.kind, source, kind.params)
  const series = (bytes && SampleSeries.parse(bytes.toString('utf8'), kind.rate)) || new SampleSeries(kind.rate)
  remember(key, series)
  return { series, source }
}

function remember(key: string, series: SampleSeries): void {
  loaded.delete(key)
  loaded.set(key, series)
  while (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value as string)
}

/** Forget the in-memory copies (tests; a cache directory change). */
export function clearLoadedSeries(): void {
  loaded.clear()
}

/**
 * Make sure indices [from, to) of the source are measured, decoding only
 * what is missing, and save what was added when every decode was clean.
 * Returns the series to read them from.
 */
export async function ensureSeries(
  kind: SeriesKind, videoPath: string, ranges: Array<{ from: number; to: number }>, signal?: AbortSignal
): Promise<SampleSeries> {
  const { series, source } = await loadSeries(kind, videoPath)
  let added = false
  let clean = true
  for (const range of ranges) {
    for (const gap of series.missing(range.from, range.to)) {
      signal?.throwIfAborted()
      const result = await kind.decode(videoPath, gap.from, gap.to, signal)
      result.values.forEach((value, i) => series.set(gap.from + i, value))
      if (result.clean && result.values.length < gap.to - gap.from) {
        series.limit = Math.min(series.limit, gap.from + result.values.length)
      }
      added = true
      clean &&= result.clean
    }
  }
  if (!source || !added) return series
  if (clean) {
    // Another analysis of the same source may have saved since this one
    // loaded; keep its samples too.
    const bytes = await readAnalysis(kind.kind, source, kind.params)
    const saved = bytes && SampleSeries.parse(bytes.toString('utf8'), kind.rate)
    if (saved) series.merge(saved)
    await writeAnalysis(kind.kind, source, kind.params, series.serialize(kind.decimals))
  } else {
    // A decode with errors is used this once and not remembered, in memory
    // or on disk: the next analysis decodes again.
    loaded.delete(loadedKey(kind, source))
  }
  return series
}
