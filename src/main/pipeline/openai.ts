import { usesSubscription, usesLocalTranscription, subscriptionJSON, transcribeLocally } from '../subscription'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { analysisRequests } from './mediaJobs'
import { OPENROUTER_API_BASE } from '@shared/openrouter'

/**
 * Minimal OpenAI REST client using Node's built-in fetch, so the app has no
 * SDK dependency. Only the two endpoints the pipeline needs are wrapped.
 * All calls retry transient failures with exponential backoff and support
 * cancellation via AbortSignal.
 */

export const DEFAULT_OPENAI_API_BASE = 'https://api.openai.com/v1'

/**
 * Resolve an OpenAI-compatible REST base URL. Empty, whitespace, relative
 * values like "/v1", and other non-absolute URLs fall back to the default —
 * otherwise fetch() posts to "/v1/audio/transcriptions" and Whisper fails
 * with HTTP 404 "Invalid URL".
 *
 * `OPENAI_BASE_URL` still wins when set (cloud agents, CI). Settings values
 * are applied through `configureOpenAiEndpoints`.
 */
export function resolveOpenAiApiBase(
  envBase: string | undefined = process.env.OPENAI_BASE_URL
): string {
  const raw = envBase?.trim()
  if (!raw) return DEFAULT_OPENAI_API_BASE

  const trimmed = raw.replace(/\/$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    console.warn(
      `[cutawan] API base URL must be an absolute http(s) URL (got ${JSON.stringify(raw)}); using ${DEFAULT_OPENAI_API_BASE}`
    )
    return DEFAULT_OPENAI_API_BASE
  }

  try {
    const url = new URL(trimmed)
    // api.openai.com serves the REST API under /v1 — accept the bare host too.
    if (url.hostname === 'api.openai.com') {
      const path = url.pathname.replace(/\/$/, '')
      if (path === '' || path === '/') return `${url.origin}/v1`
    }
    return trimmed
  } catch {
    console.warn(
      `[cutawan] API base URL is invalid (${JSON.stringify(raw)}); using ${DEFAULT_OPENAI_API_BASE}`
    )
    return DEFAULT_OPENAI_API_BASE
  }
}

/**
 * Settings-sourced bases. Env vars still take precedence so a cloud/CI
 * `OPENAI_BASE_URL` cannot be silently overridden by a leftover Settings field.
 */
let settingsChatBase: string | undefined
let settingsTranscriptionBase: string | undefined
let openRouter = false

export function configureOpenAiEndpoints(opts: {
  chatBase?: string
  transcriptionBase?: string
  /**
   * OpenRouter is its own provider: both chat and transcription go to
   * openrouter.ai with the OpenRouter key, and the OpenAI base URL settings
   * and env vars do not apply.
   */
  openRouter?: boolean
}): void {
  settingsChatBase = opts.chatBase?.trim() || undefined
  settingsTranscriptionBase = opts.transcriptionBase?.trim() || undefined
  openRouter = opts.openRouter === true
}

/** Chat completions base (analysis, captions, B-roll, visual scoring). */
export function chatApiBase(): string {
  if (openRouter) return OPENROUTER_API_BASE
  return resolveOpenAiApiBase(process.env.OPENAI_BASE_URL || settingsChatBase)
}

/**
 * Whisper transcription base. A dedicated transcription URL (env or Settings)
 * wins, then the shared chat base, then the OpenAI default — so a local
 * Whisper server can sit next to a hosted LLM.
 */
export function transcriptionApiBase(): string {
  if (openRouter) return OPENROUTER_API_BASE
  return resolveOpenAiApiBase(
    process.env.OPENAI_TRANSCRIPTION_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      settingsTranscriptionBase ||
      settingsChatBase
  )
}

/** OpenRouter's optional app attribution headers; nothing for other endpoints. */
function providerHeaders(): Record<string, string> {
  return openRouter ? { 'HTTP-Referer': 'https://github.com/JeremySNR/cutawan', 'X-Title': 'Cutawan' } : {}
}

export class OpenAIError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'OpenAIError'
  }
}

/** Client errors that retrying cannot fix (bad key, bad request, not found). */
function isNonRetryable(err: unknown): boolean {
  return (
    err instanceof OpenAIError &&
    err.status !== undefined &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  )
}

