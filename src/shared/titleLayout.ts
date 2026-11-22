import type { BrandColors, TitleStyleId } from './types'
import { captionEmphasisLook, type CaptionStyle } from './captionStyles'
import { captionLayoutBudget } from './captionLayout'
import { emphasisScores } from './captionEmphasis'

/**
 * The hook title card: its look, line breaks and place on the frame, decided
 * once here and drawn identically by the burned-in ASS (captions.ts) and the
 * live preview (PreviewPlayer). Lines are balanced explicitly (both renderers
 * draw exactly these lines), and the card sits inside the top safe area that
 * short-form apps leave clear of their own buttons.
 */

export const TITLE_STYLES: Array<{ id: TitleStyleId; name: string; hint: string }> = [
  { id: 'card', name: 'Card', hint: 'Translucent label' },
  { id: 'bold', name: 'Bold', hint: 'Big outlined text' },
  { id: 'banner', name: 'Banner', hint: 'Solid accent box' }
]

export const DEFAULT_TITLE_STYLE: TitleStyleId = 'card'

/** How long the title stays up once it appears. */
export const TITLE_SHOW_SEC = 4
/** Share of the frame width the title may span. */
const TITLE_SAFE_WIDTH = 0.8
const MAX_TITLE_LINES = 3
/** The font shrinks by steps down to this share before a fourth line is allowed. */
const MIN_SHRINK = 0.72
const SPACE_EM = 0.26

export interface TitleWord { text: string; accent: boolean }

export interface TitlePlan {
  style: TitleStyleId
  lines: TitleWord[][]
  /** Em size as a fraction of frame height. */
  fontScale: number
  fontFamily: string
  bold: boolean
  /** Top of the first line, as a fraction of frame height. */
  top: number
  textColor: string
  accentColor: string
  /** Box behind each line, or null for outlined text. */
  boxColor: string | null
  /** Box opacity 0..1. */
  boxOpacity: number
  /** Box padding as a fraction of frame height. */
  boxPad: number
  outlineColor: string
  /** Outline width as a fraction of frame height (outlined styles). */
  outlineWidth: number
  /** Output seconds the title is on screen. */
  start: number
  end: number
}

/** Relative luminance-ish 0..1 of "#RRGGBB", for picking readable text on a box. */
function lightness(hex: string): number {
  const c = hex.replace('#', '')
  if (c.length !== 6) return 0
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Top safe-area inset for the title, by output aspect (width / height). */
export function titleTop(aspectRatio: number): number {
  if (aspectRatio < 0.7) return 0.105
  if (aspectRatio < 1.2) return 0.08
  return 0.07
}

/**
 * Split words into at most `maxLines` lines no wider than `limit` em, as evenly
 * as possible: the fewest lines that fit, then the split whose widest line is
 * narrowest (ties: the most even). Null when no split fits.
 */
export function balanceLines(widths: number[], limit: number, maxLines: number): number[][] | null {
  const n = widths.length
  if (n === 0) return []
  const span = (from: number, to: number): number => {
    let w = 0
    for (let i = from; i < to; i++) w += widths[i] + (i > from ? SPACE_EM : 0)
    return w
  }
  for (let lines = 1; lines <= Math.min(maxLines, n); lines++) {
    let best: { cuts: number[]; widest: number; spread: number } | null = null
    const search = (from: number, left: number, cuts: number[]): void => {
      if (left === 1) {
        const all = [...cuts, n]
        const spans = all.map((end, i) => span(i === 0 ? 0 : all[i - 1], end))
        const widest = Math.max(...spans)
        if (widest > limit) return
        const spread = widest - Math.min(...spans)
        if (!best || widest < best.widest - 1e-9 || (Math.abs(widest - best.widest) < 1e-9 && spread < best.spread)) {
          best = { cuts: all, widest, spread }
        }
        return
      }
      for (let cut = from + 1; cut <= n - left + 1; cut++) {
        if (span(from, cut) > limit) break
        search(cut, left - 1, [...cuts, cut])
      }
    }
    search(0, lines, [])
    if (best) {
      const cuts = (best as { cuts: number[] }).cuts
      return cuts.map((end, i) => Array.from({ length: end - (i === 0 ? 0 : cuts[i - 1]) }, (_, k) => (i === 0 ? 0 : cuts[i - 1]) + k))
    }
  }
  return null
}

export interface TitleOptions {
  styleId?: TitleStyleId | null
  captionStyle: CaptionStyle
  brandColors?: BrandColors | null
  /** Output width / height. */
  aspectRatio: number
  /** Output second the title appears (after any cold open). */
  start: number
  /** Output duration of the clip. */
  duration: number
}

export function planTitle(text: string, opts: TitleOptions): TitlePlan | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length || opts.start >= opts.duration) return null
  const style = opts.styleId ?? DEFAULT_TITLE_STYLE
  const caption = opts.captionStyle
  const brand = opts.brandColors?.enabled ? opts.brandColors : null
  const uppercase = style !== 'card' && caption.uppercase
  const shown = words.map((w) => (uppercase ? w.toUpperCase() : w))

  // Bold titles mark their one key word in the caption accent.
  let accentIndex = -1
  if (style === 'bold') {
    const scores = emphasisScores(words.map((w, i) => ({ text: w, start: i, end: i + 0.5 })), { hook: text })
    const top = Math.max(0, ...scores)
    if (top >= 2.5) accentIndex = scores.indexOf(top)
  }

  const baseScale = style === 'bold' ? 0.056 : style === 'banner' ? 0.046 : 0.044
  const glyph = captionLayoutBudget({ ...caption, uppercase, fontScale: baseScale }, opts.aspectRatio).glyphWidthEm
  const widths = shown.map((w) => w.length * glyph)
  let fontScale = baseScale
  let split: number[][] | null = null
  for (let shrink = 1; shrink >= MIN_SHRINK - 1e-9 && !split; shrink -= 0.07) {
    fontScale = baseScale * shrink
    split = balanceLines(widths, (opts.aspectRatio * TITLE_SAFE_WIDTH) / fontScale, MAX_TITLE_LINES)
  }
  if (!split) {
    // Still too long: keep the smallest size and let it take more lines.
    split = balanceLines(widths, (opts.aspectRatio * TITLE_SAFE_WIDTH) / fontScale, words.length) ??
      words.map((_, i) => [i])
  }

  const accentLook = captionEmphasisLook(caption)
  const accent = brand ? brand.primaryColor : accentLook.boxColor ?? accentLook.color
  let textColor = brand ? brand.hookTextColor : '#FFFFFF'
  let boxColor: string | null = brand ? brand.hookBackgroundColor : '#000000'
  let boxOpacity = 0.75
  if (style === 'bold') {
    textColor = caption.textColor
    boxColor = null
  } else if (style === 'banner') {
    boxColor = accent
    boxOpacity = 1
    textColor = lightness(accent) > 0.6 ? '#111111' : '#FFFFFF'
  }
  return {
    style,
    lines: split.map((line) => line.map((i) => ({ text: shown[i], accent: i === accentIndex }))),
    fontScale,
    fontFamily: caption.fontFamily,
    bold: true,
    top: titleTop(opts.aspectRatio),
    textColor,
    accentColor: style === 'bold' ? accent : textColor,
    boxColor,
    boxOpacity,
    boxPad: style === 'banner' ? 0.011 : 0.009,
    outlineColor: style === 'bold' ? caption.outlineColor : '#000000',
    outlineWidth: style === 'bold' ? 0.0026 : 0,
    start: opts.start,
    end: Math.min(opts.duration, opts.start + TITLE_SHOW_SEC)
  }
}
