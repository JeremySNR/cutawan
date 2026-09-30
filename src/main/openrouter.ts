import { readFile } from 'node:fs/promises'
import {
  OPENROUTER_API_BASE,
  parseOpenRouterModels,
  suggestedAsModels,
  SUGGESTED_OPENROUTER_MODELS,
  OPENROUTER_TRANSCRIPTION_MODELS,
  isSupportedTranscriptionModel,
  type OpenRouterCatalog
} from '@shared/openrouter'
import { getOpenRouterKey } from './settings'

const CATALOG_TTL_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 12_000

let cached: { at: number; catalog: OpenRouterCatalog } | null = null

async function getJson(path: string, key?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${OPENROUTER_API_BASE}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* non-JSON body */ }
  return { status: res.status, body }
}

/**
 * The public model catalogue (no key needed): chat models, and the
 * transcription models OpenRouter serves at /audio/transcriptions that
 * Cutawan can use (word timestamps required). Offline,
 * the suggested models stand in so setup still works.
 * `CUTAWAN_OPENROUTER_CATALOG` points at a saved `/models` response, for
 * headless checks without network access.
 */
export async function listOpenRouterModels(refresh = false): Promise<OpenRouterCatalog> {
  if (!refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog
  const fixture = process.env.CUTAWAN_OPENROUTER_CATALOG
  try {
    let llm, transcription
    if (fixture) {
      const saved = JSON.parse(await readFile(fixture, 'utf8')) as { models: unknown; transcription: unknown }
      llm = parseOpenRouterModels(saved.models, 'llm')
      transcription = parseOpenRouterModels(saved.transcription, 'transcription')
    } else {
      const [chat, speech] = await Promise.all([
        getJson('/models'),
        getJson('/models?output_modalities=transcription').catch(() => ({ status: 0, body: null }))
      ])
      if (chat.status !== 200) throw new Error(`OpenRouter returned HTTP ${chat.status}`)
      llm = parseOpenRouterModels(chat.body, 'llm')
      transcription = parseOpenRouterModels(speech.body, 'transcription')
    }
    if (!llm.length) throw new Error('OpenRouter returned no models')
    // Only models that return word timestamps; see OPENROUTER_TRANSCRIPTION_MODELS.
    // A short or failed transcription listing keeps the whole allowlist.
    const supported = transcription.filter(m => isSupportedTranscriptionModel(m.id))
    const catalog: OpenRouterCatalog = {
      llm,
      transcription: supported.length ? supported : suggestedAsModels(OPENROUTER_TRANSCRIPTION_MODELS),
      live: true
    }
    cached = { at: Date.now(), catalog }
    return catalog
  } catch (error) {
    return {
      llm: suggestedAsModels(SUGGESTED_OPENROUTER_MODELS),
      transcription: suggestedAsModels(OPENROUTER_TRANSCRIPTION_MODELS),
      live: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Validate a key (the typed one, else the stored one) with OpenRouter's
 * key-info endpoint. Makes no model request and costs nothing.
 */
export async function checkOpenRouterKey(typed?: string): Promise<{ message: string }> {
  const key = typed?.trim() || getOpenRouterKey()
  if (!key) throw new Error('Enter an OpenRouter API key first.')
  let res: { status: number; body: unknown }
  try {
    res = await getJson('/key', key)
  } catch (error) {
    throw new Error(`Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (res.status === 401 || res.status === 403) throw new Error('OpenRouter rejected this key. Copy it again from openrouter.ai/keys.')
  if (res.status !== 200) throw new Error(`OpenRouter key check failed (HTTP ${res.status}).`)
  const data = (res.body as { data?: { limit_remaining?: unknown; is_free_tier?: unknown } } | null)?.data
  const remaining = typeof data?.limit_remaining === 'number' ? ` $${data.limit_remaining.toFixed(2)} of this key’s limit remains.` : ''
  const free = data?.is_free_tier === true ? ' This account is on the free tier; add credits to use paid models.' : ''
  return { message: `OpenRouter accepted the key.${remaining}${free}` }
}
