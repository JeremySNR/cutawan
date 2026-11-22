import { useEffect, useMemo, useState } from 'react'
import { Redo2, Scissors, SplitSquareHorizontal, Trash2, Undo2 } from 'lucide-react'
import type { Clip, TimelineData, TimeRange } from '@shared/types'
import type { TimelineScale } from '@shared/timelineScale'
import { activityKeptRanges, autoRemovedRanges, editedClipDuration, normalizeRanges } from '@shared/tighten'
import { cutRange, keepsPlayback, moveCutEdge, pieceAt, setTrimEdge, splitAt, timelinePieces, toggleActiveGap, toggleRemovedPause, uncutAt } from '@shared/editOps'
import { historyState } from '@shared/editHistory'
import { usePreviewBus } from '../lib/previewBus'
import { useStore } from '../store'
import TrimBar, { type TimelineMark } from './TrimBar'

/** Keyboard shortcuts must not fire while the user is typing. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)))
}

const SHORTCUTS = 'Space/K play · J/L ±1 s · ←/→ frame · I/O in/out · S split · Delete cut piece · ⌘Z undo'

/**
 * Timeline editing on top of the trim bar: razor splits, ripple-deleting a
 * piece, restoring automatically removed pauses, undo/redo and
 * Premiere-style shortcuts. Every change goes through the shared edit ops
 * and `clipKeptSegments`, so preview and export stay identical.
 */
