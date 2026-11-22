import { captionEmphasisLook, hexToRgba, type CaptionStyle } from './captionStyles'
import { CAPTION_SAFE_WIDTH, captionLinePitchEm } from './captionLayout'
import { EMPHASIS_SCALE } from './captionEmphasis'
import { CAPTION_LINE_HEIGHT_EM, translatedOutlineWidth } from './captionTranslation'
import type { AnimatedCaptionPlan, CaptionScene, CardScene, PlannedWord } from './animatedCaptions'
import type { TitlePlan } from './titleLayout'

/**
 * Drawing for the animated caption styles: one function that paints a scene
 * (shared/animatedCaptions.ts) onto a canvas 2D context. The live preview
 * calls it on a canvas over the video; the export calls it in a hidden
 * Chromium window, once per frame, and ffmpeg composites the frames. Both
 * load this same module, so what the editor shows is what the file gets.
 *
 * Everything is sized from the frame height, so a small preview canvas and a
 * 1080x1920 export frame draw the same picture at different resolutions.
 */

/** The parts of CanvasRenderingContext2D this module uses (tests pass a fake). */
export interface CaptionCanvasGradient {
  addColorStop(offset: number, color: string): void
}

export interface CaptionCanvasContext {
  font: string
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  lineJoin: string
  textAlign: string
  textBaseline: string
  direction: string
  globalAlpha: number
  shadowBlur: number
  shadowColor: string
  shadowOffsetX: number
  shadowOffsetY: number
  save(): void
  restore(): void
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  clip(): void
  fill(): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  measureText(text: string): { width: number; fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CaptionCanvasGradient
}

/** Pixel rectangle a draw touched (integer, clamped to the frame). */
export interface DirtyRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Colour emoji, as the animated styles draw them: the bundled subset first
 * (resources/fonts/CutawanColorEmoji.ttf, from Noto Color Emoji, OFL), then
 * the platform's own colour emoji face if this Chromium cannot use it.
 */
export const COLOR_EMOJI_FONT = 'Cutawan Color Emoji'
export const COLOR_EMOJI_STACK = `"${COLOR_EMOJI_FONT}", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
/**
 * Emoji em size relative to the caption em. Colour emoji are wider than the
 * outline subset (Noto's advance is 1.25 em), so they draw a little smaller to
 * stay inside the width the layout reserves (EMOJI_WIDTH_EM).
 */
export const ANIMATED_EMOJI_EM = 0.85
/** Gap between words, in em (the static preview uses the same). */
const WORD_GAP_EM = 0.28
/** How much bigger the active word grows (libass pops 109%). */
const ACTIVE_SCALE = 0.08

/** CSS font shorthand for a caption family. */
export function captionFont(family: string, weight: number, px: number): string {
  return `${weight} ${px.toFixed(2)}px "${family}", sans-serif`
}

function weightOf(style: Pick<CaptionStyle, 'bold'>): number {
  return style.bold ? 700 : 400
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** Blend two "#RRGGBB" colours; `amount` 0 = a, 1 = b. */
export function mixColor(a: string, b: string, amount: number): string {
  const parse = (hex: string): number[] => {
    const c = hex.replace('#', '')
    return c.length === 6 ? [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)) : [255, 255, 255]
  }
  const x = parse(a)
  const y = parse(b)
  const k = clamp01(amount)
  const out = x.map((v, i) => Math.round(v + (y[i] - v) * k))
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Rounded rectangle path (arcTo, which every canvas has). */
function roundRectPath(ctx: CaptionCanvasContext, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

class Bounds {
  x0 = Infinity
  y0 = Infinity
  x1 = -Infinity
  y1 = -Infinity
  add(x0: number, y0: number, x1: number, y1: number): void {
    this.x0 = Math.min(this.x0, x0)
    this.y0 = Math.min(this.y0, y0)
    this.x1 = Math.max(this.x1, x1)
    this.y1 = Math.max(this.y1, y1)
  }
  rect(width: number, height: number): DirtyRect | null {
    if (!(this.x1 > this.x0 && this.y1 > this.y0)) return null
    const x = Math.max(0, Math.floor(this.x0))
    const y = Math.max(0, Math.floor(this.y0))
    const x1 = Math.min(width, Math.ceil(this.x1))
    const y1 = Math.min(height, Math.ceil(this.y1))
    return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null
  }
}

/** Vertical offset from a line's centre to its alphabetic baseline. */
function baselineOffset(ctx: CaptionCanvasContext, px: number): number {
  const m = ctx.measureText('Hg')
  if (m.fontBoundingBoxAscent !== undefined && m.fontBoundingBoxDescent !== undefined) {
    return (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2
  }
  return px * 0.35
}

interface WordBox {
  word: PlannedWord
  index: number
  /** Word centre and size before any animation scale. */
  cx: number
  cy: number
  width: number
  px: number
  baseline: number
  emojiX: number
  emojiWidth: number
}

interface CardLayout {
  words: WordBox[]
  top: number
  bottom: number
  left: number
  right: number
  px: number
}

/**
 * Lay a card out: the lines captionLayout chose, each centred, measured with
 * the real font, and scaled down as a whole if it would leave the safe width
 * (the layout's width model is an estimate; this keeps text off the edges).
 */
export function layoutCard(ctx: CaptionCanvasContext, plan: AnimatedCaptionPlan, scene: CardScene, width: number, height: number): CardLayout {
  const style = plan.style
  const card = plan.cards[scene.index]
  const px = style.fontScale * height
  const pitch = captionLinePitchEm(style.fontFamily) * px
  const safe = CAPTION_SAFE_WIDTH * width
  const centreY = scene.y * height
  const top = centreY - (card.lines.length * pitch) / 2
  const words: WordBox[] = []
  let index = 0
  let left = Infinity
  let right = -Infinity
  card.lines.forEach((line, li) => {
    const sizes = line.map((w) => (w.emphasis ? EMPHASIS_SCALE : 1) * px)
    const widths = line.map((w, i) => {
      ctx.font = captionFont(style.fontFamily, weightOf(style), sizes[i])
      return ctx.measureText(w.text).width
    })
    const emojiWidths = line.map((w) => {
      if (!w.emoji) return 0
      ctx.font = `${(px * ANIMATED_EMOJI_EM).toFixed(2)}px ${COLOR_EMOJI_STACK}`
      return ctx.measureText(w.emoji).width
    })
    const gap = WORD_GAP_EM * px
    let total = 0
    line.forEach((_, i) => {
      total += widths[i] + (emojiWidths[i] ? gap + emojiWidths[i] : 0) + (i > 0 ? gap : 0)
    })
    const shrink = total > safe ? safe / total : 1
    let x = width / 2 - (total * shrink) / 2
    left = Math.min(left, x)
    right = Math.max(right, x + total * shrink)
    const cy = top + (li + 0.5) * pitch
    line.forEach((w, i) => {
      const size = sizes[i] * shrink
      ctx.font = captionFont(style.fontFamily, weightOf(style), size)
      const baseline = baselineOffset(ctx, size)
      const wordWidth = widths[i] * shrink
      const box: WordBox = {
        word: w,
        index: index++,
        cx: x + wordWidth / 2,
        cy,
        width: wordWidth,
        px: size,
        baseline,
        emojiX: 0,
        emojiWidth: emojiWidths[i] * shrink
      }
      x += wordWidth
      if (emojiWidths[i]) {
        box.emojiX = x + gap * shrink + box.emojiWidth / 2
        x += gap * shrink + box.emojiWidth
      }
      x += gap * shrink
      words.push(box)
    })
  })
  return { words, top, bottom: top + card.lines.length * pitch, left, right, px }
}

function setShadow(ctx: CaptionCanvasContext, style: CaptionStyle, height: number, alpha = 1): void {
  const a = style.animation
  if (!a || a.shadowBlur <= 0) return
  ctx.shadowColor = hexToRgba(a.shadowColor, a.shadowOpacity * alpha)
  ctx.shadowBlur = a.shadowBlur * height
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = a.shadowOffset * height
}

function clearShadow(ctx: CaptionCanvasContext): void {
  ctx.shadowColor = 'rgba(0,0,0,0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
}

/** Outline in output pixels: the style's figure is libass pixels on a 1920-high frame. */
function outlinePx(style: CaptionStyle, height: number): number {
  return style.outlineWidth * (height / 1920)
}

function drawCard(ctx: CaptionCanvasContext, plan: AnimatedCaptionPlan, scene: CardScene, width: number, height: number, bounds: Bounds): void {
  const style = plan.style
  const kind = style.animation?.kind ?? 'pop'
  const layout = layoutCard(ctx, plan, scene, width, height)
  const look = captionEmphasisLook(style)
  const emphasisColor = style.emphasisColor ?? look.color
  const outline = outlinePx(style, height)
  const px = layout.px

  ctx.save()
  // Whole-card motion: Spark springs the card up from below; the others ease
  // it in with a short rise. Every style fades out over its last moment.
  const enter = scene.enter
  const cardScale = kind === 'spark' ? 0.7 + 0.3 * enter : 1
  const rise = (1 - enter) * (kind === 'spark' ? 0.6 : kind === 'pop' ? 0 : 0.25) * px
  const centreY = (layout.top + layout.bottom) / 2
  ctx.translate(width / 2, centreY + rise)
  ctx.scale(cardScale, cardScale)
  ctx.translate(-width / 2, -centreY)
  ctx.globalAlpha = clamp01(scene.exit) * (kind === 'pop' ? 1 : clamp01(enter * 2))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.direction = 'ltr'

  // Glide: one rounded box behind the active word, sliding between words.
  if (kind === 'glide' && scene.box && style.highlightBoxColor) {
    const from = layout.words[scene.box.from]
    const to = layout.words[scene.box.to]
    if (from && to) {
      const p = scene.box.progress
      const grow = scene.box.from === scene.box.to ? p : 1
      const cx = from.cx + (to.cx - from.cx) * p
      const cy = from.cy + (to.cy - from.cy) * p
      // Padding stays inside the word gap so the box never covers a neighbour.
      const w = (from.width + (to.width - from.width) * p + 0.24 * to.px) * grow
      const h = to.px * 1.32 * grow
      ctx.save()
      setShadow(ctx, style, height)
      ctx.fillStyle = style.highlightBoxColor
      roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, 0.32 * to.px)
      ctx.fill()
      ctx.restore()
    }
  }

  for (const box of layout.words) {
    const state = scene.words[box.index]
    if (!state || state.appear <= 0) continue
    const lift = state.lift
    const liftClamped = clamp01(lift)
    const word = box.word
    const base = word.emphasis ? emphasisColor : style.textColor
    // A growing word may push into at most 40% of the gap on each side, so a
    // long word's pop never touches its neighbours.
    const maxGrowth = (0.8 * WORD_GAP_EM * layout.px) / Math.max(1, box.width)
    const growth = Math.min(maxGrowth, (kind === 'prism' ? 0.1 : ACTIVE_SCALE) * lift)
    const scale = state.appear * (1 + growth)
    let dy = 0
    if (kind === 'spark') dy = -0.08 * box.px * lift
    ctx.save()
    ctx.translate(box.cx, box.cy + dy)
    ctx.scale(scale, scale)
    ctx.font = captionFont(style.fontFamily, weightOf(style), box.px)
    const y = box.baseline

    // Outline (with the soft shadow under it), then the fill.
    const onBox = kind === 'glide' && liftClamped > 0.5
    if (outline > 0 && !onBox) {
      ctx.save()
      setShadow(ctx, style, height)
      ctx.strokeStyle = style.outlineColor
      ctx.lineWidth = outline * 2
      ctx.strokeText(word.text, 0, y)
      ctx.restore()
    } else if (!onBox) {
      setShadow(ctx, style, height)
    }

    if (kind === 'prism') {
      const top = -box.px * 0.62
      const bottom = box.px * 0.42
      const idle = ctx.createLinearGradient(0, top, 0, bottom)
      idle.addColorStop(0, word.emphasis ? emphasisColor : style.textColor)
      idle.addColorStop(1, style.animation?.secondaryColor ?? style.highlightColor)
      ctx.fillStyle = idle
      ctx.fillText(word.text, 0, y)
      if (liftClamped > 0) {
        clearShadow(ctx)
        const hot = ctx.createLinearGradient(0, top, 0, bottom)
        hot.addColorStop(0, style.animation?.secondaryColor ?? '#FFFFFF')
        hot.addColorStop(1, style.highlightColor)
        ctx.globalAlpha *= liftClamped
        ctx.fillStyle = hot
        ctx.fillText(word.text, 0, y)
      }
    } else if (kind === 'sweep') {
      ctx.fillStyle = base
      ctx.fillText(word.text, 0, y)
      clearShadow(ctx)
      const fill = clamp01(state.fill)
      if (fill > 0) {
        const left = -box.width / 2 - box.px * 0.1
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, -box.px * 1.2, (box.width + box.px * 0.2) * fill, box.px * 2.4)
        ctx.clip()
        ctx.fillStyle = word.emphasis && emphasisColor !== style.textColor ? emphasisColor : style.highlightColor
        ctx.fillText(word.text, 0, y)
        ctx.restore()
      }
    } else {
      ctx.fillStyle = mixColor(base, style.highlightColor, liftClamped)
      ctx.fillText(word.text, 0, y)
    }
    ctx.restore()

    if (word.emoji) {
      // Colour emoji pop in with their word.
      const s = state.pop
      if (s > 0) {
        ctx.save()
        ctx.translate(box.emojiX, box.cy - (kind === 'spark' ? 0.12 * box.px * Math.max(0, 1 - s) : 0))
        ctx.scale(s, s)
        clearShadow(ctx)
        setShadow(ctx, style, height, 0.6)
        // Emoji only follow emphasised words, whose size includes EMPHASIS_SCALE.
        ctx.font = `${((box.px / EMPHASIS_SCALE) * ANIMATED_EMOJI_EM).toFixed(2)}px ${COLOR_EMOJI_STACK}`
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#FFFFFF'
        ctx.fillText(word.emoji, 0, 0)
        ctx.textBaseline = 'alphabetic'
        ctx.restore()
      }
    }
  }
  ctx.restore()

  // Generous bounds: springs overshoot, shadows blur and the card can rise.
  const a = style.animation
  const pad = px * 0.9 + outline * 2 + (a ? a.shadowBlur * height * 2.5 + Math.abs(a.shadowOffset * height) : 0)
  const halfWidth = ((layout.right - layout.left) / 2) * 1.2
  bounds.add(width / 2 - halfWidth - pad, layout.top - pad, width / 2 + halfWidth + pad, layout.bottom + pad + px * 0.6)
}

function drawTitle(ctx: CaptionCanvasContext, plan: TitlePlan, style: CaptionStyle, enter: number, opacity: number, width: number, height: number, bounds: Bounds): void {
  const px = plan.fontScale * height
  const pitch = captionLinePitchEm(plan.fontFamily) * px
  const pad = plan.boxPad * height
  const top = plan.top * height
  const boxed = plan.boxColor !== null
  const weight = plan.bold ? 700 : 400
  ctx.save()
  ctx.font = captionFont(plan.fontFamily, weight, px)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.direction = 'ltr'
  const baseline = baselineOffset(ctx, px)
  const space = ctx.measureText(' ').width
  const lines = plan.lines.map((line) => {
    const widths = line.map((w) => ctx.measureText(w.text).width)
    const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, line.length - 1)
    return { line, widths, total }
  })
  const blockHeight = plan.lines.length * pitch
  const scale = 0.88 + 0.12 * enter
  const centreY = top + blockHeight / 2
  ctx.translate(width / 2, centreY)
  ctx.scale(scale, scale)
  ctx.translate(-width / 2, -centreY)
  ctx.globalAlpha = clamp01(opacity)
  lines.forEach(({ line, widths, total }, i) => {
    const cy = top + (i + 0.5) * pitch
    const x0 = width / 2 - total / 2
    if (boxed) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.35)'
      ctx.shadowBlur = 0.012 * height
      ctx.shadowOffsetY = 0.004 * height
      ctx.fillStyle = hexToRgba(plan.boxColor!, plan.boxOpacity)
      roundRectPath(ctx, x0 - pad, cy - pitch / 2 - pad + (i > 0 ? pad : 0), total + 2 * pad, pitch + 2 * pad - (i > 0 ? pad : 0), 0.22 * px)
      ctx.fill()
      ctx.restore()
    }
    let x = x0
    line.forEach((w, wi) => {
      if (!boxed && plan.outlineWidth > 0) {
        ctx.save()
        setShadow(ctx, style, height)
        ctx.strokeStyle = plan.outlineColor
        ctx.lineWidth = plan.outlineWidth * height * 2
        ctx.strokeText(w.text, x, cy + baseline)
        ctx.restore()
      }
      ctx.fillStyle = w.accent ? plan.accentColor : plan.textColor
      ctx.fillText(w.text, x, cy + baseline)
      x += widths[wi] + space
    })
  })
  ctx.restore()
  const widest = Math.max(0, ...lines.map((l) => l.total))
  const margin = pad + px * 0.5 + 0.03 * height
  bounds.add(width / 2 - widest / 2 - margin, top - margin, width / 2 + widest / 2 + margin, top + blockHeight + margin)
}

function drawTranslated(ctx: CaptionCanvasContext, plan: AnimatedCaptionPlan, index: number, y: number, opacity: number, width: number, height: number, bounds: Bounds): void {
  const tr = plan.translation
  const event = tr?.events[index]
  if (!tr || !event) return
  const style = plan.style
  const px = tr.fontScale * height
  const pitch = CAPTION_LINE_HEIGHT_EM * px
  const blockHeight = event.lines.length * pitch
  const top = tr.anchor === 'top' ? y * height : y * height - blockHeight / 2
  const outline = translatedOutlineWidth(style, tr.fontScale / style.fontScale) * (height / 1920)
  ctx.save()
  ctx.globalAlpha = clamp01(opacity)
  ctx.font = `${weightOf(style)} ${px.toFixed(2)}px ${tr.fontStack}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  const baseline = baselineOffset(ctx, px)
  let widest = 0
  event.lines.forEach((line, i) => {
    ctx.direction = event.rtl ? 'rtl' : 'ltr'
    const cy = top + (i + 0.5) * pitch + baseline
    const lineWidth = ctx.measureText(line).width
    widest = Math.max(widest, lineWidth)
    // Long translated lines shrink to the safe width rather than clip.
    const shrink = Math.min(1, (CAPTION_SAFE_WIDTH * width) / Math.max(1, lineWidth))
    ctx.save()
    ctx.translate(width / 2, cy)
    ctx.scale(shrink, shrink)
    ctx.save()
    setShadow(ctx, style, height)
    ctx.strokeStyle = style.outlineColor
    ctx.lineWidth = outline * 2
    ctx.strokeText(line, 0, 0)
    ctx.restore()
    ctx.fillStyle = style.textColor
    ctx.fillText(line, 0, 0)
    ctx.restore()
  })
  ctx.restore()
  const pad = px * 0.8 + outline * 2 + 0.03 * height
  const half = Math.min(width, widest) / 2
  bounds.add(width / 2 - half - pad, top - pad, width / 2 + half + pad, top + blockHeight + pad)
}

