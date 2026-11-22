import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectHighlights } from '../src/main/pipeline/highlights'
import { chatJSON } from '../src/main/pipeline/openai'
import { transcriptSentences } from '@shared/sentences'
import { makeTranscript } from './helpers'

/**
 * ChatGPT sign-in has a small daily request cap and no retries, so a long
 * video must cost it the same number of requests as a short one, and none of
 * the optional extra requests (a repair of a broken selection, the
 * comparative rerank, the video outline and distant joins) may run on it.
 */
vi.mock('../src/main/subscription', () => ({ usesSubscription: () => true, throwIfSubscriptionError: () => undefined }))
vi.mock('../src/main/pipeline/openai', () => ({ chatJSON: vi.fn() }))

afterEach(() => vi.resetAllMocks())

const clipFields = (n: number) => ({
  title: `clip ${n}`, hook: 'hook', summary: 'summary', payoff: 'payoff',
  score_parts: { hook: 20, emotion: 10, value: 10, structure: 10, shareability: n % 9 },
  virality_score: 0, virality_reason: 'because', hashtags: ['a']
})

describe('detectHighlights on ChatGPT sign-in', () => {
  const transcript = makeTranscript(
    Array.from({ length: 2700 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const options = { prompt: '', clipLength: 'auto' as const, broll: false, hookFirst: true, videoType: 'auto' as const }

  it('spends one request per stage on a two-hour transcript', async () => {
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') {
        return { clips: Array.from({ length: 20 }, (_, n) => ({ start_line: n * 100, end_line: n * 100 + 6, ...clipFields(n) })) }
      }
      return schema === 'clip_endings' ? { endings: [] } : { starts: [] }
    })
    const clips = await detectHighlights('key', 'model', transcript, options, transcript.durationSec)
    expect(clips).toHaveLength(20)
    const schemas = vi.mocked(chatJSON).mock.calls.map((call) => call[3])
    // No comparative rerank: the one selection request saw every clip at once.
    expect(schemas).toEqual(['viral_clips', 'clip_endings', 'clip_openings'])
    // The one request shows the whole transcript, not a part of it.
    const user = vi.mocked(chatJSON).mock.calls[0][2][1].content as string
    expect(user).not.toMatch(/This is part/)
    expect(user).toContain(sentences[sentences.length - 1].text)
  })

  it('does not ask for a repair of a selection that breaks the rules', async () => {
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') {
        return {
          clips: [
            { start_line: 10, end_line: 16, ...clipFields(1) },
            // An unknown line and an end before the start: two violations.
            { start_line: 400, end_line: 99999, ...clipFields(2) },
            { start_line: 900, end_line: 890, ...clipFields(3) }
          ]
        }
      }
      return schema === 'clip_endings' ? { endings: [] } : { starts: [] }
    })
    const clips = await detectHighlights('key', 'model', transcript, options, transcript.durationSec)
    expect(clips.map((c) => c.title)).toEqual(['clip 1'])
    expect(vi.mocked(chatJSON).mock.calls.map((call) => call[3])).toEqual(['viral_clips', 'clip_endings', 'clip_openings'])
  })

  it('adds only the join review when clips join separate moments', async () => {
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') {
        return {
          clips: [
            { segments: [{ start_line: 10, end_line: 13 }, { start_line: 40, end_line: 43 }], join_reason: 'skips a tangent', ...clipFields(1) },
            // Over the cap as a joined clip: a violation, dropped without a repair request.
            { segments: [{ start_line: 100, end_line: 130 }, { start_line: 200, end_line: 230 }], join_reason: 'too long', ...clipFields(2) },
            { segments: [{ start_line: 300, end_line: 306 }], join_reason: '', ...clipFields(3) }
          ]
        }
      }
      if (schema === 'clip_joins') return { clips: [{ index: 0, seamless: true, faithful: true, reason: 'follows' }] }
      return schema === 'clip_endings' ? { endings: [] } : { starts: [] }
    })
    const clips = await detectHighlights('key', 'model', transcript, { ...options, stitch: true }, transcript.durationSec)
    expect(clips.map((c) => c.title).sort()).toEqual(['clip 1', 'clip 3'])
    expect(vi.mocked(chatJSON).mock.calls.map((call) => call[3])).toEqual(['viral_clips', 'clip_joins', 'clip_endings', 'clip_openings'])
  })

  it('builds no outline and proposes no distant joins, even with a cache directory', async () => {
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') {
        return { clips: [{ segments: [{ start_line: 10, end_line: 13 }, { start_line: 40, end_line: 43 }], join_reason: 'skips a tangent', ...clipFields(1) }] }
      }
      if (schema === 'clip_joins') return { clips: [{ index: 0, seamless: true, faithful: true, reason: 'follows' }] }
      return schema === 'clip_endings' ? { endings: [] } : { starts: [] }
    })
    const dir = await mkdtemp(join(tmpdir(), 'cutawan-outline-sub-'))
    try {
      await detectHighlights('key', 'model', transcript, { ...options, stitch: true }, transcript.durationSec,
        undefined, undefined, { cacheDir: dir, providerCacheKey: 'chatgpt:model:low' })
      const schemas = vi.mocked(chatJSON).mock.calls.map((call) => call[3])
      expect(schemas).toEqual(['viral_clips', 'clip_joins', 'clip_endings', 'clip_openings'])
      expect(schemas.some((s) => s.startsWith('outline') || s === 'long_range_joins')).toBe(false)
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('spends no opening review when hook-first is off', async () => {
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') return { clips: [{ start_line: 10, end_line: 16, ...clipFields(1) }] }
      return { endings: [] }
    })
    await detectHighlights('key', 'model', transcript, { ...options, hookFirst: false }, transcript.durationSec)
    expect(vi.mocked(chatJSON).mock.calls.map((call) => call[3])).toEqual(['viral_clips', 'clip_endings'])
  })

  it('spends no extra request on speaker, reaction and topic marks or clip kinds', async () => {
    const marked = {
      ...transcript,
      speakerTurns: Array.from({ length: 27 }, (_, n) => ({ start: sentences[n * 100].start, end: sentences[n * 100 + 99].end, speaker: n % 2 })),
      reactions: [{ start: sentences[16].end + 0.1, end: sentences[16].end + 2, strength: 0.9, kind: 'laughter' as const }]
    }
    // A topic every 200 lines, from a stand-in for the local embedding model.
    const embedder = {
      id: 'test',
      embed: async (texts: string[]) => texts.map((t) => {
        const v = new Float32Array(16)
        v[Math.floor(Number(t.match(/sentence (\d+)/)?.[1] ?? 0) / 200) % 16] = 1
        return v
      })
    }
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') {
        return { clips: Array.from({ length: 20 }, (_, n) => ({ start_line: n * 100 + 10, end_line: n * 100 + 16, kind: n % 2 ? 'funny' : 'story', ...clipFields(n) })) }
      }
      return schema === 'clip_endings' ? { endings: [] } : { starts: [] }
    })
    const clips = await detectHighlights('key', 'model', marked, options, transcript.durationSec, undefined, undefined, { embedder })
    expect(clips).toHaveLength(20)
    expect(vi.mocked(chatJSON).mock.calls.map((call) => call[3])).toEqual(['viral_clips', 'clip_endings', 'clip_openings'])
    const user = vi.mocked(chatJSON).mock.calls[0][2][1].content as string
    expect(user).toContain('(Speaker B)')
    expect(user).toContain('[laughter after]')
    expect(user).toContain('— topic change —')
    expect(clips.every((c) => c.kind === 'story' || c.kind === 'funny')).toBe(true)
  })
})
