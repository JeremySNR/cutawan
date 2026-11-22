import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FolderOpen,
  Layers,
  Link2,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import { useStore } from '../store'
import type { AnalyzeOptions, BatchItem, BatchItemSource, ClipLengthPreference, VideoType } from '@shared/types'
import { VIDEO_TYPE_OPTIONS } from '@shared/videoType'
import { LICENCE_WARNING } from '@shared/importLicence'

const LENGTHS: Array<{ value: ClipLengthPreference; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'short', label: '15–30s' },
  { value: 'medium', label: '30–60s' },
  { value: 'long', label: '60–90s' }
]

/**
 * Batch queue on the home screen: add several files or links, choose the
 * settings once, and Cutawan imports and analyses them one after another.
 * Collapsed to a single line until it is used, so the single-video flow
 * looks the same for everyone who never queues.
 */
export default function BatchQueue(): React.JSX.Element {
  const batch = useStore((s) => s.batch)
  const [open, setOpen] = useState(false)
  const expanded = open || batch.items.length > 0

  if (!expanded) {
    return (
      <div className="flex justify-center">
        <button
          type="button"
          data-testid="batch-open"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition hover:bg-surface-850 hover:text-zinc-300"
        >
          <Layers size={13} /> Queue several videos
        </button>
      </div>
    )
  }
  return <BatchPanel onClose={batch.items.length === 0 ? () => setOpen(false) : undefined} />
}