/**
 * Paint `scene` onto `ctx`, a canvas of `width` x `height` pixels that the
 * caller has cleared. Returns the pixels that may have been touched (null
 * when nothing is visible), so the export only reads back that region.
 */
export function drawCaptionScene(
  ctx: CaptionCanvasContext,
  plan: AnimatedCaptionPlan,
  scene: CaptionScene,
  width: number,
  height: number
): DirtyRect | null {
  const bounds = new Bounds()
  clearShadow(ctx)
  ctx.globalAlpha = 1
  if (scene.card && plan.cards[scene.card.index]) drawCard(ctx, plan, scene.card, width, height, bounds)
  if (scene.translated) drawTranslated(ctx, plan, scene.translated.index, scene.translated.y, scene.translated.opacity, width, height, bounds)
  if (scene.title && plan.title) drawTitle(ctx, plan.title, plan.style, scene.title.enter, scene.title.opacity, width, height, bounds)
  return bounds.rect(width, height)
}

/**
 * The bundled caption faces and the weights they are registered under. The
 * preview gets the same set from @font-face rules in renderer/src/index.css;
 * the export window registers these files with the FontFace API.
 */
export const BUNDLED_CAPTION_FONTS: Array<{ family: string; file: string; weight: string }> = [
  { family: 'Anton', file: 'Anton-Regular.ttf', weight: '400' },
  { family: 'Poppins', file: 'Poppins-Bold.ttf', weight: '700' },
  { family: 'Poppins Medium', file: 'Poppins-Medium.ttf', weight: '500' },
  { family: COLOR_EMOJI_FONT, file: 'CutawanColorEmoji.ttf', weight: 'normal' }
]
