import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import type { Clip, Transcript } from '@shared/types'
import {
  CAPTION_STYLES,
  captionEmojiEnabled,
  getCaptionStyle,
  isAnimatedCaptionStyle,
  libassCaptionStyleId,
  resolveCaptionStyle
} from '@shared/captionStyles'
import {
  SPRINGS,
  animatedCaptionPlan,
  captionFrameCount,
  captionSceneAt,
  cardIndexAt,
  sceneKey,
  springSettleTime,
  springValue,
  type AnimatedCaptionPlan
} from '@shared/animatedCaptions'
import { CAPTION_SAFE_WIDTH } from '@shared/captionLayout'
import { clipCaptionGroups } from '@shared/clipOverlays'
import { ClipTimeline } from '@shared/clipTimeline'
import { planTitle } from '@shared/titleLayout'
import { drawCaptionScene, layoutCard, mixColor, type CaptionCanvasContext } from '@shared/captionCanvas'
import { buildAss } from '../src/main/pipeline/captions'
import { writeCaptionFrames, type CaptionFrameSession } from '../src/main/pipeline/animatedCaptions'

function speech(text: string, from: number, step: number): Transcript['segments'][number] {
  const words = text.split(' ').map((t, i) => ({ text: t, start: from + i * step, end: from + (i + 1) * step - 0.04 }))
  return { id: Math.round(from * 10), text, start: words[0].start, end: words[words.length - 1].end, words }
}

const transcript: Transcript = {
  language: 'en',
  durationSec: 20,
  segments: [speech('The secret to growing fast is simple.', 1, 0.4), speech('Money changes everything about your life', 8, 0.4)]
}

function clip(edit: Partial<Clip['edit']> = {}): Clip {
  return {
    id: 'c', suggestedStart: 0, suggestedEnd: 12, title: 'T', hook: 'The secret nobody tells you', summary: '',
    viralityScore: 0, visualSummary: null, viralityReason: '', hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5, captionsEnabled: true,
      captionStyleId: 'pop', showTitle: true, start: 0, end: 12, ...edit
    }
  }
}

function plan(styleId: string, timeline = new ClipTimeline([{ start: 0, end: 12 }]), edit: Partial<Clip['edit']> = {}): AnimatedCaptionPlan {
  const c = clip({ captionStyleId: styleId, ...edit })
  const style = resolveCaptionStyle(styleId)
  return animatedCaptionPlan({
    transcript, clip: c, timeline, style, aspectRatio: 9 / 16, captions: true,
    title: planTitle(c.hook, { captionStyle: style, aspectRatio: 9 / 16, start: timeline.coldOpenDuration, duration: timeline.outputDuration }),
    translation: null, positionRanges: []
  })
}

/** A canvas stand-in: fixed-advance text, records what is drawn where. */
function fakeContext(): CaptionCanvasContext & { texts: Array<{ text: string; x: number; y: number }> } {
  let tx = 0
  let ty = 0
  let sx = 1
  const stack: Array<[number, number, number]> = []
  const ctx = {
    font: '10px x', fillStyle: '' as unknown, strokeStyle: '' as unknown, lineWidth: 1, lineJoin: 'miter', textAlign: 'start',
    textBaseline: 'alphabetic', direction: 'ltr', globalAlpha: 1, shadowBlur: 0, shadowColor: '', shadowOffsetX: 0, shadowOffsetY: 0,
    texts: [] as Array<{ text: string; x: number; y: number }>,
    save: () => stack.push([tx, ty, sx]),
    restore: () => { [tx, ty, sx] = stack.pop() ?? [0, 0, 1] },
    translate: (x: number, y: number) => { tx += x * sx; ty += y * sx },
    scale: (x: number) => { sx *= x },
    beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined, arcTo: () => undefined,
    closePath: () => undefined, rect: () => undefined, clip: () => undefined, fill: () => undefined,
    fillText: (text: string, x: number, y: number) => ctx.texts.push({ text, x: tx + x * sx, y: ty + y * sx }),
    strokeText: () => undefined,
    measureText: (text: string) => {
      const px = Number(/([\d.]+)px/.exec(ctx.font)?.[1] ?? 10)
      return { width: [...text].length * px * 0.6 }
    },
    createLinearGradient: () => ({ addColorStop: () => undefined })
  }
  return ctx
}

