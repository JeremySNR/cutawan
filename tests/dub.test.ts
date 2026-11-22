import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Clip, ClipDub, Transcript } from '@shared/types'
import { playedSentences } from '@shared/captionTranslation'
import {
  DUB_DUCK_DB,
  DUB_LINE_GAP_SEC,
  DUB_MAX_TEMPO,
  DUB_RAMP_SEC,
  duckGainAt,
  duckWindows,
  dubSupport,
  estimateDubCostUsd,
  planDubCues
} from '@shared/dubPlan'
import { clipKeptSegments, TimeMap } from '@shared/tighten'
import { makeTranscript } from './helpers'
import { duckFilters, dubMixGraph, dubTrackGraph, estimateDub, fasterSpeed, fitDubLine, SilentTakeError, speechCachePath, withDubMix } from '../src/main/pipeline/dub'
import { configureOpenAiEndpoints, synthesizeSpeech } from '../src/main/pipeline/openai'

const SENTENCES = ['One two three four.', 'Five six seven eight.', 'Nine ten eleven twelve.']

function makeClip(transcript: Transcript, edit: Partial<Clip['edit']> = {}): Clip {
  const clip: Clip = {
    id: 'c', title: '', hook: '', summary: '', suggestedStart: 0, suggestedEnd: transcript.durationSec,
    viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5,
      captionsEnabled: true, captionStyleId: 'beast', showTitle: false, start: 0, end: transcript.durationSec,
      captionLanguage: 'translated', ...edit
    }
  }
  const sentences = playedSentences(clip, transcript)
  clip.translation = {
    version: 1, language: 'Spanish', edited: false, accepted: true, createdAt: 0,
    lines: sentences.map((s, i) => ({ start: s.start, end: s.end, source: s.text, text: `línea ${i + 1}` }))
  }
  return clip
}

function dubFor(clip: Clip, audioSec: number[] | number, tempo = 1): ClipDub {
  return {
    version: 1, provider: 'openai', model: 'tts-1', voice: 'alloy', enabled: true, createdAt: 0,
    lines: clip.translation!.lines.map((l, i) => ({
      start: l.start, end: l.end, text: l.text, audioPath: `/cache/${i}.mp3`,
      audioSec: Array.isArray(audioSec) ? audioSec[i] : audioSec, tempo, fit: 'natural' as const
    }))
  }
}

describe('fitting a synthesised line into its slot', () => {
  const takes = (first: number, faster: number) => {
    const calls: Array<{ faster: boolean; speed: number }> = []
    const synth = async (v: { faster: boolean; speed: number }) => {
      calls.push(v)
      return { path: v.faster ? 'fast.mp3' : 'first.mp3', sec: v.faster ? faster : first }
    }
    return { calls, synth }
  }

  it('uses the first take when it fits', async () => {
    const t = takes(1.8, 0)
    expect(await fitDubLine(2, t.synth)).toEqual({ audioPath: 'first.mp3', audioSec: 1.8, tempo: 1, fit: 'natural' })
    expect(t.calls).toHaveLength(1)
  })

  it('re-requests at a faster rate before stretching', async () => {
    const t = takes(2.4, 1.9)
    expect(await fitDubLine(2, t.synth)).toEqual({ audioPath: 'fast.mp3', audioSec: 1.9, tempo: 1, fit: 'faster' })
    expect(t.calls[1].faster).toBe(true)
    expect(t.calls[1].speed).toBeCloseTo(fasterSpeed(2.4, 2), 6)
  })

  it('time-stretches the faster take by at most 1.25x', async () => {
    const t = takes(2.8, 2.4)
    const fit = await fitDubLine(2, t.synth)
    expect(fit.fit).toBe('stretched')
    expect(fit.audioPath).toBe('fast.mp3')
    expect(fit.tempo).toBeLessThanOrEqual(DUB_MAX_TEMPO)
    expect(fit.audioSec / fit.tempo).toBeLessThanOrEqual(2)
  })

  it('marks a line truncated when even 1.25x is not enough', async () => {
    const t = takes(4, 3.5)
    expect(await fitDubLine(2, t.synth)).toMatchObject({ fit: 'truncated', tempo: DUB_MAX_TEMPO, audioSec: 3.5 })
  })

  it('keeps the first take when the faster one fails or comes back silent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const synth = async (v: { faster: boolean; speed: number }) => {
      if (v.faster) throw new SilentTakeError()
      return { path: 'first.mp3', sec: 2.2 }
    }
    expect(await fitDubLine(2, synth)).toMatchObject({ audioPath: 'first.mp3', fit: 'stretched' })
    error.mockRestore()
  })

  it('keeps the first take when the faster one came back no shorter', async () => {
    const t = takes(2.2, 2.6)
    expect(await fitDubLine(2, t.synth)).toMatchObject({ audioPath: 'first.mp3', fit: 'stretched' })
  })
})

