import type { CaptionSafety, Clip, FaceBand } from './types'
import type { CaptionPositionRange } from './contentRegion'
import { CAPTION_MAX_LINES } from './captionLayout'
import { automaticLayoutShots, detailCaptionRanges } from './contentType'

/**
 * Keep captions clear of the speaker's face and of text already burned into
 * the source (subtitles, a ticker), using the per-time caption position
 * mechanism the preview and the export already share (CaptionPositionRange).
 *
 * Deliberately conservative: captions only move when the measured face or
 * text band clearly overlaps where the caption block would be drawn, for long
 * enough to matter, and only to a place that is actually clear. Anything less
 * certain leaves the style's own position alone.
 */

/**
 * Caption line pitch in em: libass advances lines by the font's win ascent +
 * descent, about 1.75 em for the fonts we ship (see captionLinePitchEm).
 */
const LINE_HEIGHT_EM = 1.75
/** Gap kept between a caption block and what it steps around. */
const CLEARANCE = 0.02
/** Never place captions outside this vertical band (short-form app UI). */
const SAFE_TOP = 0.3
const SAFE_BOTTOM = 0.86
/** Share of the caption block a face must cover before captions move. */
const FACE_OVERLAP_SHARE = 0.5
/** Captions only move for a face that stays put at least this long. */
const MIN_MOVE_SEC = 1.5
/** Faces grow under auto zoom; allow for that much. */
const ZOOM_ALLOWANCE = 0.03

export type PlacementClip = Pick<Clip, 'edit' | 'visualLayout' | 'captionSafety'>

/** Output aspect (width / height) of a clip's frame, for a source of the given size. */
export function outputAspect(aspect: Clip['edit']['aspect'], sourceWidth: number, sourceHeight: number): number {
  switch (aspect) {
    case '9:16': return 9 / 16
    case '1:1': return 1
    case '16:9': return 16 / 9
    default: return sourceWidth / Math.max(1, sourceHeight)
  }
}

/**
 * Where normalised source height `y` lands in the output frame (0 = top), or
 * null when that row is cropped away. Mirrors reframeGraph: a crop keeps the
 * full height of a wider source; fit modes scale the whole frame into a band.
 */
export function sourceToOutputY(
  y: number,
  edit: Pick<Clip['edit'], 'aspect' | 'reframeMode'>,
  sourceWidth: number,
  sourceHeight: number
): number | null {
  if (edit.aspect === 'original') return y
  const source = sourceWidth / Math.max(1, sourceHeight)
  const target = outputAspect(edit.aspect, sourceWidth, sourceHeight)
  if (edit.reframeMode === 'crop') {
    if (source >= target) return y
    const visible = source / target
    const out = (y - (1 - visible) / 2) / visible
    return out < 0 || out > 1 ? null : out
  }
  if (source <= target) return y
  const band = target / source
  return (1 - band) / 2 + y * band
}

/** Half the height of a caption block of `lines` lines, as a fraction of frame height. */
export function captionHalfHeight(fontScale: number, lines = CAPTION_MAX_LINES): number {
  return (lines * LINE_HEIGHT_EM * fontScale) / 2
}

/**
 * The caption anchor once burned-in text is avoided: above the text band when
 * the caption block would touch it, else the style's own anchor.
 */
export function textBandPosition(
  safety: CaptionSafety | undefined,
  edit: Pick<Clip['edit'], 'aspect' | 'reframeMode'>,
  sourceWidth: number,
  sourceHeight: number,
  positionY: number,
  fontScale: number
): number {
  const band = safety?.textBand
  if (!band) return positionY
  const top = sourceToOutputY(band.top, edit, sourceWidth, sourceHeight)
  const bottom = sourceToOutputY(band.bottom, edit, sourceWidth, sourceHeight)
  if (top === null || bottom === null) return positionY
  const half = captionHalfHeight(fontScale)
  const overlaps = positionY + half + CLEARANCE > top && positionY - half - CLEARANCE < bottom
  if (!overlaps) return positionY
  const above = top - half - CLEARANCE
  // Below the band is fine too when there is room (text high in the frame).
  const below = bottom + half + CLEARANCE
  if (below + half <= SAFE_BOTTOM + 0.04 && Math.abs(below - positionY) < Math.abs(above - positionY)) return below
  return Math.max(SAFE_TOP, above)
}

interface FacePlacement { start: number; end: number; positionY: number }

/**
 * Where the caption should sit while each face band is on screen, or nothing
 * where the face leaves the caption alone. Below the chin when there is room,
 * otherwise above the head when that is still inside the safe band; when
 * neither is clear the caption stays put (moving onto the face elsewhere
 * would not help).
 */
