import { useState } from 'react'
import { ImagePlus, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BrollSource, MetachlorianIntendedUse } from '@shared/types'
import { useStore } from '../store'

const SOURCES: Array<{ value: BrollSource; label: string; hint: string }> = [
  { value: 'web', label: 'Web images', hint: 'Wikipedia and Openverse pictures of what is named. No account needed.' },
  { value: 'metachlorian', label: 'Metachlorian library', hint: 'Footage from your own Metachlorian library, cut in as video inserts.' }
]

const inputClass =
  'mt-1 w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none'

/**
 * Settings → B-roll: where AI B-roll comes from. Web images stay the default;
 * a Metachlorian server supplies footage instead, searched with the LLM's
 * footage-style queries and checked against the intended use for rights.
 */
export default function BrollSourceSettings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const [url, setUrl] = useState(settings?.metachlorianUrl ?? '')
  const [token, setToken] = useState('')
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const source = settings?.brollSource ?? 'web'
  const intended: MetachlorianIntendedUse = settings?.metachlorianIntendedUse ?? { use: '', channel: '', territory: '' }

  const saveConnection = async (): Promise<void> => {
    await saveSettings({ metachlorianUrl: url, ...(token.trim() ? { metachlorianToken: token.trim() } : {}) })
    setToken('')
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    setStatus(null)
    try {
      const result = await window.cutawan.checkMetachlorian({ url: url.trim() || undefined, token: token.trim() || undefined })
      setStatus({ ok: true, message: result.message })
    } catch (error) {
      setStatus({ ok: false, message: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setChecking(false)
    }
  }

  const intendedField = (key: keyof MetachlorianIntendedUse, label: string, placeholder: string): React.JSX.Element => (
    <label className="block">
      <span className="text-[11px] font-medium text-zinc-400">{label}</span>
      <input
        key={intended[key]}
        defaultValue={intended[key]}
        placeholder={placeholder}
        onBlur={(e) => {
          if (e.target.value.trim() !== intended[key]) void saveSettings({ metachlorianIntendedUse: { [key]: e.target.value } })
        }}
        className={inputClass}
      />
    </label>
  )

  return (
    <div className="max-w-xl" data-testid="broll-settings">
      <label className="flex items-center gap-2 text-sm font-medium">
        <ImagePlus size={15} className="text-accent-400" />
        B-roll source
      </label>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Where “AI B-roll” finds inserts when you generate clips.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {SOURCES.map((option) => (
          <button
            key={option.value}
            type="button"
            data-testid={`broll-source-${option.value}`}
            onClick={() => void saveSettings({ brollSource: option.value })}
            className={`rounded-xl border px-3.5 py-3 text-left transition ${
              source === option.value
                ? 'border-white/30 bg-white/[0.07]'
                : 'border-surface-600 hover:bg-surface-800'
            }`}
          >
            <span className="block text-sm font-semibold text-zinc-100">{option.label}</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">{option.hint}</span>
          </button>
        ))}
      </div>

      {source === 'metachlorian' && (
        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs">Metachlorian address</span>
            <input
              value={url}
              onChange={(e) => { setUrl(e.target.value); setStatus(null) }}
              onBlur={() => { if (url.trim() !== settings?.metachlorianUrl) void saveConnection() }}
              placeholder="http://127.0.0.1:8770"
              className={inputClass}
            />
          </label>
          <div>
            <label className="block text-xs" htmlFor="metachlorian-token">Access token</label>
            <div className="mt-1 flex gap-2">
              <input
                id="metachlorian-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => { setToken(e.target.value); setStatus(null) }}
                placeholder={settings?.hasMetachlorianToken ? `Current: ${settings.metachlorianTokenMasked}` : 'Not needed for a local solo library'}
                className="w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void saveConnection()}
                disabled={!token.trim()}
                className="shrink-0 rounded-lg border border-surface-600 px-3 py-2 text-sm disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                data-testid="metachlorian-check"
                onClick={() => void check()}
                disabled={checking || !(url.trim() || settings?.metachlorianUrl)}
                className="shrink-0 rounded-lg border border-surface-600 px-3 py-2 text-sm disabled:opacity-50"
              >
                {checking ? 'Checking…' : 'Check connection'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
              <span>Create one in Metachlorian Settings → Agents with the library:read and media:export scopes.</span>
              {settings?.keyStorageSecure !== false
                ? <span className="flex items-center gap-1"><ShieldCheck size={12} /> Encrypted with your system keychain</span>
                : <span className="flex items-center gap-1 text-amber-400"><TriangleAlert size={12} /> No keychain: stored obfuscated only</span>}
            </div>
            {status && (
              <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${status.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-300'}`}>
                {status.message}
              </p>
            )}
          </div>
          <div>
            <span className="text-xs">Intended use (optional)</span>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Metachlorian only offers footage cleared for this use. Leave blank to search everything.
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {intendedField('use', 'Use', 'marketing')}
              {intendedField('channel', 'Channel', 'organic_social')}
              {intendedField('territory', 'Territory', 'GB')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
