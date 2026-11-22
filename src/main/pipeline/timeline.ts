import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { TimelineData } from '@shared/types'
import { runFfmpeg } from './ffmpeg'
import { pruneDirectory } from './analysisCache'

/**
 * Editor timeline data: a filmstrip of evenly spaced thumbnails plus an audio
 * waveform for a window of the source video. Results are cached on disk keyed
 * by (path, mtime, window) — trims re-open the same window constantly and the
 * extraction costs a full decode of the window.
 */

const FRAME_COUNT = 16
const FRAME_HEIGHT = 96
const WAVEFORM_BUCKETS = 160
const WAVEFORM_SAMPLE_RATE = 8000
/** Bump to invalidate previously cached entries when the format changes. */
const CACHE_VERSION = 1
const CACHE_MAX_AGE_MS = 14 * 24 * 3600 * 1000
/**
 * Total size the cache may reach before the least recently opened windows
 * go. One window is about 60 KB (16 small JPEGs and a manifest), so this is
 * a few thousand windows: far more than anyone reopens.
 */
const CACHE_MAX_BYTES = 200 * 1024 * 1024

function cacheRoot(): string {
  const base = app?.getPath?.('userData') ?? join(process.cwd(), '.tmp', 'userData')
  return join(base, 'timeline-cache')
}

/**
 * Mean RMS per bucket over signed 16-bit little-endian mono PCM, normalised
 * so the loudest bucket is 1. Pure and exported for unit tests.
 */
export function computeWaveform(pcm: Buffer, buckets: number): number[] {
  const sampleCount = Math.floor(pcm.length / 2)
  if (sampleCount === 0 || buckets <= 0) return []
  const perBucket = Math.max(1, Math.floor(sampleCount / buckets))
  const out: number[] = []
  for (let b = 0; b < buckets; b++) {
    const from = b * perBucket
    if (from >= sampleCount) break
    const to = Math.min(sampleCount, from + perBucket)
    let sum = 0
    for (let i = from; i < to; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768
      sum += v * v
    }
    out.push(Math.sqrt(sum / (to - from)))
  }
  const peak = Math.max(...out, 1e-6)
  return out.map((v) => Math.round((v / peak) * 1000) / 1000)
}

/** Drop windows not opened in a while, then the least recently opened past the size bound. */
async function pruneCache(root: string): Promise<void> {
  await pruneDirectory(root, { maxAgeMs: CACHE_MAX_AGE_MS, maxBytes: CACHE_MAX_BYTES })
}

let prunedThisRun = false
/** Concurrent requests for the same window share one extraction. */
const inFlight = new Map<string, Promise<TimelineData>>()

export async function getTimeline(
  videoPath: string,
  startSec: number,
  endSec: number
): Promise<TimelineData> {
  const info = await stat(videoPath)
  const key = createHash('md5')
    .update(
      JSON.stringify([videoPath, info.mtimeMs, startSec.toFixed(2), endSec.toFixed(2), CACHE_VERSION])
    )
    .digest('hex')
    .slice(0, 20)

  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = extractTimeline(key, videoPath, startSec, endSec).finally(() =>
    inFlight.delete(key)
  )
  inFlight.set(key, promise)
  return promise
}

async function extractTimeline(
  key: string,
  videoPath: string,
  startSec: number,
  endSec: number
): Promise<TimelineData> {
  const dir = join(cacheRoot(), key)
  const manifestPath = join(dir, 'timeline.json')

  if (!prunedThisRun) {
    prunedThisRun = true
    await pruneCache(cacheRoot())
  }

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TimelineData
    await Promise.all(manifest.frames.map((f) => stat(f)))
    // Pruning goes by the window's own time: opening it counts as use.
    const now = new Date()
    await utimes(dir, now, now).catch(() => undefined)
    return manifest
  } catch {
    /* not cached yet */
  }

  await mkdir(dir, { recursive: true })
  const duration = Math.max(0.1, endSec - startSec)

  await runFfmpeg([
    '-ss', startSec.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', videoPath,
    '-vf', `fps=${FRAME_COUNT}/${duration.toFixed(3)},scale=-2:${FRAME_HEIGHT}`,
    '-frames:v', String(FRAME_COUNT),
    '-q:v', '5',
    join(dir, 'f%03d.jpg')
  ])
  const frames = (await readdir(dir))
    .filter((f) => f.startsWith('f') && f.endsWith('.jpg'))
    .sort()
    .map((f) => join(dir, f))

  let waveform: number[] = []
  const pcmPath = join(dir, 'wave.pcm')
  try {
    await runFfmpeg([
      '-ss', startSec.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', String(WAVEFORM_SAMPLE_RATE),
      '-f', 's16le',
      pcmPath
    ])
    waveform = computeWaveform(await readFile(pcmPath), WAVEFORM_BUCKETS)
  } catch {
    /* no audio stream — the timeline still shows the filmstrip */
  } finally {
    await rm(pcmPath, { force: true }).catch(() => undefined)
  }

  const data: TimelineData = { frames, waveform }
  await writeFile(manifestPath, JSON.stringify(data), 'utf8')
  return data
}
