import type { Clip, PersonalisationSummary, ScoreBreakdown } from './types'
import { SCORE_PARTS, scoreFromParts, type ScorePart } from './scoreBreakdown'
import { selectedDuration } from './clipSegments'

/**
 * Learning from the user's own choices, kept on this machine.
 *
 * Every clip a run produces is recorded with its rubric parts, length and
 * origin; exporting or editing one (trim, cuts, captions) marks it kept.
 * Once enough clips have been kept, each rubric part gets a weight: how much
 * more (or less) of that part the kept clips have than clips overall,
 * clamped to ±20% and renormalised so scores stay on the same scale. New
 * runs' scores are recomputed from their parts with those weights, plus a
 * small nudge towards the lengths the user keeps. The parts themselves are
 * never changed, so the breakdown a creator reads is still the model's.
 *
 * Pure: the main process owns the file (main/personalisation.ts).
 */

export const PERSONALISATION_VERSION = 1
/** Kept clips needed before re-ranking starts. */
export const MIN_POSITIVES = 8
/** Largest change any one part's weight may make. */
export const WEIGHT_CLAMP = 0.2
/** Records kept on disk; the oldest clips nobody acted on go first. */
export const MAX_RECORDS = 2000
/** The most a clip loses for sitting outside the preferred length band. */
export const LENGTH_PENALTY_MAX = 4

export type PartKey = ScorePart['key']
export type ClipAction = 'exported' | 'edited'

export interface ClipRecord {
  projectId: string
  clipId: string
  recordedAt: number
  /** Rubric parts as a share of each part's scale (0..1); absent on clips without parts. */
  parts?: Record<PartKey, number>
  /** Clip kind, when the clip carries one. */
  kind?: string
  /** Seconds the clip selects (trim minus cuts) at the last record. */
  lengthSec: number
  origin: 'transcript' | 'visual'
  joined: boolean
  /** Distinct positive actions taken on this clip. */
  actions: ClipAction[]
}

export interface PersonalisationStore {
  version: number
  enabled: boolean
  records: ClipRecord[]
}

export interface PersonalisationModel {
  /** Multiplier per rubric part, within 1 ± WEIGHT_CLAMP. */
  weights: Record<PartKey, number>
  /** Lengths the user keeps (20th to 80th percentile), when there are enough. */
  lengthBand: { min: number; max: number } | null
  positives: number
}

export function emptyStore(): PersonalisationStore {
  return { version: PERSONALISATION_VERSION, enabled: true, records: [] }
}

/** A store read from disk, repaired or replaced when it is not one we understand. */
export function migrateStore(raw: unknown): PersonalisationStore {
  if (!raw || typeof raw !== 'object') return emptyStore()
  const value = raw as Partial<PersonalisationStore>
  if (value.version !== PERSONALISATION_VERSION || !Array.isArray(value.records)) {
    return { ...emptyStore(), enabled: value.enabled !== false }
  }
  const records = value.records.filter((r): r is ClipRecord =>
    !!r && typeof r === 'object' && typeof r.projectId === 'string' && typeof r.clipId === 'string' &&
    Number.isFinite(r.lengthSec) && Array.isArray(r.actions))
  return { version: PERSONALISATION_VERSION, enabled: value.enabled !== false, records }
}

/** Clip kind, for clips whose type carries one (not every build's does). */
function clipKind(clip: Clip): string | undefined {
  const kind = (clip as Clip & { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : undefined
}

function partFractions(parts: ScoreBreakdown | undefined): Record<PartKey, number> | undefined {
  if (!parts) return undefined
  const out = {} as Record<PartKey, number>
  for (const part of SCORE_PARTS) {
    const value = parts[part.key]
    if (!Number.isFinite(value)) return undefined
    out[part.key] = Math.max(0, Math.min(1, value / part.max))
  }
  return out
}

/** Clips that are not AI suggestions (the captioned full video) teach nothing. */
const learnable = (clip: Clip): boolean => clip.origin !== 'whole-video'

function describe(projectId: string, clip: Clip, now: number, actions: ClipAction[]): ClipRecord {
  const parts = partFractions(clip.scoreBreakdown)
  const kind = clipKind(clip)
  return {
    projectId,
    clipId: clip.id,
    recordedAt: now,
    ...(parts ? { parts } : {}),
    ...(kind ? { kind } : {}),
    lengthSec: Math.round(selectedDuration(clip.edit) * 10) / 10,
    origin: clip.discovery?.origin === 'visual' ? 'visual' : 'transcript',
    joined: Boolean(clip.stitch),
    actions
  }
}

/** Drop the oldest records nobody acted on until the store fits. */
function bound(records: ClipRecord[]): ClipRecord[] {
  if (records.length <= MAX_RECORDS) return records
  const sorted = [...records].sort((a, b) => a.recordedAt - b.recordedAt)
  let excess = records.length - MAX_RECORDS
  const drop = new Set<ClipRecord>()
  for (const r of sorted) {
    if (excess === 0) break
    if (r.actions.length === 0) {
      drop.add(r)
      excess--
    }
  }
  for (const r of sorted) {
    if (excess === 0) break
    if (!drop.has(r)) {
      drop.add(r)
      excess--
    }
  }
  return records.filter((r) => !drop.has(r))
}

/** Record a run's clips (new records only; existing ones keep their actions). */
export function recordClips(store: PersonalisationStore, projectId: string, clips: Clip[], now = Date.now()): PersonalisationStore {
  const known = new Set(store.records.filter((r) => r.projectId === projectId).map((r) => r.clipId))
  const added = clips.filter((c) => learnable(c) && !known.has(c.id)).map((c) => describe(projectId, c, now, []))
  return added.length ? { ...store, records: bound([...store.records, ...added]) } : store
}

/** Mark a clip kept. Its length is refreshed: the trim the user settled on is the signal. */
export function recordAction(
  store: PersonalisationStore, projectId: string, clip: Clip, action: ClipAction, now = Date.now()
): PersonalisationStore {
  if (!learnable(clip)) return store
  const index = store.records.findIndex((r) => r.projectId === projectId && r.clipId === clip.id)
  const existing = index >= 0 ? store.records[index] : null
  const actions = existing?.actions.includes(action) ? existing.actions : [...(existing?.actions ?? []), action]
  const fresh = describe(projectId, clip, existing?.recordedAt ?? now, actions)
  // The parts come from the run; an old record keeps them if the clip lost them.
  const record = { ...fresh, ...(fresh.parts ? {} : existing?.parts ? { parts: existing.parts } : {}) }
  const records = [...store.records]
  if (index >= 0) records[index] = record
  else records.push(record)
  return { ...store, records: bound(records) }
}

const isPositive = (r: ClipRecord): boolean => r.actions.length > 0

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * p))
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

