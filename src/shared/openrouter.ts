/**
 * OpenRouter (openrouter.ai): one API key for chat models from many vendors,
 * plus hosted Whisper transcription, behind an OpenAI-compatible REST API.
 * Shared by the main process (catalogue fetch, request routing) and the
 * renderer (model pickers).
 */

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys'

/** Analysis default: the model Cutawan's prompts are tuned against, via OpenRouter. */
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.4-mini'
/** Transcription default: Whisper returns the word timestamps captions need. */
export const DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL = 'openai/whisper-1'

export interface OpenRouterModel {
  id: string
  name: string
  /** Context window in tokens; null when OpenRouter does not say. */
  contextLength: number | null
  /** USD per million input tokens; null when unknown or not token-priced. */
  promptPricePerM: number | null
  /** USD per million output tokens; null when unknown or not token-priced. */
  completionPricePerM: number | null
  /** Accepts image input. Cutawan sends sampled frames for visual scoring. */
  vision: boolean
}

export interface OpenRouterCatalog {
  llm: OpenRouterModel[]
  transcription: OpenRouterModel[]
  /** False when the live catalogue could not be fetched and suggestions stand in. */
  live: boolean
  error?: string
}

export interface SuggestedModel {
  id: string
  name: string
  note: string
}

/**
 * Shown at the top of the analysis picker. Entries missing from the live
 * catalogue are hidden, so a retired model never gets suggested.
 */
export const SUGGESTED_OPENROUTER_MODELS: SuggestedModel[] = [
  { id: 'openai/gpt-5.4-mini', name: 'OpenAI: GPT-5.4 Mini', note: 'Recommended · fast, low cost, tuned for Cutawan' },
  { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', note: 'Low cost · long context for long videos' },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', note: 'Careful clip picking and titles' },
  { id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5', note: 'Highest quality · slower and pricier' }
]

/**
 * The only OpenRouter transcription models Cutawan allows. Captions, cut
 * tightening and clip timing need per-word timestamps, which means the
 * request must use `response_format: "verbose_json"` with
 * `timestamp_granularities: ["word", "segment"]`. Through OpenRouter that is
 * reliably honoured only by the Whisper models, served by OpenAI-compatible
 * upstreams (OpenAI, Groq, Together). Other listed models either reject
 * verbose_json with HTTP 400 (e.g. openai/gpt-4o-transcribe,
 * microsoft/mai-transcribe-1.5, Google Chirp), return no word timings, or
 * limit input to short or PCM-only clips (AssemblyAI sync at 120 s, Meta
 * Muse Voice WAV-only), which Cutawan's chunked MP3 uploads cannot meet.
 */
export const OPENROUTER_TRANSCRIPTION_MODELS: SuggestedModel[] = [
  { id: 'openai/whisper-1', name: 'OpenAI: Whisper', note: 'Recommended · served by OpenAI' },
  { id: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large v3 Turbo', note: 'Fastest and cheapest' },
  { id: 'openai/whisper-large-v3', name: 'OpenAI: Whisper Large v3', note: 'Most accurate open Whisper' }
]

export function isSupportedTranscriptionModel(id: string): boolean {
  return OPENROUTER_TRANSCRIPTION_MODELS.some(m => m.id === id)
}

function perMillion(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  // OpenRouter uses -1 for "variable" pricing (routers such as openrouter/auto).
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1e6 * 1e4) / 1e4
}

function modalities(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : []
}

interface RawModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
  architecture?: { input_modalities?: unknown; output_modalities?: unknown }
}

/**
 * Normalise a `GET /models` response. With `kind: 'llm'` only models that
 * read and write text are kept; `'transcription'` keeps everything (that list
 * is already filtered server-side by `output_modalities=transcription`).
 */
export function parseOpenRouterModels(json: unknown, kind: 'llm' | 'transcription'): OpenRouterModel[] {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const seen = new Set<string>()
  const models: OpenRouterModel[] = []
  for (const raw of data as RawModel[]) {
    if (typeof raw?.id !== 'string' || !raw.id.trim() || seen.has(raw.id)) continue
    const input = modalities(raw.architecture?.input_modalities)
    const output = modalities(raw.architecture?.output_modalities)
    if (kind === 'llm' && ((input.length && !input.includes('text')) || (output.length && !output.includes('text')))) continue
    seen.add(raw.id)
    const context = typeof raw.context_length === 'number' && raw.context_length > 0 ? raw.context_length : null
    models.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id,
      contextLength: context,
      promptPricePerM: perMillion(raw.pricing?.prompt),
      completionPricePerM: perMillion(raw.pricing?.completion),
      vision: input.includes('image')
    })
  }
  return models.sort((a, b) => a.name.localeCompare(b.name))
}

/** Suggestions as catalogue entries, for when the live catalogue is unavailable. */
export function suggestedAsModels(suggested: SuggestedModel[]): OpenRouterModel[] {
  return suggested.map(s => ({
    id: s.id, name: s.name, contextLength: null, promptPricePerM: null, completionPricePerM: null, vision: false
  }))
}

/** Case-insensitive match on every whitespace-separated term, across name and id. */
export function matchesModelQuery(model: { id: string; name: string }, query: string): boolean {
  const haystack = `${model.name} ${model.id}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term))
}

/** A typed id that could be a model slug, offered as a custom choice. */
export function looksLikeModelId(value: string): boolean {
  return /^[\w.-]+\/[\w.:-]+$/.test(value.trim())
}

function formatPrice(value: number): string {
  if (value === 0) return '0'
  if (value < 0.1) return value.toFixed(3).replace(/0+$/, '')
  if (value < 10) return value.toFixed(2).replace(/\.?0+$/, '')
  return value.toFixed(0)
}

/** "$0.25 in · $2 out per 1M", "Free", or null when pricing is unknown. */
export function formatModelPrice(model: OpenRouterModel): string | null {
  const { promptPricePerM: input, completionPricePerM: output } = model
  if (input === null || output === null) return null
  if (input === 0 && output === 0) return 'Free'
  return `$${formatPrice(input)} in · $${formatPrice(output)} out per 1M`
}

/** "128K context", "1M context". */
export function formatContext(tokens: number | null): string | null {
  if (!tokens) return null
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M context`.replace('.0M', 'M')
  return `${Math.round(tokens / 1000)}K context`
}
