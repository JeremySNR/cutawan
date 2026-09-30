import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatContext,
  formatModelPrice,
  looksLikeModelId,
  matchesModelQuery,
  OPENROUTER_API_BASE,
  parseOpenRouterModels
} from '../src/shared/openrouter'
import { normalizeSubscription } from '../src/shared/subscription'
import { chatApiBase, configureOpenAiEndpoints, OpenAIError, transcriptionApiBase, withWordTimings } from '../src/main/pipeline/openai'

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'openrouter-catalog.json'), 'utf8')) as {
  models: unknown
  transcription: unknown
}

describe('OpenRouter catalogue', () => {
  it('keeps text models, drops image generators, and sorts by name', () => {
    const models = parseOpenRouterModels(fixture.models, 'llm')
    const ids = models.map(m => m.id)
    expect(ids).toContain('openai/gpt-5.4-mini')
    expect(ids).not.toContain('openai/gpt-image-1')
    expect(models.map(m => m.name)).toEqual([...models.map(m => m.name)].sort((a, b) => a.localeCompare(b)))
  })

  it('converts per-token prices to per-million and flags vision input', () => {
    const mini = parseOpenRouterModels(fixture.models, 'llm').find(m => m.id === 'openai/gpt-5.4-mini')!
    expect(mini.promptPricePerM).toBe(0.25)
    expect(mini.completionPricePerM).toBe(2)
    expect(mini.vision).toBe(true)
    expect(formatModelPrice(mini)).toBe('$0.25 in · $2 out per 1M')
    expect(formatContext(mini.contextLength)).toBe('400K context')
  })

  it('treats variable router pricing as unknown and zero pricing as free', () => {
    const models = parseOpenRouterModels(fixture.models, 'llm')
    expect(formatModelPrice(models.find(m => m.id === 'openrouter/auto')!)).toBeNull()
    expect(formatModelPrice(models.find(m => m.id === 'openai/gpt-oss-120b:free')!)).toBe('Free')
  })

  it('keeps every transcription model and tolerates malformed responses', () => {
    expect(parseOpenRouterModels(fixture.transcription, 'transcription').map(m => m.id)).toContain('openai/whisper-1')
    expect(parseOpenRouterModels(null, 'llm')).toEqual([])
    expect(parseOpenRouterModels({ data: [{ id: 3 }, { id: 'a/b' }, { id: 'a/b' }] }, 'llm')).toHaveLength(1)
  })

  it('searches every term across name and id', () => {
    const model = { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5' }
    expect(matchesModelQuery(model, 'claude sonnet')).toBe(true)
    expect(matchesModelQuery(model, 'ANTHROPIC/')).toBe(true)
    expect(matchesModelQuery(model, 'claude opus')).toBe(false)
    expect(looksLikeModelId('vendor/model-1.2:free')).toBe(true)
    expect(looksLikeModelId('gemini flash')).toBe(false)
  })

  it('accepts OpenRouter as a stored provider', () => {
    expect(normalizeSubscription({ provider: 'openrouter' }).provider).toBe('openrouter')
    expect(normalizeSubscription({ provider: 'claude' as never }).provider).toBe('api')
  })
})

describe('OpenRouter routing', () => {
  const envBase = process.env.OPENAI_BASE_URL
  afterEach(() => {
    configureOpenAiEndpoints({})
    if (envBase === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = envBase
  })

  it('sends chat and transcription to OpenRouter, ignoring OpenAI base URLs', () => {
    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1'
    configureOpenAiEndpoints({ chatBase: 'http://localhost:1234/v1', transcriptionBase: 'http://localhost:9000/v1', openRouter: true })
    expect(chatApiBase()).toBe(OPENROUTER_API_BASE)
    expect(transcriptionApiBase()).toBe(OPENROUTER_API_BASE)
    configureOpenAiEndpoints({ chatBase: 'http://localhost:1234/v1' })
    expect(chatApiBase()).toBe('https://proxy.example.com/v1')
  })
})

describe('withWordTimings', () => {
  const base = { language: 'en', duration: 4, text: 'hello big world' }

  it('leaves responses that already carry word timings alone', () => {
    const res = { ...base, words: [{ word: 'hello', start: 0, end: 1 }] }
    expect(withWordTimings(res, 'openai/whisper-1')).toBe(res)
  })

  it('spreads segment timings across words, weighted by length', () => {
    const res = withWordTimings({ ...base, segments: [{ id: 0, text: ' hello big world', start: 1, end: 3.6 }] }, 'x/model')
    expect(res.words?.map(w => w.word)).toEqual(['hello', 'big', 'world'])
    expect(res.words?.[0]).toEqual({ word: 'hello', start: 1, end: 2 })
    expect(res.words?.[2].end).toBeCloseTo(3.6)
  })

  it('explains the fix when a model returns no timestamps at all', () => {
    expect(() => withWordTimings(base, 'x/text-only')).toThrow(OpenAIError)
    expect(() => withWordTimings(base, 'x/text-only')).toThrow(/Whisper model or local transcription/)
  })

  it('accepts silent audio with no text', () => {
    expect(withWordTimings({ ...base, text: '' }, 'x/model').words).toBeUndefined()
  })
})