describe('springs', () => {
  it('start at rest, overshoot, and settle to exactly 1', () => {
    expect(springValue(-0.1, SPRINGS.pop)).toBe(0)
    expect(springValue(0, SPRINGS.pop)).toBe(0)
    const samples = Array.from({ length: 60 }, (_, i) => springValue(i / 100, SPRINGS.pop))
    expect(Math.max(...samples)).toBeGreaterThan(1.08)
    expect(Math.max(...samples)).toBeLessThan(1.3)
    const settle = springSettleTime(SPRINGS.pop)
    expect(settle).toBeLessThan(0.4)
    expect(springValue(settle, SPRINGS.pop)).toBe(1)
    expect(springValue(settle + 3, SPRINGS.pop)).toBe(1)
    expect(Math.abs(springValue(settle - 1e-4, SPRINGS.pop) - 1)).toBeLessThan(0.002)
  })
  it('are pure functions of time', () => {
    for (const t of [0.01, 0.05, 0.123, 0.3]) expect(springValue(t, SPRINGS.glide)).toBe(springValue(t, SPRINGS.glide))
  })
})

describe('animated styles', () => {
  it('are flagged, fall back to a real libass preset, and keep the libass presets untouched', () => {
    const animated = CAPTION_STYLES.filter((s) => s.animation)
    expect(animated.length).toBeGreaterThanOrEqual(4)
    for (const s of animated) {
      expect(isAnimatedCaptionStyle(s.id)).toBe(true)
      const fallback = getCaptionStyle(libassCaptionStyleId(s.id))
      expect(fallback.id).toBe(s.animation!.fallbackStyleId)
      expect(fallback.animation).toBeUndefined()
    }
    expect(libassCaptionStyleId('beast')).toBe('beast')
    expect(isAnimatedCaptionStyle('karaoke')).toBe(false)
  })
  it('turn emoji on by default only where the style says, and the clip toggle wins', () => {
    expect(captionEmojiEnabled({ captionStyleId: 'spark' })).toBe(true)
    expect(captionEmojiEnabled({ captionStyleId: 'spark', emoji: false })).toBe(false)
    expect(captionEmojiEnabled({ captionStyleId: 'beast' })).toBe(false)
    expect(captionEmojiEnabled({ captionStyleId: 'pop', emoji: true })).toBe(true)
  })
  it('burn their libass equivalent through buildAss', () => {
    const ass = buildAss(transcript, { styleId: 'glide', width: 1080, height: 1920, clipStart: 0, clipEnd: 12 })
    expect(ass).toContain('Style: Caption,Poppins,')
    const bubble = buildAss(transcript, { styleId: 'bubble', width: 1080, height: 1920, clipStart: 0, clipEnd: 12 })
    expect(ass).toBe(bubble)
  })
})

describe('animatedCaptionPlan', () => {
  it('uses the same cards, lines and emphasis as the libass export', () => {
    const p = plan('sweep')
    const style = resolveCaptionStyle('sweep')
    const groups = clipCaptionGroups(transcript, clip({ captionStyleId: 'sweep' }), new ClipTimeline([{ start: 0, end: 12 }]), style, 9 / 16)
    expect(p.cards.length).toBe(groups.length)
    p.cards.forEach((card, i) => {
      expect(card.lines.map((l) => l.length)).toEqual(groups[i].lines.map((l) => l.length))
      expect(card.start).toBe(groups[i].start)
      const marked = card.lines.flat().findIndex((w) => w.emphasis)
      expect(marked).toBe(groups[i].emphasis)
    })
    expect(p.cards.every((c) => c.lines.length <= 2)).toBe(true)
  })
  it('never lets a card span a cold-open seam', () => {
    // A cold open replaying 9.0-10.0 s first: its words leave at the seam.
    const tl = new ClipTimeline([{ start: 0, end: 12 }], { start: 8.0, end: 9.5 })
    const p = plan('pop', tl)
    const seam = tl.coldOpenDuration
    for (const card of p.cards) expect(card.start >= seam - 1e-6 || card.end <= seam + 1e-6).toBe(true)
    expect(p.title?.start).toBeCloseTo(seam)
  })
  it('draws emoji with spark by default', () => {
    const p = plan('spark')
    expect(p.cards.some((c) => c.lines.flat().some((w) => w.emoji))).toBe(true)
    expect(plan('spark', undefined, { emoji: false }).cards.every((c) => c.lines.flat().every((w) => !w.emoji))).toBe(true)
  })
})

