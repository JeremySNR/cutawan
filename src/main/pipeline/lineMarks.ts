import type { AudioReaction, SpeakerTurn, Transcript } from '@shared/types'
import type { Sentence } from '@shared/sentences'

/**
 * What the clip-selection model is told about each transcript line besides
 * its words: who says it, whether the audience reacts right after it, and
 * whether a new topic starts on it. Every mark comes from local analysis
 * (diarization, audio reactions, TextTiling) and each is optional; a
 * transcript with none of them produces no marks and the model sees exactly
 * the lines it always did.
 */

export type ReactionTag = 'laughter' | 'applause' | 'reaction'

export interface LineMarks {
  /** Speaker label per line number, e.g. 'B' or 'A, then B'; empty unless the video has more than one speaker. */
  speakers: Map<number, string>
  /** Lines the audience reacts to, by line number: the reaction starts during or just after the line. */
  reactions: Map<number, ReactionTag>
  /** Line numbers that open a new topic. */
  topicStarts: Set<number>
}

export const NO_MARKS: LineMarks = { speakers: new Map(), reactions: new Map(), topicStarts: new Set() }

/** The separator shown between two lines where the topic changes. */
export const TOPIC_CHANGE_LINE = '— topic change —'

/**
 * A speaker with less speech than this is not counted towards "more than
 * one speaker": diarization now and then splits a few seconds of one voice
 * off as a second, and labelling a monologue A and B would invent a
 * conversation.
 */
const MIN_SPEAKER_SEC = 5
/**
 * Words of a second speaker a line needs before it reads as mixed. One word
 * from the other side of a turn boundary is diarization timing, not a turn.
 */
const MIN_MIXED_WORDS = 2
/** Quieter reactions than this (0..1, relative to the source) are not marked. */
export const MIN_REACTION_STRENGTH = 0.3
/** How long after a line ends a reaction may start and still be its reaction. */
export const REACTION_LAG_SEC = 1.5

/** A, B, C… in order of first appearance; S27 and on past Z. */
export function speakerLetter(order: number): string {
  return order < 26 ? String.fromCharCode(65 + order) : `S${order + 1}`
}

/**
 * The speakers that count, each with its letter by order of first
 * appearance; empty when fewer than two speakers have real speech.
 */
export function speakerLetters(turns: SpeakerTurn[] | undefined): Map<number, string> {
  if (!turns || turns.length === 0) return new Map()
  const sorted = [...turns].sort((a, b) => a.start - b.start)
  const total = new Map<number, number>()
  const order: number[] = []
  for (const turn of sorted) {
    if (!total.has(turn.speaker)) order.push(turn.speaker)
    total.set(turn.speaker, (total.get(turn.speaker) ?? 0) + Math.max(0, turn.end - turn.start))
  }
  const real = order.filter((id) => (total.get(id) ?? 0) >= MIN_SPEAKER_SEC)
  if (real.length < 2) return new Map()
  return new Map(order.map((id, i) => [id, speakerLetter(i)]))
}

/**
 * Who says each line, as a label: the line's speaker, or 'A, then B' when a
 * turn changes inside it. Read word by word (each word belongs to the turn
 * holding its midpoint) so a line is labelled by the voice of its words, not
 * by whichever turn overlaps its pauses. Lines with no word inside a turn
 * get no label. Empty unless the transcript has more than one speaker.
 * Exported for tests.
 */
export function lineSpeakers(sentences: Sentence[], turns: SpeakerTurn[] | undefined): Map<number, string> {
  const letters = speakerLetters(turns)
  const out = new Map<number, string>()
  if (letters.size === 0 || !turns) return out
  const sorted = [...turns].sort((a, b) => a.start - b.start)
  for (const s of sentences) {
    // Runs of consecutive words by the same speaker, in order.
    const runs: Array<{ speaker: number; words: number }> = []
    for (const w of s.words) {
      const speaker = speakerAt(sorted, (w.start + w.end) / 2)
      if (speaker === undefined) continue
      const last = runs[runs.length - 1]
      if (last && last.speaker === speaker) last.words++
      else runs.push({ speaker, words: 1 })
    }
    if (runs.length === 0) continue
    const byWords = new Map<number, number>()
    for (const run of runs) byWords.set(run.speaker, (byWords.get(run.speaker) ?? 0) + run.words)
    // Speakers with enough words, in the order they first speak in the line.
    const voices: number[] = []
    for (const run of runs) {
      if ((byWords.get(run.speaker) ?? 0) >= MIN_MIXED_WORDS && !voices.includes(run.speaker)) voices.push(run.speaker)
    }
    if (voices.length === 0) {
      // Every voice has a single word (a one- or two-word line): the most words wins.
      const top = [...byWords.entries()].sort((a, b) => b[1] - a[1])[0][0]
      voices.push(top)
    }
    const label = voices.map((id) => letters.get(id) ?? '?')
    out.set(s.index, label.length === 1 ? label[0] : label.join(', then '))
  }
  return out
}

