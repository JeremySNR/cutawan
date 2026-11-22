import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Clip, Transcript } from '@shared/types'
import { playedSentences } from '@shared/captionTranslation'
import { makeTranscript } from './helpers'
import { buildTranslationMessages, landTranslation, normaliseTerms, translateClip, translationWarnings } from '../src/main/pipeline/translate'

const SENTENCES = [
  'Hi, I am Jeremy from Cutawan.',
  'We grew 300 percent last year.',
  'Here is how it works.',
  'Thanks for watching.'
]

function makeClip(transcript: Transcript): Clip {
  return {
    id: 'c', title: 'Growth story', hook: '', summary: 'How a tool grew', suggestedStart: 0, suggestedEnd: transcript.durationSec,
    viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
    edit: {
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5,
      captionsEnabled: true, captionStyleId: 'beast', showTitle: false, start: 0, end: transcript.durationSec
    }
  }
}

const transcript = makeTranscript(SENTENCES)
const sentences = playedSentences(makeClip(transcript), transcript)

describe('landTranslation', () => {
  it('lands each numbered line on its sentence and keeps the original slot', () => {
    const lines = landTranslation(sentences, { lines: SENTENCES.map((_, i) => ({ n: i + 1, text: `ES ${i + 1}` })) })
    expect(lines.map((l) => l.text)).toEqual(['ES 1', 'ES 2', 'ES 3', 'ES 4'])
    lines.forEach((line, i) => {
      expect(line.start).toBe(sentences[i].start)
      expect(line.end).toBe(sentences[i].end)
      expect(line.source).toBe(SENTENCES[i])
    })
  })

  it('keeps the original text for lines the model skipped or left empty', () => {
    const lines = landTranslation(sentences, { lines: [{ n: 1, text: 'Uno' }, { n: 3, text: '   ' }, { n: 4, text: 'Cuatro' }] })
    expect(lines.map((l) => l.text)).toEqual(['Uno', SENTENCES[1], SENTENCES[2], 'Cuatro'])
    expect(lines.map((l) => Boolean(l.untranslated))).toEqual([false, true, true, false])
  })

  it('ignores extra lines and numbers out of range', () => {
    const lines = landTranslation(sentences, {
      lines: [{ n: 1, text: 'Uno' }, { n: 2, text: 'Dos' }, { n: 3, text: 'Tres' }, { n: 4, text: 'Cuatro' }, { n: 5, text: 'Cinco' }, { n: 0, text: 'Cero' }]
    })
    expect(lines.map((l) => l.text)).toEqual(['Uno', 'Dos', 'Tres', 'Cuatro'])
  })

  it('matches by position when the count is right but the numbering is off', () => {
    const zeroBased = landTranslation(sentences, { lines: [0, 1, 2, 3].map((n) => ({ n, text: `L${n}` })) })
    expect(zeroBased.map((l) => l.text)).toEqual(['L0', 'L1', 'L2', 'L3'])
    const continued = landTranslation(sentences, { lines: [11, 12, 13, 14].map((n) => ({ n, text: `L${n}` })) })
    expect(continued.map((l) => l.text)).toEqual(['L11', 'L12', 'L13', 'L14'])
  })

  it('matches by number when the numbers are in range but out of order or repeated', () => {
    const swapped = landTranslation(sentences, { lines: [2, 1, 4, 3].map((n) => ({ n, text: `L${n}` })) })
    expect(swapped.map((l) => l.text)).toEqual(['L1', 'L2', 'L3', 'L4'])
    const repeated = landTranslation(sentences, { lines: [1, 3, 3, 4].map((n, i) => ({ n, text: `L${i}` })) })
    expect(repeated.map((l) => l.text)).toEqual(['L0', SENTENCES[1], 'L1', 'L3'])
    expect(repeated.map((l) => Boolean(l.untranslated))).toEqual([false, true, false, false])
  })

  it('keeps the first of duplicated numbers, accepts numeric strings and strips an echoed number', () => {
    const lines = landTranslation(sentences, {
      lines: [{ n: '1', text: '1. Uno' }, { n: 1, text: 'Otra vez' }, { n: 2, text: 'Dos' }]
    })
    expect(lines.map((l) => l.text)).toEqual(['Uno', 'Dos', SENTENCES[2], SENTENCES[3]])
  })

  it('survives a malformed reply', () => {
    const lines = landTranslation(sentences, { lines: 'nope' as unknown as [] })
    expect(lines.every((l) => l.untranslated)).toBe(true)
  })

  it('flags protected terms and numbers the translation lost', () => {
    const lines = landTranslation(sentences, {
      lines: [
        { n: 1, text: 'Hola, soy Jeremy de Cortawan.' },
        { n: 2, text: 'Crecimos un trescientos por ciento.' },
        { n: 3, text: 'Así funciona.' },
        { n: 4, text: 'Gracias por ver.' }
      ]
    }, ['Cutawan', 'Jeremy'])
    expect(lines[0].warnings).toEqual(['“Cutawan” changed'])
    expect(lines[1].warnings).toEqual(['number 300 missing'])
    expect(lines[2].warnings).toBeUndefined()
  })
})

