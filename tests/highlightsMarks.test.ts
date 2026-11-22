import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectHighlights } from '../src/main/pipeline/highlights'
import type { SentenceEmbedder } from '../src/main/pipeline/topics'
import { TOPIC_CHANGE_LINE } from '../src/main/pipeline/lineMarks'
import { transcriptSentences } from '@shared/sentences'
import type { AnalyzeOptions, Transcript } from '@shared/types'
import { makeTranscript } from './helpers'

/**
 * The marks local analysis adds to what the model reads (speakers, audience
 * reactions, topic changes, the video's format) and the clip kinds the
 * selection returns, driven end to end against a scripted model. Every mark
 * is prompt content or local computation: each test also checks that the
 * requests made are exactly the ones made without them.
 */

interface Request { schema: string; system: string; user: string; properties: Record<string, { enum?: string[] }> }

function chatReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

/** Sentence k of "sentence k word three four five." embeds along direction floor(k / 20): a topic change every 20 lines. */
function topicEmbedder(): SentenceEmbedder & { calls: number } {
  const embedder = {
    id: 'test-embedder',
    calls: 0,
    async embed(texts: string[]): Promise<Float32Array[]> {
      embedder.calls++
      return texts.map((t) => {
        const n = Number(t.match(/sentence (\d+)/)?.[1] ?? 0)
        const v = new Float32Array(64)
        v[Math.floor(n / 20) % 64] = 1
        v[63 - (n % 7)] = 0.2
        return v
      })
    }
  }
  return embedder
}

const fields = (title: string, kind: unknown, shareability = 5) => ({
  title, hook: 'hook', summary: 'summary', payoff: 'payoff', kind,
  score_parts: { hook: 20, emotion: 15, value: 10, structure: 10, shareability },
  virality_score: 0, virality_reason: 'because', hashtags: ['a']
})

let requests: Request[]
let answers: Record<string, (req: Request) => unknown>

