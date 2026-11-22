import type { ScoreBreakdown as Breakdown } from '@shared/types'
import { SCORE_PARTS, scoreGrade, scorePartFraction, visualFraction } from '@shared/scoreBreakdown'
import { scoreColor } from '../lib/format'

interface Row {
  label: string
  fraction: number
  detail: string
}

function rows(parts: Breakdown): Row[] {
  const out: Row[] = SCORE_PARTS.map((part) => ({
    label: part.label,
    fraction: scorePartFraction(parts, part),
    detail: `${parts[part.key]}/${part.max}`
  }))
  const visual = visualFraction(parts)
  if (visual !== null) out.push({ label: 'Visuals', fraction: visual, detail: `${parts.visual}/99` })
  return out
}

/** One letter per rubric part, for a clip card. */
export function ScoreGrades({ parts }: { parts: Breakdown }): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" data-testid="score-grades">
      {rows(parts).map((row) => (
        <span key={row.label} className="whitespace-nowrap text-zinc-500" title={`${row.label}: ${row.detail}`}>
          {row.label}{' '}
          <span className="font-semibold tabular-nums" style={{ color: scoreColor(row.fraction * 100) }}>
            {scoreGrade(row.fraction)}
          </span>
        </span>
      ))}
    </div>
  )
}

/** A bar per rubric part, for the editor. */
export function ScoreBars({ parts }: { parts: Breakdown }): React.JSX.Element {
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5" data-testid="score-bars">
      {rows(parts).map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-zinc-400">{row.label}</dt>
          <dd className="h-1.5 overflow-hidden rounded-full bg-surface-700" aria-hidden="true">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.round(row.fraction * 100)}%`, backgroundColor: scoreColor(row.fraction * 100) }}
            />
          </dd>
          <dd className="text-right tabular-nums text-zinc-300">{row.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
