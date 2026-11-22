import type { Transcript, TranscriptSegment, TranscriptWord } from '@shared/types'
import { transcribeAudioFile, type TranscriptionPlan, type WhisperResponse, type WhisperSegment } from './openai'
import { mapLimit } from './concurrency'
import type { AudioChunk } from './ffmpeg'
import { runFfmpeg } from './ffmpeg'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { needsSeamRepair, repairTranscriptSeam } from './transcriptSeams'

/**
 * Chunked transcription with overlap-aware stitching. Consecutive audio
 * chunks overlap by a few seconds so Whisper sees full context on both sides
 * of a boundary; the stitcher then takes each word from the single chunk
 * whose responsibility window owns its timestamp. Since independent decodes
 * can omit opening speech or disagree on timing, suspect joins receive a
 * short audio re-decode anchored to matching words on both sides.
 */

export interface ChunkResult {
  chunk: AudioChunk
  res: WhisperResponse
}

/**
 * Whisper's own thresholds for treating a decoded segment as silence: it
 * only trusts a high no-speech probability when the text it produced is also
 * low-confidence. A segment failing both is what it emits over music, room
 * tone and dead air — "Thank you for watching", a repeated phrase, a stray
 * sentence in another language.
 */
export const NO_SPEECH_THRESHOLD = 0.6
export const LOGPROB_THRESHOLD = -1.0
/**
 * gzip ratio of the segment text above which the decoder has looped. Real
 * speech compresses to roughly 1.3–1.8; "you you you you you" goes far past
 * this. Whisper itself uses the same cut-off to reject a decoding attempt.
 */
export const COMPRESSION_RATIO_THRESHOLD = 2.4

/**
 * Whether a Whisper segment is a decoder hallucination rather than speech.
 * Segments without diagnostics are trusted. Pure and exported for tests.
 */
export function isHallucinatedSegment(seg: WhisperSegment): boolean {
  if (seg.compression_ratio !== undefined && seg.compression_ratio > COMPRESSION_RATIO_THRESHOLD) {
    return true
  }
  return (
    seg.no_speech_prob !== undefined &&
    seg.avg_logprob !== undefined &&
    seg.no_speech_prob > NO_SPEECH_THRESHOLD &&
    seg.avg_logprob < LOGPROB_THRESHOLD
  )
}

/** Shortest a word may be on screen; shorter looks like a flicker. */
export const MIN_WORD_SEC = 0.05
/** Length given to a word Whisper reported with no duration at all. */
const FILL_WORD_SEC = 0.15

/**
 * Make word timings usable for karaoke captions: sorted, non-overlapping and
 * every word at least `MIN_WORD_SEC` long. Whisper word timestamps are noisy
 * at the edges — a word can start before the previous one ends, or have zero
 * (even negative) length — and the caption generators drop any word whose
 * window is empty, so such a word would never light up. Mutates and returns
 * the array. Pure and exported for tests.
 */
export function normalizeWordTimings(words: TranscriptWord[]): TranscriptWord[] {
  words.sort((a, b) => a.start - b.start)
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const prev = words[i - 1]
    if (prev && word.start < prev.end) word.start = prev.end
    const floor = word.start + MIN_WORD_SEC
    if (word.end < floor) {
      const next = words[i + 1]
      const natural = word.start + FILL_WORD_SEC
      // Grow into the gap before the next word when there is one; otherwise
      // take the minimum and let the next word be nudged along on its turn.
      word.end = next ? (next.start >= floor ? Math.min(natural, next.start) : floor) : natural
    }
  }
  return words
}

/**
 * Merge per-chunk Whisper responses into one transcript with absolute
 * timestamps. Pure and exported for unit tests.
 *
 * - Hallucinated segments (see isHallucinatedSegment) are dropped, along
 *   with the words Whisper placed inside them.
 * - Words: kept from the chunk whose [keepFromSec, keepToSec) window contains
 *   their start. This gives disjoint ownership of timestamps, not a guarantee
 *   that independently decoded word sequences agree; join repair runs later.
 * - Segments: kept when their start falls in the window (Whisper segments the
 *   overlap region differently per chunk, so exact segment tiling is
 *   impossible; starts are a stable rule).
 * - Each word is then assigned to the last kept segment starting at or before
 *   it, guaranteeing every word appears in exactly one segment even when
 *   segments from different chunks overlap around a boundary.
 */
