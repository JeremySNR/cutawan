import type { Clip } from '@shared/types'
import { EDITORIAL_DIMENSIONS, type EditorialDimension, type EditorialRankingReport } from '@shared/editorialRanking'
import ScoreBadge from './ScoreBadge'
import { formatTimecode } from '../lib/format'

const DIMENSION_LABELS: Record<EditorialDimension, string> = {
  hook: 'Hook', clarity: 'Clarity', value: 'Value', payoff: 'Payoff', audienceFit: 'Audience fit'
}

export function EditorialScore({ clip, current, size = 'sm' }: {
  clip: Clip
  current: boolean
  size?: 'sm' | 'lg'
}): React.JSX.Element {
  // Shots from a Metachlorian package were chosen there, not scored here.
  if (!clip.editorial && clip.origin === 'package') {
    return <span className="shrink-0 rounded-full border border-white/[0.08] bg-black/75 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
      From package
    </span>
  }
  if (!clip.editorial) return <ScoreBadge score={clip.viralityScore} size={size} />
  if (current && clip.editorial.status === 'reviewed' && clip.editorial.score !== null) {
    return <ScoreBadge score={clip.editorial.score} kind="editorial" size={size} />
  }
  return <span className="shrink-0 rounded-full border border-amber-400/25 bg-black/75 px-2.5 py-1 text-[11px] font-medium text-amber-200">
    {current ? 'Needs review' : 'Review edits'}
  </span>
}

export function EditorialExplanation({ clip, current, compact = false }: {
  clip: Clip
  current: boolean
  compact?: boolean
}): React.JSX.Element {
  const assessment = clip.editorial
  if (!assessment && clip.origin === 'package') {
    return <p className={`${compact ? 'mt-2 line-clamp-2' : 'rounded-xl border border-surface-700 bg-surface-850 px-3.5 py-3'} text-xs leading-relaxed text-zinc-400`}>
      <span className="font-medium text-zinc-300">Selected in Metachlorian. </span>
      {compact ? 'Not scored by Cutawan.' : 'This shot came from an imported package, so Cutawan has not scored it.'}
    </p>
  }
  if (!assessment) {
    return <p className={`${compact ? 'mt-2 line-clamp-2' : 'rounded-xl border border-surface-700 bg-surface-850 px-3.5 py-3'} text-xs leading-relaxed text-zinc-400`}>
      <span className="font-medium text-zinc-300">Earlier AI assessment: </span>
      {clip.viralityReason || 'Regenerate to assess this selection with the current editorial criteria.'}
      {!compact && clip.visualSummary && <span className="mt-2 block"><span className="font-medium text-zinc-300">Source visuals: </span>{clip.visualSummary}</span>}
      {!compact && <span className="mt-2 block text-zinc-500">This saved score has not been assessed with the current editorial criteria.</span>}
    </p>
  }
  if (compact) {
    return <div className="mt-2 text-xs leading-relaxed">
      {!current && <p className="text-amber-300">Selection changed. Review the edited clip.</p>}
      {current && assessment.status !== 'reviewed' && <p className="text-amber-300">Review context and the complete payoff.</p>}
      <p className="line-clamp-2 text-zinc-400" title={assessment.reason}>{assessment.reason}</p>
      {assessment.deferredReason && <p className="mt-1 text-zinc-500" title={assessment.deferredReason}>Alternative take on an earlier idea</p>}
    </div>
  }
  return <div className="rounded-xl border border-surface-700 bg-surface-850 px-3.5 py-3 text-xs leading-relaxed text-zinc-400">
    <p className="font-semibold text-zinc-200">Editorial assessment</p>
    <p className="mt-1">{assessment.reason}</p>
    {!current && <p className="mt-2 text-amber-300">Your edits changed the assessed selection. This explanation describes the original selection; review the edited clip.</p>}
    {assessment.status !== 'reviewed' && <p className="mt-2 text-amber-300">The model could not confirm a complete, faithful story. Review context and the payoff before exporting.</p>}
    {assessment.deferredReason && <p className="mt-2"><span className="font-medium text-zinc-300">Alternative take: </span>{assessment.deferredReason}</p>}
    {assessment.concerns.length > 0 && <div className="mt-2 text-amber-200">
      <p className="font-medium">Check before exporting</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">{assessment.concerns.map((concern, index) => <li key={index}>{concern}</li>)}</ul>
    </div>}
    <details className="mt-3 border-t border-surface-700 pt-2">
      <summary className="cursor-pointer font-medium text-zinc-300">Assessment details</summary>
      {assessment.takeaway && <p className="mt-2"><span className="font-medium text-zinc-300">Takeaway: </span>{assessment.takeaway}</p>}
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        {EDITORIAL_DIMENSIONS.map(dimension => <div key={dimension} className="contents">
          <dt>{DIMENSION_LABELS[dimension]}</dt>
          <dd className="tabular-nums text-zinc-300">{assessment.scores[dimension] === null ? 'Not assessed' : `${assessment.scores[dimension]}/4`}</dd>
        </div>)}
      </dl>
      <p className="mt-2">Model view: story {assessment.story}; source meaning {assessment.fidelity}.</p>
      {assessment.evidence.length > 0 && <div className="mt-2">
        <p className="font-medium text-zinc-300">Cited source evidence</p>
        <ul className="mt-1 space-y-1">{assessment.evidence.slice(0, 3).map((item, index) => <li key={index}>
          <span className="font-medium text-zinc-300">{formatTimecode(item.time)} · {item.kind === 'speech' ? 'Speech' : 'Frame'}: </span>{item.quote}
        </li>)}</ul>
      </div>}
      {clip.visualSummary && <p className="mt-2"><span className="font-medium text-zinc-300">Source visuals: </span>{clip.visualSummary}</p>}
      <p className="mt-2 text-zinc-500">Model judgement from source text and sampled frames. Scores are provisional editorial estimates. Watch the export to check captions, framing and timing; audience performance has not been measured.</p>
    </details>
  </div>
}

export function EditorialRankingSummary({ report, earlierAttempt = false }: { report?: EditorialRankingReport; earlierAttempt?: boolean }): React.JSX.Element | null {
  if (!report) return null
  return <details className="mt-4 rounded-xl border border-surface-700 bg-surface-900 px-4 py-3 text-xs leading-relaxed text-zinc-400">
    <summary className="cursor-pointer font-medium text-zinc-300">{earlierAttempt ? 'Latest attempt (earlier clips retained) · ' : ''}Editorial review · {report.reviewedCount} scored · {report.needsReviewCount} need review{report.rejectedCount > 0 ? ` · ${report.rejectedCount} excluded` : ''}</summary>
    {earlierAttempt && <p className="mt-2 text-amber-300">This report is from the latest analysis attempt. The saved clips are from an earlier run.</p>}
    <p className="mt-2">Of {report.candidateCount} candidates, {report.rejectedCount} were excluded for story or context problems and {report.suppressedOverlapCount} overlapping selections were removed. {report.duplicateDeferredCount} repeated ideas were moved after distinct selections.</p>
    <p className="mt-2">{report.reviewRequestCount + report.diversityRequestCount} analysis calls, excluding provider retries. Assessment covers source selections; exported quality and audience performance still need checking.</p>
    {report.diversityStatus === 'failed' && <p className="mt-2 text-amber-300">Idea comparison was unavailable. Similar ideas may appear near each other.</p>}
    {report.limitations.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4">{report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}
  </details>
}
