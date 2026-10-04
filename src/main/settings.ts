import { DEFAULT_SUBSCRIPTION, normalizeSubscription, type SubscriptionSettings } from '@shared/subscription'
import { configureSubscription } from './subscription'
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  BrollSource,
  MetachlorianIntendedUse,
  BrandingSettings,
  BrandVoiceSettings,
  BrowserCookieSource,
  EncoderPreference,
  QualityPreference,
  SettingsUpdate,
} from '@shared/types'
import { getGpuStatus } from './pipeline/encoders'
import { clearImportCookiesFile, getImportCookiesPath } from './cookies'
import { DEFAULT_BRAND_COLORS } from '@shared/captionStyles'
import { normalizeSizeTargetMb } from '@shared/uploadBudget'
import { chatApiBase, configureOpenAiEndpoints } from './pipeline/openai'
import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL, isSupportedTranscriptionModel } from '@shared/openrouter'
import { normaliseMetachlorianUrl, type MetachlorianConnection } from './pipeline/metachlorian'


interface StoredSettings {
  setupComplete: boolean
  subscription: SubscriptionSettings
  /** Base64 of safeStorage-encrypted key, or plain 'plain:'-prefixed fallback. */
  apiKeyEncrypted: string
  transcriptionModel: string
  /** ISO-639-1 language code forced on Whisper, or 'auto' to auto-detect. */
  transcriptionLanguage: string
  analysisModel: string
  /** OpenRouter key, encrypted the same way as `apiKeyEncrypted`. */
  openRouterKeyEncrypted: string
  openRouterModel: string
  openRouterTranscriptionModel: string
  openaiBaseUrl: string
  transcriptionBaseUrl: string
  encoder: EncoderPreference
  quality: QualityPreference
  /** Megabyte cap for size-targeted export; null = quality-targeted encode. */
  sizeTargetMb: number | null
  branding: BrandingSettings
  brandVoice: BrandVoiceSettings
  importCookiesBrowser: BrowserCookieSource
  brollSource: BrollSource
  metachlorianUrl: string
  /** Metachlorian access token, encrypted the same way as `apiKeyEncrypted`. */
  metachlorianTokenEncrypted: string
  metachlorianIntendedUse: MetachlorianIntendedUse
}

const DEFAULT_INTENDED_USE: MetachlorianIntendedUse = { use: '', channel: '', territory: '' }

const DEFAULT_BRANDING: BrandingSettings = {
  enabled: false,
  imagePath: null,
  position: 'bottom-right',
  opacity: 0.8,
  scale: 0.16,
  colors: DEFAULT_BRAND_COLORS
}

const DEFAULT_BRAND_VOICE: BrandVoiceSettings = {
  brandName: '',
  tone: '',
  style: '',
  avoid: ''
}

const DEFAULTS: StoredSettings = {
  setupComplete: false,
  subscription: { ...DEFAULT_SUBSCRIPTION },
  apiKeyEncrypted: '',
  transcriptionModel: 'whisper-1',
  // Default to English rather than Whisper's auto-detect: the app is
  // English-first, and auto-detect occasionally mislabels English speech as a
  // similar-sounding language (e.g. Welsh). Users of other languages can pick
  // theirs — or 'auto' — in Settings.
  transcriptionLanguage: 'en',
  analysisModel: 'gpt-5.4-mini',
  openRouterKeyEncrypted: '',
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  openRouterTranscriptionModel: DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL,
  openaiBaseUrl: '',
  transcriptionBaseUrl: '',
  encoder: 'auto',
  quality: 'standard',
  sizeTargetMb: null,
  branding: DEFAULT_BRANDING,
  brandVoice: DEFAULT_BRAND_VOICE,
  importCookiesBrowser: '',
  brollSource: 'web',
  metachlorianUrl: '',
  metachlorianTokenEncrypted: '',
  metachlorianIntendedUse: DEFAULT_INTENDED_USE
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: StoredSettings | null = null

function applyEndpoints(s: StoredSettings): void {
  configureSubscription(s.subscription)
  configureOpenAiEndpoints({
    chatBase: s.openaiBaseUrl,
    transcriptionBase: s.transcriptionBaseUrl,
    openRouter: s.subscription.provider === 'openrouter',
    credential: getAnalysisCredential
  })
}

function storedBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/\/$/, '')
}

/** Only allowlisted OpenRouter transcription models; anything else reverts to the default. */
function supportedTranscriptionModel(raw: unknown): string {
  return typeof raw === 'string' && isSupportedTranscriptionModel(raw.trim())
    ? raw.trim() : DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL
}

