import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sentence } from '@shared/sentences'
import { throwIfSubscriptionError, usesSubscription } from '../subscription'
import { mapLimit } from './concurrency'
import { pruneDirectory } from './analysisCache'
import { chatApiBase, chatJSON } from './openai'

/**
 * A compact map of a whole transcript, in sentence-line numbers: its
 * chapters, the threads each part leaves open (a question, a setup, a claim,
 * a story) and the moments that resolve them, and the pairings of thread to
 * resolution across the whole video. Clip selection reads a long video one
 * window at a time, so a setup at minute five and its payoff at minute
 * thirty-five are never in front of the same request; the outline is the one
 * view that spans both, and it is cheap because the matching step reads the
 * outline, not the transcript.
 *
 * Built map-reduce: one request per part of the transcript, then one request
 * that sees only the per-part results. It depends on nothing but the
 * transcript and the model, so it is cached on disk and reused when the
 * creator regenerates with other instructions or another clip length.
 */

/** Bump when the prompts, schemas, windowing or validation change. */
export const OUTLINE_VERSION = 'outline-1'

export const CHAPTER_KINDS = [
  'intro', 'story', 'explanation', 'argument', 'demonstration', 'interview', 'discussion', 'banter', 'promotion', 'outro', 'other'
] as const
export const THREAD_KINDS = ['question', 'setup', 'claim', 'story'] as const
export const RESOLUTION_KINDS = ['answer', 'payoff', 'evidence', 'story-resumes', 'story-ends'] as const

type ChapterKind = typeof CHAPTER_KINDS[number]
type ThreadKind = typeof THREAD_KINDS[number]
type ResolutionKind = typeof RESOLUTION_KINDS[number]

/** Inclusive range of sentence-line numbers (indices into the transcript's sentences). */
export interface LineRange {
  startLine: number
  endLine: number
}

export interface OutlineChapter extends LineRange {
  label: string
  kind: ChapterKind
}

export interface OutlineThread extends LineRange {
  label: string
  kind: ThreadKind
}

export interface OutlineResolution extends LineRange {
  label: string
  kind: ResolutionKind
}

/** A thread and the later moment that settles it, as the matching step paired them. */
export interface OutlinePairing {
  setup: LineRange
  payoff: LineRange
  setupLabel: string
  payoffLabel: string
  /** Why the two belong together, in the matching step's words. */
  reason: string
}

export interface VideoOutline {
  version: string
  /** Sentence lines in the transcript the outline was built from. */
  lineCount: number
  chapters: OutlineChapter[]
  threads: OutlineThread[]
  resolutions: OutlineResolution[]
  /** Strongest first, by the matching step's own ranking. */
  pairings: OutlinePairing[]
}

/** Per-part caps: past these a part is being summarised line by line, not mapped. */
const MAX_PART_CHAPTERS = 8
const MAX_PART_THREADS = 12
const MAX_PART_RESOLUTIONS = 12
/** Most pairings the matching step may return and the outline keeps. */
export const MAX_OUTLINE_PAIRINGS = 16
const MAX_LABEL_CHARS = 160
const MAX_REASON_CHARS = 400
/** Parts mapped at once; the same as clip selection's windows. */
const OUTLINE_CONCURRENCY = 3
/** Outlines kept per project; the least recently written beyond this go. */
const OUTLINE_CACHE_ENTRIES = 8
/** A cached outline larger than this is not read (a two-hour outline is a few tens of KB). */
const MAX_CACHE_BYTES = 1_000_000

const MAP_SYSTEM_PROMPT = `You map the structure of one part of a long video's transcript, so that moments far apart in the video can later be connected. You receive the part as one sentence per line, each prefixed with its line number (#12). Line numbers count from the start of the whole video, so a line has the same number wherever it appears.

Return three lists. Every item is a range of line numbers ("start_line" and "end_line", both included) with a short label of at most fifteen words.
- chapters: consecutive stretches of this part on one subject or activity, in order, together covering the part. Give each a kind.
- open_threads: things raised in this part that leave the viewer waiting: a question asked and not answered here, a setup or promise ("I'll tell you what happened later", "there's a catch"), a claim stated without its proof, a story started and left unfinished. List one only when this part does not settle it, or settles it only partly. Point at the lines where it is raised, not the whole discussion around it.
- resolutions: moments in this part that answer, pay off, prove or continue something that may have been raised earlier in the video, even if you cannot see where: an answer that refers back, a promised reveal, the strongest example or evidence for a claim, a story picked up again or finished. Point at the lines that do the resolving.

A label must say what the moment is about specifically enough to be matched with a moment from another part of the video ("why the first restaurant closed", not "a question"). Use only line numbers that appear in this part. There is no quota: an empty list is the right answer when the part has nothing of that kind.`

