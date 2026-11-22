import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, AudioLines, Check, Languages, Loader2, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import type { CaptionLanguageMode, Clip, ClipTranslation, Project, TranslationLine } from '@shared/types'
import { findTranslationLanguage, TRANSLATION_LANGUAGES, translationState } from '@shared/captionTranslation'
import { DUB_VOICES, dubLineFor, dubSupport, type DubEstimate } from '@shared/dubPlan'
import { useStore } from '../store'

/**
 * Editor section for caption translation and the AI voice dub. A
 * translation arrives for review: each line side by side with its original,
 * editable, and only used once accepted. The dub is an optional step on an
 * accepted translation, with the cost shown before it runs.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : String(err)
}

function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

const MODES: Array<{ value: CaptionLanguageMode; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: 'translated', label: 'Translated' },
  { value: 'both', label: 'Both' }
]

export default function TranslationSection({ project, clip }: { project: Project; clip: Clip }): React.JSX.Element {
  const updateClip = useStore((s) => s.updateClip)
  const updateClipLocal = useStore((s) => s.updateClipLocal)
  const provider = useStore((s) => s.settings?.subscription.provider ?? 'api')
  const translation = clip.translation
  const [language, setLanguage] = useState(translation?.language ?? 'Spanish')
  const [terms, setTerms] = useState((translation?.doNotTranslate ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = useMemo(
    () => (translation ? translationState(clip, translation, project.transcript) : null),
    [clip, translation, project.transcript]
  )

  /** Take a fresh field from main onto the live local copy of the clip. */
  const graft = (updated: Project, field: 'translation' | 'dub'): void => {
    const fresh = updated.clips.find((c) => c.id === clip.id)
    const live = useStore.getState().project?.clips.find((c) => c.id === clip.id)
    if (!fresh || !live || useStore.getState().project?.id !== updated.id) return
    updateClipLocal({ ...live, [field]: fresh[field] })
  }

  const translate = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const updated = await window.cutawan.translateCaptions(project.id, clip.id, {
        language: language.trim(),
        doNotTranslate: terms.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)
      })
      graft(updated, 'translation')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const saveTranslation = (next: ClipTranslation | undefined, edit?: Partial<Clip['edit']>): void => {
    const live = useStore.getState().project?.clips.find((c) => c.id === clip.id) ?? clip
    void updateClip({ ...live, translation: next, edit: { ...live.edit, ...edit } })
  }

  const editLine = (index: number, text: string, save: boolean): void => {
    if (!translation) return
    const lines = translation.lines.map((line, i): TranslationLine =>
      i === index ? { ...line, text, edited: text !== line.source || line.edited, untranslated: false, warnings: undefined } : line)
    const next = { ...translation, lines, edited: true }
    if (save) saveTranslation(next)
    else updateClipLocal({ ...clip, translation: next })
  }

  const mode = clip.edit.captionLanguage ?? 'original'
  const chatgpt = provider === 'chatgpt'

  return (
    <div className="space-y-3" data-testid="translation-section">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input
          list="cutawan-translation-languages"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          placeholder="Language, e.g. Spanish"
          aria-label="Target language"
          className="min-w-0 rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-xs text-zinc-200 focus:border-white/25 focus:outline-none"
        />
        <datalist id="cutawan-translation-languages">
          {TRANSLATION_LANGUAGES.map((l) => <option key={l.code} value={l.name} />)}
        </datalist>
        <button
          onClick={() => void translate()}
          disabled={busy || !language.trim() || !project.transcript}
          className="flex items-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Languages size={12} />}
          {busy ? 'Translating…' : translation ? 'Translate again' : 'Translate captions'}
        </button>
      </div>
      <input
        value={terms}
        onChange={(e) => setTerms(e.target.value)}
        placeholder="Keep unchanged (optional): names, brands, catchphrases — comma separated"
        aria-label="Terms to keep untranslated"
        className="w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none"
      />
      <p className="text-[11px] leading-relaxed text-zinc-500">
        One AI request translates the whole clip, sentence by sentence
        {chatgpt ? ', counted against your ChatGPT daily request cap' : ''}. You review it before it is used.
        {!findTranslationLanguage(language) && language.trim() ? ' Any language name works.' : ''}
      </p>
      {error && <p className="text-[11px] leading-relaxed text-red-400">{error}</p>}

      {translation && state && (
        <div className="space-y-3 rounded-xl border border-surface-600 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-200">
              {translation.language}
              <span className="ml-1.5 font-normal text-zinc-500">
                {translation.accepted ? '· in use' : '· review, then use it'}
                {translation.edited ? ' · edited' : ''}
              </span>
            </span>
            <button
              onClick={() => {
                const live = useStore.getState().project?.clips.find((c) => c.id === clip.id) ?? clip
                void updateClip({ ...live, translation: undefined, dub: undefined, edit: { ...live.edit, captionLanguage: 'original' } })
              }}
              title="Discard this translation"
              className="rounded-md p-1 text-zinc-600 transition hover:bg-surface-700 hover:text-red-400"
            >
              <Trash2 size={13} />
            </button>
          </div>

          {state.needsRefresh && (
            <p data-testid="translation-stale" className="flex gap-1.5 text-[11px] leading-relaxed text-amber-400">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                The edit changed since this was translated
                {state.changed ? `: ${state.changed} line${state.changed === 1 ? ' is' : 's are'} cut through and hidden` : ''}
                {state.uncovered ? `${state.changed ? ', and' : ':'} new speech has no translation` : ''}.{' '}
                <button onClick={() => void translate()} disabled={busy} className="inline-flex items-center gap-1 underline decoration-amber-700 hover:text-amber-300">
                  <RefreshCw size={10} /> Refresh translation
                </button>
              </span>
            </p>
          )}

          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {translation.lines.map((line, i) => {
              const status = state.status[i]
              const voiced = clip.dub ? dubLineFor(clip.dub, line) : undefined
              return (
                <div key={`${line.start}-${i}`} className={`grid grid-cols-2 gap-2 ${status === 'plays' ? '' : 'opacity-40'}`}>
                  <p className="select-text text-[11px] leading-relaxed text-zinc-500">{line.source}</p>
                  <div>
                    <textarea
                      value={line.text}
                      dir="auto"
                      rows={Math.min(4, Math.max(1, Math.ceil(line.text.length / 28)))}
                      onChange={(e) => editLine(i, e.target.value, false)}
                      onBlur={(e) => editLine(i, e.target.value, true)}
                      aria-label={`Translation of line ${i + 1}`}
                      className="w-full resize-none rounded-md border border-surface-600 bg-surface-850 px-2 py-1 text-[11px] leading-relaxed text-zinc-200 focus:border-white/25 focus:outline-none"
                    />
                    <LineFlags line={line} status={status} fit={voiced?.fit} tempo={voiced?.tempo} spoken={voiced?.spoken} />
                  </div>
                </div>
              )
            })}
          </div>

          {!translation.accepted ? (
            <button
              onClick={() => saveTranslation({ ...translation, accepted: true }, mode === 'original' ? { captionLanguage: 'translated' } : undefined)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-white"
            >
              <Check size={13} /> Use translation
            </button>
          ) : (
            <div>
              <div className="mb-1.5 text-[11px] text-zinc-500">Captions show</div>
              <div className="grid grid-cols-3 gap-1.5">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => saveTranslation(translation, { captionLanguage: m.value })}
                    className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                      mode === m.value ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                Translated captions appear a sentence at a time, without word-by-word highlighting.
              </p>
            </div>
          )}

          {translation.accepted && <DubPanel project={project} clip={clip} graft={graft} />}
        </div>
      )}
    </div>
  )
}

