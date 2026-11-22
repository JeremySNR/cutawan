import type { BrandColors } from './types'

/**
 * Caption style presets, shared by the renderer (live preview) and the main
 * process (ASS subtitle generation for burn-in).
 *
 * Colours are plain hex strings ("#RRGGBB"); the ASS generator converts them
 * to libass &HBBGGRR& form.
 */

export interface CaptionStyle {
  id: string
  name: string
  fontFamily: string
  /** Font size as a fraction of video height. */
  fontScale: number
  uppercase: boolean
  textColor: string
  /** Colour of the currently spoken word. */
  highlightColor: string
  /** Optional pill behind the active word (ASS BorderStyle 3 on highlight layer). */
  highlightBoxColor: string | null
  outlineColor: string
  outlineWidth: number
  shadow: number
  bold: boolean
  /** Vertical anchor as fraction of video height measured from the top. */
  positionY: number
  /** Max words shown per caption group. */
  wordsPerGroup: number
  /**
   * Colour of an emphasised key word, for styles whose highlight colour is the
   * text colour (so the highlight alone would not mark it). Absent = highlight.
   */
  emphasisColor?: string
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'beast',
    name: 'Beast',
    fontFamily: 'Anton',
    fontScale: 0.052,
    uppercase: true,
    textColor: '#FFFFFF',
    highlightColor: '#FFD400',
    highlightBoxColor: null,
    outlineColor: '#000000',
    outlineWidth: 3.2,
    shadow: 1,
    bold: false,
    positionY: 0.72,
    wordsPerGroup: 3
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    fontFamily: 'Poppins',
    fontScale: 0.046,
    uppercase: false,
    textColor: '#FFFFFF',
    highlightColor: '#4ADE80',
    highlightBoxColor: null,
    outlineColor: '#000000',
    outlineWidth: 2.6,
    shadow: 1,
    bold: true,
    positionY: 0.74,
    wordsPerGroup: 4
  },
  {
    id: 'pill',
    name: 'Pill',
    fontFamily: 'Anton',
    fontScale: 0.044,
    uppercase: true,
    textColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    highlightBoxColor: '#7C3AED',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadow: 0,
    bold: false,
    positionY: 0.74,
    wordsPerGroup: 3
  },
  {
    id: 'minimal',
    name: 'Minimal',
    fontFamily: 'Poppins Medium',
    fontScale: 0.038,
    uppercase: false,
    textColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    highlightBoxColor: null,
    outlineColor: '#000000',
    outlineWidth: 1.6,
    shadow: 0,
    bold: false,
    positionY: 0.8,
    wordsPerGroup: 6,
    emphasisColor: '#FDE047'
  },
  {
    id: 'hormozi',
    name: 'Hormozi',
    fontFamily: 'Anton',
    fontScale: 0.05,
    uppercase: true,
    textColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    highlightBoxColor: '#16A34A',
    outlineColor: '#000000',
    outlineWidth: 2.8,
    shadow: 1,
    bold: false,
    positionY: 0.7,
    wordsPerGroup: 3
  },
  {
    id: 'neon',
    name: 'Neon',
    fontFamily: 'Poppins',
    fontScale: 0.046,
    uppercase: false,
    textColor: '#FFFFFF',
    highlightColor: '#22D3EE',
    highlightBoxColor: null,
    outlineColor: '#164E63',
    outlineWidth: 3,
    shadow: 2,
    bold: true,
    positionY: 0.74,
    wordsPerGroup: 4
  },
  {
    id: 'ember',
    name: 'Ember',
    fontFamily: 'Anton',
    fontScale: 0.052,
    uppercase: true,
    textColor: '#FFF7ED',
    highlightColor: '#FB923C',
    highlightBoxColor: null,
    outlineColor: '#431407',
    outlineWidth: 3.2,
    shadow: 1,
    bold: false,
    positionY: 0.72,
    wordsPerGroup: 3
  },
  {
    id: 'bubble',
    name: 'Bubble',
    fontFamily: 'Poppins',
    fontScale: 0.042,
    uppercase: false,
    textColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    highlightBoxColor: '#2563EB',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadow: 0,
    bold: true,
    positionY: 0.76,
    wordsPerGroup: 4
  },
  {
    id: 'lemon',
    name: 'Lemon',
    fontFamily: 'Anton',
    fontScale: 0.046,
    uppercase: true,
    textColor: '#FFFFFF',
    highlightColor: '#111111',
    highlightBoxColor: '#FACC15',
    outlineColor: '#000000',
    outlineWidth: 1.8,
    shadow: 0,
    bold: false,
    positionY: 0.74,
    wordsPerGroup: 3
  },
  {
    id: 'retro',
    name: 'Retro',
    fontFamily: 'Anton',
    fontScale: 0.05,
    uppercase: true,
    textColor: '#FDE68A',
    highlightColor: '#F472B6',
    highlightBoxColor: null,
    outlineColor: '#3B0764',
    outlineWidth: 3,
    shadow: 2,
    bold: false,
    positionY: 0.72,
    wordsPerGroup: 3
  },
  {
    id: 'crimson',
    name: 'Crimson',
    fontFamily: 'Poppins',
    fontScale: 0.048,
    uppercase: true,
    textColor: '#FFFFFF',
    highlightColor: '#EF4444',
    highlightBoxColor: null,
    outlineColor: '#000000',
    outlineWidth: 3,
    shadow: 1,
    bold: true,
    positionY: 0.72,
    wordsPerGroup: 3
  },
  {
    id: 'whisper',
    name: 'Whisper',
    fontFamily: 'Poppins Medium',
    fontScale: 0.034,
    uppercase: false,
    textColor: '#E4E4E7',
    highlightColor: '#A5F3FC',
    highlightBoxColor: null,
    outlineColor: '#000000',
    outlineWidth: 1.2,
    shadow: 0,
    bold: false,
    positionY: 0.82,
    wordsPerGroup: 7
  }
]