const REDUCE_SYSTEM_PROMPT = `You connect moments that are far apart in one long video. You receive an outline of the whole video, built part by part: its chapters, the threads each part left open (questions, setups, claims, unfinished stories) and the resolutions each part contains (answers, payoffs, evidence, stories resumed or finished). Every item has an id, the part it came from, its range of line numbers and a label. You do not see the transcript.

Match threads to the resolutions that settle them. A match is worth listing only when the resolution answers, pays off, proves or continues that exact thread, so that the two moments played back to back would make one short clip that a viewer with no context could follow: a question and its real answer, a setup and its payoff, a claim and its best evidence, the start of a story and its ending. The resolution must come later in the video than the thread. Do not match on a shared topic alone: a setup that promises a particular story or answer matches only the moment where that story or answer is actually delivered, which is often near the end of the video, not the first later moment that mentions the same subject. Matches between different parts of the video are what this step is for; a thread and a resolution a few lines apart are not worth listing. Order the matches strongest first. An empty list is the right answer when nothing matches.`

const rangeItem = (kinds: readonly string[], what: string): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required: ['start_line', 'end_line', 'label', 'kind'],
  properties: {
    start_line: { type: 'integer', description: `Number of the first line of the ${what}` },
    end_line: { type: 'integer', description: `Number of the last line of the ${what} (included)` },
    label: { type: 'string', description: 'What it is about, specifically, in at most fifteen words' },
    kind: { type: 'string', enum: [...kinds] }
  }
})

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chapters', 'open_threads', 'resolutions'],
  properties: {
    chapters: { type: 'array', items: rangeItem(CHAPTER_KINDS, 'chapter') },
    open_threads: { type: 'array', items: rangeItem(THREAD_KINDS, 'lines where the thread is raised') },
    resolutions: { type: 'array', items: rangeItem(RESOLUTION_KINDS, 'lines that resolve') }
  }
}

const REDUCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pairings'],
  properties: {
    pairings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['thread', 'resolution', 'reason'],
        properties: {
          thread: { type: 'integer', description: 'Id of the open thread (the number after T)' },
          resolution: { type: 'integer', description: 'Id of the resolution that settles it (the number after R)' },
          reason: { type: 'string', description: 'One sentence on why the two make one clip' }
        }
      }
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lineNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  // Non-strict providers sometimes send "#12" or "12".
  if (typeof value === 'string' && /^\s*#?\d+\s*$/.test(value)) return Number(value.replace(/[#\s]/g, ''))
  return null
}

function label(value: unknown, max = MAX_LABEL_CHARS): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

/**
 * Items of one list from a reply, kept only when both line numbers are whole
 * numbers inside [lo, hi] in order and the label is not empty. An item out of
 * range is dropped, never clamped: a clamped range points at lines the model
 * did not mean. A kind outside the list becomes the fallback (chapters) or
 * drops the item (threads and resolutions, whose kind is what they are).
 */
function rangeItems<K extends string>(
  value: unknown,
  lo: number,
  hi: number,
  kinds: readonly K[],
  max: number,
  fallback?: K
): Array<LineRange & { label: string; kind: K }> {
  if (!Array.isArray(value)) return []
  const out: Array<LineRange & { label: string; kind: K }> = []
  for (const item of value) {
    if (!record(item)) continue
    const startLine = lineNumber(item.start_line)
    const endLine = lineNumber(item.end_line)
    const text = label(item.label)
    if (startLine === null || endLine === null || text === null) continue
    if (startLine < lo || endLine > hi || endLine < startLine) continue
    const kind = kinds.includes(item.kind as K) ? item.kind as K : fallback
    if (!kind) continue
    out.push({ startLine, endLine, label: text, kind })
    if (out.length >= max) break
  }
  return out
}

