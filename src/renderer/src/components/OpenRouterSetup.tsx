import { useEffect, useState } from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import type { SubscriptionSettings } from '@shared/subscription'
import {
  OPENROUTER_KEYS_URL,
  SUGGESTED_OPENROUTER_MODELS,
  OPENROUTER_TRANSCRIPTION_MODELS,
  type OpenRouterCatalog
} from '@shared/openrouter'
import { useStore } from '../store'
import LocalWhisperSetup from './LocalWhisperSetup'
import ModelPicker, { type PinnedOption } from './ModelPicker'

const LOCAL_WHISPER = 'local-whisper'
const LOCAL_OPTION: PinnedOption = {
  id: LOCAL_WHISPER,
  name: 'Local Whisper (on this computer)',
  note: 'Free and private · needs Python and a one-time model download'
}

export interface OpenRouterChoice {
  apiKey: string
  model: string
  transcriptionModel: string
}

/**
 * OpenRouter key, analysis model and transcription choice. Transcription is
 * either an OpenRouter-hosted model or local Whisper (the shared
 * `localTranscription` preference).
 */
export default function OpenRouterSetup({ value, onChange, subscription, onSubscriptionChange }: {
  value: OpenRouterChoice
  onChange: (patch: Partial<OpenRouterChoice>) => void
  subscription: SubscriptionSettings
  onSubscriptionChange: (patch: Partial<SubscriptionSettings>) => void
}): React.JSX.Element {
  const settings = useStore(s => s.settings)
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null)
  const [checking, setChecking] = useState(false)
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let active = true
    void window.cutawan.listOpenRouterModels().then(c => { if (active) setCatalog(c) })
    return () => { active = false }
  }, [])

  const checkKey = async (): Promise<void> => {
    setChecking(true)
    setKeyStatus(null)
    try {
      const result = await window.cutawan.checkOpenRouterKey(value.apiKey.trim() || undefined)
      setKeyStatus({ ok: true, message: result.message })
    } catch (error) {
      setKeyStatus({ ok: false, message: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally { setChecking(false) }
  }

  const inputClass = 'mt-1 w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-sm'
  const transcription = subscription.localTranscription ? LOCAL_WHISPER : value.transcriptionModel

  return <div className="space-y-4" data-testid="openrouter-setup">
    <div>
      <label className="block text-xs" htmlFor="openrouter-key">OpenRouter API key</label>
      <div className="mt-1 flex gap-2">
        <input id="openrouter-key" type="password" autoComplete="off" value={value.apiKey}
          onChange={e => { onChange({ apiKey: e.target.value }); setKeyStatus(null) }}
          placeholder={settings?.hasOpenRouterKey ? `Current: ${settings.openRouterKeyMasked}` : 'sk-or-v1-…'}
          className="w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-sm" />
        <button type="button" onClick={() => void checkKey()} disabled={checking || (!value.apiKey.trim() && !settings?.hasOpenRouterKey)}
          className="shrink-0 rounded-lg border border-surface-600 px-3 py-2 text-sm disabled:opacity-50">{checking ? 'Checking…' : 'Check key'}</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <a href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer" className="text-xs underline">Create an OpenRouter key ↗</a>
        {settings?.keyStorageSecure !== false
          ? <span className="flex items-center gap-1 text-[11px] text-zinc-500"><ShieldCheck size={12} /> Encrypted with your system keychain</span>
          : <span className="flex items-center gap-1 text-[11px] text-amber-400"><TriangleAlert size={12} /> No keychain: stored obfuscated only</span>}
      </div>
      {keyStatus && <p role="status" className={`mt-2 text-xs ${keyStatus.ok ? 'text-emerald-400' : 'text-red-400'}`}>{keyStatus.message}</p>}
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        The key is sent only to openrouter.ai. OpenRouter bills usage to your OpenRouter credits.
      </p>
    </div>

    <ModelPicker label="Clip-finding model (LLM)" testId="openrouter-model" value={value.model}
      onChange={model => onChange({ model })} models={catalog?.llm ?? []} suggested={SUGGESTED_OPENROUTER_MODELS} loading={!catalog} />
    <p className="-mt-2 text-[11px] leading-relaxed text-zinc-500">
      Models tagged Vision can also judge sampled frames for visual moments and framing.
    </p>

    <ModelPicker label="Transcription" testId="openrouter-transcription" value={transcription}
      onChange={id => {
        if (id === LOCAL_WHISPER) onSubscriptionChange({ localTranscription: true })
        else { onSubscriptionChange({ localTranscription: false }); onChange({ transcriptionModel: id }) }
      }}
      models={catalog?.transcription ?? []} suggested={OPENROUTER_TRANSCRIPTION_MODELS} pinned={[LOCAL_OPTION]} loading={!catalog}
      allowCustom={false} suggestedTitle="Via OpenRouter · word timestamps" />
    <p className="-mt-2 text-[11px] leading-relaxed text-zinc-500">
      Captions need a timestamp for every word. On OpenRouter only the Whisper models return them, so other transcription models aren’t offered.
    </p>

    {catalog && !catalog.live && <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-400">
      Couldn’t load OpenRouter’s model list{catalog.error ? ` (${catalog.error})` : ''}. Showing suggested models; you can also type any clip-finding model id.
    </p>}

    {subscription.localTranscription && <div className="space-y-3 rounded-lg border border-surface-700 p-3">
      <label className="block text-xs">Python executable (Python 3.10+)
        <input value={subscription.pythonPath} onChange={e => onSubscriptionChange({ pythonPath: e.target.value })} className={inputClass} />
      </label>
      <LocalWhisperSetup pythonPath={subscription.pythonPath} onConfigured={(pythonPath, whisperModelPath) => onSubscriptionChange({ pythonPath, whisperModelPath })} />
      <label className="block text-xs">Whisper model folder (if already installed)
        <input value={subscription.whisperModelPath} onChange={e => onSubscriptionChange({ whisperModelPath: e.target.value })}
          placeholder="Folder containing model.bin" className={inputClass} />
      </label>
    </div>}
  </div>
}