export const DEFAULT_CAPTION_STYLE_ID = 'beast'

export const DEFAULT_BRAND_COLORS: BrandColors = {
  enabled: false,
  primaryColor: '#A855F7',
  secondaryColor: '#FFFFFF',
  textColor: null,
  outlineColor: null,
  hookTextColor: '#FFFFFF',
  hookBackgroundColor: '#000000'
}

export function getCaptionStyle(id: string): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]
}

/** Merge app-wide brand colours onto a caption preset (and optional font override). */
export function resolveCaptionStyle(
  id: string,
  brandColors?: BrandColors | null,
  fontFamily?: string | null
): CaptionStyle {
  const preset = getCaptionStyle(id)
  let style: CaptionStyle = fontFamily ? { ...preset, fontFamily } : { ...preset }

  if (!brandColors?.enabled) return style

  if (preset.highlightBoxColor !== null) {
    style = {
      ...style,
      highlightBoxColor: brandColors.primaryColor,
      highlightColor: brandColors.secondaryColor
    }
  } else {
    style = { ...style, highlightColor: brandColors.primaryColor }
  }
  if (brandColors.textColor) {
    style = { ...style, textColor: brandColors.textColor }
  }
  if (brandColors.outlineColor) {
    style = { ...style, outlineColor: brandColors.outlineColor }
  }
  return style
}

/**
 * How an emphasised key word is drawn, shared by the ASS and the preview: the
 * style's highlight treatment (its colour, and its box on box styles) at
 * EMPHASIS_SCALE. Styles whose highlight is plain text colour use their
 * second colour instead, so the word still stands out.
 */
export function captionEmphasisLook(style: CaptionStyle): { color: string; boxColor: string | null } {
  if (style.highlightBoxColor) return { color: style.highlightColor, boxColor: style.highlightBoxColor }
  const same = style.highlightColor.toLowerCase() === style.textColor.toLowerCase()
  return { color: same ? style.emphasisColor ?? '#FDE047' : style.highlightColor, boxColor: null }
}

/** Convert "#RRGGBB" to an rgba() string for CSS previews. */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return `rgba(0,0,0,${alpha})`
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
