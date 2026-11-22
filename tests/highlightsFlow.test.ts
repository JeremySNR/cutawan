import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectHighlights } from '../src/main/pipeline/highlights'
import { analyzeClipBoundaries } from '@shared/clipMetrics'
import { transcriptSentences } from '@shared/sentences'
import { selectedDuration, selectedRanges } from '@shared/clipSegments'
import { clipKeptSegments } from '@shared/tighten'
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

  /** A clip as the model is asked to give it: first and last line numbers. */
  const raw = (startLine: number, endLine: number, score: number, title = 'A clip') => ({
    start_line: startLine,
    end_line: endLine,
    title,
    hook: 'hook',
    summary: 'summary',
    payoff: 'payoff',
    virality_score: score,
    virality_reason: 'because',
    hashtags: ['a', 'b', 'c']
  })
  /** The same clip in seconds, as a provider that ignores the schema answers. */
  const rawSec = (start: number, end: number, score: number, title = 'A clip') => {
    const { start_line: _s, end_line: _e, ...rest } = raw(0, 0, score, title)
    return { ...rest, start, end }
  }
  const options = { prompt: '', clipLength: 'auto' as const, broll: false, hookFirst: false, videoType: 'auto' as const }
  const selections = () => captured.filter((c) => c.schema === 'viral_clips')

  it('shows the model one numbered sentence per line with timestamps', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(1, 5, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: true, better_end_line: 5, reason: 'lands' }] })
    }
    await detectHighlights('key', 'model', transcript, options, VIDEO)
    const request = captured.find((c) => c.schema === 'viral_clips')!
    const lines = request.user.split('\n').filter((l) => /^#\d+ \[\d+\.\ds - \d+\.\ds\] /.test(l))
    expect(lines).toHaveLength(sentences.length)
    expect(lines[3]).toBe(`#3 [${sentences[3].start.toFixed(1)}s - ${sentences[3].end.toFixed(1)}s] ${sentences[3].text}`)
    expect(request.user).toContain('"start_line"')
  })

  it('maps line numbers to the exact sentence start and end, with pre- and post-roll', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(1, 5, 80)] }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.suggestedStart).toBeCloseTo(sentences[1].start - 0.25, 5)
    // Half of the 0.5 s gap on either side; the neighbouring sentences stay out.
    expect(clip.suggestedEnd).toBeCloseTo(sentences[5].end + 0.25, 5)
    const report = analyzeClipBoundaries(transcript, clip.edit.start, clip.edit.end)
    expect(report.openingSentence).toBe(sentences[1].text)
    expect(report.closingSentence).toBe(sentences[5].text)
    // A clean answer is not sent back for repair, and one window needs no comparative rerank.
    expect(selections()).toHaveLength(1)
    expect(captured.map((c) => c.schema)).toEqual(['viral_clips', 'clip_endings'])
  })

  it('accepts line numbers sent as strings by a non-strict provider', async () => {
    answers = {
      viral_clips: () => ({ clips: [{ ...raw(0, 0, 80), start_line: '#2', end_line: '6' }] }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(analyzeClipBoundaries(transcript, clip.edit.start, clip.edit.end).openingSentence).toBe(sentences[2].text)
    expect(analyzeClipBoundaries(transcript, clip.edit.start, clip.edit.end).closingSentence).toBe(sentences[6].text)
  })

  it('keeps the duration cap after both ending review and sentence completion', async () => {
    const longTranscript = makeTranscript(
      Array.from({ length: 40 }, (_, i) => `sentence ${i} word three four five.`),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
    )
    answers = {
      // Lines 0-21 run about 60 s, past a short clip's 56 s ceiling: one
      // repair is asked for, the same answer comes back, and the clip is
      // trimmed back to the last sentence that fits.
      viral_clips: () => ({ clips: [raw(0, 21, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: false, better_end_line: 29, reason: 'later payoff' }] })
    }
    const clips = await detectHighlights('key', 'model', longTranscript,
      { ...options, clipLength: 'short' }, longTranscript.durationSec)
    expect(clips).toHaveLength(1)
    expect(clips[0].edit.end - clips[0].edit.start).toBeLessThanOrEqual(56)
    expect(analyzeClipBoundaries(longTranscript, clips[0].edit.start, clips[0].edit.end).endsMidSentence).toBe(false)
    expect(selections()).toHaveLength(2)
    expect(selections()[1].user).toMatch(/1\. Clip 1 \("A clip"\) runs about 6\d seconds; the limit is 56 seconds\./)
  })

  it('keeps a clip that runs a little past its target whole, ranks it lower and says why', async () => {
    const longTranscript = makeTranscript(
      Array.from({ length: 40 }, (_, i) => `sentence ${i} word three four five.`),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
    )
    answers = {
      // Lines 0-16 play about 47 s: past a short clip's 45 s target, inside its 56 s ceiling.
      viral_clips: () => ({ clips: [raw(0, 16, 80), raw(20, 27, 70)] }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', longTranscript,
      { ...options, clipLength: 'short' }, longTranscript.durationSec)
    // No repair request: nothing broke a rule.
    expect(selections()).toHaveLength(1)
    const long = clips.find((c) => c.edit.start < 1)!
    // Whole: it still ends on line 16, not trimmed back to fit 45 s.
    expect(long.edit.end).toBeGreaterThan(longTranscript.segments[16].end)
    expect(long.edit.end - long.edit.start).toBeGreaterThan(45)
    // 80 before; 47 s is about 5% over, so it loses 2 points, from structure.
    expect(long.viralityScore).toBe(78)
    expect(long.viralityReason).toMatch(/Runs 4\d seconds, past the 45-second target for this length; kept whole rather than cut short\./)
    const fits = clips.find((c) => c !== long)!
    expect(fits.viralityScore).toBe(70)
    expect(fits.viralityReason).not.toMatch(/Runs/)
  })

  it('falls back to snapping seconds from a provider that ignores line numbers', async () => {
    answers = {
      viral_clips: () => ({
        // 1 s into sentence 1, 0.5 s into sentence 5.
        clips: [rawSec(sentences[1].start + 1.0, sentences[5].start + 0.5, 80)]
      }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: true, better_end: 0, reason: 'lands' }] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.suggestedStart).toBeCloseTo(sentences[1].start - 0.25, 5)
    expect(clip.suggestedEnd).toBeCloseTo(sentences[5].end + 0.25, 5)
    const report = analyzeClipBoundaries(transcript, clip.edit.start, clip.edit.end)
    expect(report.startsMidSentence).toBe(false)
    expect(report.endsMidSentence).toBe(false)
    expect(report.openingSentence).toBe(sentences[1].text)
    expect(report.closingSentence).toBe(sentences[5].text)
    expect(selections()).toHaveLength(1)
  })

  it('extends a clip whose ending the review judges as setup', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(2, 6, 80)] }),
      clip_endings: () => ({
        endings: [{ index: 0, ends_with_payoff: false, better_end_line: 7, reason: 'the payoff is the next line' }]
      })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.suggestedEnd).toBeCloseTo(sentences[7].end + 0.25, 5)
    // The review saw the closing sentences numbered and tagged with their real end times.
    const review = captured.find((c) => c.schema === 'clip_endings')!
    expect(review.user).toContain(`currently ends on line #6 at`)
    expect(review.user).toContain(`#6 [ends ${sentences[6].end.toFixed(1)}s] ${sentences[6].text}`)
    expect(review.user).toContain(`#7 [ends ${sentences[7].end.toFixed(1)}s] ${sentences[7].text}`)
  })

  it('ignores an ending verdict naming a line that was not tagged for the clip', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(2, 6, 80)] }),
      // Line 3 plays in the clip but is not among its three tagged closing lines.
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: false, better_end_line: 3, reason: 'earlier' }] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.suggestedEnd).toBeCloseTo(sentences[6].end + 0.25, 5)
  })

  it('still takes an ending in seconds from a provider that ignores the schema', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(2, 6, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: false, better_end: sentences[7].end - 0.3, reason: 'next line' }] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.suggestedEnd).toBeCloseTo(sentences[7].end + 0.25, 5)
  })

  it('advances a clip opening onto its hook sentence when asked to', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(1, 8, 80)] }),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: true, better_end_line: 8, reason: 'lands' }] }),
      clip_openings: () => ({
        starts: [{ index: 0, opens_with_hook: false, better_start_line: 3, reason: 'throat clearing' }]
      })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { ...options, hookFirst: true }, VIDEO)
    expect(clip.suggestedStart).toBeCloseTo(sentences[3].start - 0.25, 5)
    const review = captured.find((c) => c.schema === 'clip_openings')!
    expect(review.user).toContain(`#1 [starts ${sentences[1].start.toFixed(1)}s] ${sentences[1].text}`)
  })

  it('ignores an opening verdict naming a line it was not shown, and accepts one in seconds', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(1, 8, 80)] }),
      clip_endings: () => ({ endings: [] }),
      clip_openings: () => ({ starts: [{ index: 0, opens_with_hook: false, better_start_line: 10, reason: 'far' }] })
    }
    const [held] = await detectHighlights('key', 'model', transcript, { ...options, hookFirst: true }, VIDEO)
    expect(held.suggestedStart).toBeCloseTo(sentences[1].start - 0.25, 5)

    answers.clip_openings = () => ({ starts: [{ index: 0, opens_with_hook: false, better_start: sentences[3].start + 0.4, reason: 'seconds' }] })
    const [moved] = await detectHighlights('key', 'model', transcript, { ...options, hookFirst: true }, VIDEO)
    expect(moved.suggestedStart).toBeCloseTo(sentences[3].start - 0.25, 5)
  })

  it('drops near-duplicate moments and keeps clips inside the video', async () => {
    answers = {
      viral_clips: () => ({
        clips: [
          raw(1, 5, 90, 'winner'),
          raw(2, 5, 70, 'dupe'),
          // One clip of the reply in seconds, past the end of the video.
          rawSec(sentences[7].start, VIDEO + 40, 60, 'overruns')
        ]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clips.map((c) => c.title)).toEqual(['winner', 'overruns'])
    expect(clips[1].suggestedEnd).toBeLessThanOrEqual(VIDEO)
  })

  it('sums the rubric parts itself instead of trusting the model total', async () => {
    answers = {
      viral_clips: () => ({
        clips: [{
          ...raw(1, 5, 95),
          // Out-of-scale parts are clamped to their own maximum first.
          score_parts: { hook: 40, emotion: 10, value: 5, structure: 15, shareability: 3 }
        }]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.scoreBreakdown).toEqual({ hook: 30, emotion: 10, value: 5, structure: 15, shareability: 3 })
    expect(clip.viralityScore).toBe(63)
  })

  it('keeps the model total when a provider returns no usable parts', async () => {
    answers = {
      viral_clips: () => ({
        clips: [{ ...raw(1, 5, 71), score_parts: { hook: 20 } }]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.viralityScore).toBe(71)
    expect(clip.scoreBreakdown).toBeUndefined()
  })
})

describe('detectHighlights repairing a selection that breaks the rules (scripted model)', () => {
  const transcript = makeTranscript(
    Array.from({ length: 20 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const VIDEO = transcript.durationSec + 5
  const options = { prompt: '', clipLength: 'auto' as const, broll: false, hookFirst: false, videoType: 'auto' as const }
  let selections: string[]
  let replies: Array<unknown | Response>

  const raw = (startLine: unknown, endLine: unknown, title: string, hook = 20) => ({
    start_line: startLine, end_line: endLine, title, hook: 'hook', summary: 'summary', payoff: 'payoff',
    score_parts: { hook, emotion: 10, value: 10, structure: 10, shareability: 5 },
    virality_score: 0, virality_reason: 'because', hashtags: ['a']
  })

  beforeEach(() => {
    selections = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      if (schema === 'clip_endings') return chatReply({ endings: [] })
      if (schema !== 'viral_clips') throw new Error(`unexpected schema ${schema}`)
      selections.push(body.messages.find((m) => m.role === 'user')?.content ?? '')
      const reply = replies[Math.min(selections.length - 1, replies.length - 1)]
      return reply instanceof Response ? reply : chatReply(reply)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never lands a line it did not show, and asks once for a corrected list naming the problem', async () => {
    replies = [
      { clips: [raw(1, 5, 'fine'), raw(8, 99, 'unknown end'), raw(14, 11, 'backwards')] },
      { clips: [raw(1, 5, 'fine'), raw(8, 12, 'fixed'), raw(14, 18, 'also fixed')] }
    ]
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(selections).toHaveLength(2)
    const repair = selections[1]
    // The repair repeats the numbered transcript and shows the previous answer.
    expect(repair).toContain(`#3 [${sentences[3].start.toFixed(1)}s`)
    expect(repair).toContain('"end_line":99')
    expect(repair).toContain('1. Clip 2 ("unknown end") ends on line #99, which is not one of the numbered lines you were given.')
    expect(repair).toContain('2. Clip 3 ("backwards") ends on line #11, before the line it starts on (#14).')
    expect(repair).toContain('Return the full corrected list of clips')
    expect(clips.map((c) => c.title).sort()).toEqual(['also fixed', 'fine', 'fixed'])
  })

  it('keeps the first answer when the correction is no better', async () => {
    replies = [
      { clips: [raw(1, 5, 'first'), raw(8, 99, 'unknown')] },
      // One violation each: a tie goes to the first answer.
      { clips: [raw(1, 5, 'second'), raw(8, 98, 'still unknown')] }
    ]
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(selections).toHaveLength(2)
    expect(clips.map((c) => c.title)).toEqual(['first'])
  })

  it('takes a correction with as many problems when the first answer had nothing usable', async () => {
    replies = [
      { clips: [raw(1, 99, 'unknown'), raw(8, 98, 'also unknown')] },
      { clips: [raw(1, 5, 'usable'), raw(8, 97, 'still unknown'), raw(14, 96, 'new unknown')] }
    ]
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clips.map((c) => c.title)).toEqual(['usable'])
  })

  it('does not accept a correction that drops usable clips to get rid of its problems', async () => {
    replies = [
      { clips: [raw(1, 5, 'one'), raw(8, 12, 'two'), raw(14, 99, 'unknown')] },
      { clips: [] }
    ]
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clips.map((c) => c.title).sort()).toEqual(['one', 'two'])
  })

  it('keeps the first answer when the repair request fails', async () => {
    replies = [
      { clips: [raw(1, 5, 'kept'), raw(8, 99, 'unknown')] },
      new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
    ]
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(error.mock.calls.some((call) => String(call[0]).includes('repair request failed'))).toBe(true)
    error.mockRestore()
    expect(selections).toHaveLength(2)
    expect(clips.map((c) => c.title)).toEqual(['kept'])
  })

  it('still stops when the run is cancelled during the repair request', async () => {
    const controller = new AbortController()
    replies = [{ clips: [raw(1, 5, 'kept'), raw(8, 99, 'unknown')] }]
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format: { json_schema: { name: string } } }
      if (body.response_format.json_schema.name !== 'viral_clips') return chatReply({ endings: [] })
      selections.push('')
      if (selections.length === 1) return chatReply(replies[0])
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(detectHighlights('key', 'model', transcript, options, VIDEO, controller.signal)).rejects.toThrow()
    error.mockRestore()
  })

  it('does not ask for a repair when the answer is clean, or broken past repair', async () => {
    replies = [{ clips: [raw(1, 5, 'clean')] }]
    await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(selections).toHaveLength(1)

    selections = []
    // Thirteen unknown lines: not a few slips, so no second request.
    replies = [{ clips: [raw(1, 5, 'clean'), ...Array.from({ length: 13 }, (_, i) => raw(200 + i, 300 + i, `bad ${i}`))] }]
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(selections).toHaveLength(1)
    expect(clips.map((c) => c.title)).toEqual(['clean'])
  })

  it('reports a clip under the minimum length and a span with no lines', async () => {
    replies = [
      { clips: [raw(1, 5, 'fine'), raw(9, 9, 'one line'), { ...raw(undefined, undefined, 'no span') }, raw(12, 'twelve', 'garbled')] },
      { clips: [raw(1, 5, 'fine')] }
    ]
    await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(selections[1]).toContain('Clip 2 ("one line") runs about 3 seconds; clips must be at least 8 seconds.')
    expect(selections[1]).toContain('Clip 3 ("no span") has no start_line and end_line.')
    expect(selections[1]).toContain('Clip 4 ("garbled") ends on line "twelve", which is not one of the numbered lines you were given.')
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
  let rerank: (user: string) => unknown | Response

  /** Start and end of the sentence lines a request showed the model. */
  const shownRange = (user: string): { from: number; to: number; lines: string[] } => {
    const lines = user.split('\n').filter((l) => /^#\d+ \[\d+\.\ds - \d+\.\ds\] /.test(l))
    const time = (line: string, which: 1 | 2): number => Number(line.match(/^#\d+ \[(\d+\.\d)s - (\d+\.\d)s\]/)![which])
    return { from: time(lines[0], 1), to: time(lines[lines.length - 1], 2), lines }
  }

  beforeEach(() => {
    requests = []
    inFlight = 0
    peak = 0
    rerank = () => ({ scores: [] })
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
        payload = {
          clips: [10, Math.floor(lines.length / 2), lines.length - 10].map((index, n) => {
            const first = Number(lines[index].match(/^#(\d+)/)![1])
            const start = sentences[first].start
            return {
              start_line: first, end_line: first + 4, title: `clip at ${start.toFixed(1)}`, hook: 'hook', summary: 'summary', payoff: 'payoff',
              score_parts: { hook: 10 + n, emotion: 10, value: 10, structure: 10, shareability: Math.round(start) % 9 },
              virality_score: 0, virality_reason: 'because', hashtags: ['a']
            }
          })
        }
      } else if (schema === 'clip_endings') {
        payload = { endings: [] }
      } else if (schema === 'clip_rerank') {
        payload = rerank(user)
      } else {
        payload = { starts: [] }
      }
      return payload instanceof Response ? payload : chatReply(payload)
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
    expect(seen.some((p) => p.message === 'Comparing clips across the video…')).toBe(true)
  })

  /** Candidate lines of a rerank request: "Candidate N — "title" (Ns):" then its text. */
  const candidates = (user: string): Array<{ index: number; title: string; text: string }> => {
    const lines = user.split('\n')
    return lines.flatMap((line, i) => {
      const match = line.match(/^Candidate (\d+) — "(.*)" \(\d+s(?:, [^)]*)?\):$/)
      return match ? [{ index: Number(match[1]), title: match[2], text: lines[i + 1].trim() }] : []
    })
  }

  it('puts every merged candidate side by side in one comparative request and applies its scores', async () => {
    let shown: Array<{ index: number; title: string; text: string }> = []
    rerank = (user) => {
      shown = candidates(user)
      // Reverse the first-pass order, and leave the last candidate unscored.
      return {
        scores: shown.slice(0, -1).map((c) => ({ index: c.index, score: 20 + c.index * 2, reason: 'compared' }))
      }
    }
    const firstPass = await (async () => {
      const saved = rerank
      rerank = () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
      error.mockRestore()
      rerank = saved
      return clips
    })()
    requests = []
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    const reranks = requests.filter((r) => r.schema === 'clip_rerank')
    expect(reranks).toHaveLength(1)
    // It comes after every other request: it judges the clips as they finally play.
    expect(requests[requests.length - 1].schema).toBe('clip_rerank')
    expect(reranks[0].user).toContain('against the others')
    expect(shown).toHaveLength(clips.length)
    // The text shown is what plays: five sentences of the clip, nothing around it.
    const first = shown[0]
    const opening = Number(first.text.match(/^sentence (\d+) /)![1])
    expect(first.text).toBe(Array.from({ length: 5 }, (_, k) => sentences[opening + k].text).join(' '))

    const unscored = shown[shown.length - 1]
    for (const clip of clips) {
      const candidate = shown.find((c) => c.title === clip.title)!
      if (candidate === unscored) {
        expect(clip.viralityScore).toBe(firstPass.find((c) => c.title === clip.title)!.viralityScore)
        continue
      }
      expect(clip.viralityScore).toBe(20 + candidate.index * 2)
      // The parts are rescaled to add up to the new total.
      const parts = clip.scoreBreakdown!
      expect(parts.hook + parts.emotion + parts.value + parts.structure + parts.shareability).toBe(clip.viralityScore)
    }
    expect(clips.map((c) => c.viralityScore)).toEqual([...clips.map((c) => c.viralityScore)].sort((a, b) => b - a))
  })

  it('keeps the first-pass scores when the comparative request fails', async () => {
    rerank = () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(error.mock.calls.some((call) => String(call[0]).includes('rerank failed'))).toBe(true)
    error.mockRestore()
    expect(requests.filter((r) => r.schema === 'clip_rerank')).toHaveLength(1)
    // First-pass scores: hook 10-12 + 30 + shareability.
    for (const clip of clips) expect(clip.viralityScore).toBeGreaterThanOrEqual(40)
    expect(clips.length).toBe(requests.filter((r) => r.schema === 'viral_clips').length * 3)
  })
})

describe('detectHighlights joining separate moments (scripted model)', () => {
  // Sixty sentences of 2.7 s: sentence k starts at 2.7k.
  const transcript = makeTranscript(
    Array.from({ length: 60 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(transcript)
  const VIDEO = transcript.durationSec + 5
  const options = { prompt: '', clipLength: 'auto' as const, broll: false, hookFirst: false, videoType: 'auto' as const, stitch: true }
  interface Request { schema: string; system: string; user: string; format: { json_schema: { schema: { properties: { clips: { items: { properties: Record<string, unknown> } } } } } } }
  let requests: Request[]
  let answers: Record<string, () => unknown | Response>

  beforeEach(() => {
    requests = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: Request['format'] & { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      requests.push({
        schema, format: body.response_format,
        system: body.messages.find((m) => m.role === 'system')?.content ?? '',
        user: body.messages.find((m) => m.role === 'user')?.content ?? ''
      })
      const answer = answers[schema]
      if (!answer) throw new Error(`unexpected schema ${schema}`)
      const payload = answer()
      return payload instanceof Response ? payload : chatReply(payload)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const span = (from: number, to: number) => ({ start_line: from, end_line: to })
  const joined = (segments: Array<Record<string, number>>, title: string, shareability = 5) => ({
    segments, join_reason: 'skips a tangent', title, hook: 'hook', summary: 'summary', payoff: 'payoff',
    score_parts: { hook: 20, emotion: 15, value: 10, structure: 10, shareability },
    virality_score: 0, virality_reason: 'because', hashtags: ['a']
  })
  const pass = (count: number) => ({
    clips: Array.from({ length: count }, (_, index) => ({ index, seamless: true, faithful: true, reason: 'follows' }))
  })

  it('asks for parts only when joining is on', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(2, 6)], 'continuous')] }),
      clip_endings: () => ({ endings: [] })
    }
    await detectHighlights('key', 'model', transcript, options, VIDEO)
    const on = requests.find((r) => r.schema === 'viral_clips')!
    expect(Object.keys(on.format.json_schema.schema.properties.clips.items.properties)).toContain('segments')
    expect(on.user).toContain('Give each segment as the number of the line it opens on')
    expect(on.system).toContain('Never change what a speaker meant')

    requests = []
    answers.viral_clips = () => ({ clips: [{ ...joined([], 'continuous'), segments: undefined, ...span(2, 6) }] })
    await detectHighlights('key', 'model', transcript, { ...options, stitch: false }, VIDEO)
    const off = requests.find((r) => r.schema === 'viral_clips')!
    const fields = Object.keys(off.format.json_schema.schema.properties.clips.items.properties)
    expect(fields).toContain('start_line')
    expect(fields).toContain('end_line')
    expect(fields).not.toContain('start')
    expect(fields).not.toContain('segments')
    expect(off.system).not.toContain('Joining moments')
    // No joined clips, so no join review either.
    expect(requests.some((r) => r.schema === 'clip_joins')).toBe(false)
  })

  it('builds a joined clip as one trim with the skipped stretch cut out', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(2, 5), span(40, 44)], 'question and answer')] }),
      clip_joins: () => pass(1),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.stitch?.reason).toBe('skips a tangent')
    expect(clip.suggestedStart).toBeCloseTo(sentences[2].start - 0.25, 5)
    expect(clip.suggestedEnd).toBeCloseTo(sentences[44].end + 0.25, 5)
    const ranges = selectedRanges(clip.edit)
    expect(ranges).toHaveLength(2)
    // Each part lands on sentence boundaries with its own roll.
    expect(ranges[0].end).toBeCloseTo(sentences[5].end + 0.25, 5)
    expect(ranges[1].start).toBeCloseTo(sentences[40].start - 0.25, 5)
    expect(selectedDuration(clip.edit)).toBeLessThan(30)
    // What plays is exactly the two moments: nothing from the skipped lines.
    const kept = clipKeptSegments(clip, transcript)!
    const spoken = transcript.segments.flatMap((seg) => seg.words)
      .filter((w) => kept.some((r) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 <= r.end))
      .map((w) => w.text).join(' ')
    expect(spoken).toContain('sentence 2 ')
    expect(spoken).toContain('sentence 44 ')
    expect(spoken).not.toContain('sentence 6 ')
    expect(spoken).not.toContain('sentence 39 ')
  })

  it('shows the join review what plays either side and what was skipped', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(2, 5), span(40, 44)], 'question and answer')] }),
      clip_joins: () => pass(1),
      clip_endings: () => ({ endings: [] })
    }
    await detectHighlights('key', 'model', transcript, options, VIDEO)
    const review = requests.find((r) => r.schema === 'clip_joins')!
    expect(review.user).toMatch(/Plays before: .*sentence 5 word three four five\./)
    expect(review.user).toMatch(/Skipped: sentence 6 word/)
    expect(review.user).toMatch(/Plays after: sentence 40 word/)
    expect(review.user).toContain('skips a tangent')
    // The ending review reads the clip as it plays, without the skipped lines.
    const ending = requests.find((r) => r.schema === 'clip_endings')!
    expect(ending.user).not.toContain('sentence 20 ')
    expect(ending.user).toContain(`[ends ${sentences[44].end.toFixed(1)}s] ${sentences[44].text}`)
  })

  it('keeps a joined clip only on an explicit pass', async () => {
    answers = {
      viral_clips: () => ({
        clips: [
          joined([span(0, 3), span(20, 23)], 'unfaithful', 9),
          joined([span(5, 8), span(26, 29)], 'not seamless', 8),
          joined([span(10, 13), span(32, 35)], 'no verdict', 7),
          joined([span(15, 18), span(38, 41)], 'passes', 6),
          joined([span(50, 55)], 'continuous', 1)
        ]
      }),
      clip_joins: () => ({
        clips: [
          { index: 0, seamless: true, faithful: false, reason: 'drops a qualification' },
          { index: 1, seamless: false, faithful: true, reason: 'the answer leans on a skipped line' },
          { index: 3, seamless: true, faithful: true, reason: 'follows' }
        ]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clips.map((c) => c.title)).toEqual(['passes', 'continuous'])
  })

  it('drops the joined clips, and only those, when the join review cannot run', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(0, 3), span(20, 23)], 'joined'), joined([span(50, 55)], 'continuous', 1)] }),
      clip_joins: () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }),
      clip_endings: () => ({ endings: [] })
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    error.mockRestore()
    expect(clips.map((c) => c.title)).toEqual(['continuous'])
  })

  it('treats picks a breath apart as one continuous clip', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(2, 4), span(5, 8)], 'adjacent')] }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clip.stitch).toBeUndefined()
    expect(clip.edit.cuts).toBeUndefined()
    expect(clip.suggestedEnd).toBeCloseTo(sentences[8].end + 0.25, 5)
    expect(requests.some((r) => r.schema === 'clip_joins')).toBe(false)
  })

  it('refuses a fragment, too many parts, and a join longer than the cap', async () => {
    answers = {
      viral_clips: () => ({
        clips: [
          // One line lands as a whole sentence (2.3 s + roll), under the three-second floor.
          joined([span(0, 4), span(30, 30)], 'fragment'),
          joined([span(0, 1), span(10, 11), span(20, 21), span(30, 31)], 'four parts'),
          joined([span(0, 9), span(30, 40)], 'too long'),
          joined([span(45, 50)], 'continuous', 1)
        ]
      }),
      clip_joins: () => pass(4),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, { ...options, clipLength: 'short' }, VIDEO)
    expect(clips.map((c) => c.title)).toEqual(['continuous'])
    // Each break was put to the model once, in plain words, before the rules dropped them.
    const finds = requests.filter((r) => r.schema === 'viral_clips')
    expect(finds).toHaveLength(2)
    expect(finds[1].user).toContain('Clip 1 ("fragment"): segment 2 runs about 3 seconds; every segment must be at least 3 seconds.')
    expect(finds[1].user).toContain('Clip 2 ("four parts") has 4 segments; a clip may join at most 3.')
    expect(finds[1].user).toMatch(/Clip 3 \("too long"\) runs about \d+ seconds; the limit is 56 seconds\./)
  })

  it('reports segments out of order or overlapping, and lands them in order if not corrected', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(40, 44), span(2, 5)], 'reversed'), joined([span(10, 16), span(14, 30)], 'overlapping')] }),
      clip_joins: () => pass(1),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    const finds = requests.filter((r) => r.schema === 'viral_clips')
    expect(finds).toHaveLength(2)
    expect(finds[1].user).toContain('Clip 1 ("reversed"): segment 2 starts before segment 1 ends. Segments must be listed in video order and must not overlap.')
    expect(finds[1].user).toContain('Clip 2 ("overlapping"): segment 2 starts before segment 1 ends.')
    // As before: sorted into order and joined, or merged into one moment.
    const reversed = clips.find((c) => c.title === 'reversed')!
    expect(selectedRanges(reversed.edit)[0].start).toBeCloseTo(sentences[2].start - 0.25, 5)
    expect(clips.find((c) => c.title === 'overlapping')?.stitch).toBeUndefined()
  })

  it('moves a joined clip ending within its last part, counting only what plays', async () => {
    answers = {
      viral_clips: () => ({ clips: [joined([span(2, 5), span(40, 44)], 'joined')] }),
      clip_joins: () => pass(1),
      clip_endings: () => ({ endings: [{ index: 0, ends_with_payoff: false, better_end: sentences[46].end, reason: 'payoff is two lines on' }] })
    }
    const [extended] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(extended.suggestedEnd).toBeCloseTo(sentences[46].end + 0.25, 5)
    expect(selectedRanges(extended.edit)).toHaveLength(2)

    // An "ending" back before the join would turn it into a different clip.
    answers.clip_endings = () => ({ endings: [{ index: 0, ends_with_payoff: false, better_end: sentences[38].end, reason: 'earlier' }] })
    const [held] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(held.suggestedEnd).toBeCloseTo(sentences[44].end + 0.25, 5)
  })

  it('does not call a joined clip a duplicate of a moment it skips', async () => {
    answers = {
      viral_clips: () => ({
        clips: [joined([span(2, 5), span(40, 44)], 'joined', 9), joined([span(15, 22)], 'in the gap', 5), joined([span(2, 6)], 'same opening', 1)]
      }),
      clip_joins: () => pass(1),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO)
    expect(clips.map((c) => c.title)).toEqual(['joined', 'in the gap'])
  })
})

