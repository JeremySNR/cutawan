import type { TimeRange } from './types'

/**
 * Retake removal: when a speaker restarts a sentence ("So the reason —
 * sorry, so the reason we did it was…") or says a sentence again almost
 * word for word, only the last take is kept. Pure and shared, so the preview
 * and the export cut the same words; pause removal (tighten.ts) applies the
 * result as automatic removals the user can restore with a click.
 *
 * Deliberately conservative. Repetition is also a rhetorical device ("never,
 * never give up", "we will fight on the beaches, we will fight on the
 * landing grounds"), and cutting one of those is far worse than leaving a
 * retake in. So each rule needs both textual evidence and a sign that the
 * first attempt was abandoned:
 *
 * - Repeated take: two phrases at most two apart, starting within
 *   REPEAT_WINDOW_SEC, each at least MIN_TAKE_WORDS long, whose word
 *   bigrams overlap with a Dice coefficient of at least MIN_DICE, and which
 *   either end the same way or the earlier, unfinished one is wholly
 *   contained in the later one (a take cut short). Anaphora shares its opening but not its
 *   ending, so it survives.
 * - False start: an opening of at least MIN_RESTART_WORDS words, spoken again
 *   within MAX_ABANDONED_WORDS words and RESTART_WINDOW_SEC, where the
 *   restart carries on past the repeated words (so "never give up, never
 *   give up!" is left alone) and something marks the first attempt as
 *   abandoned: a filler, an apology or self-correction, a dash or ellipsis,
 *   or a hesitation pause.
 */

export interface RetakeWord {
  text: string
  start: number
  end: number
  /** "um", "uh"… — never part of a take, but evidence of hesitation. */
  filler: boolean
}

/** A removed take: the words dropped and the word the speaker restarted on. */
export interface Retake {
  /** Index (into the words given) of the first word dropped. */
  first: number
  /** Index of the last word dropped. */
  last: number
  /** Index of the first word of the take that is kept. */
  restart: number
  kind: 'repeat' | 'false-start'
}

/** Bigram Dice coefficient a repeated take must reach. */
const MIN_DICE = 0.7
/** Shortest phrase (non-filler words) compared as a repeated take. */
const MIN_TAKE_WORDS = 4
/** A repeat must start within this of the take it replaces. */
const REPEAT_WINDOW_SEC = 20
/** Phrases compared at most this many apart (one phrase may sit between). */
const MAX_PHRASE_DISTANCE = 2
/** A phrase between two takes is dropped with them only when this short ("sorry, let me start again"). */
const MAX_BETWEEN_WORDS = 6
const MAX_BETWEEN_SEC = 3
/** A pause this long between words starts a new phrase. */
const PHRASE_PAUSE_SEC = 0.6
/** Words a false start's repeated opening needs ("so the", "I think"). */
const MIN_RESTART_WORDS = 2
/** Longest abandoned attempt, in non-filler words. */
const MAX_ABANDONED_WORDS = 8
const RESTART_WINDOW_SEC = 8
/** Words the restart must carry on for past the repeated opening. */
const MIN_CONTINUATION_WORDS = 2
/** A silence this long before the restart reads as a hesitation. */
const HESITATION_SEC = 0.4

/** Words a speaker uses to abandon what they were saying. */
const EDIT_TERMS = new Set(['sorry', 'wait', 'rather', 'actually', 'oops', 'pardon'])
const EDIT_PHRASES = [['i', 'mean'], ['let', 'me', 'start', 'again'], ['let', 'me', 'try', 'again'],
  ['let', 'me', 'rephrase'], ['start', 'again'], ['scratch', 'that']]

/** Lower case letters and digits only; apostrophes dropped ("we've" -> "weve"). */
export function normaliseWord(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '')
}

