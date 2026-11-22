import { Gauge } from 'lucide-react'
import { scoreColor } from '../lib/format'

export default function ScoreBadge({
  score,
  kind = 'legacy',
  size = 'sm'
}: {
  score: number
  kind?: 'editorial' | 'score' | 'legacy'
  size?: 'sm' | 'lg'
}): React.JSX.Element {
  const color = scoreColor(score)
  const label = kind === 'editorial' ? 'Editorial' : kind === 'score' ? 'Score' : 'Legacy score'
  const description = kind === 'editorial'
    ? `Editorial assessment: ${score} out of 100. Audience performance and the exported video have not been verified.`
    : kind === 'score'
      ? `AI score: ${score} out of 99, from the hook, emotion, value, flow, shareability and visuals. An estimate of editorial quality, not a prediction of views.`
      : `Legacy AI score: ${score} out of 99. Regenerate to see what the score is made of.`
  if (size === 'lg') {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border px-3 py-2"
        style={{ borderColor: `${color}55`, backgroundColor: `${color}14` }}
        title={description}
        role="img"
        aria-label={description}
      >
        <Gauge size={18} style={{ color }} aria-hidden="true" />
        <div>
          <div className="text-lg font-bold leading-none tabular-nums" style={{ color }}>
            {score}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
            {label}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div
      className="flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs font-bold tabular-nums backdrop-blur"
      style={{ color, boxShadow: `inset 0 0 0 1px ${color}55` }}
      title={description}
      role="img"
      aria-label={description}
    >
      <Gauge size={12} aria-hidden="true" />
      <span className="text-[10px] font-medium">{label}</span>
      {score}
    </div>
  )
}
