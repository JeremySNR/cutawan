import { describe, expect, it } from 'vitest'
import type { Clip, ClipTranslation, Transcript } from '@shared/types'
import { getCaptionStyle, resolveCaptionStyle } from '@shared/captionStyles'
import { makeTranscript } from './helpers'
import {
  detectScript,
  effectiveCaptionLanguage,
  playedSentences,
  showsOriginalCaptions,
  splitTranslatedSentence,
  translatedCaptionEvents,
  translatedCaptionPlan,
  translatedCaptionY,
  translatedCardBudget,
  translationCssFontStack,
  translationFont,
  translationState
} from '@shared/captionTranslation'
import { clipKeptSegments, TimeMap } from '@shared/tighten'
import { buildAss } from '../src/main/pipeline/captions'

const SENTENCES = [
  'This is the first sentence.',
  'Here comes the second one now.',
  'And finally the third sentence ends it.'
]

function makeClip(transcript: Transcript, edit: Partial<Clip['edit']> = {}): Clip {
  return {
    id: 'c', title: 'Title', hook: '', summary: 'About things', suggestedStart: 0, suggestedEnd: transcript.durationSec,
    viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5,
      captionsEnabled: true, captionStyleId: 'beast', showTitle: false, start: 0, end: transcript.durationSec, ...edit
    }
  }
}

function translationFor(clip: Clip, transcript: Transcript, texts: string[], accepted = true): ClipTranslation {
  const sentences = playedSentences(clip, transcript)
  return {
    version: 1, language: 'Spanish', languageCode: 'es', edited: false, accepted, createdAt: 0,
    lines: sentences.map((s, i) => ({ start: s.start, end: s.end, source: s.text, text: texts[i] ?? s.text }))
  }
}

describe('playedSentences', () => {
  it('sends whole sentences, and only the words that play', () => {
    const transcript = makeTranscript(SENTENCES)
    const clip = makeClip(transcript)
    expect(playedSentences(clip, transcript).map((s) => s.text)).toEqual(SENTENCES)

    // Cut "the second" out of the middle sentence and the whole last sentence.
    const second = transcript.segments[1].words
    const cut = makeClip(transcript, {
      cuts: [
        { start: second[2].start - 0.01, end: second[3].end + 0.01 },
        { start: transcript.segments[2].start - 0.05, end: transcript.durationSec }
      ]
    })
    expect(playedSentences(cut, transcript).map((s) => s.text)).toEqual(['This is the first sentence.', 'Here comes one now.'])
  })
})

describe('translationState', () => {
  const transcript = makeTranscript(SENTENCES)
  const clip = makeClip(transcript)
  const translation = translationFor(clip, transcript, ['Esta es la primera frase.', 'Aquí viene la segunda.', 'Y la tercera termina.'])

  it('keeps every line while the edit is unchanged', () => {
    const state = translationState(clip, translation, transcript)
    expect(state.playable).toHaveLength(3)
    expect(state.needsRefresh).toBe(false)
  })

  it('drops lines cut out entirely without asking for a refresh', () => {
    const trimmed = makeClip(transcript, { end: transcript.segments[1].end + 0.2 })
    const state = translationState(trimmed, translation, transcript)
    expect(state.status).toEqual(['plays', 'plays', 'dropped'])
    expect(state.needsRefresh).toBe(false)
  })

  it('hides a line cut through the middle and flags the translation for refresh', () => {
    const words = transcript.segments[1].words
    const cut = makeClip(transcript, { cuts: [{ start: words[1].start - 0.01, end: words[2].end + 0.01 }] })
    const state = translationState(cut, translation, transcript)
    expect(state.status).toEqual(['plays', 'changed', 'plays'])
    expect(state.playable.map((l) => l.text)).toEqual(['Esta es la primera frase.', 'Y la tercera termina.'])
    expect(state.needsRefresh).toBe(true)
  })

  it('flags speech that no line covers after the trim grows', () => {
    const short = makeClip(transcript, { end: transcript.segments[1].end + 0.1 })
    const partial = translationFor(short, transcript, ['Uno.', 'Dos.'])
    const state = translationState(clip, partial, transcript)
    expect(state.uncovered).toBe(transcript.segments[2].words.length)
    expect(state.needsRefresh).toBe(true)
  })

  it('survives pause removal, which shortens slots but keeps every word', () => {
    const spaced = makeTranscript(SENTENCES, { sentenceGapSec: 2.5 })
    const base = makeClip(spaced)
    const t = translationFor(base, spaced, ['Uno.', 'Dos.', 'Tres.'])
    const tightened = makeClip(spaced, { tightenCuts: true })
    expect(clipKeptSegments(tightened, spaced)).not.toBeNull()
    const state = translationState(tightened, t, spaced)
    expect(state.status).toEqual(['plays', 'plays', 'plays'])
    expect(state.needsRefresh).toBe(false)
  })
})

