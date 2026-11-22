import { describe, expect, it } from 'vitest'
import { buildAss, EMOJI_FONT_METRICS } from '../src/main/pipeline/captions'
import { captionWordText } from '@shared/captionLayout'
import { captionEmphasisLook, resolveCaptionStyle } from '@shared/captionStyles'
import { CAPTION_EMOJI_FONT, EMPHASIS_SCALE } from '@shared/captionEmphasis'
import { ClipTimeline, timelineTranscript } from '@shared/clipTimeline'
import { clipCaptionGroups, clipCaptionOptions, clipTitlePlan } from '@shared/clipOverlays'
import type { Clip } from '@shared/types'
import { makeTranscript } from './helpers'

/**
 * The live preview draws `clipCaptionGroups` (PreviewPlayer's CaptionOverlay);
 * the export burns `buildAss` fed the way render.ts feeds it. These must show
 * the same words, on the same cards, with the same word emphasised and the
 * same emoji, including across a cold open.
 */

const t = makeTranscript([
  'Most people quit their channel within a month.',
  'I posted every single day for a year.',
  'Then one video made 40 million views overnight.',
  'Consistency beats talent every single time.'
], { wordSec: 0.32, gapSec: 0.06, sentenceGapSec: 0.5 })

function clip(edit: Partial<Clip['edit']> = {}): Clip {
  return {
    id: 'parity', title: 'Title', hook: 'Consistency beats talent', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: t.durationSec, viralityScore: 0, viralityReason: '', visualSummary: null,
    hashtags: [], thumbnailPath: null,
    emphasis: { source: 'ai', words: [{ text: 'million', emoji: '💰' }, { text: 'Consistency', emoji: '🔥' }] },
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', focusX: 0.5, captionsEnabled: true,
      captionStyleId: 'karaoke', showTitle: true, tightenCuts: false, start: 0, end: t.durationSec,
      emoji: true, ...edit
    }
  }
}

/** Text of each caption event as libass would show it, without override tags, plus its time span. */
function assCards(ass: string): Array<{ start: string; end: string; text: string; emphasised: string | null; emoji: string | null }> {
  return ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,')).map((line) => {
    const [, start, end] = line.split(',')
    const body = line.slice(line.indexOf(',,0,0,0,,') + 9)
    const big = `\\fscx${Math.round(EMPHASIS_SCALE * 100)}\\fscy${Math.round(EMPHASIS_SCALE * 100)}`
    const emphasised = body.match(new RegExp(`\\{[^}]*${big.replace(/\\/g, '\\\\')}[^}]*\\}([^{]+)\\{`))?.[1] ?? null
    const emoji = body.match(new RegExp(`\\\\fn${CAPTION_EMOJI_FONT}[^}]*\\}([^{]+)\\{`))?.[1] ?? null
    const text = body.replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').replace(/\s+/g, ' ').trim()
    return { start, end, text, emphasised, emoji }
  })
}

