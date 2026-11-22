import { Combine } from 'lucide-react'
import type { Clip } from '@shared/types'
import { joinedMoments } from '@shared/clipSegments'
import { formatDuration } from '../lib/format'

/** Marks a clip card whose clip plays separate moments of the source back to back. */
export function JoinedBadge({ clip }: { clip: Clip }): React.JSX.Element | null {
  const moments = joinedMoments(clip)
  if (!moments) return null
  return (
    <span
      data-testid="joined-badge"
      className="flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-zinc-200 backdrop-blur"
      title={`Joined from ${moments.length} separate moments of the video. ${clip.stitch?.reason ?? ''}`.trim()}
    >
      <Combine size={11} aria-hidden="true" />
      {moments.length} moments
    </span>
  )
}

/**
 * Says plainly, in the editor, that this clip puts together things that were
 * not said together, where they came from, and how to check or undo it.
 */
export function JoinedMomentsNote({ clip }: { clip: Clip }): React.JSX.Element | null {
  const moments = joinedMoments(clip)
  if (!moments) return null
  return (
    <div
      data-testid="joined-note"
      className="mt-3 rounded-xl border border-surface-700 bg-surface-850 px-3.5 py-3 text-xs leading-relaxed text-zinc-400"
    >
      <p className="flex items-center gap-1.5 font-semibold text-zinc-200">
        <Combine size={13} aria-hidden="true" />
        Joined from {moments.length} moments
      </p>
      <p className="mt-1 tabular-nums">
        {moments.map((moment) => `${formatDuration(moment.start)}–${formatDuration(moment.end)}`).join(' → ')}
      </p>
      {clip.stitch?.reason && <p className="mt-1">{clip.stitch.reason}</p>}
      <p className="mt-2 text-zinc-500">
        These were not said back to back. An AI review checked that the join keeps the meaning, but play across it
        before exporting. On the timeline, drag a red edge to move the join, or click the cut to put the skipped part back.
      </p>
    </div>
  )
}