function LineFlags({ line, status, fit, tempo, spoken }: {
  line: TranslationLine
  status: string
  fit?: string
  tempo?: number
  spoken?: string
}): React.JSX.Element | null {
  const flags: Array<{ text: string; warn: boolean }> = []
  if (status === 'dropped') flags.push({ text: 'Cut from the clip', warn: false })
  if (status === 'changed') flags.push({ text: 'Cut through: refresh to show', warn: true })
  if (line.untranslated) flags.push({ text: 'Not translated: original kept', warn: true })
  for (const w of line.warnings ?? []) flags.push({ text: `Check: ${w}`, warn: true })
  if (fit === 'stretched' && tempo) flags.push({ text: `Dub sped up ×${tempo.toFixed(2)}`, warn: false })
  if (fit === 'faster') flags.push({ text: 'Dub re-voiced faster to fit', warn: false })
  if (spoken) flags.push({ text: `Dub shortened to fit: “${spoken}”`, warn: false })
  if (fit === 'truncated') flags.push({ text: 'Dub too long: cut short with a fade. Shorten this line.', warn: true })
  if (!flags.length) return null
  return (
    <div className="mt-0.5 space-y-0.5">
      {flags.map((f) => (
        <p key={f.text} className={`text-[10px] leading-snug ${f.warn ? 'text-amber-400' : 'text-zinc-500'}`}>{f.text}</p>
      ))}
    </div>
  )
}

