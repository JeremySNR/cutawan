import type { Clip, ClipContentType, ClipEditState, LayoutShot, VideoType } from './types'
import { DETAIL_CAPTION_Y, validContentRegion, type CaptionPositionRange } from './contentRegion'
import { isPresenterComposition, presenterComposition, validComposition } from './composition'

/** Face coverage below this is treated as a screencast / demo / slides clip. */
export const SCREENCAST_FACE_COVERAGE = 0.25

export function classifyClipContent(faceCoverage: number, hasFocusTrack = true): ClipContentType {
  if (!hasFocusTrack) return 'screencast'
  if (faceCoverage < SCREENCAST_FACE_COVERAGE) return 'screencast'
  return 'speaker'
}

/** Layout defaults for demos and screen shares on vertical exports. */
export function editDefaultsForContentType(
  edit: ClipEditState,
  contentType: ClipContentType
): ClipEditState {
  if (contentType !== 'screencast') return edit
  return {
    ...edit,
    reframeMode: 'fit-letterbox',
    framing: 'manual',
    focusX: 0.5,
    autoZoom: false
  }
}

/** Auto zoom only makes sense on cropped talking-head reframes. */
export function clipAllowsAutoZoom(edit: ClipEditState): boolean {
  return (edit.autoZoom ?? false) && edit.reframeMode === 'crop'
}

/** A detected face must not overrule an inspected slide, prop or demonstration. */
export function applyVisualLayout(
  edit: ClipEditState,
  assessment: Clip['visualLayout'],
  videoType: VideoType
): ClipEditState {
  if (!assessment || edit.start < assessment.start - 0.001 || edit.end > assessment.end + 0.001) return edit
  // Explicit talking-head mode is a user choice; automatic mode may prefer context.
  if (assessment.preserveContext && videoType !== 'talking-head') {
    if (validLayoutShots(assessment, edit.start, edit.end) &&
      assessment.shots!.some(shot => (shot.mode === 'crop' || validContentRegion(shot.region, shot.overview) || validComposition(shot.composition)) && shot.start < edit.end && shot.end > edit.start)) {
      return { ...edit, reframeMode: 'crop', framing: 'auto', autoZoom: false }
    }
    return { ...edit, reframeMode: 'fit-letterbox', framing: 'manual', focusX: 0.5, autoZoom: false }
  }
  return assessment.allowZoom ? edit : { ...edit, autoZoom: false }
}

export function validLayoutShots(assessment: Clip['visualLayout'], start: number, end: number): boolean {
  if (!assessment?.shots?.length || !Number.isFinite(assessment.start) || !Number.isFinite(assessment.end) ||
    assessment.shots.length > 48 || start < assessment.start - 0.001 || end > assessment.end + 0.001) return false
  let cursor = assessment.start
  for (const shot of assessment.shots) {
    if (!Number.isFinite(shot.start) || !Number.isFinite(shot.end) || shot.end <= shot.start ||
      Math.abs(shot.start - cursor) > 0.001 || (shot.mode !== 'crop' && shot.mode !== 'fit') ||
      (shot.overview !== undefined && typeof shot.overview !== 'boolean') ||
      (shot.overview && (!shot.region || shot.mode !== 'fit')) ||
      (shot.composition !== undefined && (shot.mode !== 'fit' || shot.region !== undefined || shot.overview || !validComposition(shot.composition))) ||
      (shot.region !== undefined && !validContentRegion(shot.region, shot.overview))) return false
    cursor = shot.end
  }
  return Math.abs(cursor - assessment.end) <= 0.001
}

/**
 * Add two-speaker split ranges to a camera clip's layout. Only clips without
 * inspected screen regions or presenter compositions get them; everything
 * outside a split keeps the speaker-following crop.
 */
export function applySpeakerSplits(
  assessment: Clip['visualLayout'], start: number, end: number,
  splits: Array<{ start: number; end: number; composition: LayoutShot['composition'] }>
): Clip['visualLayout'] {
  const inside = splits.filter(r => validComposition(r.composition) && r.end > r.start && r.start < end && r.end > start)
    .map(r => ({ ...r, start: Math.max(start, r.start), end: Math.min(end, r.end) }))
  if (!inside.length || assessment?.preserveContext || assessment?.kind === 'screen' ||
    assessment?.shots?.some(shot => shot.mode === 'fit')) return assessment
  const shots: LayoutShot[] = []
  let cursor = start
  for (const split of inside.sort((a, b) => a.start - b.start)) {
    if (split.start < cursor) continue
    if (split.start > cursor) shots.push({ start: cursor, end: split.start, mode: 'crop' })
    shots.push({ start: split.start, end: split.end, mode: 'fit', composition: split.composition })
    cursor = split.end
  }
  if (cursor < end) shots.push({ start: cursor, end, mode: 'crop' })
  if (shots.length > 48) return assessment
  return { ...(assessment ?? { preserveContext: false, allowZoom: true, reason: '' }), start, end, kind: assessment?.kind ?? 'camera',
    reason: [assessment?.reason, 'Split screen during two-person exchanges.'].filter(Boolean).join(' '), shots }
}