describe('caption language mode', () => {
  const transcript = makeTranscript(SENTENCES)
  it('stays original until the translation is accepted', () => {
    const clip = makeClip(transcript, { captionLanguage: 'translated' })
    clip.translation = translationFor(clip, transcript, ['a', 'b', 'c'], false)
    expect(effectiveCaptionLanguage(clip)).toBe('original')
    expect(showsOriginalCaptions(clip)).toBe(true)
    clip.translation.accepted = true
    expect(effectiveCaptionLanguage(clip)).toBe('translated')
    expect(showsOriginalCaptions(clip)).toBe(false)
    clip.edit.captionLanguage = 'both'
    expect(showsOriginalCaptions(clip)).toBe(true)
  })
})

describe('splitting a translated sentence into cards', () => {
  const beast = getCaptionStyle('beast')
  const anton = translationFont('Anton', 'hola', 'linux')

  it('balances cards to the style word cap instead of leaving a lone word', () => {
    const budget = translatedCardBudget(beast, 9 / 16, anton)
    const cards = splitTranslatedSentence('uno dos tres cuatro cinco seis siete', budget, beast, 'latin', 'es')
    expect(cards.map((c) => c.join(' ').split(' ').length)).toEqual([3, 2, 2])
    // Beast shouts; the case follows the target language.
    expect(cards[0][0]).toBe('UNO DOS TRES')
  })

  it('uppercases with the language rules', () => {
    const budget = translatedCardBudget(beast, 9 / 16, anton)
    expect(splitTranslatedSentence('istanbul iyi', budget, beast, 'latin', 'tr').flat().join(' ')).toBe('İSTANBUL İYİ')
  })

  it('fills Han text by width, not by a word count', () => {
    const minimal = getCaptionStyle('minimal')
    const font = translationFont(minimal.fontFamily, '我们今天要讨论一个非常重要的问题', 'linux', 'zh-Hans')
    const budget = translatedCardBudget(minimal, 9 / 16, font)
    const cards = splitTranslatedSentence('我们今天要讨论一个非常重要的问题，大家都应该认真听。', budget, minimal, 'han', 'zh-Hans')
    const lineEm = budget.lineWidthEm
    for (const card of cards) {
      expect(card.length).toBeLessThanOrEqual(2)
      for (const line of card) expect([...line].length).toBeLessThanOrEqual(Math.floor(lineEm) + 1)
    }
    expect(cards.flat().join('')).toBe('我们今天要讨论一个非常重要的问题，大家都应该认真听。')
  })
})