const clampWeight = (w: number): number => Math.max(1 - WEIGHT_CLAMP, Math.min(1 + WEIGHT_CLAMP, w))

/**
 * Weights and a preferred length band from the records, or null while
 * personalisation is off or too few clips have been kept.
 */
export function computeModel(store: PersonalisationStore): PersonalisationModel | null {
  if (!store.enabled) return null
  const withParts = store.records.filter((r) => r.parts)
  const kept = withParts.filter(isPositive)
  if (kept.length < MIN_POSITIVES) return null
  const raw = {} as Record<PartKey, number>
  for (const part of SCORE_PARTS) {
    const mean = (rs: ClipRecord[]): number => rs.reduce((sum, r) => sum + (r.parts?.[part.key] ?? 0), 0) / rs.length
    const overall = mean(withParts)
    raw[part.key] = overall > 1e-6 ? clampWeight(mean(kept) / overall) : 1
  }
  // Renormalise so a clip scoring every part's maximum still scores the
  // same total: the weights redistribute emphasis, they do not inflate.
  const capacity = SCORE_PARTS.reduce((sum, p) => sum + p.max, 0)
  const weighted = SCORE_PARTS.reduce((sum, p) => sum + raw[p.key] * p.max, 0)
  const weights = {} as Record<PartKey, number>
  for (const part of SCORE_PARTS) weights[part.key] = clampWeight(raw[part.key] * (capacity / weighted))

  const lengths = store.records.filter(isPositive).map((r) => r.lengthSec).filter((l) => l > 0).sort((a, b) => a - b)
  const lengthBand = lengths.length >= 5 ? { min: percentile(lengths, 0.2), max: percentile(lengths, 0.8) } : null
  return { weights, lengthBand, positives: kept.length }
}

/** Points a clip loses for its length, 0 inside the band. */
export function lengthPenalty(lengthSec: number, band: PersonalisationModel['lengthBand']): number {
  if (!band || !(lengthSec > 0)) return 0
  const distance = lengthSec < band.min ? band.min - lengthSec : lengthSec > band.max ? lengthSec - band.max : 0
  if (distance === 0) return 0
  // Relative to the band's scale: five seconds matters more for 20 s clips than for 80 s ones.
  const scale = Math.max(5, (band.min + band.max) / 4)
  return LENGTH_PENALTY_MAX * Math.min(1, distance / scale)
}

/**
 * A clip's score recomputed with the weights. Adjustments made to the
 * score after the parts were summed (length overruns, for instance) are
 * kept: only the parts' contribution is re-weighted.
 */
export function personalisedScore(clip: Pick<Clip, 'viralityScore' | 'scoreBreakdown' | 'edit'>, model: PersonalisationModel): number {
  let score = clip.viralityScore
  if (clip.scoreBreakdown) {
    const parts = clip.scoreBreakdown
    const reweighted = SCORE_PARTS.reduce((sum, p) => sum + model.weights[p.key] * parts[p.key], 0)
    score += reweighted - scoreFromParts(parts)
  }
  score -= lengthPenalty(selectedDuration(clip.edit), model.lengthBand)
  return Math.max(0, Math.min(99, Math.round(score)))
}

/** Re-score clips in place and return them highest first. */
export function applyPersonalisation(clips: Clip[], model: PersonalisationModel): Clip[] {
  for (const clip of clips) clip.viralityScore = personalisedScore(clip, model)
  return clips.sort((a, b) => b.viralityScore - a.viralityScore)
}

export function summarise(store: PersonalisationStore): PersonalisationSummary {
  const positives = store.records.filter((r) => r.parts && isPositive(r)).length
  return {
    enabled: store.enabled,
    positives,
    recorded: store.records.length,
    minPositives: MIN_POSITIVES,
    active: store.enabled && positives >= MIN_POSITIVES
  }
}
