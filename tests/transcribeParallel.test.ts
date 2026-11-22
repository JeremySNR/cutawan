import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioChunk } from '../src/main/pipeline/ffmpeg'
import type { TranscribeFileOptions, WhisperResponse } from '../src/main/pipeline/openai'
import { transcribeChunks } from '../src/main/pipeline/transcribe'
import { transcribeAudioFile } from '../src/main/pipeline/openai'

vi.mock('../src/main/pipeline/openai', () => ({ transcribeAudioFile: vi.fn() }))
vi.mock('../src/main/pipeline/ffmpeg', () => ({ runFfmpeg: vi.fn() }))

const CHUNK_SEC = 100
const OVERLAP_SEC = 8
const STRIDE = CHUNK_SEC - OVERLAP_SEC

/** Six overlapping chunks laid out the way extractAudioChunks lays them out. */
const chunks: AudioChunk[] = Array.from({ length: 6 }, (_, i) => ({
  path: `chunk-${i}.mp3`,
  offsetSec: i * STRIDE,
  keepFromSec: i === 0 ? 0 : i * STRIDE + OVERLAP_SEC / 2,
  keepToSec: i === 5 ? Number.POSITIVE_INFINITY : i * STRIDE + CHUNK_SEC - OVERLAP_SEC / 2
}))

/** One word every two seconds, named after its chunk, so ownership is visible. */
function reply(index: number): WhisperResponse {
  const words = Array.from({ length: CHUNK_SEC / 2 }, (_, n) => ({
    word: `c${index}w${n}`, start: n * 2 + 0.5, end: n * 2 + 1.5
  }))
  return {
    language: 'en', duration: CHUNK_SEC, text: words.map((w) => w.word).join(' '), words,
    // Five words to a segment, as Whisper would break them.
    segments: Array.from({ length: words.length / 5 }, (_, s) => {
      const group = words.slice(s * 5, s * 5 + 5)
      return { id: s, text: group.map((w) => w.word).join(' ') + '.', start: group[0].start, end: group[4].end }
    })
  }
}

interface Call { index: number; prompt?: string }

/** Chunks answer in reverse order of arrival, so nothing may rely on order. */
function scriptRoute(opts: { failOn?: number } = {}): { calls: Call[]; peak: () => number; aborted: number[] } {
  const calls: Call[] = []
  const aborted: number[] = []
  let inFlight = 0
  let peak = 0
  vi.mocked(transcribeAudioFile).mockImplementation(async (_key: string, path: string, _model: string, options: TranscribeFileOptions = {}) => {
    const index = Number(path.match(/chunk-(\d)/)![1])
    calls.push({ index, prompt: options.contextPrompt })
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.failOn === index ? 5 : 40 - index * 5)
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); aborted.push(index); reject(options.signal!.reason) })
      })
    } finally {
      inFlight--
    }
    if (opts.failOn === index) throw new Error('chunk failed')
    return reply(index)
  })
  return { calls, peak: () => peak, aborted }
}

afterEach(() => vi.resetAllMocks())

describe('transcribing chunks at once', () => {
  it('goes one at a time by default, each chunk primed with the text before it', async () => {
    const route = scriptRoute()
    await transcribeChunks('key', 'whisper-1', chunks, 'en')
    expect(route.peak()).toBe(1)
    expect(route.calls.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(route.calls[0].prompt).toBeUndefined()
    expect(route.calls[3].prompt).toContain('c2w')
  })

  it('sends the opening chunk first and primes the rest with it', async () => {
    const route = scriptRoute()
    const progress: number[] = []
    const transcript = await transcribeChunks('key', 'whisper-1', chunks, 'en', (f) => progress.push(f), undefined,
      { concurrency: 3, context: 'first' })
    expect(route.calls[0]).toEqual({ index: 0, prompt: undefined })
    expect(route.peak()).toBe(3)
    for (const call of route.calls.slice(1)) {
      expect(call.prompt).toContain('c0w')
      // Never the overlap the next chunk decodes for itself.
      expect(call.prompt).not.toContain(`c0w${CHUNK_SEC / 2 - 1}`)
    }
    // Stitched in source order whatever order the replies arrived in.
    const words = transcript.segments.flatMap((s) => s.words)
    expect(words.map((w) => w.start)).toEqual([...words.map((w) => w.start)].sort((a, b) => a - b))
    expect(new Set(words.map((w) => w.text.slice(0, 2)))).toEqual(new Set(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']))
    // Each word comes from the one chunk that owns its timestamp.
    for (const word of words) {
      const owner = chunks.findIndex((c) => word.start >= c.keepFromSec && word.start < c.keepToSec)
      expect(word.text.startsWith(`c${owner}w`)).toBe(true)
    }
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('matches the one-at-a-time transcript exactly', async () => {
    scriptRoute()
    const sequential = await transcribeChunks('key', 'whisper-1', chunks, 'en')
    scriptRoute()
    const parallel = await transcribeChunks('key', 'whisper-1', chunks, 'en', undefined, undefined, { concurrency: 3, context: 'none' })
    expect(parallel).toEqual(sequential)
  })

  it('sends no prompt on a route that has none', async () => {
    const route = scriptRoute()
    await transcribeChunks('key', 'whisper-1', chunks, 'en', undefined, undefined, { concurrency: 3, context: 'none' })
    expect(route.peak()).toBe(3)
    expect(route.calls.every((c) => c.prompt === undefined)).toBe(true)
  })

  it('stops the other chunks when one fails', async () => {
    const route = scriptRoute({ failOn: 2 })
    await expect(transcribeChunks('key', 'whisper-1', chunks, 'en', undefined, undefined, { concurrency: 3, context: 'none' }))
      .rejects.toThrow('chunk failed')
    expect(route.aborted.length).toBeGreaterThan(0)
    // Nothing new is started after the failure.
    expect(route.calls.length).toBeLessThan(chunks.length)
  })

  it('stops everything when the job is cancelled', async () => {
    const route = scriptRoute()
    const controller = new AbortController()
    const run = transcribeChunks('key', 'whisper-1', chunks, 'en', undefined, controller.signal, { concurrency: 3, context: 'none' })
    setTimeout(() => controller.abort(), 10)
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(route.aborted.sort()).toEqual([0, 1, 2])
  })
})
