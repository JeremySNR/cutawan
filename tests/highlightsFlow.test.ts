import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectHighlights } from '../src/main/pipeline/highlights'
import { analyzeClipBoundaries } from '@shared/clipMetrics'
import { transcriptSentences } from '@shared/sentences'
import { makeTranscript } from './helpers'

/**
 * Drives the whole highlight pass — model request, boundary snapping,
 * sentence completion, the ending review, dedupe — against a scripted model.
 * chatJSON goes through global fetch, so a stub that answers each schema by
 * name stands in for OpenAI; the requests it receives are kept so the test
 * can check what the model was shown.
 */

interface Captured {
  schema: string
  user: string
}

function chatReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('detectHighlights end to end (scripted model)', () => {
  // Twelve sentences of six words: each 2.3 s of speech, 0.4 s apart, so
  // sentence k starts at 2.7k and ends at 2.7k + 2.3.
  const transcript = makeTranscript(
    Array.from({ length: 12 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const VIDEO = transcript.durationSec + 5
  const captured: Captured[] = []
  let answers: Record<string, (body: Record<string, unknown>) => unknown>

  beforeEach(() => {
    captured.length = 0
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      captured.push({ schema, user: body.messages.find((m) => m.role === 'user')?.content ?? '' })
      const answer = answers[schema]
      if (!answer) throw new Error(`unexpected schema ${schema}`)
      return chatReply(answer(body as unknown as Record<string, unknown>))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const raw = (start: number, end: number, score: number, title = 'A clip') => ({
    start,
    end,
    title,
    hook: 'hook',
    summary: 'summary',
    payoff: 'payoff',
    virality_score: score,
    virality_reason: 'because',
    hashtags: ['a', 'b', 'c']
  })

  it('shows the model one sentence per line with timestamps', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(sentences[1].start, sentences[5].end, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: true, better_end: sentences[5].end, reason: 'lands' }] })
    }
    await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }, VIDEO)
    const request = captured.find((c) => c.schema === 'viral_clips')!
    const lines = request.user.split('\n').filter((l) => /^\[\d+\.\ds - \d+\.\ds\] /.test(l))
    expect(lines).toHaveLength(sentences.length)
    expect(lines[3]).toBe(`[${sentences[3].start.toFixed(1)}s - ${sentences[3].end.toFixed(1)}s] ${sentences[3].text}`)
  })

  it('keeps the duration cap after both ending review and sentence completion', async () => {
    const longTranscript = makeTranscript(
      Array.from({ length: 40 }, (_, i) => `sentence ${i} word three four five.`),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
    )
    answers = {
      viral_clips: () => ({ clips: [raw(0, 44, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: false, better_end: 80, reason: 'later payoff' }] })
    }
    const clips = await detectHighlights('key', 'model', longTranscript,
      { prompt: '', clipLength: 'short', broll: false, hookFirst: false, videoType: 'auto' }, longTranscript.durationSec)
    expect(clips).toHaveLength(1)
    expect(clips[0].edit.end - clips[0].edit.start).toBeLessThanOrEqual(45)
    expect(analyzeClipBoundaries(longTranscript, clips[0].edit.start, clips[0].edit.end).endsMidSentence).toBe(false)
  })

  it('lands mid-sentence model boundaries on sentence boundaries with pre- and post-roll', async () => {
    answers = {
      viral_clips: () => ({
        // 1 s into sentence 1, 0.5 s into sentence 5.
        clips: [raw(sentences[1].start + 1.0, sentences[5].start + 0.5, 80)]
      }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: true, better_end: 0, reason: 'lands' }] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }, VIDEO)
    expect(clip.suggestedStart).toBeCloseTo(sentences[1].start - 0.25, 5)
    // Half of the 0.5 s gap is available; the next sentence must stay out.
    expect(clip.suggestedEnd).toBeCloseTo(sentences[5].end + 0.25, 5)
    const report = analyzeClipBoundaries(transcript, clip.edit.start, clip.edit.end)
    expect(report.startsMidSentence).toBe(false)
    expect(report.endsMidSentence).toBe(false)
    expect(report.openingSentence).toBe(sentences[1].text)
    expect(report.closingSentence).toBe(sentences[5].text)
  })

  it('extends a clip whose ending the review judges as setup', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(sentences[2].start, sentences[6].end, 80)] }),
      clip_endings: () => ({
        endings: [{ index: 0, ends_with_payoff: false, better_end: sentences[7].end, reason: 'the payoff is the next line' }]
      })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }, VIDEO)
    expect(clip.suggestedEnd).toBeCloseTo(sentences[7].end + 0.25, 5)
    // The review saw the closing sentences tagged with their real end times.
    const review = captured.find((c) => c.schema === 'clip_endings')!
    expect(review.user).toContain(`[ends ${sentences[6].end.toFixed(1)}s] ${sentences[6].text}`)
    expect(review.user).toContain(`[ends ${sentences[7].end.toFixed(1)}s] ${sentences[7].text}`)
  })

  it('advances a clip opening onto its hook sentence when asked to', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(sentences[1].start, sentences[8].end, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: true, better_end: 0, reason: 'lands' }] }),
      clip_openings: () => ({
        starts: [{ index: 0, opens_with_hook: false, better_start: sentences[3].start, reason: 'throat clearing' }]
      })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: true, videoType: 'auto' }, VIDEO)
    expect(clip.suggestedStart).toBeCloseTo(sentences[3].start - 0.25, 5)
    const review = captured.find((c) => c.schema === 'clip_openings')!
    expect(review.user).toContain(`[starts ${sentences[1].start.toFixed(1)}s] ${sentences[1].text}`)
  })

  it('drops near-duplicate moments and keeps clips inside the video', async () => {
    answers = {
      viral_clips: () => ({
        clips: [
          raw(sentences[1].start, sentences[5].end, 90, 'winner'),
          raw(sentences[2].start, sentences[5].end, 70, 'dupe'),
          raw(sentences[7].start, VIDEO + 40, 60, 'overruns')
        ]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }, VIDEO)
    expect(clips.map((c) => c.title)).toEqual(['winner', 'overruns'])
    expect(clips[1].suggestedEnd).toBeLessThanOrEqual(VIDEO)
  })

  it('sums the rubric parts itself instead of trusting the model total', async () => {
    answers = {
      viral_clips: () => ({
        clips: [{
          ...raw(sentences[1].start, sentences[5].end, 95),
          // Out-of-scale parts are clamped to their own maximum first.
          score_parts: { hook: 40, emotion: 10, value: 5, structure: 15, shareability: 3 }
        }]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }, VIDEO)
    expect(clip.scoreBreakdown).toEqual({ hook: 30, emotion: 10, value: 5, structure: 15, shareability: 3 })
    expect(clip.viralityScore).toBe(63)
  })

  it('keeps the model total when a provider returns no usable parts', async () => {
    answers = {
      viral_clips: () => ({
        clips: [{ ...raw(sentences[1].start, sentences[5].end, 71), score_parts: { hook: 20 } }]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }, VIDEO)
    expect(clip.viralityScore).toBe(71)
    expect(clip.scoreBreakdown).toBeUndefined()
  })
})

describe('detectHighlights on a long transcript (scripted model)', () => {
  // 900 sentences of 2.7 s: a little over 40 minutes of speech.
  const transcript = makeTranscript(
    Array.from({ length: 900 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const VIDEO = transcript.durationSec
  const options = { prompt: '', clipLength: 'auto' as const, broll: false, hookFirst: true, videoType: 'auto' as const }
  let requests: Array<{ schema: string; user: string }>
  let inFlight: number
  let peak: number

  /** Start and end of the sentence lines a request showed the model. */
  const shownRange = (user: string): { from: number; to: number; lines: string[] } => {
    const lines = user.split('\n').filter((l) => /^\[\d+\.\ds - \d+\.\ds\] /.test(l))
    const time = (line: string, which: 1 | 2): number => Number(line.match(/^\[(\d+\.\d)s - (\d+\.\d)s\]/)![which])
    return { from: time(lines[0], 1), to: time(lines[lines.length - 1], 2), lines }
  }

  beforeEach(() => {
    requests = []
    inFlight = 0
    peak = 0
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      requests.push({ schema, user })
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      let payload: unknown
      if (schema === 'viral_clips') {
        // Three clips per window, each five sentences long, spread through
        // it and scored by where they sit so every clip is distinct.
        const { lines } = shownRange(user)
        const range = (index: number): [number, number] => {
          const first = sentences.find((s) => lines[index].endsWith(s.text))!
          return [first.start, sentences[first.index + 4].end]
        }
        payload = {
          clips: [10, Math.floor(lines.length / 2), lines.length - 10].map((index, n) => {
            const [start, end] = range(index)
            return {
              start, end, title: `clip at ${start.toFixed(1)}`, hook: 'hook', summary: 'summary', payoff: 'payoff',
              score_parts: { hook: 10 + n, emotion: 10, value: 10, structure: 10, shareability: Math.round(start) % 9 },
              virality_score: 0, virality_reason: 'because', hashtags: ['a']
            }
          })
        }
      } else if (schema === 'clip_endings') {
        payload = { endings: [] }
      } else {
        payload = { starts: [] }
      }
      return chatReply(payload)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('analyses the transcript in overlapping parts that together cover all of it', async () => {
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    const finds = requests.filter((r) => r.schema === 'viral_clips')
    expect(finds.length).toBeGreaterThan(1)
    const ranges = finds.map((r) => shownRange(r.user)).sort((a, b) => a.from - b.from)
    expect(ranges[0].from).toBeCloseTo(sentences[0].start, 1)
    expect(ranges[ranges.length - 1].to).toBeCloseTo(sentences[sentences.length - 1].end, 1)
    for (let i = 1; i < ranges.length; i++) {
      // Each part reaches back past the previous one by more than the longest clip.
      expect(ranges[i - 1].to - ranges[i].from).toBeGreaterThan(100)
    }
    for (const find of finds) expect(find.user).toMatch(/This is part \d+ of \d+ of the transcript/)
    // Every part contributed, and the merged list is ranked by score.
    expect(clips.length).toBe(finds.length * 3)
    expect(clips.map((c) => c.viralityScore)).toEqual([...clips.map((c) => c.viralityScore)].sort((a, b) => b - a))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('reviews endings and openings in small batches', async () => {
    await detectHighlights('key', 'model', transcript, options, VIDEO)
    for (const schema of ['clip_endings', 'clip_openings']) {
      const reviews = requests.filter((r) => r.schema === schema)
      expect(reviews.length).toBeGreaterThan(1)
      for (const review of reviews) {
        const judged = review.user.split('\n').filter((l) => /^Clip \d+ — /.test(l))
        expect(judged.length).toBeLessThanOrEqual(8)
        // Indices restart in every batch, so a verdict cannot land on another batch's clip.
        expect(judged[0]).toMatch(/^Clip 0 — /)
      }
    }
  })

  it('reports progress as parts finish', async () => {
    const seen: Array<{ fraction: number; message: string }> = []
    await detectHighlights('key', 'model', transcript, options, VIDEO, undefined, (p) => seen.push(p))
    const fractions = seen.map((p) => p.fraction)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(fractions[fractions.length - 1]).toBe(1)
    expect(seen.some((p) => /\(\d+\/\d+\)/.test(p.message))).toBe(true)
  })
})