describe('captionSceneAt', () => {
  const p = plan('pop')
  it('shows nothing in a pause and the right card while words are spoken', () => {
    expect(captionSceneAt(p, 6).card).toBeNull()
    expect(captionSceneAt(p, 6).title).toBeNull()
    expect(sceneKey(captionSceneAt(p, 6))).toBe('')
    const at = captionSceneAt(p, 1.5)
    expect(at.card?.index).toBe(cardIndexAt(p.cards, 1.5))
    expect(at.title).not.toBeNull()
  })
  it('pops words in as they are said and holds the last word highlighted', () => {
    const card = p.cards[0]
    const words = card.lines.flat()
    const before = captionSceneAt(p, words[1].start - 0.01).card!
    expect(before.words[1].appear).toBe(0)
    expect(before.words[0].appear).toBeGreaterThan(0)
    const settled = captionSceneAt(p, words[words.length - 1].start + 1).card
    if (settled && settled.index === 0) {
      expect(settled.words[words.length - 1].lift).toBe(1)
      expect(settled.words[0].lift).toBe(0)
    }
  })
  it('is identical for the same time and stable once settled', () => {
    expect(sceneKey(captionSceneAt(p, 2.345))).toBe(sceneKey(captionSceneAt(p, 2.345)))
    const word = p.cards[0].lines.flat()[1]
    const settled = word.start + springSettleTime(SPRINGS.pop)
    const a = captionSceneAt(p, settled + 0.001)
    const b = captionSceneAt(p, settled + 0.01)
    expect(settled + 0.01).toBeLessThan(p.cards[0].lines.flat()[2].start)
    if (a.card?.index === b.card?.index) {
      expect(sceneKey({ ...a, title: null })).toBe(sceneKey({ ...b, title: null }))
    }
  })
  it('sweeps karaoke fill across each word over its spoken time', () => {
    const s = plan('sweep')
    const w = s.cards[0].lines.flat()[0]
    const mid = captionSceneAt(s, (w.start + w.end) / 2).card!.words[0].fill
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(0.6)
    expect(captionSceneAt(s, w.end + 0.01).card!.words[0].fill).toBe(1)
  })
  it('slides the glide box from the previous word to the active one', () => {
    const g = plan('glide')
    const words = g.cards[0].lines.flat()
    const box = captionSceneAt(g, words[2].start + 0.02).card!.box!
    expect(box.from).toBe(1)
    expect(box.to).toBe(2)
    expect(box.progress).toBeGreaterThan(0)
    expect(box.progress).toBeLessThan(1)
    expect(captionSceneAt(g, words[2].start + springSettleTime(SPRINGS.glide) + 0.001).card!.box!.progress).toBe(1)
  })
  it('follows caption position ranges', () => {
    const moved = { ...p, positionRanges: [{ start: 1, end: 2, positionY: 0.4 }] }
    expect(captionSceneAt(moved, 1.5).card!.y).toBe(0.4)
    expect(captionSceneAt(moved, 2.5).card!.y).toBe(p.style.positionY)
  })
  it('covers the clip with frames at the export rate', () => {
    expect(captionFrameCount(12, 30)).toBe(360)
    expect(captionFrameCount(12.01, 30)).toBe(361)
  })
})