describe('planning dub cues', () => {
  const transcript = makeTranscript(SENTENCES, { sentenceGapSec: 1 })

  it('places each line at its sentence, never into the next slot or past the clip end', () => {
    const clip = makeClip(transcript)
    clip.dub = dubFor(clip, [1, 30, 30])
    const cues = planDubCues(clip, transcript, null)
    const lines = clip.translation!.lines
    expect(cues.map((c) => c.start)).toEqual(lines.map((l) => l.start))
    expect(cues[0]).toMatchObject({ duration: 1, truncated: false })
    expect(cues[1].truncated).toBe(true)
    expect(cues[1].start + cues[1].duration).toBeCloseTo(lines[2].start - DUB_LINE_GAP_SEC, 6)
    expect(cues[1].fadeOutSec).toBeGreaterThan(0)
    expect(cues[2].start + cues[2].duration).toBeLessThanOrEqual(clip.edit.end - DUB_LINE_GAP_SEC + 1e-9)
  })

  it('shifts every line by a cold open that plays first, keeping the same slots', () => {
    const clip = makeClip(transcript)
    clip.dub = dubFor(clip, [1, 30, 30])
    const plain = planDubCues(clip, transcript, null)
    const total = plain.length ? clip.edit.end - clip.edit.start + 3 : 0
    const shifted = planDubCues(clip, transcript, null, total, 3)
    expect(shifted).toHaveLength(plain.length)
    shifted.forEach((cue, i) => {
      expect(cue.start).toBeCloseTo(plain[i].start + 3, 9)
      expect(cue.duration).toBeCloseTo(plain[i].duration, 9)
    })
    // Nothing is voiced during the cold open itself.
    expect(Math.min(...shifted.map((c) => c.start))).toBeGreaterThanOrEqual(3)
  })

  it('applies the line tempo to its length', () => {
    const clip = makeClip(transcript)
    clip.dub = dubFor(clip, 1.25, 1.25)
    expect(planDubCues(clip, transcript, null)[0]).toMatchObject({ duration: 1, tempo: 1.25 })
  })

  it('drops lines in removed spans and remaps the rest through the time map', () => {
    const clip = makeClip(transcript)
    clip.dub = dubFor(clip, 0.5)
    const middle = clip.translation!.lines[1]
    clip.edit.cuts = [{ start: middle.start - 0.3, end: middle.end + 0.3 }]
    const segments = clipKeptSegments(clip, transcript)!
    const map = new TimeMap(segments)
    const cues = planDubCues(clip, transcript, segments)
    expect(cues.map((c) => c.text)).toEqual(['línea 1', 'línea 3'])
    expect(cues[1].start).toBeCloseTo(map.toOutput(clip.translation!.lines[2].start), 9)
  })

  it('is silent for lines edited after dubbing, when disabled, or before acceptance', () => {
    const clip = makeClip(transcript)
    clip.dub = dubFor(clip, 0.5)
    clip.translation!.lines[0].text = 'cambiada'
    expect(planDubCues(clip, transcript, null).map((c) => c.text)).toEqual(['línea 2', 'línea 3'])
    clip.dub.enabled = false
    expect(planDubCues(clip, transcript, null)).toEqual([])
    clip.dub.enabled = true
    clip.translation!.accepted = false
    expect(planDubCues(clip, transcript, null)).toEqual([])
  })
})

