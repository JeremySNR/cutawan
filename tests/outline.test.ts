import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildVideoOutline,
  outlineCacheKey,
  validateOutline,
  validateOutlinePart,
  validatePairings,
  type VideoOutline
} from '../src/main/pipeline/outline'
import { planOutlineWindows } from '../src/main/pipeline/highlights'
import { transcriptSentences, type Sentence } from '@shared/sentences'
import { makeTranscript } from './helpers'

function chatReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

const item = (start: number, end: number, label: string, kind: string) => ({ start_line: start, end_line: end, label, kind })

describe('validating outline replies', () => {
  it('keeps only items inside the part, in order, with a label and a known kind', () => {
    const part = validateOutlinePart({
      chapters: [item(10, 20, 'opening chat', 'intro'), item(21, 40, 'odd kind', 'nonsense'), item(41, 60, '', 'story')],
      open_threads: [
        item(12, 13, 'why the shop closed', 'question'),
        item(5, 8, 'before the part', 'question'),
        item(55, 70, 'runs past the part', 'setup'),
        item(30, 28, 'backwards', 'claim'),
        item(31, 31, 'unknown kind', 'rumour'),
        { start_line: 'x', end_line: 14, label: 'garbled', kind: 'question' }
      ],
      resolutions: [item(50, 52, 'the real reason', 'answer'), item(99999, 100000, 'nowhere', 'payoff')]
    }, 10, 60)
    expect(part.chapters).toEqual([
      { startLine: 10, endLine: 20, label: 'opening chat', kind: 'intro' },
      // A chapter of an unknown kind is still a chapter.
      { startLine: 21, endLine: 40, label: 'odd kind', kind: 'other' }
    ])
    expect(part.threads).toEqual([{ startLine: 12, endLine: 13, label: 'why the shop closed', kind: 'question' }])
    expect(part.resolutions).toEqual([{ startLine: 50, endLine: 52, label: 'the real reason', kind: 'answer' }])
    expect(validateOutlinePart(null, 0, 10)).toEqual({ chapters: [], threads: [], resolutions: [] })
  })

  it('keeps pairings of known items whose resolution comes later, once each, in the given order', () => {
    const threads = [
      { startLine: 10, endLine: 12, label: 'question', kind: 'question' as const },
      { startLine: 500, endLine: 502, label: 'late setup', kind: 'setup' as const }
    ]
    const resolutions = [
      { startLine: 400, endLine: 404, label: 'answer', kind: 'answer' as const },
      { startLine: 300, endLine: 301, label: 'early', kind: 'payoff' as const }
    ]
    const pairings = validatePairings({
      pairings: [
        { thread: 0, resolution: 1, reason: 'second best' },
        { thread: 0, resolution: 0, reason: 'best' },
        { thread: 0, resolution: 1, reason: 'repeat' },
        { thread: 1, resolution: 0, reason: 'answer before the question' },
        { thread: 7, resolution: 0, reason: 'unknown thread' },
        { thread: 0, resolution: 9, reason: 'unknown resolution' }
      ]
    }, threads, resolutions)
    expect(pairings.map((p) => p.reason)).toEqual(['second best', 'best'])
    expect(pairings[1]).toEqual({
      setup: { startLine: 10, endLine: 12 }, payoff: { startLine: 400, endLine: 404 },
      setupLabel: 'question', payoffLabel: 'answer', reason: 'best'
    })
  })

  it('rejects a stored outline that does not fit the current transcript', () => {
    const outline: VideoOutline = {
      version: 'outline-1', lineCount: 100,
      chapters: [{ startLine: 0, endLine: 99, label: 'all', kind: 'other' }],
      threads: [{ startLine: 1, endLine: 2, label: 't', kind: 'question' }],
      resolutions: [{ startLine: 80, endLine: 81, label: 'r', kind: 'answer' }],
      pairings: [{ setup: { startLine: 1, endLine: 2 }, payoff: { startLine: 80, endLine: 81 }, setupLabel: 't', payoffLabel: 'r', reason: 'fits' }]
    }
    expect(validateOutline(outline, 100)).toEqual(outline)
    expect(validateOutline(outline, 99)).toBeNull()
    expect(validateOutline({ ...outline, version: 'outline-0' }, 100)).toBeNull()
    expect(validateOutline({ ...outline, pairings: [{ ...outline.pairings[0], payoff: { startLine: 80, endLine: 100 } }] }, 100)).toBeNull()
    expect(validateOutline({ ...outline, pairings: [{ ...outline.pairings[0], payoff: { startLine: 0, endLine: 1 } }] }, 100)).toBeNull()
    expect(validateOutline({ ...outline, threads: [{ startLine: 1, endLine: 2, label: 't', kind: 'gossip' }] }, 100)).toBeNull()
  })
})