function BatchPanel({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const batch = useStore((s) => s.batch)
  const batchError = useStore((s) => s.batchError)
  const settings = useStore((s) => s.settings)
  const addToBatch = useStore((s) => s.addToBatch)
  const startBatch = useStore((s) => s.startBatch)
  const pauseBatch = useStore((s) => s.pauseBatch)
  const clearFinished = useStore((s) => s.clearFinishedBatch)
  const [urls, setUrls] = useState('')
  const [showOptions, setShowOptions] = useState(batch.items.length === 0)
  const [options, setOptions] = useState<AnalyzeOptions>(() => ({
    prompt: '',
    clipLength: 'auto',
    videoType: 'auto',
    broll: false,
    // Same default as the setup screen: off on ChatGPT sign-in's small daily cap.
    hookFirst: settings?.subscription.provider !== 'chatgpt',
    stitch: false,
    visualDiscovery: false,
    editorialRanking: false
  }))
  const set = (patch: Partial<AnalyzeOptions>): void => setOptions((o) => ({ ...o, ...patch }))

  const queued = batch.items.filter((i) => i.status === 'queued').length
  const finished = batch.items.filter((i) => i.status === 'done' || i.status === 'cancelled').length
  const add = async (sources: BatchItemSource[]): Promise<void> => {
    if (sources.length) await addToBatch(sources, options)
  }
  const parsedUrls = urls.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/.test(u))

  return (
    <section data-testid="batch-queue" className="mx-auto mt-2 w-full max-w-3xl rounded-2xl border border-surface-700 bg-surface-900 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Layers size={15} className="text-accent-400" /> Batch queue
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Each video is imported and analysed in turn with the settings it was added with.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {finished > 0 && (
            <button type="button" onClick={() => void clearFinished()}
              className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-surface-800 hover:text-zinc-300">
              Clear finished
            </button>
          )}
          {batch.running ? (
            <button type="button" data-testid="batch-pause" onClick={() => void pauseBatch()}
              className="flex items-center gap-1.5 rounded-lg border border-surface-600 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-surface-800">
              <Pause size={13} /> Pause after this video
            </button>
          ) : (
            <button type="button" data-testid="batch-start" disabled={queued === 0} onClick={() => void startBatch()}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-40">
              <Play size={13} /> {batch.items.some((i) => i.status === 'done' || i.status === 'failed') && queued ? 'Resume' : 'Start'}{queued ? ` (${queued})` : ''}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} title="Hide the queue"
              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-surface-800 hover:text-zinc-300">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {batch.items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {batch.items.map((item) => <BatchRow key={item.id} item={item} />)}
        </ul>
      )}

      <div className="mt-4 rounded-xl border border-surface-700 bg-surface-850/50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="batch-add-files"
            onClick={async () => {
              const paths = await window.cutawan.selectVideos()
              await add(paths.map((path) => ({ kind: 'file' as const, path })))
            }}
            className="flex items-center gap-1.5 rounded-lg border border-surface-600 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
          >
            <FolderOpen size={13} /> Add files…
          </button>
          <form
            className="flex min-w-[16rem] flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void add(parsedUrls.map((url) => ({ kind: 'url' as const, url }))).then(() => setUrls(''))
            }}
          >
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-surface-600 bg-surface-900 px-2.5 py-1.5 focus-within:border-white/25">
              <Link2 size={13} className="shrink-0 text-zinc-500" />
              <input
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder="Paste one or more links, separated by spaces"
                className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
              />
            </div>
            <button type="submit" disabled={parsedUrls.length === 0}
              className="rounded-lg border border-surface-600 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-40">
              Add {parsedUrls.length > 1 ? `${parsedUrls.length} links` : 'link'}
            </button>
          </form>
        </div>
        {batchError && <p className="mt-2 text-xs text-red-400">{batchError}</p>}

        <button type="button" onClick={() => setShowOptions(!showOptions)}
          className="mt-3 flex items-center gap-1 text-[11px] font-medium text-zinc-400 transition hover:text-zinc-200">
          <ChevronDown size={12} className={`transition ${showOptions ? 'rotate-180' : ''}`} />
          Settings for videos added next
          <span className="font-normal text-zinc-600">
            · {LENGTHS.find((l) => l.value === options.clipLength)?.label} · {VIDEO_TYPE_OPTIONS.find((v) => v.value === options.videoType)?.label}
            {options.prompt.trim() ? ' · custom instructions' : ''}
          </span>
        </button>
        {showOptions && (
          <div className="mt-2.5 space-y-2.5">
            <input
              value={options.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="AI instructions (optional), e.g. “Find the funniest exchanges”"
              className="w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-lg border border-surface-600">
                {LENGTHS.map((l) => (
                  <button key={l.value} type="button" onClick={() => set({ clipLength: l.value })}
                    className={`px-2.5 py-1.5 text-[11px] transition ${options.clipLength === l.value ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:bg-surface-800'}`}>
                    {l.label}
                  </button>
                ))}
              </div>
              <select
                value={options.videoType}
                onChange={(e) => set({ videoType: e.target.value as VideoType })}
                className="rounded-lg border border-surface-600 bg-surface-900 px-2.5 py-1.5 text-[11px] text-zinc-300 focus:border-white/25 focus:outline-none"
              >
                {VIDEO_TYPE_OPTIONS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-zinc-400">
              <Check2 label="Open on the hook" checked={options.hookFirst} onChange={(v) => set({ hookFirst: v })} />
              <Check2 label="AI B-roll images" checked={options.broll} onChange={(v) => set({ broll: v })} />
              <Check2 label="Join separate moments" checked={options.stitch === true} onChange={(v) => set({ stitch: v })} />
              <Check2 label="Find visual moments" checked={options.visualDiscovery === true} onChange={(v) => set({ visualDiscovery: v })} />
              <Check2 label="Review and rank stories" checked={options.editorialRanking === true} onChange={(v) => set({ editorialRanking: v })} />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function Check2({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

const STATUS_LABEL: Record<BatchItem['status'], string> = {
  queued: 'Queued',
  importing: 'Importing',
  analysing: 'Finding clips',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function BatchRow({ item }: { item: BatchItem }): React.JSX.Element {
  const openProject = useStore((s) => s.openProject)
  const cancel = useStore((s) => s.cancelBatchItem)
  const remove = useStore((s) => s.removeBatchItem)
  const retry = useStore((s) => s.retryBatchItem)
  const active = item.status === 'importing' || item.status === 'analysing'
  const iconButton = 'rounded-md p-1 text-zinc-500 transition hover:bg-surface-700 hover:text-zinc-200'

  return (
    <li data-testid="batch-item" className="rounded-xl border border-surface-700 bg-surface-850/40 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="shrink-0">
          {active ? <Loader2 size={14} className="animate-spin text-zinc-300" />
            : item.status === 'done' ? <Check size={14} className="text-emerald-400" />
              : item.status === 'failed' ? <AlertTriangle size={14} className="text-red-400" />
                : <span className="block h-2 w-2 rounded-full bg-zinc-600" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-200" title={item.label}>{item.label}</div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={item.error ?? item.message}>
            {STATUS_LABEL[item.status]}
            {item.status === 'done' && item.clipCount !== undefined ? ` · ${item.clipCount} clip${item.clipCount === 1 ? '' : 's'}` : ''}
            {active && item.message ? ` · ${item.message}` : ''}
            {item.status === 'queued' && item.message !== 'Waiting' ? ` · ${item.message}` : ''}
            {item.status === 'failed' && item.error ? ` · ${item.error}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {item.status === 'done' && item.projectId && (
            <button type="button" onClick={() => void openProject(item.projectId!)}
              className="rounded-md border border-surface-600 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition hover:bg-surface-800">
              Open
            </button>
          )}
          {(item.status === 'failed' || item.status === 'cancelled') && (
            <button type="button" title="Retry" onClick={() => void retry(item.id)} className={iconButton}>
              <RotateCcw size={13} />
            </button>
          )}
          {(active || item.status === 'queued') && (
            <button type="button" title="Cancel" onClick={() => void cancel(item.id)} className={iconButton}>
              <X size={13} />
            </button>
          )}
          <button type="button" title="Remove from the queue" onClick={() => void remove(item.id)} className={`${iconButton} hover:text-red-400`}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {active && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-700">
          <div
            className={`h-full rounded-full bg-zinc-300 transition-all ${item.progress < 0 ? 'w-1/4 animate-pulse' : ''}`}
            style={item.progress >= 0 ? { width: `${Math.round(Math.min(1, item.progress) * 100)}%` } : undefined}
          />
        </div>
      )}
      {item.licence && !item.licence.reusable && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/90">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {LICENCE_WARNING}
        </p>
      )}
    </li>
  )
}