export function stitchChunkResults(results: ChunkResult[]): Transcript {
  let language = 'english'
  let duration = 0

  const pool: TranscriptWord[] = []
  const segments: TranscriptSegment[] = []

  for (const { chunk, res } of results) {
    language = res.language ?? language
    duration = Math.max(duration, chunk.offsetSec + (res.duration ?? 0))
    const inWindow = (absStart: number): boolean =>
      absStart >= chunk.keepFromSec && absStart < chunk.keepToSec

    // Spans (chunk-local seconds) of segments judged to be hallucinations;
    // words falling inside them go too.
    const dropped: Array<[number, number]> = []
    for (const seg of res.segments ?? []) {
      if (isHallucinatedSegment(seg)) dropped.push([seg.start, seg.end])
    }
    const inDropped = (localMid: number): boolean =>
      dropped.some(([from, to]) => localMid >= from && localMid <= to)

    for (const w of res.words ?? []) {
      const start = w.start + chunk.offsetSec
      if (!inWindow(start)) continue
      if (dropped.length > 0 && inDropped((w.start + w.end) / 2)) continue
      const text = w.word.trim()
      if (text.length === 0) continue
      pool.push({ text, start, end: w.end + chunk.offsetSec })
    }

    for (const seg of res.segments ?? []) {
      const start = seg.start + chunk.offsetSec
      if (!inWindow(start)) continue
      if (isHallucinatedSegment(seg)) continue
      segments.push({
        id: 0, // renumbered after sorting
        text: seg.text.trim(),
        start,
        end: seg.end + chunk.offsetSec,
        words: []
      })
    }
  }

  normalizeWordTimings(pool)
  segments.sort((a, b) => a.start - b.start)
  segments.forEach((seg, i) => (seg.id = i))

  // Assign each word to the last segment starting at or before it (with a
  // small epsilon so words exactly on a segment boundary land in one place).
  let segIdx = 0
  for (const word of pool) {
    while (segIdx + 1 < segments.length && segments[segIdx + 1].start <= word.start + 0.01) {
      segIdx++
    }
    if (segments.length > 0) segments[segIdx].words.push(word)
  }
  // Words can outrun a segment's Whisper-reported end near chunk boundaries.
  for (const seg of segments) {
    const lastWord = seg.words[seg.words.length - 1]
    if (lastWord) seg.end = Math.max(seg.end, lastWord.end)
  }

  return { language, durationSec: duration, segments }
}

/**
 * Text of a chunk with hallucinated segments removed, for priming the next
 * chunk. Feeding a hallucination back in as the prompt is the classic way
 * Whisper is talked into repeating it for the rest of the file.
 */