describe('the translation prompt', () => {
  it('numbers the played sentences and lists the protected terms', () => {
    const messages = buildTranslationMessages(makeClip(transcript), sentences, { before: 'Previously.' },
      { language: 'German', doNotTranslate: ['Cutawan', ' cutawan ', '', 'Jeremy'] })
    const user = String(messages[1].content)
    expect(user).toContain('Target language: German')
    expect(user).toContain('1. Hi, I am Jeremy from Cutawan.\n2. We grew 300 percent last year.')
    expect(user).toContain('- Cutawan\n- Jeremy')
    expect(user).not.toContain('- cutawan')
    expect(user).toContain('Said just before the clip (context only, do not translate): "Previously."')
    expect(String(messages[0].content)).toMatch(/Never merge, split, reorder or drop lines/)
  })

  it('normalises terms', () => {
    expect(normaliseTerms(['  a  b ', 'A B', 'c'])).toEqual(['a b', 'c'])
  })

  it('does not warn about numbers kept as digits', () => {
    expect(translationWarnings('In 2024 we had 3 wins', 'En 2024 tuvimos 3 victorias', [])).toEqual([])
  })
})

describe('translateClip with a scripted model', () => {
  afterEach(() => vi.unstubAllGlobals())

  function scriptedModel(reply: (userPrompt: string) => unknown): { calls: () => number } {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }
      const content = JSON.stringify(reply(body.messages[1].content))
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    return { calls: () => calls }
  }

  it('makes one request and returns a translation awaiting review', async () => {
    const model = scriptedModel((prompt) => ({
      lines: prompt.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => {
        const n = Number(l.split('.')[0])
        return { n, text: `[de] ${l.slice(l.indexOf(' ') + 1)}` }
      })
    }))
    const clip = makeClip(transcript)
    const result = await translateClip('sk-test', 'gpt-test', clip, transcript, { language: 'German', doNotTranslate: ['Cutawan'] })
    expect(model.calls()).toBe(1)
    expect(result).toMatchObject({ language: 'German', languageCode: 'de', accepted: false, edited: false, doNotTranslate: ['Cutawan'] })
    expect(result.lines.map((l) => l.text)).toEqual(SENTENCES.map((s) => `[de] ${s}`))
  })

  it('refuses an empty reply instead of storing an untranslated copy', async () => {
    scriptedModel(() => ({ lines: [] }))
    await expect(translateClip('sk-test', 'gpt-test', makeClip(transcript), transcript, { language: 'French' }))
      .rejects.toThrow(/came back empty/)
  })

  it('needs a language and some speech', async () => {
    scriptedModel(() => ({ lines: [] }))
    await expect(translateClip('k', 'm', makeClip(transcript), transcript, { language: '  ' })).rejects.toThrow(/Choose a language/)
    const silent: Transcript = { language: 'en', durationSec: 10, segments: [] }
    await expect(translateClip('k', 'm', makeClip(silent), silent, { language: 'French' })).rejects.toThrow(/no spoken words/)
  })
})
