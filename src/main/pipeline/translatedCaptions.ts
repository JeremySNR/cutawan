import type { CaptionStyle } from '@shared/captionStyles'
import type { FontMetrics } from '../fonts'
import { captionPositionAt, type CaptionPositionRange } from '@shared/contentRegion'
import { translatedCaptionY, translatedOutlineWidth, type TranslatedCaptionPlan } from '@shared/captionTranslation'

/**
 * ASS events for translated captions (see @shared/captionTranslation).
 * Kept apart from the karaoke generator in captions.ts, which only calls in
 * here when a clip shows a translation: translated cards are sentence-level,
 * drawn whole with no active-word highlight, with their font, size and
 * anchor set per event so the script's styles stay untouched.
 */

function assTime(sec: number): string {
  const clamped = Math.max(0, sec)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** "#RRGGBB" -> ASS "&HBBGGRR&". */
function assColor(hex: string): string {
  const clean = hex.replace('#', '')
  return `&H${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}&`.toUpperCase()
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ')
}

export interface TranslatedAssContext {
  style: CaptionStyle
  width: number
  height: number
  /** The script's clip start: added to event times to look up layout bands. */
  clipStart: number
  positionRanges?: CaptionPositionRange[]
  /** CSS em size in pixels -> ASS Fontsize for a face's metrics (captions.ts assFontSize). */
  fontSize: (emPx: number, metrics: FontMetrics | null) => number
  /** Metrics of the style's own font. */
  styleMetrics: FontMetrics | null
}

/**
 * Window-span ratio assumed for a system fallback face, whose file libass
 * picks through the OS font provider and we never see. Measured spans of the
 * faces SYSTEM_FALLBACKS names sit around 1.3-1.5 (Segoe UI 1.33, Noto Sans
 * CJK 1.45); the 1.75 default for unreadable uploads made CJK fallback text
 * overflow the frame.
 */
const SYSTEM_FACE_METRICS: FontMetrics = { unitsPerEm: 1000, winSpan: 1400 }

/** Dialogue lines for a translated caption plan, in output time. */
export function buildTranslatedAssEvents(plan: TranslatedCaptionPlan, ctx: TranslatedAssContext): string[] {
  const { style } = ctx
  const scale = plan.layout.fontScale / style.fontScale
  const size = ctx.fontSize(plan.layout.fontScale * ctx.height, plan.font.systemFallback ? SYSTEM_FACE_METRICS : ctx.styleMetrics)
  const x = Math.round(ctx.width / 2)
  const align = plan.layout.anchor === 'top' ? 8 : 5
  const face = escapeAss(plan.font.family).replace(/[\\,]/g, ' ')
  const look = `\\fn${face}\\fs${size}\\b${style.bold ? 1 : 0}\\c${assColor(style.textColor)}` +
    `\\3c${assColor(style.outlineColor)}\\bord${translatedOutlineWidth(style, scale).toFixed(2)}\\shad${(style.shadow * scale).toFixed(2)}`
  const out: string[] = []
  for (const event of plan.events) {
    const text = event.lines.map(escapeAss).join('\\N')
    const cuts = [event.start, ...new Set((ctx.positionRanges ?? [])
      .flatMap((r) => [r.start - ctx.clipStart, r.end - ctx.clipStart])
      .filter((t) => t > event.start && t < event.end)), event.end].sort((a, b) => a - b)
    for (let part = 0; part < cuts.length - 1; part++) {
      const from = cuts[part]
      const until = cuts[part + 1]
      const base = captionPositionAt(ctx.positionRanges, ctx.clipStart + (from + until) / 2, style.positionY)
      const y = Math.round(translatedCaptionY(style, plan.mode, base) * ctx.height)
      // Layer 1 sits over the originals when both are shown.
      out.push(`Dialogue: 1,${assTime(from)},${assTime(until)},Caption,,0,0,0,,{\\an${align}\\q2\\pos(${x},${y})${look}}${text}`)
    }
  }
  return out
}