describe('timing translated cards', () => {
  const transcript = makeTranscript(SENTENCES)
  const clip = makeClip(transcript)
  const style = getCaptionStyle('beast')
  const font = translationFont('Anton', 'x', 'linux')

  it('shifts translated captions by a cold open that plays first', () => {
    const translation = translationFor(clip, transcript, ['aaaa bbbb cccc dd ee ff', 'corto.', 'final.'])
    const plain = translatedCaptionEvents(translation.lines, null, clip.edit.start, clip.edit.end,
      { style, aspectRatio: 9 / 16, font, scale: 1 })
    const shifted = translatedCaptionEvents(translation.lines, null, clip.edit.start, clip.edit.end,
      { style, aspectRatio: 9 / 16, font, scale: 1, outputOffset: 2.5 })
    expect(shifted).toHaveLength(plain.length)
    shifted.forEach((e, i) => {
      expect(e.start).toBeCloseTo(plain[i].start + 2.5, 9)
      expect(e.end).toBeCloseTo(plain[i].end + 2.5, 9)
    })
    expect(shifted.map((e) => e.lines)).toEqual(plain.map((e) => e.lines))
  })

  it('shares each sentence slot between its cards by text length and holds the last card', () => {
    const translation = translationFor(clip, transcript, ['aaaa bbbb cccc dd ee ff', 'corto.', 'final.'])
    const events = translatedCaptionEvents(translation.lines, null, clip.edit.start, clip.edit.end,
      { style, aspectRatio: 9 / 16, font, scale: 1 })
    const first = translation.lines[0]
    const own = events.filter((e) => e.start >= first.start - 1e-6 && e.start < first.end)
    expect(own).toHaveLength(2)
    expect(own[0].start).toBeCloseTo(first.start, 6)
    // 12 visible characters against 6: two thirds of the slot.
    expect(own[0].end - own[0].start).toBeCloseTo((first.end - first.start) * 12 / 18, 6)
    expect(own[1].start).toBeCloseTo(own[0].end, 6)
    // The hold never runs into the next sentence.
    expect(own[1].end).toBeLessThanOrEqual(translation.lines[1].start + 1e-9)
    for (let i = 1; i < events.length; i++) expect(events[i].start).toBeGreaterThanOrEqual(events[i - 1].end - 1e-9)
    expect(events[events.length - 1].end).toBeLessThanOrEqual(clip.edit.end - clip.edit.start + 1e-9)
  })

  it('maps slots through the time map like the original captions', () => {
    const spaced = makeTranscript(SENTENCES, { sentenceGapSec: 3 })
    const tightened = makeClip(spaced, { tightenCuts: true })
    const segments = clipKeptSegments(tightened, spaced)!
    const map = new TimeMap(segments)
    const translation = translationFor(tightened, spaced, ['uno.', 'dos.', 'tres.'])
    const events = translatedCaptionEvents(translation.lines, segments, tightened.edit.start, tightened.edit.end,
      { style, aspectRatio: 9 / 16, font, scale: 1 })
    expect(events.map((e) => e.start)).toEqual(translation.lines.map((l) => map.toOutput(l.start)))
    expect(events[events.length - 1].end).toBeLessThanOrEqual(map.outputDuration + 1e-9)
  })
})

describe('fonts for translated captions', () => {
  it('detects scripts', () => {
    expect(detectScript('Hola, ¿qué tal?')).toBe('latin')
    expect(detectScript('Xin chào các bạn, tôi là người Việt')).toBe('vietnamese')
    expect(detectScript('Привет, OpenAI')).toBe('cyrillic')
    expect(detectScript('مرحبا بكم في Cutawan')).toBe('arabic')
    expect(detectScript('שלום')).toBe('hebrew')
    expect(detectScript('東京へようこそ')).toBe('japanese')
    expect(detectScript('你好世界')).toBe('han')
    expect(detectScript('안녕하세요')).toBe('korean')
  })

  it('keeps the bundled font where it covers the script and falls back otherwise', () => {
    expect(translationFont('Anton', 'Hola amigos', 'linux').systemFallback).toBe(false)
    expect(translationFont('Anton', 'Xin chào các bạn', 'darwin').systemFallback).toBe(false)
    expect(translationFont('Poppins', 'Xin chào các bạn', 'darwin')).toMatchObject({ family: 'Helvetica Neue', systemFallback: true })
    expect(translationFont('Poppins', 'नमस्ते दोस्तों', 'win32').systemFallback).toBe(false)
    expect(translationFont('Anton', 'مرحبا', 'win32')).toMatchObject({ family: 'Segoe UI', systemFallback: true })
    expect(translationFont('Anton', '你好', 'darwin', 'zh-Hant').family).toBe('PingFang TC')
    expect(translationFont('Anton', '你好', 'linux', 'zh-Hans').family).toBe('Noto Sans CJK SC')
    // A custom upload is the user's choice; both renderers keep it.
    expect(translationFont('My Brand Font', 'مرحبا', 'linux').systemFallback).toBe(false)
  })

  it('puts the export face first in the preview stack', () => {
    const font = translationFont('Anton', 'مرحبا', 'linux')
    expect(translationCssFontStack(font)).toBe("'Noto Sans Arabic', 'DejaVu Sans', sans-serif")
  })
})

