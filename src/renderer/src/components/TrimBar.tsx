import { useCallback, useRef } from 'react'
import type { TimelineData, TimeRange } from '@shared/types'
import type { TimelineScale } from '@shared/timelineScale'

/**
 * A span the timeline marks: removed by pause removal, restored by the user,
 * kept automatically because something happens in it, or cut.
 */
export interface TimelineMark { range: TimeRange; kind: 'auto' | 'restored' | 'active' | 'cut' }

const MARK_STYLE: Record<TimelineMark['kind'], { className: string; title: string }> = {
  auto: { className: 'bg-[repeating-linear-gradient(135deg,rgba(0,0,0,.7)_0_4px,rgba(255,255,255,.18)_4px_7px)]',
    title: 'Pause removed automatically — click to keep it' },
  restored: { className: 'border-x-2 border-dashed border-sky-300/80 bg-sky-300/10',
    title: 'Pause kept — click to remove it again' },
  active: { className: 'border-x-2 border-dashed border-emerald-300/80 bg-emerald-300/10',
    title: 'Pause kept automatically: something moves or sounds in it — click to remove it' },
  cut: { className: 'bg-[repeating-linear-gradient(135deg,rgba(127,29,29,.8)_0_4px,rgba(248,113,113,.35)_4px_7px)]',
    title: 'Cut — click to put it back, or drag an edge to move it' }
}
import { formatDuration, formatTimecode } from '../lib/format'
import { usePreviewBus } from '../lib/previewBus'

/**
 * Visual trim control: a filmstrip of the context window with the audio
 * waveform overlaid, dual drag handles bounding the clip, a live playhead,
 * and click-to-seek. The window extends a little beyond the AI-suggested
 * boundaries so users can grab more of the source video.
 *
 * Time runs along the bar by `scale`, which folds the middle of a long cut
 * into a narrow marker (see shared/timelineScale.ts); each pane it leaves
 * drawn to scale has its own filmstrip and waveform.
 */
