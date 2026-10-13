import { join } from 'node:path'
import { app } from 'electron'
import type { Transcript, BrandColors } from '@shared/types'
import { resolveCaptionStyle, type CaptionStyle } from '@shared/captionStyles'
import { captionPositionAt, type CaptionPositionRange } from '@shared/contentRegion'
import type { FontMetrics } from '../fonts'
import {
  CAPTION_SAFE_WIDTH,
  captionLayoutBudget,
  groupDisplayEnd,
  groupWords,
  wordsInRange,
  type WordGroup
} from '@shared/captionLayout'

/**
 * Bundled caption fonts (Anton, Poppins — OFL licensed) so exports render
 * identically on every OS instead of falling back to system fonts.
 * `app` is undefined when running outside Electron (test scripts).
 */
export function fontsDir(): string {
  if (app?.isPackaged) return join(process.resourcesPath, 'fonts')
  const base = app?.getAppPath?.() ?? process.cwd()
  return join(base, 'resources', 'fonts')
}

/**
 * Generates ASS (Advanced SubStation Alpha) subtitles with word-level karaoke
 * highlighting: for every spoken word we emit one Dialogue event that shows
 * the whole word group with the active word emphasised. libass renders this
 * as the classic "Opus Clip" style animated captions when burned in.
 */