/** Retain the full scene where face detail cannot support a reliable close-up. */
export function protectLayoutRanges(
  assessment: Clip['visualLayout'], start: number, end: number,
  ranges: Array<{ start: number; end: number }>
): Clip['visualLayout'] {
  const protectedRanges = ranges.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) &&
    r.end > r.start && r.start < end && r.end > start)
  if (!protectedRanges.length) return assessment
  const baseShots = validLayoutShots(assessment, start, end) ? assessment!.shots! : []
  const wholeFit = !baseShots.length && assessment?.preserveContext &&
    start >= assessment.start - 0.001 && end <= assessment.end + 0.001
  const times = [...protectedRanges, ...baseShots].flatMap(r => [r.start, r.end])
  const bounds = [start, ...new Set(times.filter(t => t > start && t < end))].sort((a, b) => a - b)
  bounds.push(end)
  const shots = bounds.slice(0, -1).map((from, i) => {
    const until = bounds[i + 1]
    const base = baseShots.find(r => from >= r.start && until <= r.end)
    // An inspected object region is independent of confidence in the speaking face.
    const region = base?.mode === 'fit' ? base.region : undefined
    return { start: from, end: until, ...(base?.composition ? { composition: base.composition } : {}),
      ...(base?.review ? { review: base.review } : {}), ...(region ? { region, ...(base?.overview ? { overview: true } : {}) } : {}),
      mode: (wholeFit || protectedRanges.some(r => from < r.end && until > r.start) || base?.mode === 'fit' ? 'fit' : 'crop') as 'fit' | 'crop' }
  })
  return {
    start, end, preserveContext: true, allowZoom: false,
    reason: [assessment?.reason, 'Preserve shots with insufficient face detail for reliable speaker framing.'].filter(Boolean).join(' '),
    shots: shots.length <= 48 ? shots : [{ start, end, mode: 'fit' }]
  }
}

/**
 * How far a trim edge may sit outside the analysed footage and still reuse
 * that analysis (see needsReframe in reframe.ts, which re-exports it).
 */
export const REFRAME_EXTENSION_TOLERANCE_SEC = 1.5

/**
 * Whether the layout covers the trim once its edge shots are stretched by up
 * to REFRAME_EXTENSION_TOLERANCE_SEC: a small outward drag keeps the layout.
 */
function layoutCoversWithTolerance(assessment: Clip['visualLayout'], start: number, end: number): boolean {
  if (!assessment) return false
  const tol = REFRAME_EXTENSION_TOLERANCE_SEC
  if (start < assessment.start - tol || end > assessment.end + tol) return false
  const inner = { start: Math.max(start, assessment.start), end: Math.min(end, assessment.end) }
  return inner.end > inner.start && validLayoutShots(assessment, inner.start, inner.end)
}

