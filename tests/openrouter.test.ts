import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL,
  formatContext,
  isSupportedTranscriptionModel,
  formatModelPrice,
  looksLikeModelId,
  matchesModelQuery,
  OPENROUTER_API_BASE,
  parseOpenRouterModels
} from '../src/shared/openrouter'
import { normalizeSubscription } from '../src/shared/subscription'
import {
  chatApiBase,
  configureOpenAiEndpoints,
  OPENROUTER_AUDIO_CHUNK_SEC,
  OpenAIError,
  requireWordTimings,
  transcribeAudioFile,
  transcriptionApiBase,
  transcriptionChunkSec
} from '../src/main/pipeline/openai'
import { configureSubscription } from '../src/main/subscription'
import { DEFAULT_SUBSCRIPTION } from '../src/shared/subscription'

vi.mock('../src/main/settings', () => ({ getOpenRouterKey: () => '' }))
const { listOpenRouterModels } = await import('../src/main/openrouter')

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

describe('OpenRouter transcription allowlist', () => {
  afterEach(() => { delete process.env.CUTAWAN_OPENROUTER_CATALOG })

  it('allows only the Whisper models, which return word timestamps', () => {
    expect(isSupportedTranscriptionModel(DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL)).toBe(true)
    expect(isSupportedTranscriptionModel('openai/whisper-large-v3-turbo')).toBe(true)
    // Rejects verbose_json with HTTP 400.
    expect(isSupportedTranscriptionModel('openai/gpt-4o-transcribe')).toBe(false)
    expect(isSupportedTranscriptionModel('mistralai/voxtral-mini-transcribe')).toBe(false)
  })

  it('drops unsupported models from the live transcription list', async () => {
    process.env.CUTAWAN_OPENROUTER_CATALOG = join(__dirname, 'fixtures', 'openrouter-catalog.json')
    const catalog = await listOpenRouterModels(true)
    expect(catalog.live).toBe(true)
    expect(catalog.transcription.map(m => m.id).sort()).toEqual(
      ['openai/whisper-1', 'openai/whisper-large-v3', 'openai/whisper-large-v3-turbo']
    )
  })

  it('keeps the allowlist when the catalogue cannot be read', async () => {
    process.env.CUTAWAN_OPENROUTER_CATALOG = '/nonexistent/catalog.json'
    const catalog = await listOpenRouterModels(true)
    expect(catalog.live).toBe(false)
    expect(catalog.transcription.every(m => isSupportedTranscriptionModel(m.id))).toBe(true)
    expect(catalog.transcription).toHaveLength(3)
  })
})

describe('OpenRouter transcription requests', () => {
  let dir = ''
  afterEach(async () => {
    vi.unstubAllGlobals()
    configureOpenAiEndpoints({})
    configureSubscription(DEFAULT_SUBSCRIPTION)
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  const reply = { language: 'en', duration: 2, text: 'hello world', words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'world', start: 0.6, end: 1 }] }

  it('sends the documented JSON body with word and segment timestamps', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-or-'))
    const file = join(dir, 'audio-0.mp3')
    await writeFile(file, Buffer.from('mp3-bytes'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    configureOpenAiEndpoints({ openRouter: true })

    const res = await transcribeAudioFile('sk-or-test', file, 'openai/whisper-1', { language: 'en', contextPrompt: 'earlier text' })
    expect(res.words).toHaveLength(2)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${OPENROUTER_API_BASE}/audio/transcriptions`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      model: 'openai/whisper-1',
      input_audio: { data: Buffer.from('mp3-bytes').toString('base64'), format: 'mp3' },
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      language: 'en'
    })
  })

  it('labels seam-repair WAV files and omits language when auto-detecting', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-or-'))
    const file = join(dir, 'audio.wav')
    await writeFile(file, Buffer.from('wav'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    configureOpenAiEndpoints({ openRouter: true })
    await transcribeAudioFile('k', file, 'openai/whisper-large-v3', { language: 'auto' })
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.input_audio.format).toBe('wav')
    expect(body).not.toHaveProperty('language')
  })

  it('does not retry (and re-bill) a reply without word timestamps', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-or-'))
    const file = join(dir, 'audio-0.mp3')
    await writeFile(file, Buffer.from('mp3'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ language: 'en', duration: 2, text: 'hello world' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    configureOpenAiEndpoints({ openRouter: true })
    await expect(transcribeAudioFile('k', file, 'openai/whisper-1')).rejects.toThrow(/no word timestamps/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to send a key from another route after a provider switch mid-job', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-or-'))
    const file = join(dir, 'audio-0.mp3')
    await writeFile(file, Buffer.from('mp3'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    // The job read the OpenAI key, then Settings switched to OpenRouter.
    configureOpenAiEndpoints({ openRouter: true, credential: () => 'sk-or-current' })
    await expect(transcribeAudioFile('sk-openai-old', file, 'openai/whisper-1')).rejects.toThrow(/connection changed/)
    expect(fetchMock).not.toHaveBeenCalled()
    await transcribeAudioFile('sk-or-current', file, 'openai/whisper-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('also refuses when the new route has no key stored', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-or-'))
    const file = join(dir, 'audio-0.mp3')
    await writeFile(file, Buffer.from('mp3'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    configureOpenAiEndpoints({ openRouter: true, credential: () => '' })
    await expect(transcribeAudioFile('sk-openai-old', file, 'openai/whisper-1')).rejects.toThrow(/connection changed/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses short chunks for OpenRouter to stay inside its 60 s upstream timeout', () => {
    expect(transcriptionChunkSec(1200)).toBe(1200)
    configureOpenAiEndpoints({ openRouter: true })
    expect(transcriptionChunkSec(1200)).toBe(OPENROUTER_AUDIO_CHUNK_SEC)
    configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'openrouter', localTranscription: true })
    expect(transcriptionChunkSec(1200)).toBe(1200)
  })
})

describe('requireWordTimings', () => {
  const base = { language: 'en', duration: 4, text: 'hello big world' }

  it('passes responses that carry word timings', () => {
    const res = { ...base, words: [{ word: 'hello', start: 0, end: 1 }] }
    expect(requireWordTimings(res, 'openai/whisper-1')).toBe(res)
  })

  it('fails with a fix when speech comes back without word timings', () => {
    const segmentsOnly = { ...base, segments: [{ id: 0, text: 'hello big world', start: 0, end: 3 }] }
    expect(() => requireWordTimings(segmentsOnly, 'openai/whisper-1')).toThrow(OpenAIError)
    expect(() => requireWordTimings(base, 'openai/whisper-1')).toThrow(/local transcription/)
  })

  it('accepts silent audio with no text', () => {
    expect(requireWordTimings({ ...base, text: '' }, 'openai/whisper-1').words).toBeUndefined()
  })
})
