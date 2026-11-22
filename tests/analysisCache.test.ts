import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureSeries,
  pruneDirectory,
  readAnalysis,
  SampleSeries,
  setAnalysisCacheRoot,
  sourceIdentity,
  writeAnalysis,
  type SeriesKind
} from '../src/main/pipeline/analysisCache'

let dir: string
let source: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-analysis-cache-'))
  source = join(dir, 'source.mp4')
  await writeFile(source, 'not really a video')
  setAnalysisCacheRoot(join(dir, 'cache'))
})

afterEach(async () => {
  setAnalysisCacheRoot(undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('SampleSeries', () => {
  it('reports what is missing and round-trips compactly', () => {
    const series = new SampleSeries(4)
    for (const k of [2, 3, 4, 8]) series.set(k, k / 3)
    expect(series.missing(0, 10)).toEqual([{ from: 0, to: 2 }, { from: 5, to: 8 }, { from: 9, to: 10 }])
    series.limit = 9
    expect(series.missing(0, 12)).toEqual([{ from: 0, to: 2 }, { from: 5, to: 8 }])
    const text = series.serialize(2)
    expect(JSON.parse(text)).toEqual({ rate: 4, limit: 9, runs: [{ k: 2, v: [0.67, 1, 1.33] }, { k: 8, v: [2.67] }] })
    const back = SampleSeries.parse(text, 4)!
    expect(back.range(0, 10).map(s => s.k)).toEqual([2, 3, 4, 8])
    expect(back.limit).toBe(9)
    expect(SampleSeries.parse(text, 10)).toBeNull()
    expect(SampleSeries.parse('{not json', 4)).toBeNull()
  })
})

describe('the analysis cache', () => {
  it('keys entries by the file and the parameters', async () => {
    const id = (await sourceIdentity(source))!
    await writeAnalysis('kind', id, { threshold: 1 }, 'one')
    expect((await readAnalysis('kind', id, { threshold: 1 }))?.toString()).toBe('one')
    expect(await readAnalysis('kind', id, { threshold: 2 })).toBeNull()
    expect(await readAnalysis('other', id, { threshold: 1 })).toBeNull()
    // The file changed: a different identity, so a miss.
    await writeFile(source, 'a different, longer video')
    expect(await readAnalysis('kind', (await sourceIdentity(source))!, { threshold: 1 })).toBeNull()
    expect(await sourceIdentity(join(dir, 'missing.mp4'))).toBeNull()
  })

  it('does nothing when turned off', async () => {
    setAnalysisCacheRoot(null)
    const id = (await sourceIdentity(source))!
    await writeAnalysis('kind', id, {}, 'one')
    expect(await readAnalysis('kind', id, {})).toBeNull()
  })

  it('decodes only what is missing, and keeps nothing from a decode with errors', async () => {
    const decode = vi.fn(async (_path: string, from: number, to: number) =>
      ({ values: Array.from({ length: to - from }, (_, i) => from + i), clean: true }))
    const kind: SeriesKind = { kind: 'test', rate: 10, params: {}, decimals: 1, decode }
    await ensureSeries(kind, source, [{ from: 0, to: 20 }])
    setAnalysisCacheRoot(join(dir, 'cache')) // as after a restart: disk only
    const series = await ensureSeries(kind, source, [{ from: 10, to: 30 }])
    expect(decode.mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 20], [20, 30]])
    expect(series.range(0, 30).map(s => s.value)).toEqual(Array.from({ length: 30 }, (_, i) => i))

    // Running into the end of the file is remembered, so it is not retried.
    decode.mockImplementationOnce(async (_path, from) => ({ values: [from, from + 1], clean: true }))
    await ensureSeries(kind, source, [{ from: 30, to: 40 }])
    decode.mockClear()
    await ensureSeries(kind, source, [{ from: 30, to: 40 }])
    expect(decode).not.toHaveBeenCalled()

    const broken: SeriesKind = { ...kind, kind: 'broken', decode: async (_p, from, to) =>
      ({ values: Array.from({ length: to - from }, () => 1), clean: false }) }
    await ensureSeries(broken, source, [{ from: 0, to: 5 }])
    expect((await readdir(join(dir, 'cache'))).some(name => name.startsWith('broken-'))).toBe(false)
  })
})

describe('pruneDirectory', () => {
  async function entry(name: string, bytes: number, ageSec: number): Promise<void> {
    const path = join(dir, 'prune', name)
    await writeFile(path, Buffer.alloc(bytes))
    const when = new Date(Date.now() - ageSec * 1000)
    await utimes(path, when, when)
  }

  beforeEach(async () => {
    await import('node:fs/promises').then(fs => fs.mkdir(join(dir, 'prune')))
    await entry('a', 100, 10)
    await entry('b', 100, 20)
    await entry('c', 100, 30)
    await entry('stale.tmp', 10, 7200)
  })

  const left = async (): Promise<string[]> => (await readdir(join(dir, 'prune'))).sort()

  it('drops the least recently used past the size bound, and old temporary files', async () => {
    await pruneDirectory(join(dir, 'prune'), { maxBytes: 250 })
    expect(await left()).toEqual(['a', 'b'])
  })

  it('bounds the entry count and age, and only touches matching entries', async () => {
    await pruneDirectory(join(dir, 'prune'), { maxEntries: 1, match: name => name !== 'c' })
    expect(await left()).toEqual(['a', 'c'])
    await pruneDirectory(join(dir, 'prune'), { maxAgeMs: 15_000 })
    expect(await left()).toEqual(['a'])
  })

  it('never throws, even for a directory that is not there', async () => {
    await expect(pruneDirectory(join(dir, 'nowhere'), { maxEntries: 0 })).resolves.toBeUndefined()
  })
})
