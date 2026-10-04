import SubscriptionSettings from './SubscriptionSettings'
import OpenRouterSetup, { type OpenRouterChoice } from './OpenRouterSetup'
import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL } from '@shared/openrouter'
import { DEFAULT_SUBSCRIPTION } from '@shared/subscription'
import { useEffect, useState } from 'react'
import {
  X,
  KeyRound,
  Brain,
  Check,
  ExternalLink,
  ImagePlus,
  MonitorPlay,
  RefreshCw,
  Stamp,
  Trash2,
  Type,
  Zap,
  Download,
  Languages,
  Loader2,
  Palette,
  MessageSquareQuote,
  Server,
} from 'lucide-react'
import { useStore } from '../store'
import { NotesList, userNotes, WhatsNewDialog } from './WhatsNew'
import { parseNotes } from '@shared/releaseNotes'
import SizeTargetControls from './SizeTargetControls'
import BrollSourceSettings from './BrollSourceSettings'
import { DEFAULT_BRAND_COLORS, resolveCaptionStyle } from '@shared/captionStyles'
import type {
  BrandColors,
  BrandVoiceSettings,
  EncoderPreference,
  ImportProgress,
  QualityPreference,
  WatermarkPosition
} from '@shared/types'

const ANALYSIS_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-4o-mini']

/** Whisper transcription languages. 'auto' lets Whisper detect per video. */
const TRANSCRIPTION_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Auto-detect' },
  { value: 'cy', label: 'Welsh' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'ru', label: 'Russian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' }
]

const ENCODERS: Array<{ value: EncoderPreference; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'GPU when ready' },
  { value: 'gpu', label: 'Hardware', hint: navigator.platform.startsWith('Mac') ? 'VideoToolbox' : 'NVIDIA NVENC' },
  { value: 'cpu', label: 'CPU', hint: 'libx264' }
]

const QUALITIES: Array<{ value: QualityPreference; label: string; hint: string }> = [
  { value: 'draft', label: 'Draft', hint: 'Fastest' },
  { value: 'standard', label: 'Standard', hint: 'Balanced' },
  { value: 'high', label: 'High', hint: 'Best quality' }
]

const WATERMARK_POSITIONS: Array<{ value: WatermarkPosition; label: string }> = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
]

type SectionId = 'general' | 'broll' | 'export' | 'branding' | 'voice' | 'fonts' | 'updates'

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof KeyRound }> = [
  { id: 'general', label: 'API & models', icon: KeyRound },
  { id: 'broll', label: 'B-roll', icon: ImagePlus },
  { id: 'export', label: 'Export', icon: MonitorPlay },
  { id: 'branding', label: 'Branding', icon: Stamp },
  { id: 'voice', label: 'Brand voice', icon: MessageSquareQuote },
  { id: 'fonts', label: 'Fonts', icon: Type },
  { id: 'updates', label: 'Updates', icon: RefreshCw }
]

