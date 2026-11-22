import type { Clip, Transcript, TranscriptWord } from './types'
import { emphasisKey, emphasisScores, isEmphasisCandidate } from './captionEmphasis'
import { isFiller, TimeMap, type KeptSegment } from './tighten'

/**
 * Cold open: replay the clip's strongest short line at the very start, then
 * play the clip from its beginning. The line is chosen here, deterministically,
 * so the preview and the export replay the same words.
 *
 * The line is 1-4 seconds of whole words, inside one kept segment (so the
 * teaser itself has no jump cut), and starts at least ~8 seconds into the
 * edit, so the viewer meets it again later rather than straight away. It is
 * the stretch that best matches the clip's hook text when one does; otherwise
 * the most energetic, punchiest line.
 */

export const COLD_OPEN_MIN_SEC = 1
export const COLD_OPEN_MAX_SEC = 4
/** The line must start at least this far into the edited clip. */
export const COLD_OPEN_MIN_OFFSET_SEC = 8
/** A pause longer than this ends a phrase. */
const PHRASE_PAUSE_SEC = 0.45
/** A replay this close to its natural length reads best. */
const IDEAL_SEC = 2.6
/** Breathing room around the words, inside the neighbouring words' gaps. */
const LEAD_SEC = 0.08
const TAIL_SEC = 0.2
/** A part of a long sentence needs at least this many words to stand alone. */
const MIN_PARTIAL_WORDS = 3
/** How much a part of a sentence ranks below a whole phrase. */
const PARTIAL_PENALTY = 0.2

export type ColdOpenClip = Pick<Clip, 'edit' | 'hook'>

interface Candidate {
  words: TranscriptWord[]
  segment: KeptSegment
  hookScore: number
  hookMatches: number
  score: number
}

/**
 * The source range to replay first, or null when the clip has no line that
 * qualifies (too short, no speech far enough in). `main` is the clip's kept
 * segments in play order (clipKeptSegments, or the whole trim).
 */
export function planColdOpen(
  transcript: Transcript | null,
  clip: ColdOpenClip,
  main: KeptSegment[]
): KeptSegment | null {
  if (!transcript || main.length === 0) return null
  const map = new TimeMap(main)
  if (map.outputDuration < COLD_OPEN_MIN_OFFSET_SEC + COLD_OPEN_MIN_SEC + 2) return null
  const segmentOf = (w: TranscriptWord): KeptSegment | undefined => {
    const mid = (w.start + w.end) / 2
    return main.find((s) => mid >= s.start && mid <= s.end)
  }
  const words = transcript.segments.flatMap((s) => s.words)
    .filter((w) => w.text.trim().length > 0 && !isFiller(w.sourceText ?? w.text) && segmentOf(w))
    .sort((a, b) => a.start - b.start)
  if (words.length < 3) return null

  // Phrases: runs of words broken at punctuation, a pause or a cut.
  const phrases: TranscriptWord[][] = []
  let current: TranscriptWord[] = []
  words.forEach((w, i) => {
    current.push(w)
    const next = words[i + 1]
    if (!next || /[.!?,;:]["'”’)]*$/.test(w.text) || next.start - w.end > PHRASE_PAUSE_SEC || segmentOf(next) !== segmentOf(w)) {
      phrases.push(current)
      current = []
    }
  })

  const hookKeys = new Set((clip.hook ?? '').split(/\s+/).filter(isEmphasisCandidate).map(emphasisKey))
  const energyAt = (t: number): number =>
    transcript.segments.find((s) => t >= s.start && t <= s.end)?.energy ?? 0.5
  const scores = emphasisScores(words, { hook: clip.hook })
  const strength = new Map(words.map((w, i) => [w, scores[i]]))

  const candidates: Candidate[] = []
  /** Score a run of words as a cold open; `partial` runs cut a sentence and rank lower. */
  const consider = (run: TranscriptWord[], partial: boolean): void => {
    const first = run[0], last = run[run.length - 1]
    const duration = last.end - first.start
    const segment = segmentOf(first)
    if (!segment || segmentOf(last) !== segment) return
    if (duration < COLD_OPEN_MIN_SEC || duration > COLD_OPEN_MAX_SEC) return
    if (map.toOutput(first.start) < COLD_OPEN_MIN_OFFSET_SEC) return
    const keys = new Set(run.map((w) => emphasisKey(w.text)))
    const hookMatches = [...hookKeys].filter((k) => keys.has(k)).length
    const hookScore = hookKeys.size ? hookMatches / hookKeys.size : 0
    const fit = Math.max(0, 1 - Math.abs(duration - IDEAL_SEC) / 3)
    const ending = /[.!?]["'”’)]*$/.test(last.text) ? (/[!?]/.test(last.text) ? 0.25 : 0.15) : 0
    const punch = run.reduce((sum, w) => sum + Math.min(4, strength.get(w) ?? 0), 0) / (run.length * 4)
    const energy = energyAt((first.start + last.end) / 2)
    candidates.push({
      words: run,
      segment,
      hookScore,
      hookMatches,
      score: energy + ending + punch * 0.6 + fit * 0.25 - (partial ? PARTIAL_PENALTY : 0)
    })
  }
  for (let i = 0; i < phrases.length; i++) {
    let run: TranscriptWord[] = []
    for (let j = i; j < phrases.length; j++) {
      run = [...run, ...phrases[j]]
      if (run[run.length - 1].end - run[0].start > COLD_OPEN_MAX_SEC) break
      consider(run, false)
    }
    // A sentence too long to replay whole still offers its opening words or
    // its punchline: the longest head and tail that fit.
    const phrase = phrases[i]
    if (phrase[phrase.length - 1].end - phrase[0].start > COLD_OPEN_MAX_SEC) {
      let head = phrase.length
      while (head > MIN_PARTIAL_WORDS && phrase[head - 1].end - phrase[0].start > COLD_OPEN_MAX_SEC) head--
      if (head >= MIN_PARTIAL_WORDS) consider(phrase.slice(0, head), true)
      let tail = 0
      while (phrase.length - tail > MIN_PARTIAL_WORDS && phrase[phrase.length - 1].end - phrase[tail].start > COLD_OPEN_MAX_SEC) tail++
      if (phrase.length - tail >= MIN_PARTIAL_WORDS) consider(phrase.slice(tail), true)
    }
  }
  if (!candidates.length) return null

  // The hook decides when the line clearly echoes it; energy otherwise.
  const echoes = candidates.filter((c) => c.hookMatches >= Math.min(2, hookKeys.size) && c.hookScore >= 0.34)
  const pool = echoes.length ? echoes : candidates
  const rank = (c: Candidate): number => (echoes.length ? c.hookScore * 2 : 0) + c.score
  const best = pool.reduce((a, b) => (rank(b) > rank(a) + 1e-9 ? b : a))

  const first = best.words[0], last = best.words[best.words.length - 1]
  const before = words[words.indexOf(first) - 1]
  const after = words[words.indexOf(last) + 1]
  const start = Math.max(best.segment.start, first.start - LEAD_SEC, before ? Math.min(first.start, before.end) : -Infinity)
  const end = Math.min(best.segment.end, last.end + TAIL_SEC, after ? Math.max(last.end, after.start - 0.02) : Infinity)
  return end - start >= COLD_OPEN_MIN_SEC * 0.9 ? { start, end } : null
}