const assTime = (sec: number): string => {
  const s = Math.floor(sec % 60), cs = Math.floor((sec - Math.floor(sec)) * 100)
  return `0:00:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function exportAss(c: Clip, timeline: ClipTimeline): string {
  const style = resolveCaptionStyle(c.edit.captionStyleId)
  return buildAss(timelineTranscript(t, timeline, c.edit.start, c.edit.end), {
    styleId: c.edit.captionStyleId, width: 1080, height: 1920, clipStart: 0, clipEnd: timeline.outputDuration,
    title: c.hook, titleStyle: c.edit.titleStyle, titleStart: timeline.coldOpenDuration,
    fontMetrics: { unitsPerEm: 2048, winSpan: 3550 },
    ...clipCaptionOptions(c, timeline)
  }).replace(/^Style: Caption[^\n]*\n/m, (m) => { expect(m).toContain(style.fontFamily); return m })
}

function previewCards(c: Clip, timeline: ClipTimeline): ReturnType<typeof assCards> {
  const style = resolveCaptionStyle(c.edit.captionStyleId)
  const groups = clipCaptionGroups(t, c, timeline, style, 9 / 16)
  return groups.flatMap((g) => g.words.map((w, i) => ({
    start: assTime(w.start),
    end: '',
    // As CaptionOverlay draws it: the emoji right after the emphasised word.
    text: g.words.map((x, k) => captionWordText(x.text, style) + (k === g.emphasis && g.emoji ? ` ${g.emoji}` : '')).join(' '),
    emphasised: (g.emphasis ?? -1) >= 0 ? captionWordText(g.words[g.emphasis!].text, style) : null,
    emoji: g.emoji ?? null,
    index: i
  })))
}

describe('preview and export captions agree', () => {
  for (const [name, timeline] of [
    ['a plain clip', new ClipTimeline([{ start: 0, end: t.durationSec }])],
    ['a clip with a cold open', new ClipTimeline([{ start: 0, end: t.durationSec }], { start: 9.3, end: 11.9 })],
    ['a tightened clip with a cold open', new ClipTimeline([{ start: 0, end: 4 }, { start: 5, end: t.durationSec }], { start: 9.3, end: 11.9 })]
  ] as const) {
    it(`shows the same words, emphasis and emoji: ${name}`, () => {
      const c = clip()
      const ass = assCards(exportAss(c, timeline))
      const preview = previewCards(c, timeline)
      expect(ass.length).toBe(preview.length)
      ass.forEach((card, i) => {
        expect(card.start).toBe(preview[i].start)
        expect(card.text).toBe(preview[i].text)
        expect(card.emphasised).toBe(preview[i].emphasised)
        expect(card.emoji).toBe(preview[i].emoji)
      })
      expect(ass.some((card) => card.emphasised === 'million')).toBe(true)
      expect(ass.some((card) => card.emoji === '💰')).toBe(true)
    })
  }

  it('turns emphasis and emoji off together in both', () => {
    const timeline = new ClipTimeline([{ start: 0, end: t.durationSec }])
    const c = clip({ emphasis: false })
    expect(assCards(exportAss(c, timeline)).every((card) => card.emphasised === null && card.emoji === null)).toBe(true)
    expect(previewCards(c, timeline).every((card) => card.emphasised === null)).toBe(true)
  })

  it('draws the emphasised word in the style accent, larger', () => {
    const timeline = new ClipTimeline([{ start: 0, end: t.durationSec }])
    const ass = exportAss(clip({ captionStyleId: 'minimal' }), timeline)
    const look = captionEmphasisLook(resolveCaptionStyle('minimal'))
    const bgr = `&H${look.color.slice(5, 7)}${look.color.slice(3, 5)}${look.color.slice(1, 3)}&`.toUpperCase()
    expect(ass).toContain(`\\c${bgr}\\fscx118\\fscy118`)
    // The emoji is drawn in the bundled outline font, sized from its own metrics.
    expect(ass).toMatch(new RegExp(`\\\\fn${CAPTION_EMOJI_FONT}\\\\fs\\d+`))
    expect(EMOJI_FONT_METRICS.winSpan / EMOJI_FONT_METRICS.unitsPerEm).toBeCloseTo(1.172, 2)
  })

  it('shows the same title, after the cold open, in both', () => {
    const timeline = new ClipTimeline([{ start: 0, end: t.durationSec }], { start: 9.3, end: 11.9 })
    const c = clip({ titleStyle: 'bold' })
    const plan = clipTitlePlan(c, timeline, resolveCaptionStyle('karaoke'), null, 9 / 16)!
    const title = exportAss(c, timeline).split('\n').find((l) => l.startsWith('Dialogue: 1,'))!
    expect(title.startsWith(`Dialogue: 1,${assTime(plan.start)},`)).toBe(true)
    const lines = title.slice(title.indexOf('\\fad(200,300)}') + 14).replace(/\{[^}]*\}/g, '').split('\\N')
    expect(lines).toEqual(plan.lines.map((l) => l.map((w) => w.text).join(' ')))
  })

  it('keeps cold-open words off the clip proper', () => {
    const timeline = new ClipTimeline([{ start: 0, end: t.durationSec }], { start: 9.3, end: 11.9 })
    const ass = exportAss(clip(), timeline)
    const seam = timeline.coldOpenDuration
    for (const line of ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'))) {
      const [, start, end] = line.split(',')
      const sec = (v: string): number => { const [h, m, s] = v.split(':'); return +h * 3600 + +m * 60 + +s }
      // Every caption event sits entirely before or after the seam.
      expect(sec(end) <= seam + 0.011 || sec(start) >= seam - 0.011).toBe(true)
    }
  })
})