export function trustedChunkText(res: WhisperResponse, beforeSec = Infinity): string {
  const segments = res.segments
  if (!segments || segments.length === 0) return beforeSec === Infinity ? res.text ?? '' : ''
  return segments
    .filter((seg) => seg.end <= beforeSec && !isHallucinatedSegment(seg))
    .map((seg) => seg.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** Text of chunk `index` up to where the next chunk's audio begins. */
function tailBeforeNext(chunks: AudioChunk[], index: number, res: WhisperResponse): string {
  const next = chunks[index + 1]
  // The prompt describes preceding audio, never the overlapping opening of
  // the next file: that text has not yet been decoded by the next request.
  return trustedChunkText(res, next ? next.offsetSec - chunks[index].offsetSec : Infinity).slice(-600)
}

/**
 * Transcribe all audio chunks, stitch the results, then check sustained
 * overlap disagreements against audio.
 *
 * By default chunks go one at a time, each primed with the text just before
 * it. A `plan` with more concurrency sends several at once (see
 * `transcriptionPlan`); the stitching and join repair are the same either
 * way, since every chunk is decoded independently in both.
 */
export async function transcribeChunks(
  apiKey: string,
  model: string,
  chunks: AudioChunk[],
  language: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  plan: TranscriptionPlan = { concurrency: 1, context: 'previous' }
): Promise<Transcript> {
  const results: ChunkResult[] = new Array(chunks.length)
  let finished = 0
  const transcribe = async (i: number, contextPrompt: string, requestSignal?: AbortSignal): Promise<WhisperResponse> => {
    requestSignal?.throwIfAborted()
    const res = await transcribeAudioFile(apiKey, chunks[i].path, model, {
      contextPrompt: contextPrompt || undefined,
      language,
      signal: requestSignal
    })
    results[i] = { chunk: chunks[i], res }
    finished++
    onProgress?.((finished / chunks.length) * (chunks.length > 1 ? 0.9 : 1))
    return res
  }

  if (plan.concurrency <= 1 || plan.context === 'previous') {
    let previousTail = ''
    for (let i = 0; i < chunks.length; i++) {
      previousTail = tailBeforeNext(chunks, i, await transcribe(i, previousTail, signal))
    }
  } else {
    // A failed chunk stops the others: every request still running is billed.
    const group = new AbortController()
    const groupSignal = signal ? AbortSignal.any([signal, group.signal]) : group.signal
    let guide = ''
    let rest = chunks.map((_, i) => i)
    if (plan.context === 'first' && chunks.length > 0) {
      // The opening, not the end, of the first chunk: hosts introduce the
      // guest and the names Whisper needs to spell at the start.
      const first = await transcribe(0, '', signal)
      guide = trustedChunkText(first, chunks[1] ? chunks[1].offsetSec - chunks[0].offsetSec : Infinity).slice(0, 600)
      rest = rest.slice(1)
    }
    await mapLimit(rest, plan.concurrency, async (i) => {
      try {
        await transcribe(i, guide, groupSignal)
      } catch (error) {
        group.abort()
        throw error
      }
    })
    signal?.throwIfAborted()
  }

  let transcript = stitchChunkResults(results)
  for (let i = 1; i < results.length; i++) {
    signal?.throwIfAborted()
    const left = results[i - 1], right = results[i]
    const seam = right.chunk.keepFromSec
    const complete = (r: ChunkResult): Transcript => stitchChunkResults([{
      ...r, chunk: { ...r.chunk, keepFromSec: 0, keepToSec: Infinity }
    }])
    const from = Math.max(left.chunk.offsetSec, seam - 20)
    const end = Math.min(right.chunk.offsetSec + (right.res.duration ?? 0), seam + 20)
    if (seam - from >= 16 && end - seam >= 16 && needsSeamRepair(complete(left), complete(right), seam)) {
      let temporary: string | undefined
      try {
        temporary = await mkdtemp(join(tmpdir(), 'cutawan-seam-'))
        const path = join(temporary, 'audio.wav')
        // One contiguous source interval, assembled from the already decoded
        // upload files. Split at the source seam; do not concatenate overlap.
        await runFfmpeg([
          '-i', left.chunk.path, '-i', right.chunk.path,
          '-filter_complex',
          `[0:a]atrim=start=${from - left.chunk.offsetSec}:end=${seam - left.chunk.offsetSec},asetpts=PTS-STARTPTS[l];` +
          `[1:a]atrim=start=${seam - right.chunk.offsetSec}:end=${end - right.chunk.offsetSec},asetpts=PTS-STARTPTS[r];` +
          '[l][r]concat=n=2:v=0:a=1[a]',
          '-map', '[a]', '-ac', '1', '-ar', '16000', path
        ], { signal })
        const response = await transcribeAudioFile(apiKey, path, model, { language, signal })
        const patch = stitchChunkResults([{
          chunk: { path, offsetSec: from, keepFromSec: 0, keepToSec: Infinity }, res: response
        }])
        const repair = repairTranscriptSeam(transcript, patch, seam)
        transcript = repair.transcript
        if (!repair.applied) console.warn(`[cutawan] Transcript join ${seam}s retained: ${repair.reason}`)
      } catch (error) {
        signal?.throwIfAborted()
        console.warn(`[cutawan] Transcript join ${seam}s could not be checked:`, error)
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    onProgress?.(0.9 + 0.1 * i / (results.length - 1))
  }
  return transcript
}
