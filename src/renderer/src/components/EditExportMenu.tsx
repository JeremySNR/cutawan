import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, FolderOpen, Loader2, Clapperboard } from 'lucide-react'
import type { NleFormat } from '@shared/types'
import { useStore } from '../store'

const FORMATS: Array<{ value: NleFormat; label: string; hint: string }> = [
  { value: 'xmeml', label: 'Premiere Pro', hint: 'XML · also DaVinci Resolve' },
  { value: 'fcpxml', label: 'Final Cut Pro', hint: 'FCPXML · also DaVinci Resolve' }
]

/**
 * "Export edit for…": the clip's cut list as an editing timeline that
 * references the source file, for finishing in an NLE. Lives under the
 * editor's export button; writes into the same export folder.
 */
export default function EditExportMenu({ clipId }: { clipId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const entry = useStore((s) => s.editExports[clipId])
  const exportEdit = useStore((s) => s.exportEdit)
  const busy = entry?.status === 'exporting'

  return (
    <div className="mt-2" data-testid="edit-export">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-[11px] font-medium text-zinc-400 transition hover:text-zinc-200"
      >
        <span className="flex items-center gap-1.5">
          <Clapperboard size={12} /> Export edit for Premiere, Resolve or Final Cut…
        </span>
        <ChevronDown size={12} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl border border-surface-600 bg-surface-850/60 p-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                disabled={busy}
                data-testid={`edit-export-${f.value}`}
                onClick={() => void exportEdit(clipId, f.value)}
                className="rounded-lg border border-surface-600 px-2.5 py-2 text-left transition hover:bg-surface-800 disabled:opacity-50"
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                  {busy && entry?.format === f.value && <Loader2 size={11} className="animate-spin" />}
                  {f.label}
                </div>
                <div className="mt-0.5 text-[10px] text-zinc-500">{f.hint}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
            Writes the cuts (pauses removed, your cuts applied) as a timeline that uses the original
            video, with captions as an .srt file. Reframing, zoom, B-roll and burned-in caption
            styling are not carried over.
          </p>
          {entry?.status === 'done' && entry.outputPath && (
            <button
              type="button"
              onClick={() => void window.cutawan.showItemInFolder(entry.outputPath!)}
              title={entry.srtPath ? `${entry.outputPath}\n${entry.srtPath}` : entry.outputPath}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[11px] font-medium text-emerald-400 transition hover:bg-emerald-500/25"
            >
              <Check size={12} /> Timeline saved{entry.srtPath ? ' with captions' : ''}
              <FolderOpen size={12} />
            </button>
          )}
          {entry?.status === 'error' && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-red-400">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {entry.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