export default function TimelineEditor({ clip, scale, timelines, fps, onSave, onLocal, onDragState }: {
  clip: Clip
  scale: TimelineScale
  timelines: Array<TimelineData | null>
  fps: number
  onDragState?: (dragging: boolean) => void
  onSave: (edit: Clip['edit']) => void
  onLocal: (edit: Clip['edit']) => void
}): React.JSX.Element {
  const transcript = useStore((s) => s.project?.transcript ?? null)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  useStore((s) => s.historyVersion) // re-render undo/redo availability
  const { canUndo, canRedo } = historyState(clip.id)
  const [selected, setSelected] = useState<TimeRange | null>(null)
  const edit = clip.edit
  const windowStart = scale.panes[0].start
  const windowEnd = scale.panes[scale.panes.length - 1].end

  const marks = useMemo<TimelineMark[]>(() => {
    const restored = normalizeRanges(edit.restored, edit.start, edit.end)
    const auto = autoRemovedRanges(clip, transcript)
      .filter((r) => !restored.some((k) => k.start < r.end && k.end > r.start))
    // Pauses kept because something happens in them: shown as kept, and one
    // click removes them like any other pause.
    const active = activityKeptRanges(clip, transcript)
      .filter((r) => !restored.some((k) => k.start < r.end && k.end > r.start))
    return [
      ...auto.map((range) => ({ range, kind: 'auto' as const })),
      ...active.map((range) => ({ range, kind: 'active' as const })),
      ...(edit.tightenCuts ? restored.map((range) => ({ range, kind: 'restored' as const })) : []),
      ...normalizeRanges(edit.cuts, edit.start, edit.end).map((range) => ({ range, kind: 'cut' as const }))
    ]
  }, [clip, transcript, edit.restored, edit.cuts, edit.start, edit.end, edit.tightenCuts])

  const pieces = timelinePieces(edit)
  // A selection only means something once the timeline has been split, and
  // only while it is still exactly one of the current pieces (a split, trim
  // or undo since the click would otherwise leave a stale range to cut).
  const selection = selected && pieces.length > 1 &&
    pieces.some((p) => Math.abs(p.start - selected.start) < 1e-6 && Math.abs(p.end - selected.end) < 1e-6)
    ? selected : null

  const cutSelected = (): void => {
    if (!selection) return
    const next = cutRange(edit, selection)
    // Never cut away everything that plays.
    if (keepsPlayback({ ...clip, edit: next }, transcript)) onSave(next)
    setSelected(null)
  }
  // Trims and re-removed pauses go through the same guard as cuts: they could
  // otherwise leave nothing to play.
  const saveTrim = (next: Clip['edit']): void => {
    if (keepsPlayback({ ...clip, edit: next }, transcript)) onSave(next)
  }
  const split = (): void => {
    const next = splitAt(edit, usePreviewBus.getState().time)
    if (next !== edit) onSave(next)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target) || e.altKey || e.defaultPrevented) return
      const bus = usePreviewBus.getState()
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      // Holding a key auto-repeats it: stepping should continue, but play,
      // split, cut, in/out and undo must fire once per press.
      if (e.repeat && !['j', 'l', 'arrowleft', 'arrowright'].includes(key)) {
        if ([' ', 'k', 's', 'i', 'o', 'delete', 'backspace', 'z', 'y'].includes(key)) e.preventDefault()
        return
      }
      const step = (dt: number): void => bus.seek(Math.max(edit.start, Math.min(edit.end, bus.time + dt)))
      let handled = true
      if (mod && key === 'z') void (e.shiftKey ? redo(clip.id) : undo(clip.id))
      else if (mod && key === 'y') void redo(clip.id)
      else if (mod && key === 'k') split()
      else if (mod) handled = false
      else if (key === ' ' || key === 'k') bus.togglePlay()
      else if (key === 'j') step(-1)
      else if (key === 'l') step(1)
      else if (key === 'arrowleft') step(e.shiftKey ? -1 : -1 / fps)
      else if (key === 'arrowright') step(e.shiftKey ? 1 : 1 / fps)
      else if (key === 'i') saveTrim(setTrimEdge(edit, 'start', Math.max(windowStart, bus.time)))
      else if (key === 'o') saveTrim(setTrimEdge(edit, 'end', Math.min(windowEnd, bus.time)))
      else if (key === 's') split()
      else if (key === 'delete' || key === 'backspace') cutSelected()
      else if (key === 'escape') setSelected(null)
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const button = 'flex items-center gap-1 rounded-md border border-surface-600 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-surface-800 disabled:opacity-40'
  return (
    <div>
      <TrimBar
        scale={scale}
        timelines={timelines}
        start={edit.start}
        end={edit.end}
        onDragState={onDragState}
        onCutEdge={(cut, which, t) => {
          // Read the live clip, as onCommit does: the drag spans many renders.
          const current = useStore.getState().project?.clips.find((c) => c.id === clip.id)
          if (!current) return
          const next = moveCutEdge(current.edit, cut, which, t)
          onLocal(next)
          // Show the frame the edge now sits on, wherever the clamp left it.
          const moved = next.cuts?.find((c) => which === 'start' ? c.end === cut.end : c.start === cut.start)
          if (moved) usePreviewBus.getState().scrub(which === 'start' ? moved.start : moved.end)
        }}
        onChange={(start, end) => onLocal({ ...edit, start, end })}
        onCommit={() => {
          // Read the live clip: the drag closure was created at drag start,
          // so `edit` here is the pre-drag trim to snap back to if refused.
          const current = useStore.getState().project?.clips.find((c) => c.id === clip.id)
          if (!current) return
          if (keepsPlayback(current, transcript)) onSave(current.edit)
          else onLocal(edit)
        }}
        marks={marks}
        splits={edit.splits}
        selected={selection}
        onPieceClick={(t) => setSelected(pieceAt(edit, t) ?? null)}
        playsFor={editedClipDuration(clip, transcript)}
        onMarkClick={(mark) => {
          if (mark.kind === 'cut') onSave(uncutAt(edit, (mark.range.start + mark.range.end) / 2))
          else if (mark.kind === 'active') saveTrim(toggleActiveGap(edit, mark.range))
          else saveTrim(toggleRemovedPause(edit, mark.range))
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className={button} onClick={split} title="Split at playhead (S or ⌘K)">
          <SplitSquareHorizontal size={12} /> Split
        </button>
        <button type="button" className={button} onClick={cutSelected} disabled={!selection} title="Cut the selected piece (Delete)">
          <Trash2 size={12} /> Cut piece
        </button>
        <button type="button" className={button} onClick={() => void undo(clip.id)} disabled={!canUndo} title="Undo (⌘Z)">
          <Undo2 size={12} /> Undo
        </button>
        <button type="button" className={button} onClick={() => void redo(clip.id)} disabled={!canRedo} title="Redo (⇧⌘Z)">
          <Redo2 size={12} /> Redo
        </button>
        {(edit.cuts?.length ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-zinc-500">
            <Scissors size={11} /> {edit.cuts!.length} cut{edit.cuts!.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">{SHORTCUTS}</p>
    </div>
  )
}