describe('detectHighlights checking clip openings (scripted model)', () => {
  const texts = [
    'This first line sets the whole scene up.',
    'Yeah.',
    'Okay, so.',
    'Most people get money completely wrong today.',
    'They save first and spend whatever is left.',
    'The rich do it the other way around.',
    'And that is why they stay rich forever.',
    'Nobody ever tells you this part though.',
    'You have to pay yourself before anything else.',
    'That changes everything about how you spend.',
    'Try it for one month and see.',
    'Here is one more thing to remember always.'
  ]
  const transcript = makeTranscript(texts, { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
  const sentences = transcriptSentences(transcript)
  const VIDEO = transcript.durationSec + 5
  const options = { prompt: '', clipLength: 'auto' as const, broll: false, hookFirst: false, videoType: 'auto' as const }
  let requests: Array<{ schema: string; user: string }>
  let answers: Record<string, () => unknown>
  const raw = (startLine: number, endLine: number, title: string) => ({
    start_line: startLine, end_line: endLine, title, hook: 'hook', summary: 'summary', payoff: 'payoff',
    score_parts: { hook: 20, emotion: 10, value: 10, structure: 10, shareability: 5 },
    virality_score: 0, virality_reason: 'Strong claim.', hashtags: ['a']
  })

  beforeEach(() => {
    requests = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      requests.push({ schema, user: body.messages.find((m) => m.role === 'user')?.content ?? '' })
      const answer = answers[schema]
      if (!answer) throw new Error(`unexpected schema ${schema}`)
      return chatReply(answer())
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips lead-in fragments on the final opening, after the opening review', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(1, 6, 'lead-ins')] }),
      clip_endings: () => ({ endings: [] }),
      clip_openings: () => ({ starts: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, { ...options, hookFirst: true }, VIDEO)
    // The opening review judged the clip as selected and left it alone…
    const opening = requests.find((r) => r.schema === 'clip_openings')!
    expect(opening.user).toContain('currently starts on line #1 at')
    // …and the free check then skipped the throwaway lines it opens on.
    expect(clip.suggestedStart).toBeCloseTo(sentences[3].start - 0.25, 5)
    expect(clip.edit.start).toBe(clip.suggestedStart)
    expect(analyzeClipBoundaries(transcript, clip.edit.start, clip.edit.end).openingSentence).toBe(texts[3])
    expect(clip.scoreBreakdown?.hook).toBe(20)
  })

  it('does not penalise an opening the opening review already moved past a dangling "And"', async () => {
    // Lines 4 and 5 lean back too, so the free check could not have fixed line 6 itself.
    const leaning = makeTranscript(texts.map((t, i) => i === 4 ? 'And they spend whatever is left after that.' : i === 5 ? 'But the rich do it the other way around.' : t),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
    const lines = transcriptSentences(leaning)
    answers = {
      viral_clips: () => ({ clips: [raw(6, 10, 'moved')] }),
      clip_endings: () => ({ endings: [] }),
      clip_openings: () => ({ starts: [{ index: 0, opens_with_hook: false, better_start_line: 7, reason: 'hook is line 7' }] })
    }
    const [clip] = await detectHighlights('key', 'model', leaning, { ...options, hookFirst: true }, leaning.durationSec + 5)
    expect(clip.suggestedStart).toBeCloseTo(lines[7].start - 0.25, 5)
    expect(clip.viralityScore).toBe(55)
    expect(clip.viralityReason).toBe('Strong claim.')
  })

  it('opens a clip that starts on a dangling "And" on the line it continues', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(6, 10, 'dangling')] }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', transcript, options, VIDEO)
    // "The rich do it the other way around." stands on its own, so the clip
    // opens there, and nothing is docked.
    expect(clip.suggestedStart).toBeCloseTo(sentences[5].start - 0.25, 5)
    expect(clip.edit.start).toBe(clip.suggestedStart)
    expect(clip.viralityScore).toBe(55)
    expect(clip.viralityReason).toBe('Strong claim.')
  })

  it('ranks a dangling opening lower, and says why, when the lines before it lean back too', async () => {
    const leaning = makeTranscript(texts.map((t, i) => i === 4 ? 'And they spend whatever is left after that.' : i === 5 ? 'But the rich do it the other way around.' : t),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
    const lines = transcriptSentences(leaning)
    answers = { clip_endings: () => ({ endings: [] }) }
    answers.viral_clips = () => ({ clips: [raw(6, 10, 'dangling')] })
    const [alone] = await detectHighlights('key', 'model', leaning, options, leaning.durationSec + 5)
    expect(alone.scoreBreakdown?.hook).toBe(12)
    expect(alone.viralityScore).toBe(47)
    expect(alone.viralityReason).toBe('Strong claim. Opens on "And", which leans on something said before the clip.')
    // Its span is untouched.
    expect(alone.suggestedStart).toBeCloseTo(lines[6].start - 0.25, 5)
  })

  it('does nothing to a transcript that is not in English', async () => {
    answers = {
      viral_clips: () => ({ clips: [raw(1, 6, 'lead-ins'), raw(6, 10, 'dangling')] }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', { ...transcript, language: 'german' }, options, VIDEO)
    const leadIns = clips.find((c) => c.title === 'lead-ins')!
    expect(leadIns.suggestedStart).toBeCloseTo(sentences[1].start - 0.25, 5)
    expect(clips.find((c) => c.title === 'dangling')!.viralityScore).toBe(55)
  })
})