export interface OutlinePart {
  chapters: OutlineChapter[]
  threads: OutlineThread[]
  resolutions: OutlineResolution[]
}

/**
 * Validate one part's reply against the line numbers that part showed
 * ([lo, hi]). Exported for tests.
 */
export function validateOutlinePart(reply: unknown, lo: number, hi: number): OutlinePart {
  const res = record(reply) ? reply : {}
  return {
    chapters: rangeItems(res.chapters, lo, hi, CHAPTER_KINDS, MAX_PART_CHAPTERS, 'other'),
    threads: rangeItems(res.open_threads, lo, hi, THREAD_KINDS, MAX_PART_THREADS),
    resolutions: rangeItems(res.resolutions, lo, hi, RESOLUTION_KINDS, MAX_PART_RESOLUTIONS)
  }
}

/**
 * Validate the matching step's reply: each pairing must name a known thread
 * and a known resolution, the resolution must start after the thread ends,
 * and each pair counts once. Order is kept, since it is the ranking.
 * Exported for tests.
 */
export function validatePairings(reply: unknown, threads: OutlineThread[], resolutions: OutlineResolution[]): OutlinePairing[] {
  const items = record(reply) && Array.isArray(reply.pairings) ? reply.pairings : []
  const out: OutlinePairing[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!record(item)) continue
    const t = lineNumber(item.thread)
    const r = lineNumber(item.resolution)
    const thread = t === null ? undefined : threads[t]
    const resolution = r === null ? undefined : resolutions[r]
    if (!thread || !resolution || resolution.startLine <= thread.endLine) continue
    const key = `${thread.startLine}-${thread.endLine}:${resolution.startLine}-${resolution.endLine}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      setup: { startLine: thread.startLine, endLine: thread.endLine },
      payoff: { startLine: resolution.startLine, endLine: resolution.endLine },
      setupLabel: thread.label,
      payoffLabel: resolution.label,
      reason: label(item.reason, MAX_REASON_CHARS) ?? ''
    })
    if (out.length >= MAX_OUTLINE_PAIRINGS) break
  }
  return out
}

/** Items from neighbouring parts' overlap can come back twice; keep the first. */
function dedupeItems<T extends LineRange & { kind: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.startLine}-${item.endLine}-${item.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validRange(value: unknown, lineCount: number): value is LineRange {
  return record(value) && Number.isInteger(value.startLine) && Number.isInteger(value.endLine) &&
    (value.startLine as number) >= 0 && (value.endLine as number) < lineCount && (value.endLine as number) >= (value.startLine as number)
}

function validLabelled(value: unknown, lineCount: number, kinds: readonly string[]): boolean {
  if (!validRange(value, lineCount)) return false
  const { label: text, kind } = value as LineRange & { label?: unknown; kind?: unknown }
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_LABEL_CHARS && kinds.includes(kind as string)
}

/**
 * A stored outline, checked again before use: everything a cache file holds
 * is re-validated against the current transcript's line count, as if the
 * model had just sent it. Null when anything is off. Exported for tests.
 */
export function validateOutline(value: unknown, lineCount: number): VideoOutline | null {
  if (!record(value) || value.version !== OUTLINE_VERSION || value.lineCount !== lineCount) return null
  const { chapters, threads, resolutions, pairings } = value
  if (!Array.isArray(chapters) || !Array.isArray(threads) || !Array.isArray(resolutions) || !Array.isArray(pairings)) return null
  if (!chapters.every((c) => validLabelled(c, lineCount, CHAPTER_KINDS))) return null
  if (!threads.every((t) => validLabelled(t, lineCount, THREAD_KINDS))) return null
  if (!resolutions.every((r) => validLabelled(r, lineCount, RESOLUTION_KINDS))) return null
  if (pairings.length > MAX_OUTLINE_PAIRINGS) return null
  const pairingsOk = pairings.every((p) =>
    record(p) && validRange(p.setup, lineCount) && validRange(p.payoff, lineCount) &&
    p.payoff.startLine > p.setup.endLine &&
    typeof p.setupLabel === 'string' && typeof p.payoffLabel === 'string' &&
    typeof p.reason === 'string' && p.reason.length <= MAX_REASON_CHARS)
  if (!pairingsOk) return null
  return value as unknown as VideoOutline
}

/**
 * The cache key: the outline depends on the sentence texts (and so their
 * count), the provider and the model, and on nothing the creator chooses per
 * run. Sentence times are left out on purpose: the outline speaks in line
 * numbers, which stay right as long as the lines are the same text.
 * Exported for tests.
 */
export function outlineCacheKey(sentences: Sentence[], model: string, providerCacheKey = ''): string {
  const hash = createHash('sha256').update(JSON.stringify({
    version: OUTLINE_VERSION,
    model,
    provider: usesSubscription() ? 'subscription' : chatApiBase(),
    providerCacheKey,
    lineCount: sentences.length
  }))
  // Streamed line by line rather than joined into one large string.
  for (const s of sentences) hash.update(JSON.stringify(s.text))
  return hash.digest('hex')
}

async function readCachedOutline(path: string, key: string, lineCount: number, signal?: AbortSignal): Promise<VideoOutline | null> {
  try {
    if ((await stat(path)).size > MAX_CACHE_BYTES) return null
    const cached: unknown = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
    if (!record(cached) || cached.key !== key) return null
    return validateOutline(cached.outline, lineCount)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function writeCachedOutline(dir: string, path: string, key: string, outline: VideoOutline, signal?: AbortSignal): Promise<void> {
  // Written beside the target and renamed over it, so a crash mid-write never
  // leaves a half file that a later run would have to reject.
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temporary, JSON.stringify({ key, outline }), { signal })
    signal?.throwIfAborted()
    await rename(temporary, path)
    // One file per transcript and model: regenerating with other models, or
    // after a transcript edit, would otherwise pile them up in the project.
    await pruneDirectory(dir, { maxEntries: OUTLINE_CACHE_ENTRIES, match: name => name.startsWith('outline-') })
  } catch (err) {
    signal?.throwIfAborted()
    // A cache that cannot be written costs the next run its requests, nothing more.
    console.error('Could not save the video outline cache:', err)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A line as the outline requests show it: number and text, no times. */
function outlineLine(s: Sentence): string {
  // Times are left out: the outline is about what is said where, not how
  // long it runs, and on a two-hour transcript they are a fifth of the text.
  return `#${s.index} ${s.text}`
}