describe('drawCaptionScene', () => {
  it('keeps every line inside the safe width and returns bounds around the text', () => {
    for (const id of ['pop', 'glide', 'prism', 'sweep', 'spark']) {
      const p = plan(id)
      for (let i = 0; i < p.cards.length; i++) {
        const t = p.cards[i].lines.flat().at(-1)!.start + 0.6
        const scene = captionSceneAt(p, Math.min(t, p.cards[i].end - 0.01))
        if (!scene.card) continue
        const ctx = fakeContext()
        const layout = layoutCard(ctx, p, scene.card, 1080, 1920)
        expect(layout.left).toBeGreaterThanOrEqual((1080 * (1 - CAPTION_SAFE_WIDTH)) / 2 - 0.5)
        expect(layout.right).toBeLessThanOrEqual(1080 - (1080 * (1 - CAPTION_SAFE_WIDTH)) / 2 + 0.5)
        const rect = drawCaptionScene(ctx, p, { ...scene, title: null }, 1080, 1920)!
        expect(rect).not.toBeNull()
        for (const drawn of ctx.texts) {
          expect(drawn.x).toBeGreaterThanOrEqual(rect.x)
          expect(drawn.x).toBeLessThanOrEqual(rect.x + rect.w)
          expect(drawn.y).toBeGreaterThanOrEqual(rect.y)
          expect(drawn.y).toBeLessThanOrEqual(rect.y + rect.h)
          // Anchored on the style's line, in the lower part of the frame.
          expect(Math.abs(drawn.y / 1920 - p.style.positionY)).toBeLessThan(0.08)
        }
      }
    }
  })
  it('draws nothing for an empty scene', () => {
    expect(drawCaptionScene(fakeContext(), plan('pop'), { card: null, title: null, translated: null }, 1080, 1920)).toBeNull()
  })
  it('mixes colours', () => {
    expect(mixColor('#000000', '#FFFFFF', 0.5)).toBe('#808080')
    expect(mixColor('#123456', '#ABCDEF', 0)).toBe('#123456')
    expect(mixColor('#123456', '#ABCDEF', 2)).toBe('#abcdef')
  })
})

describe('writeCaptionFrames', () => {
  it('streams one frame per output frame, drawing each distinct scene once and skipping empty ones', async () => {
    const p = plan('glide')
    const drawn: number[] = []
    const session: CaptionFrameSession = {
      draw: async (scenes) => {
        drawn.push(scenes.length)
        return scenes.map(() => ({ x: 2, y: 3, w: 4, h: 2, data: new Uint8Array(4 * 2 * 4).fill(200) }))
      },
      close: () => undefined
    }
    const out = new PassThrough()
    let bytes = 0
    const frames: Buffer[] = []
    out.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (frames.length < 400) frames.push(Buffer.from(chunk))
    })
    const stats = await writeCaptionFrames(session, p, { width: 16, height: 16, fps: 30 }, out)
    expect(stats.frames).toBe(captionFrameCount(p.duration, 30))
    expect(bytes).toBe(stats.frames * 16 * 16 * 4)
    // Far fewer draws than frames: settled and empty stretches are reused.
    expect(stats.drawn).toBeLessThan(stats.frames * 0.7)
    expect(stats.empty).toBeGreaterThan(0)
    // Pixels land at the drawn rect, the rest stays transparent.
    const all = Buffer.concat(frames)
    const frame = all.subarray(Math.round(2 * 30) * 1024, Math.round(2 * 30) * 1024 + 1024)
    expect(frame[(3 * 16 + 2) * 4]).toBe(200)
    expect(frame[0]).toBe(0)
    const empty = all.subarray(Math.round(6.2 * 30) * 1024, Math.round(6.2 * 30) * 1024 + 1024)
    expect(empty.every((v) => v === 0)).toBe(true)
  })
  it('surfaces a renderer failure as a caption renderer error', async () => {
    const session: CaptionFrameSession = { draw: async () => { throw new Error('gone') }, close: () => undefined }
    const out = new PassThrough()
    out.resume()
    await expect(writeCaptionFrames(session, plan('pop'), { width: 8, height: 8, fps: 30 }, out)).rejects.toMatchObject({ name: 'CaptionRendererError', message: 'gone' })
  })
  it('stops when aborted', async () => {
    const controller = new AbortController()
    const session: CaptionFrameSession = {
      draw: async (scenes) => { controller.abort(); return scenes.map(() => null) },
      close: () => undefined
    }
    const out = new PassThrough()
    out.resume()
    await expect(writeCaptionFrames(session, plan('pop'), { width: 8, height: 8, fps: 30 }, out, controller.signal)).rejects.toThrow()
  })
})