/**
 * Combine an optional caller cancel signal with a hard timeout, so a connection
 * a firewall silently blackholes aborts instead of hanging the request forever
 * (fetch has no default timeout). Returns a signal that fires on either.
 */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Per-attempt request timeouts. Every fetch in this module must carry one:
 * on a restricted network a silently blackholed connection otherwise hangs
 * the pipeline (or a caption button) forever, and the retry loop never fires
 * because the fetch never rejects. Each retry gets a fresh window.
 * Transcription uploads ~7 MB per chunk, so it gets more headroom.
 */
export const CHAT_TIMEOUT_MS = 5 * 60_000
export const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  signal?: AbortSignal
}

/** Run `fn` with exponential backoff on transient failures. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4
  const baseDelayMs = opts.baseDelayMs ?? 1500
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    opts.signal?.throwIfAborted()
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (opts.signal?.aborted || isNonRetryable(err)) throw err
      if (attempt < attempts - 1) {
        const jitter = Math.random() * 0.3 + 0.85
        await sleep(baseDelayMs * 2 ** attempt * jitter, undefined, { signal: opts.signal })
      }
    }
  }
  throw lastError
}

async function raiseForStatus(res: Response, context: string): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) {
    throw new OpenAIError('The API rejected the API key. Check it in Settings.', 401)
  }
  throw new OpenAIError(`${context} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, res.status)
}

export interface WhisperWord {
  word: string
  start: number
  end: number
}

export interface WhisperSegment {
  id: number
  text: string
  start: number
  end: number
  /**
   * Decoder diagnostics Whisper reports per segment. Together they identify
   * the hallucinations it produces on silence and music — see
   * `isHallucinatedSegment` in transcribe.ts. Absent on some models.
   */
  no_speech_prob?: number
  avg_logprob?: number
  compression_ratio?: number
}

export interface WhisperResponse {
  language: string
  duration: number
  text: string
  words?: WhisperWord[]
  segments?: WhisperSegment[]
}

export interface TranscribeFileOptions {
  /** Trailing text of the previous chunk, for cross-chunk context continuity. */
  contextPrompt?: string
  /**
   * ISO-639-1 language code (e.g. 'en'). When set, Whisper transcribes in that
   * language instead of auto-detecting — which avoids it occasionally guessing
   * the wrong language. Omit or pass 'auto' to let Whisper detect.
   */
  language?: string
  signal?: AbortSignal
}

export async function transcribeAudioFile(
  apiKey: string,
  filePath: string,
  model: string,
  opts: TranscribeFileOptions = {}
): Promise<WhisperResponse> {
  if (usesLocalTranscription()) return transcribeLocally(filePath, opts)
  if (openRouter) return transcribeWithOpenRouter(apiKey, filePath, model, opts)
  const bytes = await readFile(filePath)
  return withRetries(
    async () => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }), basename(filePath))
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'word')
      form.append('timestamp_granularities[]', 'segment')
      if (opts.contextPrompt) form.append('prompt', opts.contextPrompt)
      if (opts.language && opts.language !== 'auto') form.append('language', opts.language)

      const res = await fetch(`${transcriptionApiBase()}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: withTimeout(TRANSCRIBE_TIMEOUT_MS, opts.signal)
      })
      await raiseForStatus(res, 'Transcription')
      return (await res.json()) as WhisperResponse
    },
    { signal: opts.signal }
  )
}

/**
 * OpenRouter's documented JSON form: base64 audio plus the fields its
 * transcription schema lists. It has no top-level `prompt` (that is a
 * per-provider option), so chunks are transcribed without the previous
 * chunk's text; the overlap and seam repair still cover the joins.
 */
async function transcribeWithOpenRouter(
  apiKey: string,
  filePath: string,
  model: string,
  opts: TranscribeFileOptions
): Promise<WhisperResponse> {
  const body = JSON.stringify({
    model,
    input_audio: {
      data: (await readFile(filePath)).toString('base64'),
      format: filePath.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3'
    },
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
    ...(opts.language && opts.language !== 'auto' ? { language: opts.language } : {})
  })
  return withRetries(
    async () => {
      const res = await fetch(`${OPENROUTER_API_BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...providerHeaders() },
        body,
        signal: withTimeout(TRANSCRIBE_TIMEOUT_MS, opts.signal)
      })
      await raiseForStatus(res, 'Transcription')
      return requireWordTimings((await res.json()) as WhisperResponse, model)
    },
    { signal: opts.signal }
  )
}

