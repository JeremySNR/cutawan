import { join } from 'node:path'
import { app } from 'electron'
import type { Transcript, BrandColors, CaptionEmphasisWord, TitleStyleId } from '@shared/types'
import { captionEmphasisLook, resolveCaptionStyle, type CaptionStyle } from '@shared/captionStyles'
import { captionPositionAt, type CaptionPositionRange } from '@shared/contentRegion'
import { CAPTION_EMOJI_FONT, EMOJI_EM, EMPHASIS_SCALE } from '@shared/captionEmphasis'
import { planTitle, type TitlePlan } from '@shared/titleLayout'
import type { FontMetrics } from '../fonts'
import {
  CAPTION_SAFE_WIDTH,
  captionGroupsFor,
  captionLayoutBudget,
  captionWordText,
  groupDisplayEnd,
  type WordGroup
} from '@shared/captionLayout'

/**
 * Bundled caption fonts (Anton, Poppins, the Cutawan Emoji subset — OFL
 * licensed) so exports render identically on every OS instead of falling
 * back to system fonts. `app` is undefined when running outside Electron
 * (test scripts).
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

/**
 * Metrics of the bundled emoji font (resources/fonts/CutawanEmoji.ttf: Noto
 * Emoji's win ascent 1900 + descent 500 over 2048 units). Fixed because the
 * file is ours; tests/fonts.test.ts checks them against the file.
 */
export const EMOJI_FONT_METRICS: FontMetrics = { unitsPerEm: 2048, winSpan: 2400 }