/** Manual framing and layout choices always override automatic shot composition. */
export function automaticLayoutShots(clip: Pick<Clip, 'edit' | 'visualLayout'>): NonNullable<NonNullable<Clip['visualLayout']>['shots']> {
  if (clip.edit.framing !== 'auto' || clip.edit.reframeMode !== 'crop' || clip.edit.aspect === 'original') return []
  if (!validLayoutShots(clip.visualLayout, clip.edit.start, clip.edit.end) &&
    layoutCoversWithTolerance(clip.visualLayout, clip.edit.start, clip.edit.end)) {
    // The edge shots hold for the few extra frames, as the focus track does.
    const layout = clip.visualLayout!
    const shots = layout.shots!.map((shot, i, all) => ({ ...shot,
      start: i === 0 ? Math.min(shot.start, clip.edit.start) : shot.start,
      end: i === all.length - 1 ? Math.max(shot.end, clip.edit.end) : shot.end }))
    return automaticLayoutShots({ ...clip, visualLayout: { ...layout,
      start: Math.min(layout.start, clip.edit.start), end: Math.max(layout.end, clip.edit.end), shots } })
  }
  if (!validLayoutShots(clip.visualLayout, clip.edit.start, clip.edit.end)) {
    return clip.visualLayout?.preserveContext ? [{ start: clip.edit.start, end: clip.edit.end, mode: 'fit',
      review: { status: 'needs-review', reason: 'Layout does not cover this trim; full source retained. Adjust source regions or choose a layout.' } }] : []
  }
  const regions = new Set<string>()
  return clip.visualLayout!.shots!.filter((shot) => shot.start < clip.edit.end && shot.end > clip.edit.start).map(shot => {
    // The editor's split-screen switch turns conversations back into speaker crops.
    if (shot.composition?.preset === 'speakers' && clip.edit.speakerSplit === false) {
      return { start: shot.start, end: shot.end, mode: 'crop' as const }
    }
    let composition = shot.composition
    if (composition && clip.edit.aspect !== '9:16') return { ...shot, composition: undefined }
    const preference = clip.edit.compositionPreference
    if (composition && isPresenterComposition(composition) && preference && preference !== 'auto' && preference !== composition.preset) {
      const content = composition.layers.find(l => l.role === 'content')!
      const presenter = composition.layers.find(l => l.role === 'presenter')
      if (presenter) composition = presenterComposition(content.source, presenter.source, preference)
    }
    const planned = composition === shot.composition ? shot : { ...shot, composition,
      review: { status: 'needs-review' as const, reason: 'Layout changed; check the preview before exporting.' } }
    if ((!shot.region && !composition) || shot.mode !== 'fit') return planned
    const key = JSON.stringify([shot.region, shot.overview ?? false, composition])
    // Bound the number of full-resolution render branches; use full fit beyond it.
    if (!regions.has(key) && regions.size >= 8) return { ...shot, region: undefined, overview: undefined, composition: undefined,
      review: { status: 'needs-review' as const, reason: 'Complex layout preserved in full; check readability.' } }
    regions.add(key)
    return planned
  })
}

export function detailCaptionRanges(clip: Pick<Clip, 'edit' | 'visualLayout'>): CaptionPositionRange[] {
  return automaticLayoutShots(clip).filter(shot => (shot.overview && shot.region) || shot.composition)
    .map(shot => ({ start: shot.start, end: shot.end, positionY: shot.composition?.captionY ?? DETAIL_CAPTION_Y }))
}

/** Existing full-width hook titles would cover a composited presenter. */
/** Auto zoom would magnify an overlaid layout, so it runs only on plain crops. */
export function layoutBlocksAutoZoom(clip: Pick<Clip, 'edit' | 'visualLayout'>): boolean {
  return automaticLayoutShots(clip).some(shot => shot.mode === 'fit')
}

export function compositionHidesTitle(clip: Pick<Clip, 'edit' | 'visualLayout'>): boolean {
  return automaticLayoutShots(clip).some(shot => shot.composition)
}

export function layoutReviewMessage(clip: Pick<Clip, 'edit' | 'visualLayout'>): string | null {
  if (!validLayoutShots(clip.visualLayout, clip.edit.start, clip.edit.end)) return automaticLayoutShots(clip)[0]?.review?.reason ?? null
  const shots = clip.edit.framing === 'auto' && clip.edit.reframeMode === 'crop'
    ? automaticLayoutShots(clip) : clip.visualLayout!.shots!.filter(s => s.start < clip.edit.end && s.end > clip.edit.start)
  const issue = shots.find(s => s.review?.status === 'needs-review')
  return issue?.review?.reason ?? null
}

/** Editing at the end handle selects the final visible shot, not a new layout. */
export function layoutShotAt(clip: Pick<Clip, 'edit' | 'visualLayout'>, time: number): LayoutShot | undefined {
  const t = Math.max(clip.edit.start, Math.min(clip.edit.end - 0.000001, time))
  return clip.visualLayout?.shots?.find(shot => t >= shot.start && t < shot.end)
}

/** Avoid a one-frame fit flash when both sides of a transition are safe crops. */
export function bridgeTransitionLayouts(
  shots: NonNullable<NonNullable<Clip['visualLayout']>['shots']>,
  transitions: Array<{ start: number; end: number }>
): void {
  const isTransition = shots.map((shot) => transitions.some((range) => shot.start < range.end && shot.end > range.start))
  for (let i = 0; i < shots.length; i++) {
    if (!isTransition[i]) continue
    let left = i - 1, right = i + 1
    while (left >= 0 && isTransition[left]) left--
    while (right < shots.length && isTransition[right]) right++
    if (left >= 0 && right < shots.length && shots[left].mode === 'crop' && shots[right].mode === 'crop') shots[i].mode = 'crop'
  }
}