const endsSentence = (text: string): boolean => /[.!?]["'”’)]*$/.test(text.trim())
const trailsOff = (text: string): boolean => /(?:—|–|-{1,2}|\.{3}|…)["'”’)]*$/.test(text.trim())

interface Token { norm: string; index: number }

function bigrams(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`)
  return out
}

/** Dice coefficient over bigram multisets. */
export function bigramDice(a: string[], b: string[]): number {
  const x = bigrams(a), y = bigrams(b)
  if (!x.length || !y.length) return 0
  const counts = new Map<string, number>()
  for (const g of y) counts.set(g, (counts.get(g) ?? 0) + 1)
  let shared = 0
  for (const g of x) {
    const n = counts.get(g) ?? 0
    if (n > 0) { shared++; counts.set(g, n - 1) }
  }
  return (2 * shared) / (x.length + y.length)
}

/** Share of `a`'s bigrams that also occur in `b`. */
function containment(a: string[], b: string[]): number {
  const x = bigrams(a), y = new Set(bigrams(b))
  return x.length ? x.filter(g => y.has(g)).length / x.length : 0
}

/** Phrases as runs of non-filler tokens, split at sentence ends, trailing dashes and pauses. */
function phrases(words: RetakeWord[]): Token[][] {
  const out: Token[][] = []
  let current: Token[] = []
  let previous: RetakeWord | null = null
  words.forEach((word, index) => {
    if (previous && (endsSentence(previous.text) || trailsOff(previous.text) || word.start - previous.end >= PHRASE_PAUSE_SEC) &&
        current.length) {
      out.push(current)
      current = []
    }
    previous = word
    if (word.filler) return
    const norm = normaliseWord(word.text)
    if (norm) current.push({ norm, index })
  })
  if (current.length) out.push(current)
  return out
}

function endingsAgree(a: string[], b: string[]): boolean {
  const last = `${a[a.length - 2]} ${a[a.length - 1]}`
  return bigrams(b.slice(-4)).includes(last)
}

function repeatedTakes(words: RetakeWord[]): Retake[] {
  const list = phrases(words)
  const out: Retake[] = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a.length < MIN_TAKE_WORDS) continue
    for (let j = i + 1; j <= Math.min(list.length - 1, i + MAX_PHRASE_DISTANCE); j++) {
      const b = list[j]
      if (b.length < MIN_TAKE_WORDS) continue
      if (words[b[0].index].start - words[a[0].index].start > REPEAT_WINDOW_SEC) break
      const x = a.map(t => t.norm), y = b.map(t => t.norm)
      if (bigramDice(x, y) < MIN_DICE) continue
      // Contained in the later take counts only when the earlier one was
      // left unfinished: "I came here to win. I came here to win and
      // nothing else." builds on a finished sentence.
      const unfinished = !endsSentence(words[a[a.length - 1].index].text)
      if (!endingsAgree(x, y) && !(unfinished && x.length < y.length && containment(x, y) >= 0.9)) continue
      // A phrase between the takes goes with the first one only when it is
      // an aside ("sorry, let me say that again"), not more content.
      if (j === i + 2) {
        const between = list[i + 1]
        const span = words[between[between.length - 1].index].end - words[between[0].index].start
        if (between.length > MAX_BETWEEN_WORDS || span > MAX_BETWEEN_SEC) continue
      }
      out.push({ first: a[0].index, last: b[0].index - 1, restart: b[0].index, kind: 'repeat' })
      break
    }
  }
  return out
}

function hasEditTerm(tokens: string[]): boolean {
  if (tokens.some(t => EDIT_TERMS.has(t))) return true
  return EDIT_PHRASES.some(phrase => tokens.some((_, i) => phrase.every((p, k) => tokens[i + k] === p)))
}

function falseStarts(words: RetakeWord[]): Retake[] {
  const tokens: Token[] = []
  words.forEach((word, index) => {
    if (word.filler) return
    const norm = normaliseWord(word.text)
    if (norm) tokens.push({ norm, index })
  })
  const out: Retake[] = []
  for (let p = 0; p < tokens.length; p++) {
    let found: Retake | null = null
    for (let q = p + MIN_RESTART_WORDS; q <= Math.min(tokens.length - 1, p + MAX_ABANDONED_WORDS) && !found; q++) {
      if (words[tokens[q].index].start - words[tokens[p].index].start > RESTART_WINDOW_SEC) break
      let m = 0
      while (q + m < tokens.length && p + m < q && tokens[p + m].norm === tokens[q + m].norm) m++
      if (m < MIN_RESTART_WORDS) continue
      // The restart has to go somewhere new: carry on past the repeat,
      // within the same sentence, and not straight into the opening again
      // ("again and again and again").
      const continuation = tokens.slice(q + m, q + m + MIN_CONTINUATION_WORDS)
      if (continuation.length < MIN_CONTINUATION_WORDS) continue
      if (tokens.slice(q, q + m + MIN_CONTINUATION_WORDS - 1).some(t => endsSentence(words[t.index].text))) continue
      if (tokens.slice(q + m, q + 2 * m).map(t => t.norm).join(' ') === tokens.slice(p, p + m).map(t => t.norm).join(' ')) continue
      const lastAbandoned = tokens[q - 1].index
      const abandoned = tokens.slice(p, q)
      const between = words.slice(tokens[p].index, tokens[q].index)
      const edited = hasEditTerm(abandoned.slice(m).map(t => t.norm))
      // A finished sentence is not an abandoned attempt: "It was great. It
      // was amazing, really." says two things. Only an explicit edit term
      // ("sorry", "I mean") overrides the full stop.
      if (!edited && abandoned.some(t => endsSentence(words[t.index].text) && !trailsOff(words[t.index].text))) continue
      const cue = edited || between.some(w => w.filler || trailsOff(w.text)) ||
        words[tokens[q].index].start - words[lastAbandoned].end >= HESITATION_SEC
      if (!cue) continue
      found = { first: tokens[p].index, last: tokens[q].index - 1, restart: tokens[q].index, kind: 'false-start' }
    }
    if (found) {
      out.push(found)
      // Nested restarts ("so the — so the — so the reason") resolve to the
      // last: carry on looking from the restart.
      p = tokens.findIndex(t => t.index === found.restart) - 1
    }
  }
  return out
}

/** Retakes in time-ordered words, earliest first, never overlapping. */
export function findRetakes(words: RetakeWord[]): Retake[] {
  const found = [...falseStarts(words), ...repeatedTakes(words)].sort((a, b) => a.first - b.first || b.last - a.last)
  const out: Retake[] = []
  for (const retake of found) {
    const previous = out[out.length - 1]
    if (previous && retake.first <= previous.last) {
      // Overlapping finds describe one stumble: take in both.
      if (retake.last > previous.last) {
        previous.last = retake.last
        previous.restart = retake.restart
      }
      continue
    }
    out.push({ ...retake })
  }
  return out
}

/**
 * Source ranges to cut for `retakes`: from just before the first dropped
 * word to just before the restart, with each edge kept in the silence
 * either side where there is any, so the cut never clips the kept words.
 */
export function retakeCutRanges(words: RetakeWord[], retakes: Retake[]): TimeRange[] {
  return retakes.map(({ first, last, restart }) => {
    const before = words[first - 1]
    const lead = before ? Math.max(0, words[first].start - before.end) : 0.05
    const gap = Math.max(0, words[restart].start - words[last].end)
    return {
      start: words[first].start - Math.min(0.05, lead / 2),
      end: Math.max(words[last].end, words[restart].start - Math.min(0.12, gap / 2))
    }
  }).filter(r => r.end > r.start)
}