function renderGroupText(group: WordGroup, activeIndex: number, style: CaptionStyle, emojiFontSize: number): string {
  const highlight = assColor(style.highlightColor)
  const base = assColor(style.textColor)
  const look = captionEmphasisLook(style)
  const emphasisColor = assColor(look.color)
  const big = Math.round(EMPHASIS_SCALE * 100)
  const lines: string[] = []
  let index = 0
  for (const line of group.lines) {
    const parts: string[] = []
    for (const word of line) {
      const text = escapeAss(captionWordText(word.text, style))
      const active = index === activeIndex
      const emphasised = index === group.emphasis
      // The active word pops to 109% of whatever size it rests at.
      const rest = emphasised ? big : 100
      const pop = active ? `\\t(0,70,\\fscx${Math.round(rest * 1.09)}\\fscy${Math.round(rest * 1.09)})` : ''
      const scale = emphasised || active ? `\\fscx${rest}\\fscy${rest}` : ''
      const color = active ? highlight : emphasised ? emphasisColor : base
      // Fat outline in the pill colour approximates a rounded label.
      const boxColor = active ? style.highlightBoxColor : emphasised ? look.boxColor : null
      const box = boxColor ? `\\bord10\\3c${assColor(boxColor)}` : ''
      let part = `{\\c${color}${box}${scale}${pop}}${text}{\\r}`
      if (emphasised && group.emoji) {
        part += ` {\\fn${CAPTION_EMOJI_FONT}\\fs${emojiFontSize}\\c${emphasisColor}}${group.emoji}{\\r}`
      }
      parts.push(part)
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

/** Opacity 0..1 as the two hex digits of an ASS alpha (00 = opaque). */
function assAlpha(opacity: number): string {
  return Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255).toString(16).padStart(2, '0').toUpperCase()
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
  /** Clip boundaries in the transcript's timeline; events are re-based to 0. */
  clipStart: number
  clipEnd: number
  /** Optional hook title shown near the top for the first seconds. */
  title?: string
  /** Look of the hook title (shared/titleLayout.ts); absent = card. */
  titleStyle?: TitleStyleId | null
  /** Second (after clipStart) the title appears, e.g. after a cold open. */
  titleStart?: number
  /** Custom font family overriding the style's font (must exist in fontsdir). */
  fontFamily?: string
  /** App-wide brand palette merged onto the caption preset. */
  brandColors?: BrandColors | null
  /** Layout bands that move captions (detail views, faces, burned-in text), in the transcript's timeline. */
  positionRanges?: CaptionPositionRange[]
  /** Seams no caption group may span (a cold open's end), in the transcript's timeline. */
  breaks?: number[]
  /** Mark each group's key word (see shared/captionEmphasis.ts). */
  emphasis?: boolean
  /** Draw an occasional emoji after an emphasised word. */
  emoji?: boolean
  /** Validated AI keywords; absent uses the heuristic. */
  keywords?: CaptionEmphasisWord[] | null
  /** The clip's hook line, for the emphasis heuristic. */
  hook?: string
}

/** The hook title as an ASS style line plus its dialogue event. */
function titleAss(plan: TitlePlan, opts: CaptionOptions): { style: string; event: string } {
  const fontSize = assFontSize(plan.fontScale * opts.height, opts.fontMetrics ?? null)
  const text = assStyleColor(plan.textColor)
  const boxed = plan.boxColor !== null
  const outline = boxed
    ? assStyleColorWithAlpha(plan.boxColor!, assAlpha(plan.boxOpacity))
    : assStyleColor(plan.outlineColor)
  // Soft shadow: black at ~44% opacity.
  const shadowColor = '&H90000000'
  const border = boxed
    ? Math.max(6, Math.round(opts.height * plan.boxPad))
    : Math.max(2, Math.round(opts.height * plan.outlineWidth))
  const shadow = Math.max(2, Math.round(opts.height * 0.0032))
  // BorderStyle 3 draws an opaque box per line in the outline colour (the
  // card/banner label); 1 is outlined text (bold).
  const style = `Style: Title,${plan.fontFamily},${fontSize},${text},${text},${outline},${shadowColor},-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${border},${shadow},8,0,0,0,1`
  const accent = assColor(plan.accentColor)
  const base = assColor(plan.textColor)
  const body = plan.lines
    .map((line) => line.map((w) => (w.accent ? `{\\c${accent}}${escapeAss(w.text)}{\\c${base}}` : escapeAss(w.text))).join(' '))
    .join('\\N')
  const x = Math.round(opts.width / 2)
  const y = Math.round(plan.top * opts.height)
  const event = `Dialogue: 1,${assTime(plan.start)},${assTime(plan.end)},Title,,0,0,0,,{\\an8\\q2\\pos(${x},${y})\\fad(200,300)}${body}`
  return { style, event }
}

export function buildAss(transcript: Transcript, opts: CaptionOptions): string {
  const style = resolveCaptionStyle(opts.styleId, opts.brandColors, opts.fontFamily)
  const fontSize = assFontSize(style.fontScale * opts.height, opts.fontMetrics ?? null)
  const emojiFontSize = assFontSize(style.fontScale * opts.height * EMOJI_EM, EMOJI_FONT_METRICS)
  // Captions are positioned per event with \an5\pos so the block is centred on
  // the style's anchor line exactly as the preview centres it (translateY -50%).
  // A bottom-aligned style with MarginV would grow upwards from that line and
  // sit half a block higher than the preview on every two-line caption.
  const captionX = Math.round(opts.width / 2)
  const marginH = Math.round(opts.width * (1 - CAPTION_SAFE_WIDTH) / 2)
  const primary = assStyleColor(style.textColor)
  const outline = assStyleColor(style.outlineColor)
  const clipDur = opts.clipEnd - opts.clipStart

  // The hook title: look, balanced lines and safe-area placement come from the
  // shared planner the preview uses.
  const titlePlan = opts.title && opts.title.trim().length > 0
    ? planTitle(opts.title, {
        styleId: opts.titleStyle,
        captionStyle: style,
        brandColors: opts.brandColors,
        aspectRatio: opts.width / opts.height,
        start: Math.max(0, opts.titleStart ?? 0),
        duration: clipDur
      })
    : null
  const title = titlePlan ? titleAss(titlePlan, opts) : null

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
${title?.style ?? `Style: Title,${style.fontFamily},${assFontSize(opts.height * 0.044, opts.fontMetrics ?? null)},&H00FFFFFF,&H00FFFFFF,&H40000000,&H90000000,-1,0,0,0,100,100,0,0,3,6,2,8,0,0,0,1`}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

  const lines: string[] = []
  if (title) lines.push(title.event)

  // Same grouping, line layout and emphasis as the preview (captionGroupsFor).
  const breaks = opts.breaks ?? []
  const groups = captionGroupsFor(transcript, opts.clipStart, opts.clipEnd, captionLayoutBudget(style, opts.width / opts.height), {
    breaks,
    emphasis: opts.emphasis,
    emoji: opts.emoji,
    keywords: opts.keywords,
    hook: opts.hook
  })
  // \q2 turns libass wrapping off for caption events: the layout above
  // decided their lines.
  groups.forEach((group, gi) => {
    // The finished group holds briefly after its last word (never into the
    // next group or across a seam) so pauses do not leave an empty frame.
    const groupEnd = groupDisplayEnd(groups, gi, opts.clipEnd, breaks)
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
        lines.push(`Dialogue: 0,${assTime(from)},${assTime(until)},Caption,,0,0,0,,${anchor}${renderGroupText(group, i, style, emojiFontSize)}`)
      }
    }
  })

  return header + lines.join('\n') + '\n'
}