function load(): StoredSettings {
  if (cache) return cache
  try {
    if (existsSync(settingsPath())) {
      const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<StoredSettings>
      cache = {
        ...DEFAULTS,
        ...parsed,
        // Existing installations should not be interrupted by a new wizard.
        setupComplete: parsed.setupComplete !== false,
        subscription: normalizeSubscription(parsed.subscription),
        openaiBaseUrl: storedBaseUrl(parsed.openaiBaseUrl),
        transcriptionBaseUrl: storedBaseUrl(parsed.transcriptionBaseUrl),
        openRouterTranscriptionModel: supportedTranscriptionModel(parsed.openRouterTranscriptionModel),
        // Nested objects: merge so settings saved before new fields stay valid.
        sizeTargetMb: normalizeSizeTargetMb(parsed.sizeTargetMb),
        branding: {
          ...DEFAULT_BRANDING,
          ...(parsed.branding ?? {}),
          colors: { ...DEFAULT_BRAND_COLORS, ...(parsed.branding?.colors ?? {}) }
        },
        brandVoice: { ...DEFAULT_BRAND_VOICE, ...(parsed.brandVoice ?? {}) },
        brollSource: parsed.brollSource === 'metachlorian' ? 'metachlorian' : 'web',
        metachlorianIntendedUse: { ...DEFAULT_INTENDED_USE, ...(parsed.metachlorianIntendedUse ?? {}) }
      }
      applyEndpoints(cache)
      return cache
    }
  } catch {
    /* corrupted settings fall back to defaults */
  }
  cache = { ...DEFAULTS }
  applyEndpoints(cache)
  return cache
}

function persist(s: StoredSettings): void {
  cache = s
  applyEndpoints(s)
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8')
}

function encryptKey(key: string): string {
  if (key === '') return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64')
  }
  // Headless Linux without a keyring: store obfuscated-but-recoverable.
  return 'plain:' + Buffer.from(key, 'utf8').toString('base64')
}

function decryptKey(stored: string): string {
  if (stored === '') return ''
  try {
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    }
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

export function getApiKey(): string {
  const envKey = process.env.OPENAI_API_KEY
  const stored = decryptKey(load().apiKeyEncrypted)
  return stored || envKey || ''
}

export function getOpenRouterKey(): string {
  return decryptKey(load().openRouterKeyEncrypted) || process.env.OPENROUTER_API_KEY || ''
}

export function getMetachlorianToken(): string {
  return decryptKey(load().metachlorianTokenEncrypted) || process.env.METACHLORIAN_TOKEN || ''
}

/** The configured Metachlorian server, with any typed (unsaved) values taking precedence. */
export function getMetachlorianConnection(typed?: { url?: string; token?: string }): MetachlorianConnection {
  return {
    url: normaliseMetachlorianUrl(typed?.url || load().metachlorianUrl),
    token: typed?.token?.trim() || getMetachlorianToken()
  }
}

/** Synchronous access to the B-roll source preferences. */
export function getBrollPreferences(): { source: BrollSource; intendedUse: MetachlorianIntendedUse } {
  const s = load()
  return { source: s.brollSource, intendedUse: s.metachlorianIntendedUse }
}

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key ? '•••' : ''
}

/** What to ask for when the selected provider has no credential. */
export function missingCredentialName(): string {
  return load().subscription.provider === 'openrouter' ? 'OpenRouter key' : 'OpenAI API key'
}

/** Credential for analysis (and hosted transcription) on the selected provider. */
export function getAnalysisCredential(): string {
  const provider = load().subscription.provider
  if (provider === 'chatgpt') return 'local-codex-subscription'
  if (provider === 'openrouter') return getOpenRouterKey()
  return getApiKey()
}

export async function getSettings(): Promise<AppSettings> {
  const s = load()
  applyEndpoints(s)
  const key = getApiKey()
  const openRouterKey = getOpenRouterKey()
  return {
    setupComplete: s.setupComplete || Boolean(process.env.CUTAWAN_SMOKE && !process.env.CUTAWAN_SMOKE_WIZARD),
    subscription: { ...s.subscription },
    hasApiKey: key.length > 0,
    apiKeyMasked: maskKey(key),
    keyStorageSecure: safeStorage.isEncryptionAvailable(),
    transcriptionModel: s.transcriptionModel,
    transcriptionLanguage: s.transcriptionLanguage,
    analysisModel: s.analysisModel,
    hasOpenRouterKey: openRouterKey.length > 0,
    openRouterKeyMasked: maskKey(openRouterKey),
    openRouterModel: s.openRouterModel,
    openRouterTranscriptionModel: s.openRouterTranscriptionModel,
    openaiBaseUrl: s.openaiBaseUrl,
    transcriptionBaseUrl: s.transcriptionBaseUrl,
    openaiBaseUrlFromEnv: Boolean(process.env.OPENAI_BASE_URL?.trim()),
    encoder: s.encoder,
    quality: s.quality,
    sizeTargetMb: s.sizeTargetMb,
    gpu: await getGpuStatus(),
    branding: s.branding,
    brandVoice: s.brandVoice,
    appVersion: app.getVersion(),
    importCookiesBrowser: s.importCookiesBrowser,
    hasImportCookiesFile: getImportCookiesPath() !== null,
    brollSource: s.brollSource,
    metachlorianUrl: s.metachlorianUrl,
    hasMetachlorianToken: getMetachlorianToken().length > 0,
    metachlorianTokenMasked: maskKey(getMetachlorianToken()),
    metachlorianIntendedUse: { ...s.metachlorianIntendedUse }
  }
}

