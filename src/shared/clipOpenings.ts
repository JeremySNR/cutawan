/**
 * A deterministic check on how a clip opens, run without a model call.
 *
 * Two problems recur in the first sentence of AI-picked clips from
 * conversation: a throwaway lead-in ("Yeah." "Okay, so.") that wastes the
 * first second a viewer decides on, and an opener that leans on something
 * said before the clip ("And…", "That's why…", "As I said…"), which a cold
 * viewer cannot follow. The first is fixed by starting a sentence later; the
 * second cannot be fixed by trimming without judging content, so it only
 * costs the clip some of its hook score.
 *
 * Everything here is English-only and deliberately narrow. A false positive
 * costs a good clip, so the lists name exact words and phrases rather than
 * guessing at grammar, and questions are never penalised.
 */

/** True for transcript languages this check understands ('english', 'en', 'en-US'). */
export function isEnglishLanguage(language: string | undefined): boolean {
  const lang = (language ?? '').trim().toLowerCase()
  return lang === 'english' || lang === 'en' || /^en[-_]/.test(lang)
}

/**
 * Words that carry nothing on their own. A one- or two-word sentence made
 * only of these ("Yeah." "Okay, so." "Right, exactly.") is a lead-in.
 */
const FILLER_WORDS = new Set([
  'yeah', 'yea', 'yes', 'yep', 'yup', 'right', 'so', 'okay', 'ok', 'alright',
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm',
  'well', 'anyway', 'anyways', 'oh', 'and', 'but', 'like', 'sure', 'cool',
  'exactly', 'absolutely', 'totally', 'definitely'
])

/** Two-word throwaways whose words are not fillers on their own. */
const LEAD_IN_PHRASES = new Set([
  'i mean', 'you know', 'all right', 'uh huh', 'thank you', 'thanks', 'got it',
  'gotcha', 'fair enough', 'good question', 'great question', 'for sure',
  'of course', 'i see', 'that\'s true', 'so true'
])

/** Lower case, straight apostrophes, no leading quotes or dashes, single spaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, '\'')
    .replace(/^[^a-z0-9']+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(text: string): string[] {
  return normalize(text).replace(/[^a-z0-9' ]/g, ' ').split(' ').filter(Boolean)
}

/** A one- or two-word sentence that only clears the throat. */
export function isLeadInFragment(text: string): boolean {
  const w = words(text)
  if (w.length === 0 || w.length > 2) return false
  return LEAD_IN_PHRASES.has(w.join(' ')) || w.every((word) => FILLER_WORDS.has(word))
}

/**
 * Words a speaker puts in front of a sentence without changing what it leans
 * on: "Yeah, because…" depends on earlier talk exactly as "Because…" does.
 */
const LEADING_FILLER = /^(yeah|yes|so|um|uh|okay|ok|well|oh|right|alright)\b[,.]?\s+/

/**
 * Openers that only make sense after something the clip does not include.
 * Kept short on purpose; each one is near-certain to point backwards.
 */