export function facePlacements(
  faces: FaceBand[],
  edit: Pick<Clip['edit'], 'aspect' | 'reframeMode'>,
  sourceWidth: number,
  sourceHeight: number,
  positionY: number,
  fontScale: number
): FacePlacement[] {
  const half = captionHalfHeight(fontScale)
  const blockTop = positionY - half
  const blockBottom = positionY + half
  const moves: FacePlacement[] = []
  for (const face of faces) {
    const top = sourceToOutputY(face.top, edit, sourceWidth, sourceHeight)
    const bottom = sourceToOutputY(face.bottom, edit, sourceWidth, sourceHeight)
    if (top === null || bottom === null || face.end <= face.start) continue
    const faceTop = top - ZOOM_ALLOWANCE
    const faceBottom = bottom + ZOOM_ALLOWANCE
    const overlap = Math.max(0, Math.min(blockBottom, faceBottom) - Math.max(blockTop, faceTop))
    if (overlap < FACE_OVERLAP_SHARE * (blockBottom - blockTop)) continue
    const belowChin = faceBottom + CLEARANCE + half
    const aboveHead = faceTop - CLEARANCE - half
    let y: number | null = null
    if (belowChin + half <= SAFE_BOTTOM + 0.04) y = belowChin
    else if (aboveHead >= SAFE_TOP) y = aboveHead
    if (y !== null) moves.push({ start: face.start, end: face.end, positionY: y })
  }
  // Merge neighbours into steady runs (one position per run, the safest of
  // them), then drop runs too short to be worth a jump.
  const runs: FacePlacement[] = []
  for (const move of moves.sort((a, b) => a.start - b.start)) {
    const last = runs[runs.length - 1]
    const sameSide = last && (last.positionY > positionY) === (move.positionY > positionY)
    if (last && sameSide && move.start - last.end < 0.5) {
      last.end = Math.max(last.end, move.end)
      last.positionY = move.positionY > positionY ? Math.max(last.positionY, move.positionY) : Math.min(last.positionY, move.positionY)
    } else runs.push({ ...move })
  }
  return runs.filter((r) => r.end - r.start >= MIN_MOVE_SEC)
}

/**
 * Every caption position change for a clip, in source time: the layout's
 * detail bands (which always win), then face and burned-in-text avoidance for
 * the rest. Shared by the preview (evaluated at the source time playing) and
 * the export (mapped onto the output timeline).
 */
export function clipCaptionPositionRanges(
  clip: PlacementClip,
  positionY: number,
  fontScale: number,
  sourceWidth: number,
  sourceHeight: number
): CaptionPositionRange[] {
  const detail = detailCaptionRanges(clip)
  // Composed layouts place captions themselves; their frames are not the
  // plain crop the face/text measurements describe.
  if (automaticLayoutShots(clip).some((shot) => shot.mode === 'fit') || !clip.captionSafety) return detail
  const safety = clip.captionSafety
  const base = textBandPosition(safety, clip.edit, sourceWidth, sourceHeight, positionY, fontScale)
  const faces = facePlacements(safety.faces, clip.edit, sourceWidth, sourceHeight, base, fontScale)
    .map((f) => ({ ...f, positionY: avoidBand(safety, clip.edit, sourceWidth, sourceHeight, f.positionY, fontScale) }))
  const ranges: CaptionPositionRange[] = []
  let at = clip.edit.start
  for (const face of faces) {
    const start = Math.max(clip.edit.start, face.start)
    const end = Math.min(clip.edit.end, face.end)
    if (end <= start) continue
    if (start > at && Math.abs(base - positionY) > 1e-6) ranges.push({ start: at, end: start, positionY: base })
    ranges.push({ start, end, positionY: face.positionY })
    at = end
  }
  if (at < clip.edit.end && Math.abs(base - positionY) > 1e-6) ranges.push({ start: at, end: clip.edit.end, positionY: base })
  return [...detail, ...ranges.filter((r) => !detail.some((d) => d.start < r.end && d.end > r.start))]
}

/** A face move must not land the caption on burned-in text; fall back to the band-safe base then. */
function avoidBand(
  safety: CaptionSafety,
  edit: Pick<Clip['edit'], 'aspect' | 'reframeMode'>,
  sourceWidth: number,
  sourceHeight: number,
  y: number,
  fontScale: number
): number {
  return textBandPosition(safety, edit, sourceWidth, sourceHeight, y, fontScale)
}