function DubPanel({ project, clip, graft }: {
  project: Project
  clip: Clip
  graft: (updated: Project, field: 'translation' | 'dub') => void
}): React.JSX.Element {
  const updateClip = useStore((s) => s.updateClip)
  const provider = useStore((s) => s.settings?.subscription.provider ?? 'api')
  const support = dubSupport(provider)
  const [model, setModel] = useState(clip.dub?.model ?? support.models[0]?.id ?? '')
  const [voice, setVoice] = useState(clip.dub?.voice ?? DUB_VOICES[0].id)
  const [estimate, setEstimate] = useState<DubEstimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const linesKey = clip.translation?.lines.map((l) => l.text).join('\n') ?? ''
  const editKey = JSON.stringify([clip.edit.start, clip.edit.end, clip.edit.cuts, clip.edit.tightenCuts, clip.edit.restored])

  useEffect(() => {
    if (!support.available) return
    let alive = true
    window.cutawan.estimateDub(project.id, clip.id, { model, voice })
      .then((e) => { if (alive) setEstimate(e) })
      .catch(() => { if (alive) setEstimate(null) })
    return () => { alive = false }
  }, [support.available, project.id, clip.id, model, voice, linesKey, editKey, clip.dub])

  useEffect(() => window.cutawan.onDubProgress((p) => {
    if (p.clipId === clip.id) setProgress({ done: p.done, total: p.total })
  }), [clip.id])

  if (!support.available) {
    return (
      <div className="border-t border-surface-700 pt-3">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400"><AudioLines size={12} /> AI voice dub</div>
        <p data-testid="dub-unavailable" className="text-[11px] leading-relaxed text-zinc-500">{support.reason}</p>
      </div>
    )
  }

  const dub = clip.dub
  const voiced = dub ? (clip.translation?.lines ?? []).filter((l) => dubLineFor(dub, l)).length : 0
  const run = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    setProgress(null)
    try {
      graft(await window.cutawan.dubClip(project.id, clip.id, { model, voice }), 'dub')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  const select = 'w-full rounded-lg border border-surface-600 bg-surface-850 px-2 py-1.5 text-xs text-zinc-200 focus:border-white/25 focus:outline-none'

  return (
    <div className="space-y-2 border-t border-surface-700 pt-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400"><AudioLines size={12} /> AI voice dub</div>
      <div className="grid grid-cols-2 gap-2">
        <select value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Voice" className={select}>
          {DUB_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Speech model" className={select}>
          {support.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      {estimate && (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          {estimate.uncachedCharacters === 0
            ? `All ${estimate.lines} lines are already voiced with this voice: no cost.`
            : `About ${formatUsd(estimate.usd)} for ${estimate.uncachedCharacters.toLocaleString()} characters` +
              ` (approximate, at the provider's list price; up to ${formatUsd(estimate.usdMax)} if lines need a faster re-take).`}
        </p>
      )}
      <button
        onClick={() => void run()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-60"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        {busy
          ? progress ? `Voicing ${progress.done}/${progress.total} lines…` : 'Voicing…'
          : dub ? 'Dub again with these settings' : 'Dub with AI voice'}
      </button>
      {dub && (
        <label className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          <span>
            Play dub over the original ({voiced} line{voiced === 1 ? '' : 's'} voiced, original ducked)
          </span>
          <input
            type="checkbox"
            checked={dub.enabled}
            onChange={(e) => void updateClip({ ...clip, dub: { ...dub, enabled: e.target.checked } })}
          />
        </label>
      )}
      {error && <p className="text-[11px] leading-relaxed text-red-400">{error}</p>}
      <p className="text-[10px] leading-relaxed text-zinc-600">
        Each line is voiced into its sentence’s time slot; long lines are re-voiced faster, then sped up slightly. Audio is cached in the project, so re-exports cost nothing.
      </p>
    </div>
  )
}