beforeEach(() => {
  requests = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>
      response_format: { json_schema: { name: string; schema: { properties?: { clips?: { items?: { properties?: Request['properties'] } } } } } }
    }
    const req: Request = {
      schema: body.response_format.json_schema.name,
      system: body.messages.find((m) => m.role === 'system')?.content ?? '',
      user: body.messages.find((m) => m.role === 'user')?.content ?? '',
      properties: body.response_format.json_schema.schema.properties?.clips?.items?.properties ?? {}
    }
    requests.push(req)
    const answer = answers[req.schema]
    if (!answer) throw new Error(`unexpected schema ${req.schema}`)
    return chatReply(answer(req))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectHighlights with speaker, reaction and topic marks (scripted model)', () => {
  // Sixty sentences of 2.7 s: sentence k starts at 2.7k and ends 2.3 s later.
  const base = makeTranscript(
    Array.from({ length: 60 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(base)
  const VIDEO = base.durationSec + 5
  // Speaker 0 for lines 0-9, speaker 1 for 10-19, and so on.
  const marked: Transcript = {
    ...base,
    speakerTurns: Array.from({ length: 6 }, (_, n) => ({ start: sentences[n * 10].start - 0.2, end: sentences[n * 10 + 9].end + 0.2, speaker: n % 2 })),
    reactions: [{ start: sentences[15].end + 0.2, end: sentences[15].end + 2.5, strength: 0.9, kind: 'laughter' }]
  }
  const options: AnalyzeOptions = { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }

  it('shows each line with its speaker, the reaction after a line and the topic changes, and explains them', async () => {
    answers = {
      viral_clips: () => ({ clips: [{ start_line: 12, end_line: 15, ...fields('the laugh', 'funny') }] }),
      clip_endings: () => ({ endings: [] })
    }
    await detectHighlights('key', 'model', marked, options, VIDEO, undefined, undefined, { embedder: topicEmbedder() })
    const select = requests.find((r) => r.schema === 'viral_clips')!
    const lines = select.user.split('\n')
    expect(lines).toContain(`#0 [${sentences[0].start.toFixed(1)}s - ${sentences[0].end.toFixed(1)}s] (Speaker A) sentence 0 word three four five.`)
    expect(lines.find((l) => l.startsWith('#12 '))).toContain('(Speaker B) sentence 12')
    expect(lines.find((l) => l.startsWith('#15 '))).toMatch(/sentence 15 word three four five\. \[laughter after\]$/)
    expect(lines[lines.findIndex((l) => l.startsWith('#20 ')) - 1]).toBe(TOPIC_CHANGE_LINE)
    expect(lines[lines.findIndex((l) => l.startsWith('#40 ')) - 1]).toBe(TOPIC_CHANGE_LINE)
    expect(lines.filter((l) => l === TOPIC_CHANGE_LINE)).toHaveLength(2)
    // Every sentence is still one numbered line.
    expect(lines.filter((l) => /^#\d+ \[\d+\.\ds - \d+\.\ds\] /.test(l))).toHaveLength(60)
    expect(select.system).toContain('Marks on the transcript lines:')
    expect(select.system).toContain('(Speaker A, then B)')
    expect(select.system).toContain('The reaction comes AFTER the payoff')
    expect(select.system).toContain(TOPIC_CHANGE_LINE)
    // Two voices with real shares of the speech: a conversation, offered as a hint.
    expect(select.user).toContain('Format: this looks like a podcast or interview (judged from the transcript')

    const ending = requests.find((r) => r.schema === 'clip_endings')!
    expect(ending.system).toContain('the audience reacted right after that line')
    expect(ending.user).toMatch(/#15 \[ends \d+\.\ds\] \(Speaker B\) sentence 15 word three four five\. \[laughter after\]/)
  })

  it('makes exactly the requests it makes without marks, and none for topics', async () => {
    answers = {
      viral_clips: () => ({ clips: [{ start_line: 12, end_line: 15, ...fields('the laugh', 'funny') }] }),
      clip_endings: () => ({ endings: [] })
    }
    await detectHighlights('key', 'model', base, options, VIDEO, undefined, undefined, { embedder: null })
    const plain = requests.map((r) => r.schema)
    const plainSelect = requests.find((r) => r.schema === 'viral_clips')!
    requests = []
    const embedder = topicEmbedder()
    await detectHighlights('key', 'model', marked, { ...options, hookFirst: false }, VIDEO, undefined, undefined, { embedder })
    expect(requests.map((r) => r.schema)).toEqual(plain)
    expect(plain).toEqual(['viral_clips', 'clip_endings'])
    expect(embedder.calls).toBeGreaterThan(0)
    // Without marks the prompt carries none of them.
    expect(plainSelect.system).not.toContain('Marks on the transcript lines')
    expect(plainSelect.user).not.toMatch(/\(Speaker|after\]|topic change/)
  })

  it('runs a clip that ends on the laughed-at line a beat into the laugh', async () => {
    answers = {
      viral_clips: () => ({ clips: [{ start_line: 12, end_line: 15, ...fields('the laugh', 'funny') }] }),
      clip_endings: () => ({ endings: [] })
    }
    const [clip] = await detectHighlights('key', 'model', marked, options, VIDEO, undefined, undefined, { embedder: null })
    // The next line starts 0.4 s after line 15 ends; the clip stops just short of it.
    expect(clip.suggestedEnd).toBeCloseTo(sentences[16].start - 0.05, 5)
  })

  it('tells the join review who speaks either side of a join and that it crosses a topic change', async () => {
    answers = {
      viral_clips: () => ({
        clips: [{ segments: [{ start_line: 12, end_line: 15 }, { start_line: 41, end_line: 44 }], join_reason: 'skips a tangent', ...fields('joined', 'story') }]
      }),
      clip_joins: () => ({ clips: [{ index: 0, seamless: true, faithful: true, reason: 'ok' }] }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', marked, { ...options, stitch: true }, VIDEO, undefined, undefined, { embedder: topicEmbedder() })
    expect(clips[0].stitch).toBeDefined()
    const review = requests.find((r) => r.schema === 'clip_joins')!
    expect(review.user).toContain('    Speakers: Speaker B says the line before the join; a different speaker, Speaker A, says the line after it.')
    expect(review.user).toContain('    Topic: the join crosses a topic change.')
    expect(review.system).toContain('the join is faithful only if the clip still plays as two people')
    expect(requests.map((r) => r.schema)).toEqual(['viral_clips', 'clip_joins', 'clip_endings'])
  })

  it('gives the join review no speaker or topic lines it does not have', async () => {
    answers = {
      viral_clips: () => ({
        clips: [{ segments: [{ start_line: 12, end_line: 15 }, { start_line: 41, end_line: 44 }], join_reason: 'skips a tangent', ...fields('joined', 'story') }]
      }),
      clip_joins: () => ({ clips: [{ index: 0, seamless: true, faithful: true, reason: 'ok' }] }),
      clip_endings: () => ({ endings: [] })
    }
    await detectHighlights('key', 'model', base, { ...options, stitch: true }, VIDEO, undefined, undefined, { embedder: null })
    const review = requests.find((r) => r.schema === 'clip_joins')!
    expect(review.user).not.toMatch(/Speakers:|Topic:/)
    expect(review.system).not.toContain('two people')
  })
})

describe('detectHighlights clip kinds and variety (scripted model)', () => {
  const transcript = makeTranscript(
    Array.from({ length: 60 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const VIDEO = transcript.durationSec + 5
  const options: AnalyzeOptions = { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto' }

  it('asks for a kind from the fixed set and stores it on the clip, tolerating a missing or unknown one', async () => {
    answers = {
      viral_clips: () => ({
        clips: [
          { start_line: 2, end_line: 6, ...fields('story', 'story', 8) },
          { start_line: 10, end_line: 14, ...fields('tip', 'Tip', 7) },
          { start_line: 20, end_line: 24, ...fields('nothing', undefined, 6) },
          { start_line: 30, end_line: 34, ...fields('bogus', 'banana', 5) }
        ]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO, undefined, undefined, { embedder: null })
    const select = requests.find((r) => r.schema === 'viral_clips')!
    expect(select.properties.kind?.enum).toEqual(['story', 'insight', 'opinion', 'funny', 'emotional', 'explainer', 'other'])
    expect(clips.map((c) => [c.title, c.kind])).toEqual([['story', 'story'], ['tip', 'insight'], ['nothing', undefined], ['bogus', undefined]])
    expect(clips.some((c) => 'kind' in c && c.kind === undefined)).toBe(false)
  })

  it('varies the kinds at the top of the final list within the bounds', async () => {
    answers = {
      viral_clips: () => ({
        clips: [
          { start_line: 2, end_line: 6, ...fields('story one', 'story', 9) },
          { start_line: 10, end_line: 14, ...fields('story two', 'story', 8) },
          { start_line: 20, end_line: 24, ...fields('story three', 'story', 7) },
          { start_line: 30, end_line: 34, ...fields('the joke', 'funny', 6) }
        ]
      }),
      clip_endings: () => ({ endings: [] })
    }
    const clips = await detectHighlights('key', 'model', transcript, options, VIDEO, undefined, undefined, { embedder: null })
    expect(clips.map((c) => c.title)).toEqual(['story one', 'the joke', 'story two', 'story three'])
    expect(requests.map((r) => r.schema)).toEqual(['viral_clips', 'clip_endings'])
  })
})

describe('detectHighlights format guidance (scripted model)', () => {
  const transcript = makeTranscript(
    Array.from({ length: 60 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const VIDEO = transcript.durationSec + 5

  it('adds the chosen format\'s paragraph to the selection request, and nothing for an undecided auto', async () => {
    answers = {
      viral_clips: () => ({ clips: [{ start_line: 2, end_line: 6, ...fields('a', 'story') }] }),
      clip_endings: () => ({ endings: [] })
    }
    const base: AnalyzeOptions = { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'webinar' }
    await detectHighlights('key', 'model', transcript, base, VIDEO, undefined, undefined, { embedder: null })
    expect(requests.find((r) => r.schema === 'viral_clips')!.user).toContain('Format: this is a webinar or presentation.')
    requests = []
    await detectHighlights('key', 'model', transcript, { ...base, videoType: 'auto' }, VIDEO, undefined, undefined, { embedder: null })
    expect(requests.find((r) => r.schema === 'viral_clips')!.user).not.toContain('Format:')
  })
})

describe('detectHighlights on a long transcript with marks (scripted model)', () => {
  // 900 sentences of 2.7 s: a little over 40 minutes, read in windows.
  const base = makeTranscript(
    Array.from({ length: 900 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  )
  const sentences = transcriptSentences(base)
  const marked: Transcript = {
    ...base,
    reactions: sentences.filter((s) => s.index % 50 === 14).map((s) => ({ start: s.end + 0.1, end: s.end + 2, strength: 0.9, kind: 'laughter' as const }))
  }
  const options: AnalyzeOptions = { prompt: '', clipLength: 'auto', broll: false, hookFirst: true, videoType: 'auto' }

  const answer = (): void => {
    answers = {
      viral_clips: (req) => {
        const lines = req.user.split('\n').filter((l) => /^#\d+ \[/.test(l))
        const first = Number(lines[10].match(/^#(\d+)/)![1])
        return { clips: [{ start_line: first, end_line: first + 4, ...fields(`clip ${first}`, 'story', first % 9) }] }
      },
      clip_endings: () => ({ endings: [] }),
      clip_openings: () => ({ starts: [] }),
      clip_rerank: () => ({ scores: [] })
    }
  }

  it('makes the same requests with marks and topic windows as without, and shows the rerank the reactions', async () => {
    answer()
    await detectHighlights('key', 'model', base, options, base.durationSec, undefined, undefined, { embedder: null })
    const plain = requests.map((r) => r.schema).sort()
    requests = []
    answer()
    await detectHighlights('key', 'model', marked, options, base.durationSec, undefined, undefined, { embedder: topicEmbedder() })
    expect(requests.map((r) => r.schema).sort()).toEqual(plain)
    expect(plain.filter((s) => s === 'clip_rerank')).toHaveLength(1)
    const rerank = requests.find((r) => r.schema === 'clip_rerank')!
    expect(rerank.user).toContain('[laughter]')
    expect(rerank.system).toContain('the audience reacted to it')
    // Each window shows its topic changes as separator lines.
    const select = requests.find((r) => r.schema === 'viral_clips')!
    expect(select.user).toContain(TOPIC_CHANGE_LINE)
  })
})
