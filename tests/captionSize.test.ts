import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assFontSize, buildAss } from '../src/main/pipeline/captions'
import { parseFontMetrics } from '../src/main/fonts'
import { CAPTION_STYLES, libassCaptionStyleId, resolveCaptionStyle } from '@shared/captionStyles'
import type { Transcript } from '@shared/types'

const FONTS = join(process.cwd(), 'resources', 'fonts')
const anton = parseFontMetrics(readFileSync(join(FONTS, 'Anton-Regular.ttf')))
const poppins = parseFontMetrics(readFileSync(join(FONTS, 'Poppins-Bold.ttf')))

function transcript(): Transcript {
  return {
    language: 'en',
    durationSec: 5,
    segments: [{ id: 0, start: 0, end: 5, text: 'HELLO', words: [{ text: 'HELLO', start: 0, end: 5 }] }]
  }
}

function captionFontSize(ass: string): number {
  return Number(/^Style: Caption,[^,]+,(\d+)/m.exec(ass)![1])
}

describe('parseFontMetrics', () => {
  it('reads the bundled fonts', () => {
    expect(anton).toEqual({ unitsPerEm: 2048, winSpan: 2876 + 674 })
    expect(poppins).toEqual({ unitsPerEm: 1000, winSpan: 1135 + 627 })
  })

  it('returns null for data that is not a font', () => {
    expect(parseFontMetrics(Buffer.from('not a font at all, really'))).toBeNull()
    expect(parseFontMetrics(Buffer.alloc(0))).toBeNull()
  })
})

describe('assFontSize', () => {
  /**
   * The bug this guards: CSS `font-size` sets the em square, libass `Fontsize`
   * sets the OS/2 window ascent+descent span. Feeding an em size straight in
   * rendered every caption at ~58% of the size the preview showed.
   */
  it('scales an em size by the font’s win span', () => {
    expect(assFontSize(100, anton)).toBe(Math.round(100 * (3550 / 2048)))
    expect(assFontSize(100, poppins)).toBe(Math.round(100 * (1762 / 1000)))
  })

  it('always enlarges, never shrinks', () => {
    for (const m of [anton, poppins]) {
      expect(assFontSize(100, m)).toBeGreaterThan(100)
    }
  })

  it('falls back to a sane ratio when metrics are unavailable', () => {
    const fallback = assFontSize(100, null)
    expect(fallback).toBeGreaterThan(150)
    expect(fallback).toBeLessThan(200)
    // Close enough to the real fonts that an unreadable font is not a regression.
    expect(Math.abs(fallback - assFontSize(100, anton))).toBeLessThan(20)
  })

  it('scales linearly with the requested size, to within rounding', () => {
    expect(assFontSize(200, anton)).toBeCloseTo(2 * assFontSize(100, anton), -0.5)
    expect(Math.abs(assFontSize(200, anton) - 2 * assFontSize(100, anton))).toBeLessThanOrEqual(1)
  })
})

describe('buildAss font sizing', () => {
  const base = { width: 1080, height: 1920, clipStart: 0, clipEnd: 5 }

  it('emits the converted size for every preset', () => {
    for (const preset of CAPTION_STYLES) {
      // Animated presets burn their libass equivalent.
      const style = resolveCaptionStyle(libassCaptionStyleId(preset.id))
      const metrics = style.fontFamily.startsWith('Poppins') ? poppins : anton
      const ass = buildAss(transcript(), { ...base, styleId: preset.id, fontMetrics: metrics })
      expect(captionFontSize(ass)).toBe(assFontSize(style.fontScale * base.height, metrics))
    }
  })

  it('renders larger than the old em-size assumption did', () => {
    const ass = buildAss(transcript(), { ...base, styleId: 'beast', fontMetrics: anton })
    const old = Math.round(resolveCaptionStyle('beast').fontScale * base.height)
    // The regression it fixes was roughly 0.58x; anything near `old` is a relapse.
    expect(captionFontSize(ass)).toBeGreaterThan(old * 1.5)
  })

  it('still produces a valid style line without metrics', () => {
    const ass = buildAss(transcript(), { ...base, styleId: 'beast' })
    expect(captionFontSize(ass)).toBeGreaterThan(0)
  })
})