/** Synchronous access to the URL-import preferences. */
export function getImportPreferences(): {
  importCookiesBrowser: BrowserCookieSource
  importCookiesPath: string | null
} {
  return {
    importCookiesBrowser: load().importCookiesBrowser,
    importCookiesPath: getImportCookiesPath()
  }
}

/** Synchronous access to the stored branding preferences. */
export function getBrandingSettings(): BrandingSettings {
  return load().branding
}

/** Synchronous access to the stored brand tone-of-voice settings. */
export function getBrandVoiceSettings(): BrandVoiceSettings {
  return load().brandVoice
}

/** Synchronous access to the stored encoder/quality/size-cap preferences. */
export function getExportPreferences(): {
  encoder: EncoderPreference
  quality: QualityPreference
  sizeTargetMb: number | null
} {
  const s = load()
  return { encoder: s.encoder, quality: s.quality, sizeTargetMb: s.sizeTargetMb }
}

/** Synchronous access to the stored model preferences (no GPU probe). */
export function getModelPreferences(): {
  transcriptionModel: string
  transcriptionLanguage: string
  analysisModel: string
  analysisProviderKey: string
} {
  const s = load()
  const openRouter = s.subscription.provider === 'openrouter'
  return {
    transcriptionModel: openRouter ? s.openRouterTranscriptionModel : s.transcriptionModel,
    transcriptionLanguage: s.transcriptionLanguage,
    analysisModel: openRouter ? s.openRouterModel : s.analysisModel,
    analysisProviderKey: s.subscription.provider === 'chatgpt'
      ? `chatgpt:${s.subscription.codexModel}:low`
      : `api:${chatApiBase()}`
  }
}

export async function updateSettings(update: SettingsUpdate): Promise<AppSettings> {
  const s = { ...load() }
  if (update.setupComplete !== undefined) s.setupComplete = update.setupComplete
  if (update.subscription !== undefined) s.subscription = normalizeSubscription({ ...s.subscription, ...update.subscription })
  if (update.apiKey !== undefined) s.apiKeyEncrypted = encryptKey(update.apiKey.trim())
  if (update.transcriptionModel !== undefined && update.transcriptionModel.trim()) {
    s.transcriptionModel = update.transcriptionModel.trim()
  }
  if (update.transcriptionLanguage !== undefined && update.transcriptionLanguage.trim()) {
    s.transcriptionLanguage = update.transcriptionLanguage.trim()
  }
  if (update.analysisModel !== undefined && update.analysisModel.trim()) {
    s.analysisModel = update.analysisModel.trim()
  }
  if (update.openRouterKey !== undefined) s.openRouterKeyEncrypted = encryptKey(update.openRouterKey.trim())
  if (update.openRouterModel !== undefined && update.openRouterModel.trim()) {
    s.openRouterModel = update.openRouterModel.trim()
  }
  if (update.openRouterTranscriptionModel !== undefined) {
    if (!isSupportedTranscriptionModel(update.openRouterTranscriptionModel.trim())) {
      throw new Error(`${update.openRouterTranscriptionModel} can't be used for transcription: Cutawan needs word timestamps, which only OpenRouter's Whisper models return.`)
    }
    s.openRouterTranscriptionModel = update.openRouterTranscriptionModel.trim()
  }
  if (update.openaiBaseUrl !== undefined) s.openaiBaseUrl = storedBaseUrl(update.openaiBaseUrl)
  if (update.transcriptionBaseUrl !== undefined) {
    s.transcriptionBaseUrl = storedBaseUrl(update.transcriptionBaseUrl)
  }
  if (update.encoder !== undefined) s.encoder = update.encoder
  if (update.quality !== undefined) s.quality = update.quality
  if (update.sizeTargetMb !== undefined) s.sizeTargetMb = normalizeSizeTargetMb(update.sizeTargetMb)
  if (update.branding !== undefined) {
    const b = update.branding
    s.branding = {
      ...s.branding,
      ...b,
      ...(b.colors !== undefined ? { colors: { ...s.branding.colors, ...b.colors } } : {})
    }
  }
  if (update.brandVoice !== undefined) {
    s.brandVoice = { ...s.brandVoice, ...update.brandVoice }
  }
  if (update.importCookiesBrowser !== undefined) s.importCookiesBrowser = update.importCookiesBrowser
  if (update.clearImportCookiesFile) await clearImportCookiesFile()
  if (update.brollSource !== undefined) s.brollSource = update.brollSource === 'metachlorian' ? 'metachlorian' : 'web'
  if (update.metachlorianUrl !== undefined) s.metachlorianUrl = normaliseMetachlorianUrl(update.metachlorianUrl)
  if (update.metachlorianToken !== undefined) s.metachlorianTokenEncrypted = encryptKey(update.metachlorianToken.trim())
  if (update.metachlorianIntendedUse !== undefined) {
    const next = { ...s.metachlorianIntendedUse, ...update.metachlorianIntendedUse }
    s.metachlorianIntendedUse = { use: next.use.trim(), channel: next.channel.trim(), territory: next.territory.trim().toUpperCase() }
  }
  persist(s)
  return getSettings()
}