const DANGLING_OPENERS: RegExp[] = [
  /^(and|but|because|'cause|which)\b/,
  /^(as|like) (i|we|you|i've|we've) (said|mentioned|just said|was saying|were saying|discussed|talked about|told you)\b/,
  /^(that's|that is|which is) (why|how)\b/,
  /^that('s| is) because\b/,
  /^that's what i (mean|meant|was saying)\b/,
  /^that's what i'm saying\b/
]

/**
 * The backward-leaning opener a sentence starts with, as spoken (e.g. "and",
 * "that's why"), or null. Questions are never flagged: "But why does it
 * matter?" opens a clip on a question whatever word it starts with.
 */
export function danglingOpener(text: string): string | null {
  let sentence = normalize(text)
  if (/\?["']?$/.test(sentence)) return null
  // Check the sentence as spoken, then with each leading filler word removed:
  // "Like I said" must be read before "like" is stripped from it.
  for (let i = 0; i < 4 && sentence; i++) {
    for (const pattern of DANGLING_OPENERS) {
      const match = sentence.match(pattern)
      if (match) return match[0]
    }
    const stripped = sentence.replace(LEADING_FILLER, '')
    if (stripped === sentence) break
    sentence = stripped
  }
  return null
}

export interface OpeningLine {
  start: number
  end: number
  text: string
}

export interface OpeningLimits {
  /** Where the clip starts now (pre-roll included). */
  clipStart: number
  /** End of the clip's first played part; the clip's end for a continuous clip. */
  firstPartEnd: number
  /** Seconds the clip plays now. */
  playedSec: number
  /** Shortest the clip may become. */
  minPlayedSec: number
  /** Shortest the first part may become; 0 for a continuous clip. */
  minFirstPartSec: number
  /** Most seconds of opening that may be skipped. */
  maxSkipSec?: number
  /** Most lead-in sentences that may be skipped. */
  maxSkipCount?: number
}

export interface OpeningVerdict {
  /** How many leading lines to skip; the clip then opens on `lines[skip]`. */
  skip: number
  /** The backward-leaning opener of the first substantive line, or null. */
  dangling: string | null
}

/** "A few seconds": a lead-in is a word or two, not a sentence of setup. */
export const MAX_LEAD_IN_SKIP_SEC = 4
export const MAX_LEAD_IN_SKIP_COUNT = 3

/**
 * What to do about a clip's opening, given the lines it opens on (in order,
 * the first one being the line it starts on). Lead-ins are skipped while the
 * clip and its first part stay long enough; the first line that is not a
 * lead-in is then checked for a backward-leaning opener.
 */
export function reviewOpening(lines: OpeningLine[], limits: OpeningLimits): OpeningVerdict {
  const maxSkipSec = limits.maxSkipSec ?? MAX_LEAD_IN_SKIP_SEC
  const maxSkipCount = limits.maxSkipCount ?? MAX_LEAD_IN_SKIP_COUNT
  let skip = 0
  while (skip < maxSkipCount && skip + 1 < lines.length && isLeadInFragment(lines[skip].text)) {
    const next = lines[skip + 1]
    const advance = next.start - limits.clipStart
    if (
      advance > maxSkipSec ||
      next.start >= limits.firstPartEnd ||
      limits.playedSec - advance < limits.minPlayedSec ||
      limits.firstPartEnd - next.start < limits.minFirstPartSec
    ) {
      break
    }
    skip++
  }
  // The first substantive line: past any lead-ins that could not be skipped.
  let first = skip
  while (first < lines.length && first < skip + maxSkipCount && isLeadInFragment(lines[first].text)) first++
  return { skip, dangling: first < lines.length ? danglingOpener(lines[first].text) : null }
}

/** Most seconds an opening may be moved back to supply what it leans on. */
export const MAX_REWIND_SEC = 15
/** Fewest words a line needs before a clip may open on it. */
export const MIN_REWIND_WORDS = 6
/** Most sentences an opening may be moved back. */
export const MAX_REWIND_COUNT = 2

export interface RewindLimits {
  /** Seconds the clip plays now. */
  playedSec: number
  /** Longest the clip may become. */
  maxPlayedSec: number
  /** Where the clip opens now (the first word of its first line). */
  firstLineStart: number
  /** Earliest the clip may open (e.g. the end of the previous clip's speech is not a limit; the video start is). */
  earliestStart?: number
  maxRewindSec?: number
  maxRewindCount?: number
}

/**
 * For a clip whose first line leans backwards ("And then…", "But that's…"),
 * how many of the lines just before it to take in so it opens on the line it
 * continues, or 0 when that is not possible. `before` is the lines preceding
 * the clip, nearest last. The new first line must stand on its own (not
 * dangle itself, not be a throwaway lead-in), and the clip must stay within
 * its length cap. The model chose the moment; this only restores the start
 * of the thought it cut into, which is what a human editor does first.
 */
export function rewindOpening(before: OpeningLine[], limits: RewindLimits): number {
  const maxSec = limits.maxRewindSec ?? MAX_REWIND_SEC
  const maxCount = limits.maxRewindCount ?? MAX_REWIND_COUNT
  for (let count = 1; count <= Math.min(maxCount, before.length); count++) {
    const line = before[before.length - count]
    const added = limits.firstLineStart - line.start
    if (added > maxSec || limits.playedSec + added > limits.maxPlayedSec) return 0
    if (limits.earliestStart !== undefined && line.start < limits.earliestStart) return 0
    if (isLeadInFragment(line.text)) continue
    if (danglingOpener(line.text)) continue
    // A short line before a dangling opener is usually someone's reaction
    // ("Oh no.", "Delightful, but terrifying."), not the thought it continues;
    // opening on it is worse than the dangling word. Measured on a live run.
    if (line.text.trim().split(/\s+/).length < MIN_REWIND_WORDS) return 0
    return count
  }
  return 0
}