describe('the duck envelope', () => {
  const cue = (start: number, duration: number) => ({ start, duration, tempo: 1, truncated: false, fadeOutSec: 0, audioPath: '', text: '' })

  it('ducks by 18 dB under a line with a short ramp either side', () => {
    const windows = duckWindows([cue(2, 1)])
    const floor = 10 ** (DUB_DUCK_DB / 20)
    expect(duckGainAt(windows, 1)).toBe(1)
    expect(duckGainAt(windows, 2.5)).toBeCloseTo(floor, 9)
    expect(duckGainAt(windows, 2 - DUB_RAMP_SEC / 2)).toBeCloseTo((1 + floor) / 2, 6)
    expect(duckGainAt(windows, 3 + DUB_RAMP_SEC + 0.01)).toBe(1)
  })

  it('merges lines whose ramps would meet so the original does not pump between them', () => {
    expect(duckWindows([cue(1, 1), cue(2.2, 1), cue(6, 1)])).toEqual([{ start: 1, end: 3.2 }, { start: 6, end: 7 }])
  })

  it('builds ffmpeg volume filters in batches that stay within the parser limit', () => {
    const windows = Array.from({ length: 30 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }))
    const filters = duckFilters(windows)
    expect(filters).toHaveLength(3)
    for (const f of filters) {
      expect(f).toMatch(/^volume=volume='1-0\.87411\*/)
      expect((f.match(/clip\(/g) ?? []).length).toBeLessThanOrEqual(12)
    }
  })
})

describe('dub mix graph', () => {
  it('mixes the dub over the ducked voice and keeps the voice length', () => {
    const mix = dubMixGraph('aout', 3, [{ start: 1, end: 2 }])
    expect(mix.label).toBe('adub')
    expect(mix.filter).toContain('[aout]asetpts=N/SR/TB,asetnsamples=n=256:p=0,volume=')
    expect(mix.filter).toContain('[3:a]aresample=48000')
    expect(mix.filter).toContain('amix=inputs=2:duration=first:dropout_transition=0:normalize=0[adub]')
  })

  it('adds the dub track as the next input after the graph inputs', () => {
    const graph = { filterComplex: '[0:a]anull[aout]', extraInputs: ['-loop', '1', '-t', '5', '-i', 'logo.png'], audioLabel: 'aout', focusCommands: null }
    const mixed = withDubMix(graph, { trackPath: 'dub.wav', windows: [] }, 2)
    expect(mixed.extraInputs.slice(-2)).toEqual(['-i', 'dub.wav'])
    expect(mixed.filterComplex).toContain('[3:a]')
    expect(mixed.audioLabel).toBe('adub')
    expect(withDubMix(graph, null, 1)).toBe(graph)
  })

  it('lays a track out of delayed, tempo-adjusted, faded cues', () => {
    const graph = dubTrackGraph([
      { start: 0.5, duration: 1, tempo: 1.2, truncated: true, fadeOutSec: 0.12, audioPath: 'a', text: '' },
      { start: 3, duration: 1, tempo: 1, truncated: false, fadeOutSec: 0, audioPath: 'b', text: '' }
    ], 6)
    expect(graph).toContain('atempo=1.2000,atrim=end=1.0000')
    expect(graph).toContain('afade=t=out:st=0.8800:d=0.1200')
    expect(graph).toContain('adelay=delays=500:all=1[d0]')
    expect(graph).toContain('adelay=delays=3000:all=1[d1]')
    expect(graph).toContain('apad=whole_dur=6.0000,atrim=end=6.0000[dub]')
  })
})

describe('routes and cost', () => {
  it('offers dubbing on the OpenAI API and OpenRouter, not on ChatGPT sign-in', () => {
    expect(dubSupport('api')).toMatchObject({ available: true, provider: 'openai' })
    expect(dubSupport('openrouter')).toMatchObject({ available: true, provider: 'openrouter' })
    const chatgpt = dubSupport('chatgpt')
    expect(chatgpt.available).toBe(false)
    expect(chatgpt.reason).toMatch(/ChatGPT sign-in/)
  })

  it('estimates from characters at the model list price', () => {
    const model = dubSupport('api').models.find((m) => m.id === 'tts-1')!
    expect(estimateDubCostUsd(1_000_000, model)).toBe(15)
    expect(estimateDubCostUsd(2000, model)).toBeCloseTo(0.03, 9)
  })
})

describe('synthesising speech', () => {
  let cacheDir: string
  beforeAll(async () => { cacheDir = await mkdtemp(join(tmpdir(), 'cutawan-dub-cache-')) })
  afterAll(async () => { await rm(cacheDir, { recursive: true, force: true }) })
  afterEach(() => {
    vi.unstubAllGlobals()
    configureOpenAiEndpoints({})
  })

  function mockSpeech(): Array<{ url: string; body: Record<string, unknown>; auth: string }> {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) })
      return new Response(new Uint8Array(512).fill(7), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }))
    return calls
  }

  it('posts to the OpenAI-compatible speech endpoint of the configured base', async () => {
    const calls = mockSpeech()
    configureOpenAiEndpoints({ chatBase: 'https://example.test/v1' })
    const bytes = await synthesizeSpeech('sk-x', { model: 'tts-1', voice: 'nova', input: 'Hola', speed: 1.3 })
    expect(bytes.length).toBe(512)
    const expectedBase = process.env.OPENAI_BASE_URL?.trim() ? process.env.OPENAI_BASE_URL.trim().replace(/\/$/, '') : 'https://example.test/v1'
    expect(calls[0].url).toBe(`${expectedBase}/audio/speech`)
    expect(calls[0].body).toEqual({ model: 'tts-1', voice: 'nova', input: 'Hola', response_format: 'mp3', speed: 1.3 })
    expect(calls[0].auth).toBe('Bearer sk-x')
  })

  it('uses OpenRouter speech on the OpenRouter route', async () => {
    const calls = mockSpeech()
    configureOpenAiEndpoints({ openRouter: true })
    await synthesizeSpeech('or-key', { model: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'alloy', input: 'Hi', instructions: 'Speak briskly' })
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/audio/speech')
    expect(calls[0].body.instructions).toBe('Speak briskly')
  })

  it('counts only uncached characters in the estimate', async () => {
    const transcript = makeTranscript(SENTENCES, { sentenceGapSec: 1 })
    const clip = makeClip(transcript)
    const model = dubSupport('api').models[1]
    const choice = { provider: 'openai' as const, model, voice: 'alloy' }
    const before = estimateDub(clip, transcript, cacheDir, choice)
    expect(before.lines).toBe(3)
    expect(before.uncachedCharacters).toBe(before.characters)
    await writeFile(speechCachePath(cacheDir, { model: model.id, voice: 'alloy', input: 'línea 1' }), 'x')
    const after = estimateDub(clip, transcript, cacheDir, choice)
    expect(after.uncachedCharacters).toBe(before.characters - 'línea 1'.length)
    expect(after.usdMax).toBeCloseTo(after.usd * 2, 12)
  })
})
