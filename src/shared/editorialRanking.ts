import type { Clip, Project, Transcript, VideoInfo } from './types'
import { clipKeptSegments } from './tighten'
import { MAX_SUBSCRIPTION_IMAGES } from './subscription'

export const EDITORIAL_VERSION = 'editorial-1'
export const EDITORIAL_DIMENSIONS = ['hook', 'clarity', 'value', 'payoff', 'audienceFit'] as const
export type EditorialDimension = typeof EDITORIAL_DIMENSIONS[number]
const EDITORIAL_FRAMES_PER_CLIP = 4
const SUBSCRIPTION_BATCH_SIZE = Math.floor(MAX_SUBSCRIPTION_IMAGES / EDITORIAL_FRAMES_PER_CLIP)
export const EDITORIAL_BUDGET = { maxCandidates: 44, batchSize: 4, subscriptionBatchSize: SUBSCRIPTION_BATCH_SIZE,
  framesPerClip: EDITORIAL_FRAMES_PER_CLIP, maxReviewCalls: Math.ceil(44 / SUBSCRIPTION_BATCH_SIZE),
  maxApiReviewCalls: 11, maxDiversityCalls: 1 } as const

/** Model assessment of a source selection, never certification of an export. */
export interface EditorialAssessment {
  version: 1
  status: 'reviewed' | 'needs-review' | 'rejected'
  story: 'complete' | 'incomplete' | 'uncertain'
  fidelity: 'supported' | 'misleading' | 'uncertain'
  scores: Record<EditorialDimension, number | null>
  /** Uncalibrated editorial index 0–100; null when incomplete/uncertain. */
  score: number | null
  reason: string
  concerns: string[]
  takeaway: string
  evidence: Array<{ kind: 'speech' | 'frame'; time: number; quote: string }>
  selectionKey: string
  start: number
  end: number
  /** Repeated ideas are deferred, not silently discarded. */
  deferredReason?: string
}

export interface EditorialRankingReport {
  version: 1
  generationId?: string
  recipe: typeof EDITORIAL_VERSION
  createdAt: string
  sourceSha256: string
  sourceRevision: number
  model: string
  provider: 'api' | 'chatgpt'
  effectiveModel: string | null
  prompt: string
  /** Frozen input and two output arms permit an offline same-pool comparison. */
  video: VideoInfo
  transcript: Transcript
  candidates: Clip[]
  baseline: { recipe: 'legacy-60-40-overlap-v1'; clips: Clip[] }
  rankedSnapshot: Clip[]
  assessments: Array<{ clipId: string; assessment: EditorialAssessment }>
  candidateCount: number
  reviewedCount: number
  needsReviewCount: number
  rejectedCount: number
  suppressedOverlapCount: number
  duplicateDeferredCount: number
  reviewRequestCount: number
  diversityRequestCount: number
  diversityStatus: 'complete' | 'failed' | 'not-needed'
  limitations: string[]
}

/** Compare the actual source selection, including removed words and caption corrections.
 * Layout/title changes do not change this source assessment; rendered layout remains separate. */