export default function TrimBar({
  scale,
  timelines,
  start,
  end,
  onChange,
  onCommit,
  marks = [],
  splits = [],
  selected = null,
  onMarkClick,
  onPieceClick,
  onCutEdge,
  onDragState,
  playsFor
}: {
  scale: TimelineScale
  /** Filmstrip and waveform for each of the scale's panes, in order. */
  timelines: Array<TimelineData | null>
  start: number
  end: number
  onChange: (start: number, end: number) => void
  onCommit: () => void
  marks?: TimelineMark[]
  splits?: number[]
  selected?: TimeRange | null
  onMarkClick?: (mark: TimelineMark) => void
  /** Clicking the track selects the piece under the pointer as well as seeking. */
  onPieceClick?: (t: number) => void
  /** Dragging an edge of a cut; the caller applies the move and saves on `onCommit`. */
  onCutEdge?: (cut: TimeRange, which: 'start' | 'end', t: number) => void
  /** A drag began or ended, so the caller can hold the layout still under the pointer. */
  onDragState?: (dragging: boolean) => void
  /** Playback length after pauses and cuts are removed, when it differs from the trim. */
  playsFor?: number
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const time = usePreviewBus((s) => s.time)
  const seek = usePreviewBus((s) => s.seek)
  const scrub = usePreviewBus((s) => s.scrub)
  const windowStart = scale.panes[0].start
  const windowEnd = scale.panes[scale.panes.length - 1].end

  const toFrac = scale.toFrac
  const fromClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return windowStart
      return scale.fromFrac((clientX - rect.left) / rect.width)
    },
    [scale, windowStart]
  )

  /** Drag one edge of a cut. The preview follows it, as it does a trim handle. */
  const beginCutDrag = useCallback((cut: TimeRange, which: 'start' | 'end', e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const bound = which === 'start' ? cut.start : cut.end
    const grabDelta = fromClientX(e.clientX) - bound
    onDragState?.(true)
    scrub(bound)
    // The caller finds the cut by its other edge and shows the frame it lands on.
    const move = (ev: PointerEvent): void => onCutEdge?.(cut, which, fromClientX(ev.clientX) - grabDelta)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onDragState?.(false)
      onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [fromClientX, onCommit, onCutEdge, onDragState, scrub])

  const beginDrag = useCallback(
    (which: 'start' | 'end', e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const MIN_LEN = 2
      const bound = which === 'start' ? start : end
      // Drag relative to where the handle was grabbed, in seconds, so it
      // tracks the pointer instead of snapping its centre under the cursor on
      // the first move.
      const grabDelta = fromClientX(e.clientX) - bound

      // The preview follows the handle, so the frame being set is always the
      // one on screen. Without this you only saw the new bound when the drag
      // happened to push the playhead out of range, which meant dragging a
      // handle back inwards showed nothing at all.
      const apply = (clientX: number): void => {
        const t = fromClientX(clientX) - grabDelta
        if (which === 'start') {
          const next = Math.min(t, end - MIN_LEN)
          onChange(next, end)
          scrub(next)
        } else {
          const next = Math.max(t, start + MIN_LEN)
          onChange(start, next)
          scrub(next)
        }
      }
      // Show the frame at the grabbed bound immediately, without moving it.
      onDragState?.(true)
      scrub(bound)
      const move = (ev: PointerEvent): void => apply(ev.clientX)
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        onDragState?.(false)
        onCommit()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [start, end, fromClientX, onChange, onCommit, onDragState, scrub]
  )

  const cutEdges: Array<{ range: TimeRange; which: 'start' | 'end' }> = onCutEdge
    ? marks.filter((mark) => mark.kind === 'cut')
        .flatMap((mark) => [{ range: mark.range, which: 'start' as const }, { range: mark.range, which: 'end' as const }])
        // An edge on the trim edge is the trim handle's to move; a second
        // handle on top of it would steal the grab and jump the cut.
        .filter(({ range, which }) => Math.abs((which === 'start' ? range.start : range.end) - (which === 'start' ? start : end)) > 1e-3)
    : []
  const leftPct = toFrac(start) * 100
  const rightPct = toFrac(end) * 100
  const playheadPct = toFrac(time) * 100

  return (
    <div>
      <div
        ref={trackRef}
        data-testid="trim-track"
        className="relative isolate h-16 cursor-pointer overflow-hidden rounded-lg bg-surface-800"
        onPointerDown={(e) => {
          const t = fromClientX(e.clientX)
          seek(t)
          onPieceClick?.(t)
        }}
      >
        {/* Filmstrip and waveform, one pair per pane */}
        {scale.panes.map((pane, index) => {
          const timeline = timelines[index]
          const waveform = timeline?.waveform ?? []
          return (
            <div
              key={`${pane.start}-${pane.end}`}
              className="pointer-events-none absolute inset-y-0 overflow-hidden"
              style={{ left: `${pane.left * 100}%`, width: `${pane.width * 100}%` }}
            >
              {timeline && timeline.frames.length > 0 && (
                <div className="absolute inset-0 flex">
                  {timeline.frames.map((f) => (
                    <img
                      key={f}
                      src={window.cutawan.mediaUrl(f)}
                      alt=""
                      draggable={false}
                      className="h-full min-w-0 flex-1 object-cover"
                    />
                  ))}
                </div>
              )}
              {waveform.length > 1 && (
                <svg
                  className="absolute inset-x-0 bottom-0 h-2/5 w-full"
                  viewBox={`0 0 ${waveform.length} 1`}
                  preserveAspectRatio="none"
                >
                  <path
                    d={`M0,1 ${waveform.map((v, i) => `L${i + 0.5},${(1 - v * 0.92).toFixed(3)}`).join(' ')} L${waveform.length},1 Z`}
                    fill="rgba(255,255,255,0.5)"
                  />
                </svg>
              )}
            </div>
          )
        })}
        {/* Dim outside the selection */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/65"
          style={{ width: `${leftPct}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/65"
          style={{ width: `${100 - rightPct}%` }}
        />
        {/* Selection frame */}
        <div
          className="pointer-events-none absolute inset-y-0 border-y-2 border-zinc-100"
          style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }}
        />
        {/* Removed, restored and cut spans */}
        {marks.map((mark) => (
          <div
            key={`${mark.kind}-${mark.range.start}`}
            title={MARK_STYLE[mark.kind].title}
            className={`absolute inset-y-0 cursor-pointer ${MARK_STYLE[mark.kind].className}`}
            style={{ left: `${toFrac(mark.range.start) * 100}%`, width: `${(toFrac(mark.range.end) - toFrac(mark.range.start)) * 100}%` }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onMarkClick?.(mark)
            }}
          />
        ))}
        {/* Folded stretches: how much source the marker stands for */}
        {scale.folds.map((fold) => (
          <div
            key={`fold-${fold.start}`}
            data-testid="timeline-fold"
            className="pointer-events-none absolute inset-y-0 flex flex-col items-center justify-center gap-0.5 border-x border-black/60 bg-black/70 text-[9px] font-medium leading-none text-zinc-300"
            style={{ left: `${fold.left * 100}%`, width: `${fold.width * 100}%` }}
          >
            <span aria-hidden="true">⋯</span>
            <span className="tabular-nums">{formatDuration(fold.end - fold.start)}</span>
          </div>
        ))}
        {/* Cut edges: drag to let a moment run longer or end sooner */}
        {cutEdges.map(({ range, which }) => (
          <div
            key={`edge-${which}-${range.start}`}
            data-testid={`cut-edge-${which}`}
            title="Drag to move this edge of the cut"
            className="absolute inset-y-0 z-10 w-2 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${toFrac(which === 'start' ? range.start : range.end) * 100}%` }}
            onPointerDown={(e) => beginCutDrag(range, which, e)}
          >
            <div className="absolute inset-y-1 left-1/2 w-[3px] -translate-x-1/2 rounded bg-red-200" />
          </div>
        ))}
        {/* Selected piece and razor points */}
        {selected && (
          <div
            className="pointer-events-none absolute inset-y-0 border-2 border-amber-300 bg-amber-300/10"
            style={{ left: `${toFrac(selected.start) * 100}%`, width: `${(toFrac(selected.end) - toFrac(selected.start)) * 100}%` }}
          />
        )}
        {splits.filter((t) => t > start && t < end).map((t) => (
          <div key={t} className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 bg-amber-300"
            style={{ left: `${toFrac(t) * 100}%` }} />
        ))}
        {/* Playhead: white core with a dark halo so it reads on bright frames */}
        {time >= windowStart && time <= windowEnd && (
          <div
            className="pointer-events-none absolute inset-y-0 w-[6px] -translate-x-1/2 bg-black/60"
            style={{ left: `${playheadPct}%` }}
          >
            <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-white" />
          </div>
        )}
        {/* Drag handles */}
        <div
          className="absolute inset-y-0 w-3 cursor-ew-resize rounded-l-md bg-zinc-100"
          style={{ left: `calc(${leftPct}% - 0px)` }}
          onPointerDown={(e) => beginDrag('start', e)}
        >
          <div className="absolute left-1/2 top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-600" />
        </div>
        <div
          className="absolute inset-y-0 w-3 cursor-ew-resize rounded-r-md bg-zinc-100"
          style={{ left: `calc(${rightPct}% - 12px)` }}
          onPointerDown={(e) => beginDrag('end', e)}
        >
          <div className="absolute left-1/2 top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-600" />
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-zinc-500">
        <span>In {formatTimecode(start)}</span>
        <span className="font-medium text-zinc-400">
          {scale.folds.length > 0 && playsFor !== undefined
            // "5:20 long" would describe the source a joined clip spans, not the clip.
            ? `plays ${formatTimecode(playsFor)} · skips ${formatDuration(end - start - playsFor)}`
            : <>
                {formatTimecode(end - start)} long
                {playsFor !== undefined && Math.abs(playsFor - (end - start)) > 0.05 && ` · plays ${formatTimecode(playsFor)}`}
              </>}
        </span>
        <span>Out {formatTimecode(end)}</span>
      </div>
    </div>
  )
}