export interface BuildOutlineOptions {
  apiKey: string
  model: string
  /** Every sentence of the transcript; a sentence's index is its line number. */
  sentences: Sentence[]
  /** The parts to map, each a run of consecutive sentences; see planOutlineWindows in highlights.ts. */
  windows: Sentence[][]
  /** Where to keep the outline between runs; no caching without it. */
  cacheDir?: string
  /** The effective provider and model identity (e.g. the ChatGPT model behind sign-in). */
  providerCacheKey?: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/**
 * The outline of the whole transcript, from the cache when a valid one is
 * there, otherwise built with one request per window plus one to match
 * threads to resolutions (none when there is nothing to match). Returns null
 * when any request fails: a partial outline would quietly miss whatever the
 * failed part held, so the run goes on without long-range joins and nothing
 * is cached. Cancellation and subscription errors propagate.
 */
export async function buildVideoOutline(opts: BuildOutlineOptions): Promise<VideoOutline | null> {
  const { apiKey, model, sentences, windows, signal } = opts
  if (sentences.length === 0 || windows.length === 0) return null
  const key = outlineCacheKey(sentences, model, opts.providerCacheKey)
  const cachePath = opts.cacheDir ? join(opts.cacheDir, `outline-${key}.json`) : null
  if (cachePath) {
    const cached = await readCachedOutline(cachePath, key, sentences.length, signal)
    if (cached) return cached
  }

  const parts: OutlinePart[] = new Array(windows.length)
  let failure: unknown = null
  let finished = 0
  opts.onProgress?.(`Mapping the video (0/${windows.length})…`)
  await mapLimit(windows, OUTLINE_CONCURRENCY, async (lines, i) => {
    signal?.throwIfAborted()
    // One part has failed, so the outline will not be used: spend no more requests on it.
    if (failure !== null || lines.length === 0) return
    const lo = lines[0].index
    const hi = lines[lines.length - 1].index
    try {
      const reply = await chatJSON<unknown>(
        apiKey,
        model,
        [
          { role: 'system', content: MAP_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `This is part ${i + 1} of ${windows.length} of the transcript, lines #${lo} to #${hi}. The other parts are mapped separately.`,
              'Transcript, one sentence per line, each prefixed with its line number:',
              lines.map(outlineLine).join('\n')
            ].join('\n\n')
          }
        ],
        'outline_part',
        MAP_SCHEMA,
        signal
      )
      parts[i] = validateOutlinePart(reply, lo, hi)
    } catch (err) {
      throwIfSubscriptionError(err)
      if (signal?.aborted) throw err
      failure ??= err
      return
    }
    finished++
    opts.onProgress?.(`Mapping the video (${finished}/${windows.length})…`)
  })
  if (failure !== null) {
    console.error('Video outline failed; distant moments will not be joined this run:', failure)
    return null
  }