export function editorialSelectionKey(clip: Clip, transcript: Transcript | null): string {
  // Without the pauses kept for on-screen activity: those are measured by
  // framing analysis after the assessment was recorded, so including them
  // marked every assessed clip as edited when nobody had touched it.
  const ranges = clipKeptSegments({ ...clip, gapActivity: undefined }, transcript) ?? [{ start: clip.edit.start, end: clip.edit.end }]
  const words = transcript?.segments.flatMap(s => s.words).filter(w => ranges.some(r =>
    (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 <= r.end)) ?? []
  return JSON.stringify({ ranges, words: words.map(w => [w.start, w.end, w.sourceText ?? w.text, w.text]) })
}

export function editorialAssessmentCurrent(clip: Clip, transcript: Transcript | null): boolean {
  return !!clip.editorial && clip.editorial.selectionKey === editorialSelectionKey(clip, transcript)
}

/** A failed later attempt must not describe the ordering of retained earlier clips. */
export function editorialReportMatchesClips(project: Pick<Project, 'clips' | 'editorialRanking' | 'clipsGenerationId'>): boolean {
  const report = project.editorialRanking
  if (!report) return false
  if (report.generationId) return report.generationId === project.clipsGenerationId
  const rankedIds = new Set((report.rankedSnapshot ?? []).map(c => c.id))
  const highlights = project.clips.filter(c => c.origin !== 'whole-video')
  return highlights.length > 0 && highlights.every(c => rankedIds.has(c.id))
}

/** Fixed weights make all discovery routes comparable. They are not learned probabilities. */
export function editorialScore(scores: EditorialAssessment['scores']): number {
  const weights: Record<EditorialDimension, number> = { hook: 20, clarity: 25, value: 20, payoff: 25, audienceFit: 10 }
  let sum = 0, weight = 0
  for (const key of EDITORIAL_DIMENSIONS) {
    if (scores[key] === null) continue
    sum += scores[key]! / 4 * weights[key]
    weight += weights[key]
  }
  return weight ? Math.round(sum / weight * 100) : 0
}

export function needsEditorialReview(clip: Clip, transcript: Transcript, reason: string): EditorialAssessment {
  return { version: 1, status: 'needs-review', story: 'uncertain', fidelity: 'uncertain',
    scores: { hook: null, clarity: null, value: null, payoff: null, audienceFit: null }, score: null,
    reason, concerns: [reason], takeaway: '', evidence: [],
    selectionKey: editorialSelectionKey(clip, transcript), start: clip.edit.start, end: clip.edit.end }
}

export interface RepeatedIdea { first: string; second: string; reason: string }

/** Hard story gates precede merit; diversity never promotes an uncertain clip over a reviewed one. */
export function selectEditorialClips(clips: Clip[], repeated: RepeatedIdea[] = [], transcript: Transcript | null = null): {
  clips: Clip[]; suppressedOverlapCount: number; duplicateDeferredCount: number
} {
  const eligible = clips.filter(c => c.editorial?.status !== 'rejected')
  const ordered = [...eligible].sort((a, b) => {
    const aReviewed = a.editorial?.status === 'reviewed', bReviewed = b.editorial?.status === 'reviewed'
    return Number(bReviewed) - Number(aReviewed) ||
      (aReviewed && bReviewed ? (b.editorial?.score ?? 0) - (a.editorial?.score ?? 0) : 0)
  })
  const ranges = new Map(ordered.map(c => [c.id, clipKeptSegments(c, transcript) ?? [{ start: c.edit.start, end: c.edit.end }]]))
  const selected: Clip[] = [], deferred: Clip[] = []
  let suppressedOverlapCount = 0
  for (const clip of ordered) {
    // Compare actual retained footage, not outer bounds around removed intervals.
    const overlaps = [...selected, ...deferred].some(other => {
      const a = ranges.get(clip.id)!, b = ranges.get(other.id)!
      const overlap = a.reduce((sum, left) => sum + b.reduce((total, right) => total +
        Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start)), 0), 0)
      return overlap > .4 * Math.min(a.reduce((s, r) => s + r.end - r.start, 0), b.reduce((s, r) => s + r.end - r.start, 0))
    })
    if (overlaps) { suppressedOverlapCount++; continue }
    const pair = repeated.find(p => (p.first === clip.id && selected.some(c => c.id === p.second)) ||
      (p.second === clip.id && selected.some(c => c.id === p.first)))
    if (pair && clip.editorial?.status === 'reviewed') {
      deferred.push({ ...clip, editorial: { ...clip.editorial, deferredReason: pair.reason } })
    } else selected.push(clip)
  }
  // Reviewed alternatives remain above clips whose review failed or was uncertain.
  return { clips: [...selected.filter(c => c.editorial?.status === 'reviewed'), ...deferred,
    ...selected.filter(c => c.editorial?.status !== 'reviewed')], suppressedOverlapCount, duplicateDeferredCount: deferred.length }
}