export default function SettingsModal(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const saveSettings = useStore((s) => s.saveSettings)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const [subscription, setSubscription] = useState(settings?.subscription ?? DEFAULT_SUBSCRIPTION)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.analysisModel ?? 'gpt-5.4-mini')
  const [openRouter, setOpenRouter] = useState<OpenRouterChoice>({
    apiKey: '',
    model: settings?.openRouterModel ?? DEFAULT_OPENROUTER_MODEL,
    transcriptionModel: settings?.openRouterTranscriptionModel ?? DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL
  })
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(settings?.openaiBaseUrl ?? '')
  const [transcriptionBaseUrl, setTranscriptionBaseUrl] = useState(
    settings?.transcriptionBaseUrl ?? ''
  )
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [gpuProgress, setGpuProgress] = useState<ImportProgress | null>(null)
  const [gpuError, setGpuError] = useState<string | null>(null)
  const [section, setSection] = useState<SectionId>(useStore.getState().settingsInitialSection)

  useEffect(() => window.cutawan.onGpuProgress(setGpuProgress), [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveSettings({
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        subscription,
        analysisModel: model,
        openaiBaseUrl,
        transcriptionBaseUrl,
        openRouterModel: openRouter.model,
        openRouterTranscriptionModel: openRouter.transcriptionModel,
        ...(openRouter.apiKey.trim() ? { openRouterKey: openRouter.apiKey.trim() } : {})
      })
      setApiKey('')
      setOpenRouter(current => ({ ...current, apiKey: '' }))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const downloadGpu = async (): Promise<void> => {
    setGpuError(null)
    setGpuProgress({ progress: 0, message: 'Starting download…' })
    try {
      await window.cutawan.downloadGpuFfmpeg()
      await refreshSettings()
    } catch (err) {
      setGpuError(err instanceof Error ? err.message : String(err))
    } finally {
      setGpuProgress(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={() => setSettingsOpen(false)}
    >
      <div
        className="flex h-[85vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-surface-900/90 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="flex w-56 shrink-0 flex-col border-r border-surface-700 bg-surface-900/50 p-3">
          <h2 className="px-2 py-2 text-lg font-semibold">Settings</h2>
          <nav className="mt-1 flex flex-col gap-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                data-testid={`settings-nav-${id}`}
                onClick={() => setSection(id)}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
                  section === id
                    ? 'bg-white/[0.08] text-zinc-100'
                    : 'text-zinc-400 hover:bg-surface-800 hover:text-zinc-200'
                }`}
              >
                <Icon size={15} className={section === id ? 'text-accent-400' : ''} />
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="relative flex-1 overflow-y-auto p-6">
          <button
            onClick={() => setSettingsOpen(false)}
            className="absolute right-4 top-4 z-10 rounded-lg p-1.5 text-zinc-500 transition hover:bg-surface-800 hover:text-zinc-200"
          >
            <X size={18} />
          </button>

          {section === 'general' && (
            <div className="max-w-xl">
              <SubscriptionSettings value={subscription} onChange={setSubscription} onSave={save} />
              {subscription.provider === 'openrouter' && <div className="mb-6">
                <OpenRouterSetup value={openRouter} onChange={patch => setOpenRouter(current => ({ ...current, ...patch }))}
                  subscription={subscription} onSubscriptionChange={patch => setSubscription(current => ({ ...current, ...patch }))} />
              </div>}
              {subscription.provider === 'api' && <>
              <div>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound size={15} className="text-accent-400" />
                  OpenAI API key
                </label>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Used for {subscription.localTranscription ? 'clip analysis' : 'Whisper transcription and clip analysis'}. Stored encrypted on this machine
            and never sent anywhere except the API base below (OpenAI by default).
          </p>
          {settings !== null && !settings.keyStorageSecure && (
            <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-400">
              Your OS keychain is unavailable, so the key is stored only obfuscated on disk.
              Prefer a key with a spending limit on this machine.
            </p>
          )}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.hasApiKey ? `Current: ${settings.apiKeyMasked}` : 'sk-…'}
            className="mt-2.5 w-full rounded-xl border border-surface-600 bg-surface-850 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none"
          />
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-zinc-400 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200"
          >
            Get an API key <ExternalLink size={11} />
          </a>
        </div>

        <div className="mt-5">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Server size={15} className="text-accent-400" />
            API base URL
          </label>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            OpenAI-compatible endpoint for analysis (and transcription, unless you set a
            separate one below). Azure OpenAI, OpenRouter, Groq, LM Studio, Ollama. Leave
            blank for api.openai.com.
          </p>
          {settings?.openaiBaseUrlFromEnv && (
            <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-400">
              OPENAI_BASE_URL is set in the environment, so it overrides these fields until
              you unset it.
            </p>
          )}
          <input
            data-testid="openai-base-url"
            type="url"
            value={openaiBaseUrl}
            onChange={(e) => setOpenaiBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            disabled={settings?.openaiBaseUrlFromEnv}
            className="mt-2.5 w-full rounded-xl border border-surface-600 bg-surface-850 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none disabled:opacity-50"
          />
          <label className="mt-3 block text-[11px] font-medium text-zinc-500">
            Transcription base URL (optional)
          </label>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Point Whisper at a local server (faster-whisper, whisper.cpp’s OpenAI-compatible
            endpoint) while clip finding stays on the chat base above. Needs word-level
            timestamps. Leave blank to use the same URL.
          </p>
          <input
            data-testid="transcription-base-url"
            type="url"
            value={transcriptionBaseUrl}
            onChange={(e) => setTranscriptionBaseUrl(e.target.value)}
            placeholder="Same as API base URL"
            disabled={settings?.openaiBaseUrlFromEnv}
            className="mt-2 w-full rounded-xl border border-surface-600 bg-surface-850 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="mt-5">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Brain size={15} className="text-accent-400" />
            Analysis model
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            gpt-5.4-mini is fast and cheap; gpt-5.4 and gpt-5.5 pick moments more carefully.
            gpt-4o-mini is the budget legacy option.
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            {ANALYSIS_MODELS.map((m) => (
              <button
                key={m}
                onClick={() => setModel(m)}
                className={`rounded-xl border px-3 py-2 text-xs font-medium transition ${
                  model === m
                    ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                    : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        </>}
        <div className="mt-5">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Languages size={15} className="text-accent-400" />
            Transcription language
          </label>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            The spoken language Whisper transcribes. Leave on English (or pick yours) rather than
            Auto-detect — auto sometimes mislabels the language (e.g. English as Welsh).
          </p>
          <select
            value={settings?.transcriptionLanguage ?? 'en'}
            onChange={(e) => void saveSettings({ transcriptionLanguage: e.target.value })}
            className="mt-2.5 w-full rounded-xl border border-surface-600 bg-surface-850 px-3.5 py-2.5 text-sm text-zinc-200 focus:border-white/25 focus:outline-none"
          >
            {TRANSCRIPTION_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
              </div>

              <button
                onClick={() => void save()}
                disabled={saving}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-60"
              >
                {saved ? <Check size={16} /> : null}
                {saved ? 'Saved' : saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          )}

          {section === 'export' && (
            <div className="max-w-xl">
              <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <MonitorPlay size={15} className="text-accent-400" />
            Export encoder
          </label>
          <div
            className={`mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
              settings?.gpu.available
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-surface-850 text-zinc-500'
            }`}
          >
            <Zap size={13} className="mt-0.5 shrink-0" />
            <span>{settings?.gpu.detail ?? 'Checking GPU…'}</span>
          </div>
          {settings?.gpu.canDownloadFfmpeg &&
            (gpuProgress ? (
              <div className="mt-2 rounded-lg border border-surface-600 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs text-zinc-300">
                  <Loader2 size={13} className="animate-spin text-zinc-300" />
                  {gpuProgress.message}
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-700">
                  <div
                    className="h-full rounded-full bg-zinc-200 transition-all"
                    style={{ width: `${Math.round(Math.max(0, gpuProgress.progress) * 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <button
                onClick={() => void downloadGpu()}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
              >
                <Download size={13} />
                Download GPU-enabled ffmpeg (~40 MB, one time)
              </button>
            ))}
          {gpuError && <p className="mt-2 text-xs text-red-400">{gpuError}</p>}
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {ENCODERS.map((e) => (
              <button
                key={e.value}
                onClick={() => void saveSettings({ encoder: e.value })}
                disabled={e.value === 'gpu' && !settings?.gpu.available}
                className={`rounded-xl border px-2 py-2 text-center transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  settings?.encoder === e.value
                    ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                    : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                }`}
              >
                <div className="text-xs font-medium">{e.label}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">{e.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <label className="flex items-center gap-2 text-sm font-medium">
            <MonitorPlay size={15} className="text-accent-400" />
            Export quality
          </label>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {QUALITIES.map((q) => (
              <button
                key={q.value}
                onClick={() => void saveSettings({ quality: q.value })}
                className={`rounded-xl border px-2 py-2 text-center transition ${
                  settings?.quality === q.value
                    ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                    : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                }`}
              >
                <div className="text-xs font-medium">{q.label}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">{q.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <SizeTargetControls />
            </div>
          )}

          {section === 'broll' && <BrollSourceSettings />}
          {section === 'branding' && <BrandingSection />}
          {section === 'voice' && <BrandVoiceSection />}
          {section === 'fonts' && <FontsSection />}
          {section === 'updates' && <UpdatesSection />}
        </div>
      </div>
    </div>
  )
}

function BrandingSection(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const selectBrandingLogo = useStore((s) => s.selectBrandingLogo)
  const branding = settings?.branding
  const colors = branding?.colors ?? DEFAULT_BRAND_COLORS

  const saveColors = (patch: Partial<BrandColors>): void => {
    void saveSettings({ branding: { colors: { ...colors, ...patch } } })
  }

  return (
    <div className="max-w-xl">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Stamp size={15} className="text-accent-400" />
        Branding
      </label>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Set your logo, watermark, and brand colours. Colours apply as defaults across every
        caption style in the preview and exports.
      </p>

      <div className="mt-4 rounded-xl border border-surface-700 bg-surface-850 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Palette size={15} className="text-accent-400" />
          Brand colours
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          Primary is the highlight or pill fill; secondary is the active-word text on pill styles.
          Leave text/outline on preset to keep each style&apos;s defaults.
        </p>

        <div className="mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-surface-600 px-3 py-2.5">
          <span className="text-xs font-medium text-zinc-300">Use brand colours on captions</span>
          <button
            onClick={() => saveColors({ enabled: !colors.enabled })}
            className={`relative h-5 w-9 shrink-0 rounded-full transition ${colors.enabled ? 'bg-zinc-100' : 'bg-surface-600'}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${colors.enabled ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`}
            />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <ColorField
            label="Primary"
            value={colors.primaryColor}
            onChange={(v) => saveColors({ primaryColor: v })}
          />
          <ColorField
            label="Secondary"
            value={colors.secondaryColor}
            onChange={(v) => saveColors({ secondaryColor: v })}
          />
          <ColorField
            label="Caption text"
            value={colors.textColor ?? ''}
            pickerFallback="#FFFFFF"
            placeholder="Style default"
            onChange={(v) => saveColors({ textColor: v })}
            onClear={colors.textColor ? () => saveColors({ textColor: null }) : undefined}
          />
          <ColorField
            label="Outline"
            value={colors.outlineColor ?? ''}
            pickerFallback="#000000"
            placeholder="Style default"
            onChange={(v) => saveColors({ outlineColor: v })}
            onClear={colors.outlineColor ? () => saveColors({ outlineColor: null }) : undefined}
          />
          <ColorField
            label="Hook text"
            value={colors.hookTextColor}
            onChange={(v) => saveColors({ hookTextColor: v })}
          />
          <ColorField
            label="Hook background"
            value={colors.hookBackgroundColor}
            onChange={(v) => saveColors({ hookBackgroundColor: v })}
          />
        </div>

        <div className="mt-3 rounded-lg border border-surface-600 bg-black/40 px-3 py-2.5">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Preview
          </div>
          {(() => {
            const preview = resolveCaptionStyle('beast', colors)
            const pill = resolveCaptionStyle('pill', colors)
            return (
              <div className="flex flex-wrap items-center gap-4">
                <span
                  className="text-sm font-bold"
                  style={{ color: preview.textColor, fontFamily: `'${preview.fontFamily}', sans-serif` }}
                >
                  SO I{' '}
                  <span style={{ color: preview.highlightColor }}>SAID</span>
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-sm font-bold"
                  style={{
                    color: pill.highlightColor,
                    backgroundColor: pill.highlightBoxColor ?? 'transparent',
                    fontFamily: `'${pill.fontFamily}', sans-serif`
                  }}
                >
                  SAID
                </span>
              </div>
            )
          })()}
        </div>

        <button
          onClick={() => saveColors({ ...DEFAULT_BRAND_COLORS, enabled: colors.enabled })}
          className="mt-3 text-[11px] text-zinc-500 transition hover:text-zinc-300"
        >
          Reset colours to Cutawan defaults
        </button>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-zinc-500">
        Overlay your logo or watermark on every clip — shown in the preview and burned into
        exports, underneath the captions.
      </p>

      <div className="mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-surface-600 px-3 py-2.5">
        <span className="text-xs font-medium text-zinc-300">Watermark on exports</span>
        <button
          onClick={() => void saveSettings({ branding: { enabled: !branding?.enabled } })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition ${branding?.enabled ? 'bg-zinc-100' : 'bg-surface-600'}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${branding?.enabled ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`}
          />
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        {branding?.imagePath ? (
          <img
            src={window.cutawan.mediaUrl(branding.imagePath)}
            alt="Watermark"
            className="h-12 w-12 shrink-0 rounded-lg border border-surface-600 bg-black/40 object-contain p-1"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-surface-600 text-zinc-600">
            <ImagePlus size={16} />
          </div>
        )}
        <button
          onClick={() => void selectBrandingLogo()}
          className="flex-1 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
        >
          {branding?.imagePath ? 'Replace logo image…' : 'Choose logo image…'}
        </button>
        {branding?.imagePath && (
          <button
            onClick={() => void saveSettings({ branding: { imagePath: null, enabled: false } })}
            title="Remove logo"
            className="rounded-lg p-2 text-zinc-500 transition hover:bg-surface-800 hover:text-red-400"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {branding?.imagePath && (
        <>
          <div className="mt-2.5 grid grid-cols-4 gap-2">
            {WATERMARK_POSITIONS.map((p) => (
              <button
                key={p.value}
                onClick={() => void saveSettings({ branding: { position: p.value } })}
                className={`rounded-xl border px-1 py-2 text-center text-[11px] font-medium transition ${
                  branding.position === p.value
                    ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                    : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                <span>Size</span>
                <span>{Math.round(branding.scale * 100)}% width</span>
              </div>
              <input
                type="range"
                min={4}
                max={40}
                value={Math.round(branding.scale * 100)}
                onChange={(e) =>
                  void saveSettings({ branding: { scale: Number(e.target.value) / 100 } })
                }
                className="w-full"
              />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                <span>Opacity</span>
                <span>{Math.round(branding.opacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round(branding.opacity * 100)}
                onChange={(e) =>
                  void saveSettings({ branding: { opacity: Number(e.target.value) / 100 } })
                }
                className="w-full"
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ColorField({
  label,
  value,
  pickerFallback = '#FFFFFF',
  placeholder,
  onChange,
  onClear
}: {
  label: string
  value: string
  pickerFallback?: string
  placeholder?: string
  onChange: (hex: string) => void
  onClear?: () => void
}): React.JSX.Element {
  const picker = /^#[0-9A-Fa-f]{6}$/.test(value) ? value : pickerFallback

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-zinc-500">{label}</span>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-zinc-600 transition hover:text-zinc-300"
          >
            Use preset
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-surface-600 bg-surface-900 px-2 py-1.5">
        <input
          type="color"
          value={picker}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-7 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            const next = e.target.value.trim()
            if (/^#[0-9A-Fa-f]{6}$/.test(next)) onChange(next.toUpperCase())
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
        />
      </div>
    </div>
  )
}

/**
 * Brand tone-of-voice and style guidance. Free-text fields that steer AI
 * caption generation. Persisted on blur so typing does not fire a save per
 * keystroke.
 */
function BrandVoiceSection(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const voice: BrandVoiceSettings = settings?.brandVoice ?? {
    brandName: '',
    tone: '',
    style: '',
    avoid: ''
  }

  const inputClass =
    'mt-2 w-full rounded-xl border border-surface-600 bg-surface-850 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none'

  // Uncontrolled inputs (defaultValue + save on blur) so typing does not fire a
  // save per keystroke; keyed on the stored value so they re-seed once settings
  // load. Only persist when the value actually changed.
  const commit = (key: keyof BrandVoiceSettings, value: string): void => {
    if (value !== voice[key]) void saveSettings({ brandVoice: { [key]: value } })
  }

  const field = (
    key: keyof BrandVoiceSettings,
    label: string,
    placeholder: string,
    rows: number
  ): React.JSX.Element => (
    <div className="mt-4">
      <span className="text-[11px] font-medium text-zinc-400">{label}</span>
      {rows > 1 ? (
        <textarea
          key={voice[key]}
          defaultValue={voice[key]}
          rows={rows}
          onBlur={(e) => commit(key, e.target.value)}
          placeholder={placeholder}
          className={`${inputClass} resize-none leading-relaxed`}
        />
      ) : (
        <input
          key={voice[key]}
          defaultValue={voice[key]}
          onBlur={(e) => commit(key, e.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
      )}
    </div>
  )

  return (
    <div className="max-w-xl">
      <label className="flex items-center gap-2 text-sm font-medium">
        <MessageSquareQuote size={15} className="text-accent-400" />
        Brand voice
      </label>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Steers the AI-generated post captions so they sound like your organisation. Leave blank
        for a neutral, friendly default.
      </p>
      {field('brandName', 'Brand / organisation name', 'e.g. your company name', 1)}
      {field('tone', 'Tone of voice', 'e.g. warm, upbeat and human; confident but never salesy', 2)}
      {field('style', 'Writing style', 'e.g. British English, short sentences, no emojis', 2)}
      {field('avoid', 'Things to avoid', 'e.g. no hashtags, no hype, no corporate jargon', 2)}
    </div>
  )
}

function FontsSection(): React.JSX.Element {
  const customFonts = useStore((s) => s.customFonts)
  const addFonts = useStore((s) => s.addFonts)
  const removeFont = useStore((s) => s.removeFont)
  const [adding, setAdding] = useState(false)

  return (
    <div className="max-w-xl">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Type size={15} className="text-accent-400" />
        Custom fonts
      </label>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Upload TTF/OTF fonts to use for captions. Pick them per clip in the editor’s Captions
        section — previews and exports both use them.
      </p>

      {customFonts.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {customFonts.map((f) => (
            <div
              key={f.fileName}
              className="flex items-center justify-between gap-3 rounded-lg border border-surface-600 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-zinc-200" style={{ fontFamily: `'${f.family}', sans-serif` }}>
                  {f.family}
                </div>
                <div className="truncate text-[10px] text-zinc-600">{f.fileName}</div>
              </div>
              <button
                onClick={() => void removeFont(f.fileName)}
                title="Remove this font"
                className="shrink-0 rounded-md p-1.5 text-zinc-600 transition hover:bg-surface-700 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={async () => {
          setAdding(true)
          try {
            await addFonts()
          } finally {
            setAdding(false)
          }
        }}
        disabled={adding}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-60"
      >
        {adding ? <Loader2 size={13} className="animate-spin" /> : <Type size={13} />}
        Add font files (.ttf / .otf)
      </button>
    </div>
  )
}

function UpdatesSection(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateCheck = useStore((s) => s.updateCheck)
  const checking = useStore((s) => s.checkingForUpdates)
  const checkForUpdates = useStore((s) => s.checkForUpdates)
  const updateDownload = useStore((s) => s.updateDownload)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const installUpdate = useStore((s) => s.installUpdate)
  const openInstaller = useStore((s) => s.openUpdateInstaller)
  const cancelDownload = useStore((s) => s.cancelUpdateDownload)
  const busy = useStore((s) => s.screen === 'processing' || s.importProgress !== null ||
    Object.values(s.exports).some((e) => e.status === 'exporting') ||
    Object.values(s.reframeBusy).some(Boolean) || Object.values(s.captionBusy).some(Boolean))

  const [notesOpen, setNotesOpen] = useState(false)
  const upcoming = updateCheck?.updateAvailable && updateCheck.releaseNotes ? userNotes(parseNotes(updateCheck.releaseNotes)) : []

  return (
    <div className="max-w-xl">
      <label className="flex items-center gap-2 text-sm font-medium">
        <RefreshCw size={15} className="text-accent-400" />
        App updates
      </label>
      <p className="mt-1 text-xs text-zinc-500">
        Cutawan v{settings?.appVersion ?? '…'} — updates are checked on launch and every six hours.
        {settings?.appVersion && (
          <button type="button" onClick={() => setNotesOpen(true)} data-testid="whats-new-button"
            className="ml-1.5 text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
            What&apos;s new in this version
          </button>
        )}
      </p>
      {notesOpen && settings?.appVersion && <WhatsNewDialog version={settings.appVersion} onClose={() => setNotesOpen(false)} />}
      {upcoming.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-surface-600 bg-surface-850 px-3 py-2.5" data-testid="update-notes">
          <p className="mb-2 text-xs font-medium text-zinc-200">What&apos;s new in v{updateCheck?.latestVersion}</p>
          <NotesList blocks={upcoming} compact />
        </div>
      )}

      {updateDownload.status !== 'idle' || (updateCheck?.updateAvailable &&
        (updateCheck.autoUpdateSupported || updateCheck.manualDownloadSupported)) ? (
        <UpdateInstaller
          latestVersion={updateDownload.version ?? updateCheck?.latestVersion ?? ''}
          releaseUrl={updateCheck?.releaseUrl ?? 'https://github.com/JeremySNR/cutawan/releases/latest'}
          download={updateDownload}
          manual={updateDownload.mode === 'manual' || !!updateCheck?.manualDownloadSupported}
          busy={busy}
          onDownload={() => void downloadUpdate()}
          onInstall={() => void installUpdate()}
          onOpen={() => void openInstaller()}
          onCancel={() => void cancelDownload()}
        />
      ) : updateCheck?.updateAvailable && updateCheck.releaseUrl ? (
        updateCheck.sourceUpdateSupported ? (
          <SourceUpdater latestVersion={updateCheck.latestVersion ?? ''} releaseUrl={updateCheck.releaseUrl} />
        ) : (
          <div className="mt-2.5 rounded-lg border border-surface-600 px-3 py-2.5 text-xs text-zinc-300">
            <p>{updateCheck.availabilityMessage ?? `Cutawan v${updateCheck.latestVersion} is available.`}</p>
            <a href={updateCheck.releaseUrl} target="_blank" rel="noreferrer"
              className="mt-2 inline-flex font-medium text-accent-400 underline">View release on GitHub</a>
          </div>
        )
      ) : updateCheck && !checking && !updateCheck.error ? (
        <p className="mt-2.5 rounded-lg bg-surface-850 px-3 py-2 text-xs text-zinc-400">
          {updateCheck.latestVersion ? `You're up to date (latest release is v${updateCheck.latestVersion}).`
            : 'No published release was found.'}
        </p>
      ) : null}
      {updateCheck?.error && <p role="status" className="mt-2 text-xs text-amber-400">{updateCheck.error}</p>}
      {updateCheck && <p className="mt-2 text-[11px] text-zinc-500">
        Last check: {new Date(updateCheck.checkedAt).toLocaleString()}
      </p>}

      <button
        onClick={() => void checkForUpdates()}
        disabled={checking}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-60"
      >
        {checking ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <RefreshCw size={13} />
        )}
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
    </div>
  )
}

/**
 * One-click update for source checkouts: the main process pulls, reinstalls,
 * rebuilds and relaunches the app; this component just drives and narrates it.
 */
function SourceUpdater({
  latestVersion,
  releaseUrl
}: {
  latestVersion: string
  releaseUrl: string
}): React.JSX.Element {
  const sourceUpdate = useStore((s) => s.sourceUpdate)
  const updateFromSource = useStore((s) => s.updateFromSource)

  switch (sourceUpdate.status) {
    case 'running':
      return (
        <div className="mt-2.5 rounded-lg border border-surface-600 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-zinc-300">
            <Loader2 size={13} className="animate-spin" />
            {sourceUpdate.message || 'Updating…'}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            Updating to v{latestVersion} — the app restarts by itself when done (about a minute).
          </p>
        </div>
      )
    case 'error':
      return (
        <>
          <p className="mt-2.5 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-400">
            {sourceUpdate.error}
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              onClick={() => void updateFromSource()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
            >
              <RefreshCw size={13} />
              Retry
            </button>
            <a
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
            >
              <ExternalLink size={13} />
              Release page
            </a>
          </div>
        </>
      )
    case 'idle':
      return (
        <>
          <button
            onClick={() => void updateFromSource()}
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2.5 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-500/25"
          >
            <Download size={13} />
            Update to v{latestVersion} and restart
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            Pulls the latest code, reinstalls dependencies, rebuilds, and restarts the app (about a
            minute). Needs a git checkout — zip downloads should use the{' '}
            <a href={releaseUrl} target="_blank" rel="noreferrer" className="text-zinc-400 underline">
              release page
            </a>{' '}
            instead.
          </p>
        </>
      )
    default: {
      const exhaustive: never = sourceUpdate.status
      return exhaustive
    }
  }
}

function UpdateInstaller({ latestVersion, releaseUrl, download, manual, busy, onDownload, onInstall, onOpen, onCancel }: {
  latestVersion: string
  releaseUrl: string
  download: import('@shared/types').UpdateDownloadState
  manual: boolean
  busy: boolean
  onDownload: () => void
  onInstall: () => void
  onOpen: () => void
  onCancel: () => void
}): React.JSX.Element {
  const buttonClass = 'mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2.5 text-xs font-semibold text-emerald-400 disabled:opacity-50'
  return (
    <div className="mt-2.5" aria-live="polite">
      {download.status === 'downloading' ? (
        <div className="rounded-lg border border-surface-600 px-3 py-2.5">
          <p className="text-xs text-zinc-300">Downloading {latestVersion && `v${latestVersion}`}… {Math.round(download.progress * 100)}%</p>
          <div role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(download.progress * 100)} className="mt-2 h-1 overflow-hidden rounded-full bg-surface-700">
            <div className="h-full bg-emerald-400" style={{ width: `${Math.round(download.progress * 100)}%` }} />
          </div>
          {manual && <button onClick={onCancel} className="mt-2 text-xs text-zinc-400 underline">Cancel download</button>}
        </div>
      ) : download.status === 'downloaded' ? (
        <>
          <p className="text-xs text-zinc-300">{manual ? 'Installer verified and ready.' : `Cutawan v${latestVersion} is ready to install.`}</p>
          <button onClick={manual ? onOpen : onInstall} disabled={!manual && busy} className={buttonClass}>
            {manual ? <Download size={13} /> : <RefreshCw size={13} />}
            {manual ? `Open installer for v${latestVersion}` : `Restart to update to v${latestVersion}`}
          </button>
          {!manual && busy && <p className="mt-2 text-xs text-amber-400">Finish your current processing or export before restarting.</p>}
          {manual && <p className="mt-2 text-xs leading-relaxed text-zinc-400">
            Open the installer, quit Cutawan when your work is finished, then drag Cutawan into Applications and choose Replace.
            Reopen Cutawan from Applications. Your saved projects and settings stay in place.
            macOS may ask you to allow the app in System Settings → Privacy &amp; Security.
          </p>}
        </>
      ) : (
        <>
          <button onClick={onDownload} className={buttonClass} data-testid="download-update">
            <Download size={13} />
            {download.status === 'error' ? 'Retry download' : `Download ${manual ? 'Mac installer' : 'update'} v${latestVersion}`}
          </button>
          <p className="mt-2 text-xs text-zinc-500">{manual
            ? 'Downloads and verifies the installer here. You will replace the app in Applications.'
            : 'Keep working while it downloads. You choose when to restart and install.'}</p>
        </>
      )}
      {download.error && <p role="alert" className="mt-2 text-xs text-red-400">{download.error}</p>}
      <a href={releaseUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs text-zinc-400 underline">
        Release notes and other downloads
      </a>
    </div>
  )
}
