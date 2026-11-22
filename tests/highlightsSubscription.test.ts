import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectHighlights } from '../src/main/pipeline/highlights'
import { chatJSON } from '../src/main/pipeline/openai'
import { transcriptSentences } from '@shared/sentences'
import { makeTranscript } from './helpers'

/**
 * ChatGPT sign-in has a small daily request cap and no retries, so a long
 * video must cost it the same number of requests as a short one.
 */
vi.mock('../src/main/subscription', () => ({ usesSubscription: () => true, throwIfSubscriptionError: () => undefined }))
vi.mock('../src/main/pipeline/openai', () => ({ chatJSON: vi.fn() }))

afterEach(() => vi.resetAllMocks())

describe('detectHighlights on ChatGPT sign-in', () => {
  it('spends one request per stage on a two-hour transcript', async () => {
    const transcript = makeTranscript(
      Array.from({ length: 2700 }, (_, i) => `sentence ${i} word three four five.`),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
    )
    const sentences = transcriptSentences(transcript)
    vi.mocked(chatJSON).mockImplementation(async (_key, _model, _messages, schema) => {
      if (schema === 'viral_clips') {
        return {
          clips: Array.from({ length: 20 }, (_, n) => ({
            start: sentences[n * 100].start, end: sentences[n * 100 + 6].end,
            title: `clip ${n}`, hook: 'hook', summary: 'summary', payoff: 'payoff',
            score_parts: { hook: 20, emotion: 10, value: 10, structure: 10, shareability: n % 9 },
            virality_score: 0, virality_reason: 'because', hashtags: ['a']
          }))
        }
      }
      return schema === 'clip_endings' ? { endings: [] } : { starts: [] }
    })
    const clips = await detectHighlights('key', 'model', transcript,
      { prompt: '', clipLength: 'auto', broll: false, hookFirst: true, videoType: 'auto' }, transcript.durationSec)
    expect(clips).toHaveLength(20)
    const schemas = vi.mocked(chatJSON).mock.calls.map((call) => call[3])
    expect(schemas).toEqual(['viral_clips', 'clip_endings', 'clip_openings'])
    // The one request shows the whole transcript, not a part of it.
    const user = vi.mocked(chatJSON).mock.calls[0][2][1].content as string
    expect(user).not.toMatch(/This is part/)
    expect(user).toContain(sentences[sentences.length - 1].text)
  })
})