/**
 * Captions, cut tightening and clip timing need per-word timestamps. A reply
 * with speech but no words (a provider that ignored the timestamp request)
 * fails with a fix rather than producing a transcript that cannot be timed.
 */
export function requireWordTimings(res: WhisperResponse, model: string): WhisperResponse {
  if (res.words?.length || !res.text?.trim()) return res
  throw new OpenAIError(
    `${model} returned no word timestamps. Choose another Whisper model or local transcription in Settings.`
  )
}

/**
 * Audio chunk length for the active transcription route. OpenRouter stops
 * waiting on its upstream after 60 seconds, so its chunks are short enough to
 * transcribe well inside that; direct APIs keep the long default.
 */
export const OPENROUTER_AUDIO_CHUNK_SEC = 5 * 60
export function transcriptionChunkSec(defaultSec: number): number {
  return openRouter && !usesLocalTranscription() ? OPENROUTER_AUDIO_CHUNK_SEC : defaultSec
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export interface ChatMessage {
  role: 'system' | 'user'
  content: string | ChatContentPart[]
}

export async function chatJSON<T>(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  schemaName: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  if (usesSubscription()) return subscriptionJSON<T>(messages, schema, signal)
  return withRetries(
    async () => {
      const content = await analysisRequests.run(() => completeChatContent(
        apiKey,
        model,
        messages,
        schemaName,
        schema,
        signal
      ), signal)
      try {
        return JSON.parse(content) as T
      } catch {
        throw new OpenAIError('Analysis returned invalid JSON')
      }
    },
    { signal }
  )
}

function looksLikeUnsupportedFormat(err: unknown): boolean {
  if (!(err instanceof OpenAIError) || (err.status !== 400 && err.status !== 422)) return false
  const m = err.message.toLowerCase()
  return /response_format|json_schema|json_object|strict|not supported|unknown parameter|unrecognized|invalid parameter/.test(
    m
  )
}

function looksLikeInvalidJson(err: unknown): boolean {
  return err instanceof OpenAIError && err.status === undefined && err.message === 'Analysis returned invalid JSON'
}

function schemaInstruction(schemaName: string, schema: Record<string, unknown>): string {
  return `Return only a JSON object matching the ${schemaName} schema:\n${JSON.stringify(schema, null, 2)}\nNo markdown, no commentary.`
}

function messagesWithSchemaInstruction(
  messages: ChatMessage[],
  schemaName: string,
  schema: Record<string, unknown>
): ChatMessage[] {
  return [...messages, { role: 'user', content: schemaInstruction(schemaName, schema) }]
}

/**
 * Compatible endpoints (Ollama, LM Studio, some Groq/OpenRouter models) often
 * reject OpenAI's strict json_schema. Try that first, then json_object, then
 * a bare completion with an instruction to return JSON.
 */
async function completeChatContent(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  schemaName: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const formats: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: 'json_schema',
      body: {
        model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema }
        }
      }
    },
    {
      label: 'json_object',
      body: {
        model,
        messages: messagesWithSchemaInstruction(messages, schemaName, schema),
        response_format: { type: 'json_object' }
      }
    },
    {
      label: 'plain',
      body: {
        model,
        messages: messagesWithSchemaInstruction(messages, schemaName, schema)
      }
    }
  ]

  let lastError: unknown
  for (let i = 0; i < formats.length; i++) {
    const format = formats[i]
    const isLast = i === formats.length - 1
    try {
      const res = await fetch(`${chatApiBase()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...providerHeaders()
        },
        body: JSON.stringify(format.body),
        signal: withTimeout(CHAT_TIMEOUT_MS, signal)
      })
      await raiseForStatus(res, 'Analysis')
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = body.choices?.[0]?.message?.content
      if (!content) throw new OpenAIError('Analysis returned an empty response')
      const text = extractJsonText(content)
      try {
        JSON.parse(text)
      } catch {
        throw new OpenAIError('Analysis returned invalid JSON')
      }
      return text
    } catch (err) {
      lastError = err
      if (signal?.aborted) throw err
      const canTryNext = looksLikeUnsupportedFormat(err) || looksLikeInvalidJson(err)
      if (!canTryNext || isLast) throw err
    }
  }
  throw lastError
}

/** Strip optional markdown fences some local models wrap JSON in. */
export function extractJsonText(content: string): string {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}