describe('building the video outline (scripted model)', () => {
  // 900 sentences of 2.7 s: about forty minutes of speech, four outline parts.
  const texts = Array.from({ length: 900 }, (_, i) => `sentence ${i} word three four five.`)
  const transcript = makeTranscript(texts, { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
  const sentences = transcriptSentences(transcript)
  const windows = planOutlineWindows(sentences).map((w) => w.sentences)
  let requests: Array<{ schema: string; user: string }>
  let partAnswer: (lo: number, hi: number) => unknown | Response
  let pairAnswer: (user: string) => unknown | Response
  let dir: string

  /** The id the matching request gave the item with this label ("T3" -> 3). */
  const idOf = (user: string, prefix: 'T' | 'R', label: string): number =>
    Number(user.split('\n').find((l) => l.startsWith(prefix) && l.endsWith(label))!.match(/^[TR](\d+) /)![1])

  beforeEach(async () => {
    requests = []
    dir = await mkdtemp(join(tmpdir(), 'cutawan-outline-'))
    partAnswer = (lo, hi) => ({
      chapters: [item(lo, hi, `part from ${lo}`, 'discussion')],
      open_threads: [
        ...(lo <= 100 && 100 <= hi ? [item(100, 102, 'why the first shop closed', 'question')] : []),
        // Out of range for the part, and for the whole transcript: both dropped.
        item(hi + 5, hi + 6, 'beyond the part', 'setup'),
        item(5000, 5001, 'beyond the video', 'setup')
      ],
      resolutions: lo <= 800 && 800 <= hi ? [item(800, 803, 'the real reason the shop closed', 'answer')] : []
    })
    pairAnswer = (user) => ({
      pairings: [
        { thread: idOf(user, 'T', 'why the first shop closed'), resolution: idOf(user, 'R', 'the real reason the shop closed'), reason: 'question and its answer' },
        { thread: 0, resolution: 42, reason: 'no such resolution' }
      ]
    })
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      requests.push({ schema, user })
      let payload: unknown
      if (schema === 'outline_part') {
        const [, lo, hi] = user.match(/lines #(\d+) to #(\d+)/)!.map(Number)
        payload = partAnswer(lo, hi)
      } else if (schema === 'outline_pairings') {
        payload = pairAnswer(user)
      } else throw new Error(`unexpected schema ${schema}`)
      return payload instanceof Response ? payload : chatReply(payload)
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  const build = (over: Partial<Parameters<typeof buildVideoOutline>[0]> = {}) =>
    buildVideoOutline({ apiKey: 'key', model: 'model', sentences, windows, cacheDir: dir, providerCacheKey: 'api:test', ...over })

  it('maps each part with numbered lines, then matches threads to resolutions in one request that sees no transcript', async () => {
    expect(windows.length).toBe(4)
    const progress: string[] = []
    const outline = await build({ onProgress: (m) => progress.push(m) })
    expect(requests.map((r) => r.schema)).toEqual(['outline_part', 'outline_part', 'outline_part', 'outline_part', 'outline_pairings'])
    const first = requests[0].user
    expect(first).toContain('This is part 1 of 4 of the transcript, lines #0 to #')
    expect(first).toContain(`#0 ${sentences[0].text}`)
    // Parts overlap only a little: no part repeats more than a few lines of the one before.
    const lastLines = windows.map((w) => w[w.length - 1].index)
    for (let i = 1; i < windows.length; i++) expect(lastLines[i - 1] - windows[i][0].index).toBeLessThan(15)
    // The matching request reads the outline, not the transcript.
    const reduce = requests[4].user
    expect(reduce).toMatch(/^T0 part 1, #100-#102 \(question\) why the first shop closed$/m)
    expect(reduce).toMatch(/^R0 part \d, #800-#803 \(answer\) the real reason the shop closed$/m)
    expect(reduce).not.toContain('sentence 100 word')
    expect(reduce).not.toContain('beyond the')

    expect(outline).not.toBeNull()
    expect(outline!.lineCount).toBe(900)
    expect(outline!.threads).toEqual([{ startLine: 100, endLine: 102, label: 'why the first shop closed', kind: 'question' }])
    expect(outline!.chapters).toHaveLength(4)
    expect(outline!.pairings).toEqual([{
      setup: { startLine: 100, endLine: 102 }, payoff: { startLine: 800, endLine: 803 },
      setupLabel: 'why the first shop closed', payoffLabel: 'the real reason the shop closed', reason: 'question and its answer'
    }])
    expect(progress).toContain('Mapping the video (4/4)…')
    expect(progress).toContain('Matching setups to payoffs…')
  })

  it('fails the whole outline when one part fails, and caches nothing', async () => {
    const answer = partAnswer
    let parts = 0
    partAnswer = (lo, hi) => (++parts === 2 ? new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }) : answer(lo, hi))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const outline = await build()
    expect(error.mock.calls.some((call) => String(call[0]).includes('Video outline failed'))).toBe(true)
    error.mockRestore()
    expect(outline).toBeNull()
    expect(requests.some((r) => r.schema === 'outline_pairings')).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('fails when the matching request fails', async () => {
    pairAnswer = () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await build()).toBeNull()
    error.mockRestore()
    expect(await readdir(dir)).toEqual([])
  })

  it('skips the matching request when no part left anything open', async () => {
    partAnswer = (lo, hi) => ({ chapters: [item(lo, hi, 'talk', 'discussion')], open_threads: [], resolutions: [] })
    const outline = await build()
    expect(requests.map((r) => r.schema)).toEqual(['outline_part', 'outline_part', 'outline_part', 'outline_part'])
    expect(outline!.pairings).toEqual([])
  })

  it('reuses a cached outline without any request, and misses when the transcript changes', async () => {
    const first = await build()
    expect(requests).toHaveLength(5)
    expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(1)

    requests = []
    // The same transcript and model: no requests, the same outline.
    expect(await build()).toEqual(first)
    expect(requests).toHaveLength(0)

    // One line reworded: a different transcript.
    const changed = transcriptSentences(makeTranscript(texts.map((t, i) => (i === 450 ? 'a different line here now.' : t)),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }))
    await build({ sentences: changed, windows: planOutlineWindows(changed).map((w) => w.sentences) })
    expect(requests.filter((r) => r.schema === 'outline_part')).toHaveLength(4)

    // Another model or provider identity is another outline.
    requests = []
    await build({ model: 'other-model' })
    expect(requests).toHaveLength(5)
    requests = []
    await build({ providerCacheKey: 'chatgpt:x:low' })
    expect(requests).toHaveLength(5)
  })

  it('does not trust a cached outline that no longer fits the transcript', async () => {
    await build()
    const file = join(dir, `outline-${outlineCacheKey(sentences, 'model', 'api:test')}.json`)
    const stored = JSON.parse(await readFile(file, 'utf8')) as { key: string; outline: VideoOutline }
    stored.outline.pairings[0].payoff = { startLine: 800, endLine: 950 }
    await writeFile(file, JSON.stringify(stored))
    requests = []
    const outline = await build()
    expect(requests.filter((r) => r.schema === 'outline_part')).toHaveLength(4)
    expect(outline!.pairings[0].payoff).toEqual({ startLine: 800, endLine: 803 })
  })

  it('builds without caching when given no cache directory', async () => {
    await build({ cacheDir: undefined })
    await build({ cacheDir: undefined })
    expect(requests.filter((r) => r.schema === 'outline_part')).toHaveLength(8)
  })

  it('stops on cancellation', async () => {
    const controller = new AbortController()
    partAnswer = () => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    await expect(build({ signal: controller.signal })).rejects.toThrow()
  })
})

describe('outline windows', () => {
  it('splits a two-hour transcript into eleven parts', () => {
    const sentences: Sentence[] = transcriptSentences(makeTranscript(
      Array.from({ length: 2700 }, (_, i) => `sentence ${i} word three four five.`),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
    ))
    const span = sentences[sentences.length - 1].end - sentences[0].start
    const windows = planOutlineWindows(sentences)
    expect(windows).toHaveLength(Math.ceil((span - 30) / 690))
    expect(windows).toHaveLength(11)
  })
})
