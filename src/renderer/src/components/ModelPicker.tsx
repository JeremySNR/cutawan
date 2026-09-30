import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, Search } from 'lucide-react'
import {
  formatContext,
  formatModelPrice,
  looksLikeModelId,
  matchesModelQuery,
  type OpenRouterModel,
  type SuggestedModel
} from '@shared/openrouter'

/** A choice outside the model catalogue, e.g. "Local Whisper on this computer". */
export interface PinnedOption {
  id: string
  name: string
  note: string
}

interface Row {
  id: string
  name: string
  detail: string | null
  badges: string[]
}

function modelRow(model: OpenRouterModel, note?: string): Row {
  const badges = [formatModelPrice(model), formatContext(model.contextLength), model.vision ? 'Vision' : null]
    .filter((b): b is string => Boolean(b))
  return { id: model.id, name: model.name, detail: note ?? model.id, badges }
}

/**
 * Searchable dropdown over a model catalogue, with pinned choices (not
 * models) and suggested models above the full list. Typing a full model id
 * that is not listed offers it as a custom choice.
 */
export default function ModelPicker({ label, value, onChange, models, suggested, pinned = [], loading = false, testId }: {
  label: string
  value: string
  onChange: (id: string) => void
  models: OpenRouterModel[]
  suggested: SuggestedModel[]
  pinned?: PinnedOption[]
  loading?: boolean
  testId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const byId = useMemo(() => new Map(models.map(m => [m.id, m])), [models])
  const groups = useMemo(() => {
    const q = query.trim()
    const match = (row: { id: string; name: string }): boolean => !q || matchesModelQuery(row, q)
    const pinnedRows: Row[] = pinned.filter(match).map(p => ({ id: p.id, name: p.name, detail: p.note, badges: [] }))
    // Suggest only models the catalogue still carries.
    const suggestedRows: Row[] = suggested
      .filter(s => byId.has(s.id))
      .map(s => modelRow(byId.get(s.id)!, s.note))
      .filter(match)
    const suggestedIds = new Set(suggestedRows.map(r => r.id))
    const allRows = models.filter(m => !suggestedIds.has(m.id) && match(m)).map(m => modelRow(m))
    const custom: Row[] = q && looksLikeModelId(q) && !byId.has(q) && !pinned.some(p => p.id === q)
      ? [{ id: q, name: `Use “${q}”`, detail: 'Custom model id', badges: [] }] : []
    return [
      { title: 'On this computer', rows: pinnedRows },
      { title: 'Suggested', rows: suggestedRows },
      { title: q ? 'Matching models' : `${suggestedRows.length ? 'More models' : 'All models'} · ${allRows.length}`, rows: allRows },
      { title: 'Custom', rows: custom }
    ].filter(g => g.rows.length > 0)
  }, [query, pinned, suggested, models, byId])
  const flat = useMemo(() => groups.flatMap(g => g.rows), [groups])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (id: string): void => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }
  const toggle = (): void => {
    setOpen(o => !o)
    setQuery('')
    setActive(0)
  }
  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(flat.length - 1, i + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)) }
    else if (event.key === 'Enter') { event.preventDefault(); if (flat[active]) choose(flat[active].id) }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
  }

  const current = pinned.find(p => p.id === value)
  const currentModel = byId.get(value)
  const currentName = current?.name ?? currentModel?.name ?? suggested.find(s => s.id === value)?.name ?? value
  let index = -1

  return <div ref={root} data-testid={testId}>
    <span className="block text-xs">{label}</span>
    <button type="button" onClick={toggle} aria-haspopup="listbox" aria-expanded={open} data-testid={testId && `${testId}-toggle`}
      className="mt-1 flex w-full items-center gap-2 rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-left text-sm hover:border-zinc-500">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-zinc-100">{currentName}</span>
        <span className="block truncate text-[11px] text-zinc-500">{current ? current.note : value}</span>
      </span>
      {loading ? <Loader2 size={14} className="animate-spin text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
    </button>
    {/* In the flow, not floating: pages and modals scroll it into view instead of clipping it. */}
    {open && <div className="mt-1 overflow-hidden rounded-xl border border-surface-600 bg-surface-900 shadow-xl shadow-black/50">
      <div className="flex items-center gap-2 border-b border-surface-700 px-3 py-2">
        <Search size={14} className="text-zinc-500" />
        <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKey}
          placeholder="Search models by name or id…" aria-label={`Search ${label}`} data-testid={testId && `${testId}-search`}
          className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none" />
      </div>
      <div ref={list} role="listbox" className="max-h-72 overflow-y-auto py-1">
        {groups.length === 0 && <p className="px-3 py-4 text-center text-xs text-zinc-500">No models match “{query}”.</p>}
        {groups.map(group => <div key={group.title}>
          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{group.title}</p>
          {group.rows.map(row => {
            index++
            const i = index
            const selected = row.id === value
            return <button type="button" key={`${group.title}:${row.id}`} role="option" aria-selected={selected} data-index={i}
              data-testid={testId && `${testId}-option-${row.id}`}
              onMouseEnter={() => setActive(i)} onClick={() => choose(row.id)}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left ${i === active ? 'bg-white/[0.06]' : ''}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">{row.name}</span>
                {row.detail && <span className="block truncate text-[11px] text-zinc-500">{row.detail}</span>}
                {row.badges.length > 0 && <span className="mt-1 flex flex-wrap gap-1">
                  {row.badges.map(b => <span key={b} className="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-zinc-400">{b}</span>)}
                </span>}
              </span>
              {selected && <Check size={14} className="mt-0.5 shrink-0 text-accent-400" />}
            </button>
          })}
        </div>)}
      </div>
    </div>}
  </div>
}
