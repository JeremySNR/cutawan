import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectHighlights,
  longRangePairings,
  pairingFitsOneWindow,
  pairingLines,
  planAnalysisWindows,
  planOutlineWindows
} from '../src/main/pipeline/highlights'
import { transcriptSentences } from '@shared/sentences'
import { selectedRanges } from '@shared/clipSegments'
import { makeTranscript } from './helpers'
import type { AnalyzeOptions } from '@shared/types'

/**
 * Joining moments too far apart for one selection window, against a scripted
 * model: the outline (one request per outline part plus one to match), one
 * request proposing joined clips for the distant pairings, and then the same
 * join review, ending review and rerank as any other clip.
 */

function chatReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

const failure = (): Response => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })

const item = (start: number, end: number, label: string, kind: string) => ({ start_line: start, end_line: end, label, kind })

describe('pairing helpers', () => {
  const sentences = transcriptSentences(makeTranscript(
    Array.from({ length: 900 }, (_, i) => `sentence ${i} word three four five.`),
    { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
  ))
  // The windows selection uses when joining is on: six minutes of overlap.
  const windows = planAnalysisWindows(sentences, 100, 360)
  const pairing = (a: number, b: number, reason = '') => ({
    setup: { startLine: a, endLine: a + 2 }, payoff: { startLine: b, endLine: b + 3 }, setupLabel: 's', payoffLabel: 'p', reason
  })

  it('treats a pairing a few minutes apart as already seen, and one far apart as distant', () => {
    expect(pairingFitsOneWindow(pairing(300, 360), windows)).toBe(true)
    // Thirty minutes apart: no window holds both.
    expect(pairingFitsOneWindow(pairing(100, 800), windows)).toBe(false)
  })

  it('keeps the distant pairings in the given order, at most eight', () => {
    const all = [pairing(300, 360, 'near'), ...Array.from({ length: 10 }, (_, i) => pairing(10 + i * 5, 700 + i * 10, `far ${i}`))]
    const chosen = longRangePairings(all, windows)
    expect(chosen.map((p) => p.reason)).toEqual(Array.from({ length: 8 }, (_, i) => `far ${i}`))
  })

  it('shows each end with a few lines either side, and no more than thirty of a long range', () => {
    expect(pairingLines({ startLine: 100, endLine: 102 }, sentences).map((s) => s.index)).toEqual(
      Array.from({ length: 11 }, (_, i) => 96 + i))
    expect(pairingLines({ startLine: 1, endLine: 2 }, sentences)[0].index).toBe(0)
    expect(pairingLines({ startLine: 897, endLine: 899 }, sentences).at(-1)!.index).toBe(899)
    const long = pairingLines({ startLine: 200, endLine: 400 }, sentences)
    expect(long[0].index).toBe(196)
    expect(long.at(-1)!.index).toBe(233)
  })
})

describe('detectHighlights joining distant moments (scripted model)', () => {
  // 900 sentences of 2.7 s: a little over forty minutes of speech. Line k
  // starts at 2.7k, so lines 100 and 800 are about thirty-one minutes apart.
  const texts = Array.from({ length: 900 }, (_, i) => `sentence ${i} word three four five.`)
  const transcript = makeTranscript(texts, { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
  const sentences = transcriptSentences(transcript)
  const VIDEO = transcript.durationSec
  const options: AnalyzeOptions = { prompt: '', clipLength: 'auto', broll: false, hookFirst: false, videoType: 'auto', stitch: true }
  const outlineParts = planOutlineWindows(sentences).length
  let requests: Array<{ schema: string; system: string; user: string }>
  let answers: Record<string, (user: string) => unknown | Response>
  let dir: string

  const scoreParts = (hook: number) => ({ hook, emotion: 10, value: 10, structure: 10, shareability: 5 })
  /** The lines a request showed, by number. */
  const shownLines = (user: string): number[] =>
    user.split('\n').flatMap((l) => (/^#\d+ \[/.test(l) ? [Number(l.match(/^#(\d+)/)![1])] : []))
  /** The id the matching request gave the item with this label. */
  const idOf = (user: string, prefix: 'T' | 'R', label: string): number =>
    Number(user.split('\n').find((l) => l.startsWith(prefix) && l.endsWith(label))!.match(/^[TR](\d+) /)![1])
  const joinedClip = (pairing: number, segments: Array<[number, number]>, title = 'setup meets payoff', hook = 28) => ({
    pairing,
    segments: segments.map(([start_line, end_line]) => ({ start_line, end_line })),
    join_reason: 'skips thirty minutes between the question and its answer',
    title, hook: 'hook', summary: 'summary', payoff: 'payoff',
    score_parts: { hook, emotion: 22, value: 15, structure: 12, shareability: 7 },
    virality_score: 0, virality_reason: 'because', hashtags: ['a']
  })

  beforeEach(async () => {
    requests = []
    dir = await mkdtemp(join(tmpdir(), 'cutawan-longrange-'))
    answers = {
      // Two continuous clips per window, early and late in it.
      viral_clips: (user) => {
        const lines = shownLines(user)
        return {
          clips: [10, lines.length - 20].map((at, n) => ({
            start_line: lines[at], end_line: lines[at] + 4, title: `clip at line ${lines[at]}`, hook: 'hook', summary: 'summary', payoff: 'payoff',
            score_parts: scoreParts(10 + n), virality_score: 0, virality_reason: 'because', hashtags: ['a']
          }))
        }
      },
      outline_part: (user) => {
        const [, lo, hi] = user.match(/lines #(\d+) to #(\d+)/)!.map(Number)
        const has = (line: number) => lo <= line && line <= hi
        return {
          chapters: [item(lo, hi, `part from ${lo}`, 'discussion')],
          open_threads: [
            ...(has(100) ? [item(100, 102, 'far setup', 'question')] : []),
            ...(has(300) ? [item(300, 301, 'near setup', 'setup')] : [])
          ],
          resolutions: [
            ...(has(360) ? [item(360, 362, 'near payoff', 'payoff')] : []),
            ...(has(800) ? [item(800, 803, 'far payoff', 'answer')] : [])
          ]
        }
      },
      // The near pair is listed first: it must still never be sent.
      outline_pairings: (user) => ({
        pairings: [
          { thread: idOf(user, 'T', 'near setup'), resolution: idOf(user, 'R', 'near payoff'), reason: 'near pair' },
          { thread: idOf(user, 'T', 'far setup'), resolution: idOf(user, 'R', 'far payoff'), reason: 'far pair' }
        ]
      }),
      long_range_joins: () => ({ clips: [joinedClip(0, [[100, 103], [800, 803]])], declined: [] }),
      clip_joins: () => ({ clips: [{ index: 0, seamless: true, faithful: true, reason: 'follows' }] }),
      clip_endings: () => ({ endings: [] }),
      clip_rerank: () => ({ scores: [] })
    }
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
        response_format: { json_schema: { name: string } }
      }
      const schema = body.response_format.json_schema.name
      const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      requests.push({ schema, system, user })
      const answer = answers[schema]
      if (!answer) throw new Error(`unexpected schema ${schema}`)
      const payload = answer(user)
      return payload instanceof Response ? payload : chatReply(payload)
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  const count = (schema: string): number => requests.filter((r) => r.schema === schema).length
  const run = (over: Partial<typeof options> = {}, onProgress?: (p: { fraction: number; message: string }) => void) =>
    detectHighlights('key', 'model', transcript, { ...options, ...over }, VIDEO, undefined, onProgress, { cacheDir: dir, providerCacheKey: 'api:test' })

  it('turns a far-apart pairing into a joined clip that goes through the join review', async () => {
    const progress: string[] = []
    const clips = await run({}, (p) => progress.push(p.message))
    // Outline: one request per part plus one to match; then one proposal request.
    expect(count('outline_part')).toBe(outlineParts)
    expect(count('outline_pairings')).toBe(1)
    expect(count('long_range_joins')).toBe(1)
    // All of it after selection and before the join review.
    const order = requests.map((r) => r.schema)
    expect(order.lastIndexOf('viral_clips')).toBeLessThan(order.indexOf('outline_part'))
    expect(order.indexOf('long_range_joins')).toBeLessThan(order.indexOf('clip_joins'))

    // Only the distant pairing is sent, as real numbered lines around both ends.
    const proposal = requests.find((r) => r.schema === 'long_range_joins')!
    expect(proposal.user).toContain('Pairing 0 — the outline\'s reason: "far pair"')
    expect(proposal.user).not.toContain('near pair')
    expect(proposal.user).not.toContain('Pairing 1')
    expect(proposal.user).toContain(`#96 [${sentences[96].start.toFixed(1)}s - ${sentences[96].end.toFixed(1)}s] ${sentences[96].text}`)
    expect(shownLines(proposal.user)).toEqual([...Array.from({ length: 11 }, (_, i) => 96 + i), ...Array.from({ length: 12 }, (_, i) => 796 + i)])
    // The same selection and joining rules, plus the instruction to decline.
    expect(proposal.system).toContain('Never change what a speaker meant')
    expect(proposal.system).toContain('Every clip MUST have the shape of a complete micro-video')
    expect(proposal.system).toContain('Declining is often the right answer')

    // The join review judged it like any other join.
    const review = requests.find((r) => r.schema === 'clip_joins')!
    expect(review.user).toMatch(/Plays before: .*sentence 103 word/)
    expect(review.user).toMatch(/Plays after: sentence 800 word/)
    const joined = clips.find((c) => c.title === 'setup meets payoff')!
    expect(joined.stitch?.reason).toBe('skips thirty minutes between the question and its answer')
    const ranges = selectedRanges(joined.edit)
    expect(ranges).toHaveLength(2)
    expect(ranges[0].start).toBeCloseTo(sentences[100].start - 0.25, 5)
    expect(ranges[1].end).toBeCloseTo(sentences[803].end + 0.25, 5)
    // The windowed clips are all still there.
    expect(clips.filter((c) => !c.stitch).length).toBe(count('viral_clips') * 2)
    expect(progress).toContain('Matching setups to payoffs…')
    expect(progress).toContain('Joining distant moments…')
  })

  it('reuses the cached outline on a regeneration with other instructions, spending only the proposal request', async () => {
    await run()
    expect(count('outline_part')).toBe(outlineParts)
    requests = []
    const clips = await run({ prompt: 'focus on the business story', clipLength: 'medium' })
    expect(count('outline_part')).toBe(0)
    expect(count('outline_pairings')).toBe(0)
    expect(count('long_range_joins')).toBe(1)
    expect(requests.find((r) => r.schema === 'long_range_joins')!.user).toContain('focus on the business story')
    expect(clips.some((c) => c.title === 'setup meets payoff')).toBe(true)
  })

  it('misses the cache when the transcript changes', async () => {
    await run()
    requests = []
    const changed = makeTranscript(texts.map((t, i) => (i === 450 ? 'a reworded line in the middle.' : t)),
      { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
    await detectHighlights('key', 'model', changed, options, changed.durationSec, undefined, undefined, { cacheDir: dir, providerCacheKey: 'api:test' })
    expect(count('outline_part')).toBe(outlineParts)
    expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(2)
  })

  it('makes no clip when the model declines the pairing', async () => {
    answers.long_range_joins = () => ({ clips: [], declined: [{ pairing: 0, reason: 'the answer leans on what came between' }] })
    const clips = await run()
    expect(count('long_range_joins')).toBe(1)
    expect(clips.some((c) => c.stitch)).toBe(false)
    // Nothing joined, so nothing for the join review to do.
    expect(count('clip_joins')).toBe(0)
  })

  it('drops a proposal the join review rejects', async () => {
    answers.clip_joins = () => ({ clips: [{ index: 0, seamless: false, faithful: true, reason: 'the answer leans on a skipped line' }] })
    const clips = await run()
    expect(count('clip_joins')).toBe(1)
    expect(clips.some((c) => c.title === 'setup meets payoff')).toBe(false)
    expect(clips.filter((c) => !c.stitch).length).toBe(count('viral_clips') * 2)
  })

  it('keeps the normal clips when the proposal request fails', async () => {
    answers.long_range_joins = failure
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const clips = await run()
    expect(error.mock.calls.some((call) => String(call[0]).includes('Joining distant moments failed'))).toBe(true)
    error.mockRestore()
    expect(clips.some((c) => c.stitch)).toBe(false)
    expect(clips.length).toBe(count('viral_clips') * 2)
  })

  it('goes on without distant joins when an outline request fails', async () => {
    let parts = 0
    const part = answers.outline_part
    answers.outline_part = (user) => (++parts === 1 ? failure() : part(user))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const clips = await run()
    error.mockRestore()
    expect(count('outline_pairings')).toBe(0)
    expect(count('long_range_joins')).toBe(0)
    expect(clips.length).toBe(count('viral_clips') * 2)
    expect(await readdir(dir)).toEqual([])
  })

  it('spends no proposal request when every pairing fits inside one window', async () => {
    answers.outline_pairings = (user) => ({
      pairings: [{ thread: idOf(user, 'T', 'near setup'), resolution: idOf(user, 'R', 'near payoff'), reason: 'near pair' }]
    })
    await run()
    expect(count('outline_pairings')).toBe(1)
    expect(count('long_range_joins')).toBe(0)
  })

  it('drops a proposal that does not join both moments, uses lines it was not shown, or names no pairing shown', async () => {
    const cases: Array<[string, ReturnType<typeof joinedClip>[]]> = [
      // Only the setup, continuous: what the windowed pass already offers.
      ['setup alone', [joinedClip(0, [[98, 104]], 'setup alone')]],
      // Reaches into the thirty minutes between the moments, which it was never shown.
      ['unshown lines', [joinedClip(0, [[100, 103], [500, 503]], 'unshown lines')]],
      ['unknown pairing', [joinedClip(3, [[100, 103], [800, 803]], 'unknown pairing')]],
      // One clip per pairing: a second answer for the same pairing is ignored.
      ['second answer', [joinedClip(0, [[98, 104]], 'first answer'), joinedClip(0, [[100, 103], [800, 803]], 'second answer')]]
    ]
    for (const [title, reply] of cases) {
      requests = []
      answers.long_range_joins = () => ({ clips: reply, declined: [] })
      const clips = await run()
      expect(count('long_range_joins')).toBe(1)
      expect(clips.some((c) => c.title === title || c.stitch)).toBe(false)
      expect(count('clip_joins')).toBe(0)
    }
  })

  it('makes exactly the requests it made before without joining, or on a short video', async () => {
    await run({ stitch: false })
    const without = new Set(requests.map((r) => r.schema))
    expect([...without].sort()).toEqual(['clip_endings', 'clip_rerank', 'viral_clips'])

    requests = []
    const short = makeTranscript(texts.slice(0, 60), { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 })
    await detectHighlights('key', 'model', short, options, short.durationSec, undefined, undefined, { cacheDir: dir })
    expect(requests.map((r) => r.schema)).toEqual(['viral_clips', 'clip_endings'])
    expect(await readdir(dir)).toEqual([])
  })
})