  const chapters = dedupeItems(parts.flatMap((p) => p?.chapters ?? []))
  // Each item remembers its part, which the matching step is shown.
  const threads: Array<OutlineThread & { part: number }> = []
  const resolutions: Array<OutlineResolution & { part: number }> = []
  parts.forEach((p, part) => {
    for (const t of p?.threads ?? []) threads.push({ ...t, part })
    for (const r of p?.resolutions ?? []) resolutions.push({ ...r, part })
  })
  const uniqueThreads = dedupeItems(threads)
  const uniqueResolutions = dedupeItems(resolutions)

  let pairings: OutlinePairing[] = []
  // Nothing to match, nothing to ask: the outline is complete without a pairing.
  if (uniqueThreads.length > 0 && uniqueResolutions.length > 0) {
    opts.onProgress?.('Matching setups to payoffs…')
    const range = (item: LineRange): string => item.startLine === item.endLine ? `#${item.startLine}` : `#${item.startLine}-#${item.endLine}`
    const user = [
      `The video's transcript has ${sentences.length} lines (#0 to #${sentences.length - 1}), mapped in ${windows.length} parts.`,
      `Return at most ${MAX_OUTLINE_PAIRINGS} matches.`,
      'Chapters:',
      chapters.map((c) => `${range(c)} (${c.kind}) ${c.label}`).join('\n') || '(none)',
      'Open threads:',
      uniqueThreads.map((t, i) => `T${i} part ${t.part + 1}, ${range(t)} (${t.kind}) ${t.label}`).join('\n'),
      'Resolutions:',
      uniqueResolutions.map((r, i) => `R${i} part ${r.part + 1}, ${range(r)} (${r.kind}) ${r.label}`).join('\n')
    ].join('\n\n')
    try {
      const reply = await chatJSON<unknown>(
        apiKey,
        model,
        [
          { role: 'system', content: REDUCE_SYSTEM_PROMPT },
          { role: 'user', content: user }
        ],
        'outline_pairings',
        REDUCE_SCHEMA,
        signal
      )
      pairings = validatePairings(reply, uniqueThreads, uniqueResolutions)
    } catch (err) {
      throwIfSubscriptionError(err)
      if (signal?.aborted) throw err
      console.error('Video outline matching failed; distant moments will not be joined this run:', err)
      return null
    }
  }

  const strip = <T extends { part: number }>({ part: _part, ...item }: T): Omit<T, 'part'> => item
  const outline: VideoOutline = {
    version: OUTLINE_VERSION,
    lineCount: sentences.length,
    chapters,
    threads: uniqueThreads.map(strip),
    resolutions: uniqueResolutions.map(strip),
    pairings
  }
  if (process.env.CUTAWAN_DEBUG) console.error('[outline] pairings:', JSON.stringify(pairings, null, 2))
  if (opts.cacheDir && cachePath) await writeCachedOutline(opts.cacheDir, cachePath, key, outline, signal)
  return outline
}