/** How many turns before the last one starting at or before a time are checked for holding it (cross-talk). */
const OVERLAP_LOOKBACK = 8

/** The speaker whose turn holds time `t`, from turns sorted by start; undefined in a gap. */
function speakerAt(sorted: SpeakerTurn[], t: number): number | undefined {
  let lo = 0, hi = sorted.length - 1, last = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].start <= t) { last = mid; lo = mid + 1 } else hi = mid - 1
  }
  // Turns may overlap (cross-talk): the latest-starting turn that still holds t wins.
  for (let i = last; i >= 0 && i > last - OVERLAP_LOOKBACK; i--) {
    if (sorted[i].end > t) return sorted[i].speaker
  }
  return undefined
}

function reactionTag(reaction: AudioReaction): ReactionTag | null {
  switch (reaction.kind) {
    case 'laughter': return 'laughter'
    case 'applause': return 'applause'
    // A music hit is the edit's sting or a transition, not the audience
    // answering a line.
    case 'music': return null
    default: return 'reaction'
  }
}

/**
 * The lines the audience reacts to: for each reaction loud enough to count,
 * the last line that starts before the reaction does, when the reaction
 * begins during it or within REACTION_LAG_SEC of its end. The reaction is
 * marked on that line because a reaction answers what was just said. When two
 * reactions land on one line, laughter and applause outrank an unnamed one.
 * Exported for tests.
 */
export function lineReactions(sentences: Sentence[], reactions: AudioReaction[] | undefined): Map<number, ReactionTag> {
  const out = new Map<number, ReactionTag>()
  if (!reactions || reactions.length === 0 || sentences.length === 0) return out
  for (const reaction of reactions) {
    if (!(reaction.strength >= MIN_REACTION_STRENGTH)) continue
    const tag = reactionTag(reaction)
    if (!tag) continue
    // The last line starting before the reaction (sentences are in time order).
    let lo = 0, hi = sentences.length - 1, found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sentences[mid].start < reaction.start) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (found < 0) continue
    const line = sentences[found]
    if (reaction.start - line.end > REACTION_LAG_SEC) continue
    const existing = out.get(line.index)
    if (!existing || existing === 'reaction') out.set(line.index, tag)
  }
  return out
}

/** Every mark for a transcript's lines. `topicStarts` are line numbers from topic detection. */
export function transcriptMarks(transcript: Transcript, sentences: Sentence[], topicStarts?: Iterable<number>): LineMarks {
  return {
    speakers: lineSpeakers(sentences, transcript.speakerTurns),
    reactions: lineReactions(sentences, transcript.reactions),
    topicStarts: new Set(topicStarts ?? [])
  }
}

/** Whether there is anything to tell the model about. */
export function hasMarks(marks: LineMarks): { speakers: boolean; reactions: boolean; topics: boolean } {
  return { speakers: marks.speakers.size > 0, reactions: marks.reactions.size > 0, topics: marks.topicStarts.size > 0 }
}

/** "(Speaker B) " before a line's text, or nothing. */
export function speakerPrefix(marks: LineMarks, index: number): string {
  const label = marks.speakers.get(index)
  return label ? `(Speaker ${label}) ` : ''
}

/** " [laughter after]" after a line's text, or nothing. */
export function reactionSuffix(marks: LineMarks, index: number): string {
  const tag = marks.reactions.get(index)
  return tag ? ` [${tag} after]` : ''
}

/** Whether a topic change falls between line `after` (exclusive) and line `upTo` (inclusive). */
export function topicChangeBetween(marks: LineMarks, after: number, upTo: number): boolean {
  for (const start of marks.topicStarts) if (start > after && start <= upTo) return true
  return false
}

/** The speaker of the last word of a line, or of its first, as a letter. */
export function edgeSpeaker(marks: LineMarks, index: number, edge: 'first' | 'last'): string | undefined {
  const label = marks.speakers.get(index)
  if (!label) return undefined
  const parts = label.split(', then ')
  return edge === 'first' ? parts[0] : parts[parts.length - 1]
}
