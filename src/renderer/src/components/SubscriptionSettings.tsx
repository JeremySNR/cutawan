import { useState } from 'react'
import type { SubscriptionSettings as Preferences } from '@shared/subscription'
import LocalWhisperSetup from './LocalWhisperSetup'

export default function SubscriptionSettings({ value, onChange, onSave }: {
  value: Preferences
  onChange: (value: Preferences) => void
  onSave: () => Promise<void>
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const update = (patch: Partial<Preferences>): void => {
    setMessage('')
    onChange({ ...value, ...patch })
  }
  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await onSave()
      const result = await window.cutawan.checkSubscriptionSetup()
      setMessage(`${result.message} ${result.requestsToday} requests used today.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setChecking(false) }
  }
  const checkLocal = async (): Promise<void> => {
    setChecking(true)
    try {
      await onSave()
      const result = await window.cutawan.checkLocalWhisperSetup()
      setMessage(result.message)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setChecking(false) }
  }
  const inputClass = 'mt-1 w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-sm'
  return <div className="mb-6 space-y-3">
    <label className="block text-sm font-medium" htmlFor="analysis-provider">AI connection</label>
    <select id="analysis-provider" value={value.provider} onChange={e => update({ provider: e.target.value as Preferences['provider'] })} className={inputClass}>
      <option value="api">OpenAI-compatible API</option>
      <option value="openrouter">OpenRouter</option>
      <option value="chatgpt">ChatGPT subscription via Codex (beta)</option>
    </select>
    {value.provider === 'api' && <>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={value.localTranscription} onChange={e => update({ localTranscription: e.target.checked })} />
        Transcribe speech locally with Whisper (analysis still uses the API)
      </label>
      {value.localTranscription && <>
        <label className="block text-xs" htmlFor="api-python-path">Python executable
          <input id="api-python-path" className={inputClass} value={value.pythonPath} onChange={e => update({ pythonPath: e.target.value })} />
        </label>
        <LocalWhisperSetup pythonPath={value.pythonPath} onConfigured={(pythonPath, whisperModelPath) => update({ pythonPath, whisperModelPath })} />
        <label className="block text-xs" htmlFor="api-whisper-path">Whisper model folder
          <input id="api-whisper-path" className={inputClass} value={value.whisperModelPath} onChange={e => update({ whisperModelPath: e.target.value })} placeholder="Folder containing model.bin" />
        </label>
        <button type="button" onClick={() => void checkLocal()} disabled={checking} className="rounded-lg border border-surface-600 px-3 py-2 text-sm disabled:opacity-50">{checking ? 'Checking…' : 'Save and check local Whisper'}</button>
        {message && <p role="status" className="text-xs leading-relaxed text-zinc-300">{message}</p>}
      </>}
    </>}
    {value.provider === 'chatgpt' && <>
      <p className="text-xs leading-relaxed text-zinc-400">Use your existing ChatGPT sign-in for analysis, with local Whisper for transcription. Requires Codex CLI, Python with faster-whisper, and a downloaded speech model. Subscription limits apply; no API key is required.</p>
      <p className="text-xs leading-relaxed text-zinc-400">Install Codex CLI and run <code>codex login</code> once to sign in with ChatGPT. Cutawan never reads or stores your login tokens. Transcript text and selected video frames are sent to Codex; audio is transcribed on this computer.</p>
      <a className="block text-xs underline" href="https://developers.openai.com/codex/cli" target="_blank" rel="noreferrer">Codex installation and sign-in</a>
      <a className="block text-xs underline" href="https://github.com/JeremySNR/cutawan/blob/main/docs/chatgpt-subscription.md" target="_blank" rel="noreferrer">Local transcription setup guide</a>
      <label className="block text-xs" htmlFor="codex-path">Codex executable
        <input id="codex-path" className={inputClass} value={value.codexPath} onChange={e => update({ codexPath: e.target.value })} />
      </label>
      <label className="block text-xs" htmlFor="codex-model">Analysis model
        <input id="codex-model" className={inputClass} value={value.codexModel} onChange={e => update({ codexModel: e.target.value })} />
      </label>
      <p className="text-xs text-zinc-500">Defaults to Luna with low reasoning. Model availability depends on your account; unavailable models produce an error, never an automatic upgrade.</p>
      <label className="block text-xs" htmlFor="request-limit">Maximum new requests per day (UTC)
        <input id="request-limit" type="number" min={0} max={500} className={inputClass} value={value.dailyRequestLimit} onChange={e => update({ dailyRequestLimit: Number(e.target.value) })} />
      </label>
      <p className="text-xs text-zinc-500">One video can need many requests. Cached results do not count. Set 0 for cached analysis only. This limits requests, not tokens or your account’s spending settings.</p>
      <label className="block text-xs" htmlFor="python-path">Python executable with faster-whisper installed
        <input id="python-path" className={inputClass} value={value.pythonPath} onChange={e => update({ pythonPath: e.target.value })} />
      </label>
      <LocalWhisperSetup pythonPath={value.pythonPath} onConfigured={(pythonPath, whisperModelPath) => update({ pythonPath, whisperModelPath })} />
      <label className="block text-xs" htmlFor="whisper-path">Downloaded faster-whisper model folder
        <input id="whisper-path" className={inputClass} value={value.whisperModelPath} onChange={e => update({ whisperModelPath: e.target.value })} placeholder="Folder containing model.bin" />
      </label>
      <button type="button" onClick={() => void check()} disabled={checking} className="rounded-lg border border-surface-600 px-3 py-2 text-sm disabled:opacity-50">{checking ? 'Checking…' : 'Save and check setup (no AI request)'}</button>
      {message && <p role="status" className="text-xs leading-relaxed text-zinc-300">{message}</p>}
    </>}
  </div>
}