/** Translated Dialogue events of an ASS script: [start, end, text]. */
function translatedAssEvents(ass: string): Array<{ start: number; end: number; text: string; tags: string }> {
  const seconds = (v: string): number => {
    const [h, m, s] = v.split(':')
    return Number(h) * 3600 + Number(m) * 60 + Number(s)
  }
  return ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,') && l.includes('\\fn')).map((line) => {
    const parts = line.split(',')
    const rest = parts.slice(9).join(',')
    const match = rest.match(/^\{([^}]*)\}(.*)$/)!
    return { start: seconds(parts[1]), end: seconds(parts[2]), tags: match[1], text: match[2] }
  })
}

describe('preview and export agree on translated captions', () => {
  const spaced = makeTranscript([
    'So today I want to talk about something really important for creators.',
    'Most people get this completely wrong.',
    'Here is what actually works.'
  ], { sentenceGapSec: 2 })

  for (const mode of ['translated', 'both'] as const) {
    it(`draws the same cards at the same times (${mode})`, () => {
      const clip = makeClip(spaced, { tightenCuts: true, captionLanguage: mode, captionStyleId: 'karaoke' })
      clip.translation = translationFor(clip, spaced, [
        'Hoy quiero hablar de algo realmente importante para los creadores.',
        'La mayoría de la gente se equivoca por completo.',
        'Esto es lo que de verdad funciona.'
      ])
      const segments = clipKeptSegments(clip, spaced)
      const style = resolveCaptionStyle(clip.edit.captionStyleId)
      const width = 1080
      const height = 1920
      // The preview's plan, on the output timeline.
      const preview = translatedCaptionPlan(clip, spaced, segments, style, width / height, 'linux')!
      expect(preview.events.length).toBeGreaterThan(3)

      // The export: buildAss on the remapped transcript, as render.ts calls it.
      const map = new TimeMap(segments!)
      const ass = buildAss(spaced, {
        styleId: clip.edit.captionStyleId, width, height, clipStart: 0, clipEnd: map.outputDuration,
        translation: translatedCaptionPlan(clip, spaced, segments, style, width / height, 'linux')
      })
      const exported = translatedAssEvents(ass)
      expect(exported).toHaveLength(preview.events.length)
      exported.forEach((event, i) => {
        // ASS times are centiseconds, truncated.
        expect(Math.abs(event.start - preview.events[i].start)).toBeLessThan(0.011)
        expect(Math.abs(event.end - preview.events[i].end)).toBeLessThan(0.011)
        expect(event.text).toBe(preview.events[i].lines.join('\\N'))
        expect(event.tags).toContain(`\\pos(540,${Math.round(translatedCaptionY(style, mode, style.positionY) * height)})`)
        expect(event.tags).toContain(mode === 'both' ? '\\an8' : '\\an5')
      })
      const karaoke = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'))
      if (mode === 'translated') expect(karaoke).toHaveLength(0)
      else expect(karaoke.length).toBeGreaterThan(0)
    })
  }

  it('names the system fallback face in the ASS for a script the style font lacks', () => {
    const clip = makeClip(spaced, { captionLanguage: 'translated' })
    clip.translation = translationFor(clip, spaced, ['مرحبا بكم جميعا اليوم', 'معظم الناس يخطئون', 'هذا ما ينجح'])
    const style = resolveCaptionStyle('beast')
    const plan = translatedCaptionPlan(clip, spaced, null, style, 9 / 16, 'linux')!
    expect(plan.font.family).toBe('Noto Sans Arabic')
    expect(plan.events[0].rtl).toBe(true)
    const ass = buildAss(spaced, { styleId: 'beast', width: 1080, height: 1920, clipStart: 0, clipEnd: clip.edit.end, translation: plan })
    expect(translatedAssEvents(ass)[0].tags).toContain('\\fnNoto Sans Arabic')
  })
})
