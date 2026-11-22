import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Clip } from '@shared/types'
import { playedSentences } from '@shared/captionTranslation'
import { DUB_MAX_TEMPO, dubSupport } from '@shared/dubPlan'
import { makeTranscript } from './helpers'
import { dubClip } from '../src/main/pipeline/dub'
import { buildCondenseMessages, condenseTarget, landCondensed } from '../src/main/pipeline/dubScript'
import { runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { configureOpenAiEndpoints } from '../src/main/pipeline/openai'

describe('shortening dub lines', () => {
  it('asks for a length that fits at the fastest tempo, with a margin', () => {
    // 5 s of speech for a 2.8 s slot: at ×1.25 it may take 3.5 s, so 70% of the characters, less 10%.
    expect(condenseTarget('x'.repeat(100), 2.8, 5, 1.25)).toBe(63)
    expect(condenseTarget('x'.repeat(100), 10, 5, 1.25)).toBe(90) // never asks to lengthen
    expect(condenseTarget('hola', 0.1, 5, 1.25)).toBe(8)
  })

  it('keeps only shorter, non-empty replies on known numbers', () => {
    const items = [{ n: 1, text: 'una línea bastante larga', maxChars: 12 }, { n: 3, text: 'otra línea larga', maxChars: 10 }]
    const landed = landCondensed(items, {
      lines: [{ n: 1, text: '  línea corta ' }, { n: 2, text: 'no pedida' }, { n: 3, text: 'otra línea larga y más' }, { n: 1, text: 'duplicada' }]
    })
    expect([...landed]).toEqual([[1, 'línea corta']])
    expect(landCondensed(items, {}).size).toBe(0)
  })

  it('tells the model each line\'s limit and language', () => {
    const [, user] = buildCondenseMessages('Spanish', [{ n: 2, text: 'hola a todos', maxChars: 9 }])
    expect(user.content).toContain('Language: Spanish')
    expect(user.content).toContain('2. [max 9 characters] hola a todos')
  })
})

describe('dubbing a line too long for its slot', () => {
  let dir: string
  let long: Buffer, short: Buffer
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-dub-script-'))
    for (const [name, sec] of [['long', 5], ['short', 1.5]] as const) {
      await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=24000:duration=${sec}`, '-c:a', 'libmp3lame', '-b:a', '64k', join(dir, `${name}.mp3`)])
    }
    long = await readFile(join(dir, 'long.mp3'))
    short = await readFile(join(dir, 'short.mp3'))
  }, 60_000)
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })
  afterEach(() => { vi.unstubAllGlobals(); configureOpenAiEndpoints({}) })

  function clipWithTranslation(): { clip: Clip; transcript: ReturnType<typeof makeTranscript> } {
    const transcript = makeTranscript(['One two three four.', 'Five six seven eight.'], { sentenceGapSec: 1 })
    const clip: Clip = {
      id: 'c', title: '', hook: '', summary: '', suggestedStart: 0, suggestedEnd: transcript.durationSec,
      viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
      edit: {
        aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5, captionsEnabled: true,
        captionStyleId: 'beast', showTitle: false, start: 0, end: transcript.durationSec, captionLanguage: 'translated'
      }
    }
    clip.translation = {
      version: 1, language: 'Spanish', edited: false, accepted: true, createdAt: 0,
      lines: playedSentences(clip, transcript).map((s, i) => ({ start: s.start, end: s.end, source: s.text, text: `una línea muy larga número ${i + 1}` }))
    }
    return { clip, transcript }
  }

  it('voices a shorter wording that fits, and keeps the caption text', async () => {
    // Every take of the full line runs 5 s; the shortened wording runs 1.5 s.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string }
      return new Response(body.input.startsWith('corta') ? short : long, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }))
    const { clip, transcript } = clipWithTranslation()
    const condense = vi.fn(async (items: Array<{ n: number }>) => new Map(items.map((item) => [item.n, `corta ${item.n}`])))
    const choice = { provider: 'openai' as const, model: dubSupport('api').models[1], voice: 'alloy' }
    const dub = await dubClip('sk-x', clip, transcript, join(dir, 'cache'), choice, { condense })
    expect(condense).toHaveBeenCalledTimes(1)
    const items = condense.mock.calls[0][0] as Array<{ n: number; text: string; maxChars: number }>
    expect(items.map((i) => i.n)).toEqual([1, 2])
    expect(items[0].maxChars).toBeLessThan(items[0].text.length)
    for (const [i, line] of dub.lines.entries()) {
      expect(line.text).toBe(clip.translation!.lines[i].text)
      expect(line.spoken).toBe(`corta ${i + 1}`)
      expect(line.fit).not.toBe('truncated')
      expect(line.tempo).toBeLessThanOrEqual(DUB_MAX_TEMPO)
    }
  })

  it('trims the silence speech models pad each take with', async () => {
    const padded = join(dir, 'padded.mp3')
    // 0.5 s of silence, 1 s of voice, 0.4 s of silence.
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=1', '-af', 'adelay=500,apad=pad_dur=0.4',
      '-c:a', 'libmp3lame', '-b:a', '64k', padded])
    const bytes = await readFile(padded)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })))
    const { clip, transcript } = clipWithTranslation()
    const choice = { provider: 'openai' as const, model: dubSupport('api').models[1], voice: 'alloy' }
    const dub = await dubClip('sk-x', clip, transcript, join(dir, 'cache3'), choice)
    for (const line of dub.lines) {
      expect(line.audioSec).toBeGreaterThan(1)
      expect(line.audioSec).toBeLessThan(1.3)
    }
  })

  it('never caches a silent take', async () => {
    const silent = join(dir, 'silent.mp3')
    await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.4', '-c:a', 'libmp3lame', '-b:a', '64k', silent])
    const bytes = await readFile(silent)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })))
    const { clip, transcript } = clipWithTranslation()
    const choice = { provider: 'openai' as const, model: dubSupport('api').models[1], voice: 'alloy' }
    const cache = join(dir, 'cache4')
    await expect(dubClip('sk-x', clip, transcript, cache, choice)).rejects.toThrow(/returned silence/)
    expect((await readdir(cache).catch(() => [])).filter((f) => /^[0-9a-f]{32}\.mp3$/.test(f))).toEqual([])
  })

  it('keeps the long take, flagged, when shortening fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(long, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })))
    const { clip, transcript } = clipWithTranslation()
    const choice = { provider: 'openai' as const, model: dubSupport('api').models[1], voice: 'alloy' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dub = await dubClip('sk-x', clip, transcript, join(dir, 'cache2'), choice, { condense: async () => { throw new Error('offline') } })
    error.mockRestore()
    expect(dub.lines.every((l) => l.fit === 'truncated' && !l.spoken)).toBe(true)
  })
})