function assTime(sec: number): string {
  const clamped = Math.max(0, sec)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** "#RRGGBB" -> ASS "&HBBGGRR&" (no alpha). */
function assColor(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H${b}${g}${r}&`.toUpperCase()
}

/** "#RRGGBB" -> ASS style colour with explicit zero alpha "&H00BBGGRR". */
function assStyleColor(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ')
}

/** Fully transparent text, outline and shadow: keeps a word's space in the layout. */
const HIDDEN = '\\alpha&HFF&'

/**
 * Pop for the word being spoken, matching the preview's `captionPop`
 * (scale 0.94 -> 1 over 90ms, ease-out). Accel 0.5 decelerates like ease-out.
 */
const POP_IN = '\\fscx94\\fscy94\\t(0,90,0.5,\\fscx100\\fscy100)'

/**
 * One layer of a karaoke caption.
 *
 * libass has no CSS transform: scaling a word changes its advance width, so a
 * centred line re-flows and every other word slides sideways each time the
 * highlight moves on (17-26px on a 1080px frame, see
 * scripts/bench-caption-stability.ts). The preview scales the word with a
 * transform that moves nothing else. To match it, each word event is drawn
 * twice from the same text, so both layers share one layout:
 *
 * - `base` draws every word except the active one, which stays in the layout
 *   but is transparent.
 * - `pop` draws only the active word. Scaling one word re-centres the line
 *   by half its growth, which leaves that word's own centre where it was, so
 *   the word pops in place. Every other word in this layer is transparent.
 */
function renderGroupText(
  group: WordGroup,
  activeIndex: number,
  style: CaptionStyle,
  layer: 'base' | 'pop',
  animate: boolean
): string {
  const highlight = assColor(style.highlightColor)
  const base = assColor(style.textColor)
  const lines: string[] = []
  let index = 0
  for (const line of group.lines) {
    const parts: string[] = []
    for (const word of line) {
      const raw = escapeAss(word.text)
      const text = style.uppercase ? raw.toUpperCase() : raw
      const active = index === activeIndex
      if (active) {
        // Fat outline in the pill colour approximates a rounded label.
        const pill = style.highlightBoxColor ? `\\bord10\\3c${assColor(style.highlightBoxColor)}` : ''
        const look = layer === 'pop' ? (animate ? POP_IN : '') : HIDDEN
        parts.push(`{\\c${highlight}${pill}${look}}${text}{\\r}`)
      } else {
        parts.push(layer === 'pop' ? `{${HIDDEN}}${text}{\\r}` : `{\\c${base}}${text}{\\r}`)
      }
      index++
    }
    lines.push(parts.join(' '))
  }
  // Hard line breaks: the layout decided the lines (\\q2 on the event keeps
  // libass from re-wrapping them).
  return lines.join('\\N')
}

/** "#RRGGBB" -> ASS style colour with explicit alpha "&HAA BB GGRR". */
function assStyleColorWithAlpha(hex: string, alphaHex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase()
}

/**
 * Typical `winSpan / unitsPerEm` across the fonts we ship and the ones users
 * upload. Only used when a font's metrics cannot be read; getting it roughly
 * right beats reverting to the old em-size assumption, which rendered every
 * caption at about 58% of its intended size.
 */
const DEFAULT_WIN_SPAN_RATIO = 1.75

/**
 * Convert a CSS-style em size into the ASS `Fontsize` that renders at the same
 * visible size.
 *
 * They are not the same unit. CSS `font-size` sets the em square, whereas
 * libass (following VSFilter) sizes text against the font's OS/2 window
 * ascent + descent. That span is larger than the em on essentially every font,
 * so feeding an em size straight into `Fontsize` renders text far too small —
 * measured at 59% for Anton and 58% for Poppins, which is exactly the gap
 * between the live preview and the burned-in captions.
 */
export function assFontSize(emPx: number, metrics: FontMetrics | null): number {
  const ratio = metrics ? metrics.winSpan / metrics.unitsPerEm : DEFAULT_WIN_SPAN_RATIO
  return Math.round(emPx * ratio)
}

export interface CaptionOptions {
  styleId: string
  /** Output video dimensions the subtitles will be rendered onto. */
  width: number
  height: number
  /**
   * Metrics of the resolved caption font, for the em-size conversion above.
   * Null falls back to `DEFAULT_WIN_SPAN_RATIO`.
   */
  fontMetrics?: FontMetrics | null
  /** Clip boundaries in source-video seconds; events are re-based to 0. */
  clipStart: number
  clipEnd: number
  /** Optional title overlaid near the top for the first seconds of the clip. */
  title?: string
  /** Custom font family overriding the style's font (must exist in fontsdir). */
  fontFamily?: string
  /** App-wide brand palette merged onto the caption preset. */
  brandColors?: BrandColors | null
  /** Source-time layout bands that keep captions clear of enlarged detail. */
  positionRanges?: CaptionPositionRange[]
}

export function buildAss(transcript: Transcript, opts: CaptionOptions): string {
  const style = resolveCaptionStyle(opts.styleId, opts.brandColors, opts.fontFamily)
  const fontSize = assFontSize(style.fontScale * opts.height, opts.fontMetrics ?? null)
  // Captions are positioned per event with \an5\pos so the block is centred on
  // the style's anchor line exactly as the preview centres it (translateY -50%).
  // A bottom-aligned style with MarginV would grow upwards from that line and
  // sit half a block higher than the preview on every two-line caption.
  const captionX = Math.round(opts.width / 2)
  const marginH = Math.round(opts.width * (1 - CAPTION_SAFE_WIDTH) / 2)
  const primary = assStyleColor(style.textColor)
  const outline = assStyleColor(style.outlineColor)
  const brandColors = opts.brandColors
  const hookText = assStyleColor(
    brandColors?.enabled ? brandColors.hookTextColor : '#FFFFFF'
  )
  const titleBox = brandColors?.enabled
    ? assStyleColorWithAlpha(brandColors.hookBackgroundColor, '40')
    : '&H40000000'
  /** Soft shadow: black at ~44% opacity. */
  const titleShadowColor = '&H90000000'

  // Hook "card": a filled, translucent rounded-feel label at the top. libass
  // draws this with BorderStyle 3 (opaque box in the outline colour) plus a
  // soft drop shadow (back colour), which reads as a modern hook overlay
  // instead of bare floating text. Sized independently of the caption style so
  // the hook stays prominent and legible whatever caption preset is chosen.
  const titleFontSize = assFontSize(opts.height * 0.044, opts.fontMetrics ?? null)
  const titleMarginV = Math.round(opts.height * 0.07)
  const titleMarginH = Math.round(opts.width * 0.1)
  const titleBoxPad = Math.max(6, Math.round(opts.height * 0.009))
  const titleShadow = Math.max(2, Math.round(opts.height * 0.0032))

  const header = `[Script Info]
Title: Cutawan captions
ScriptType: v4.00+
PlayResX: ${opts.width}
PlayResY: ${opts.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${style.fontFamily},${fontSize},${primary},${primary},${outline},&H80000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outlineWidth},${style.shadow},5,${marginH},${marginH},0,1
Style: Title,${style.fontFamily},${titleFontSize},${hookText},${hookText},${titleBox},${titleShadowColor},-1,0,0,0,100,100,0,0,3,${titleBoxPad},${titleShadow},8,${titleMarginH},${titleMarginH},${titleMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

  const lines: string[] = []
  const clipDur = opts.clipEnd - opts.clipStart

  if (opts.title && opts.title.trim().length > 0) {
    const showFor = Math.min(4, clipDur)
    lines.push(
      `Dialogue: 1,${assTime(0)},${assTime(showFor)},Title,,0,0,0,,{\\fad(200,300)}${escapeAss(opts.title.trim())}`
    )
  }

  const words = wordsInRange(transcript, opts.clipStart, opts.clipEnd)
  const groups = groupWords(words, captionLayoutBudget(style, opts.width / opts.height))
  // \q2 turns libass wrapping off for caption events only: the layout above
  // decided their lines. The hook title keeps the script's smart wrapping
  // (WrapStyle 0) because it carries no explicit breaks of its own.

  groups.forEach((group, gi) => {
    // The finished group holds briefly after its last word (never into the
    // next group) so pauses do not leave an empty frame.
    const groupEnd = groupDisplayEnd(groups, gi, opts.clipEnd)
    for (let i = 0; i < group.words.length; i++) {
      const w = group.words[i]
      const start = Math.max(0, w.start - opts.clipStart)
      const isLast = i === group.words.length - 1
      const next = group.words[i + 1]
      const end = Math.min(clipDur, (isLast ? groupEnd : next.start) - opts.clipStart)
      if (end <= start) continue
      const cuts = [start, ...new Set((opts.positionRanges ?? []).flatMap(r => [r.start - opts.clipStart, r.end - opts.clipStart])
        .filter(t => t > start && t < end)), end].sort((a, b) => a - b)
      for (let part = 0; part < cuts.length - 1; part++) {
        const from = cuts[part], until = cuts[part + 1]
        const position = captionPositionAt(opts.positionRanges, opts.clipStart + (from + until) / 2, style.positionY)
        const anchor = `{\\an5\\q2\\pos(${captionX},${Math.round(position * opts.height)})}`
        const span = `${assTime(from)},${assTime(until)},Caption,,0,0,0,,${anchor}`
        lines.push(`Dialogue: 0,${span}${renderGroupText(group, i, style, 'base', false)}`)
        // Layer 2 sits above the base (the title uses layer 1). The pop only
        // plays when the word starts, not again at a layout band boundary.
        lines.push(`Dialogue: 2,${span}${renderGroupText(group, i, style, 'pop', part === 0)}`)
      }
    }
  })

  return header + lines.join('\n') + '\n'
}
