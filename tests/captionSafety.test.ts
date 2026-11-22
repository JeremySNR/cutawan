import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { faceBandsFromTracks, persistentTextBand, textBandsInFrame } from '../src/main/pipeline/captionSafety'
import { parseFontFamily, parseFontMetrics } from '../src/main/fonts'
import { EMOJI_FONT_METRICS } from '../src/main/pipeline/captions'

const W = 320, H = 240

/** A grey frame with soft gradients (no strong edges) and optional subtitle-like glyph strokes. */
function frame(seed: number, subtitle?: { top: number; bottom: number; text?: number }): Uint8Array {
  const f = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = 60 + ((x + y + seed * 7) % 40)
  if (subtitle) {
    const top = Math.round(subtitle.top * H), bottom = Math.round(subtitle.bottom * H)
    // White glyph strokes with dark outlines, varying per frame like changing lines.
    for (let y = top; y < bottom; y++) {
      for (let x = 60; x < 260; x++) {
        const stroke = ((x * 3 + (subtitle.text ?? seed) * 5) % 9) < 3
        f[y * W + x] = stroke ? 235 : (((x + 1) * 3 + (subtitle.text ?? seed) * 5) % 9) < 3 ? 15 : f[y * W + x]
      }
    }
  }
  return f
}

describe('burned-in text detection', () => {
  it('finds a subtitle band in the lower frame', () => {
    const bands = textBandsInFrame(frame(1, { top: 0.82, bottom: 0.88 }), W, H)
    expect(bands).toHaveLength(1)
    expect(bands[0].top).toBeCloseTo(0.82, 1)
    expect(bands[0].bottom).toBeCloseTo(0.88, 1)
  })

  it('sees nothing in a plain frame or in the upper frame', () => {
    expect(textBandsInFrame(frame(2), W, H)).toEqual([])
    expect(textBandsInFrame(frame(2, { top: 0.2, bottom: 0.26 }), W, H)).toEqual([])
  })

  it('needs the band in most sampled frames', () => {
    const steady = Array.from({ length: 8 }, (_, i) => frame(i, { top: 0.8, bottom: 0.86, text: i }))
    const band = persistentTextBand(steady, W, H)!
    expect(band.top).toBeLessThanOrEqual(0.8)
    expect(band.bottom).toBeGreaterThanOrEqual(0.86)
    const rare = Array.from({ length: 8 }, (_, i) => (i < 3 ? frame(i, { top: 0.8, bottom: 0.86 }) : frame(i)))
    expect(persistentTextBand(rare, W, H)).toBeNull()
    expect(persistentTextBand(steady.slice(0, 2), W, H)).toBeNull()
  })
})

describe('face bands from the speaker tracks', () => {
  it('summarises the focused face per second', () => {
    const box = { x1: 0.4, y1: 0.2, x2: 0.6, y2: 0.5 }
    const other = { x1: 0.1, y1: 0.6, x2: 0.2, y2: 0.8 }
    const tracks = [
      { start: 0, centres: Array(50).fill(0.5), boxes: Array(50).fill(box) },
      { start: 0, centres: Array(50).fill(0.15), boxes: Array(50).fill(other) }
    ]
    const centres = [...Array(25).fill(0.5), ...Array(25).fill(null)]
    const bands = faceBandsFromTracks(tracks, centres, 10, 25)
    expect(bands).toEqual([{ start: 10, end: 11, top: 0.2, bottom: 0.5 }])
  })
})

describe('the bundled emoji font', () => {
  const buf = readFileSync(join(__dirname, '..', 'resources', 'fonts', 'CutawanEmoji.ttf'))
  it('is the family the captions ask for, with the metrics they size it by', () => {
    expect(parseFontFamily(buf)).toBe('Cutawan Emoji')
    const metrics = parseFontMetrics(buf)!
    expect(metrics.unitsPerEm).toBe(EMOJI_FONT_METRICS.unitsPerEm)
    expect(metrics.winSpan).toBe(EMOJI_FONT_METRICS.winSpan)
  })
  it('ships the same file to the preview', () => {
    const preview = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'fonts', 'CutawanEmoji.ttf'))
    expect(preview.equals(buf)).toBe(true)
  })
})
