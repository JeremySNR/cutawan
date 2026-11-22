import type { CaptionEmphasisWord, Transcript, TranscriptWord } from './types'
import type { CaptionStyle } from './captionStyles'
import {
  EMOJI_WIDTH_EM,
  EMPHASIS_SCALE,
  emphasisEmoji,
  emphasisScores,
  pickGroupEmphasis,
  thinEmoji
} from './captionEmphasis'

/**
 * Word selection and grouping shared by the ASS generator (main process) and
 * the live caption preview (renderer), so preview and export stay in sync.
 *
 * Groups are laid out into explicit lines here, once, from a character budget
 * derived from the style's font and the output frame. Both renderers then
 * draw exactly those lines (the ASS uses hard `\N` breaks with wrapping off,
 * the preview uses one non-wrapping block per line), so a caption can never
 * wrap differently on export than it did in the editor.
 */

export interface WordGroup {
  words: TranscriptWord[]
  /** `words` split into the display lines they are drawn on, in order. */
  lines: TranscriptWord[][]
  start: number
  end: number
  /** Index into `words` of the emphasised word, or -1 (see captionGroupsFor). */
  emphasis?: number
  /** Emoji drawn after the emphasised word, or null. */
  emoji?: string | null
}

/** Collect the words spoken inside [clipStart, clipEnd] from the transcript. */
export function wordsInRange(
  transcript: Transcript,
  clipStart: number,
  clipEnd: number
): TranscriptWord[] {
  const out: TranscriptWord[] = []
  for (const seg of transcript.segments) {
    if (seg.end < clipStart || seg.start > clipEnd) continue
    for (const w of seg.words) {
      const mid = (w.start + w.end) / 2
      if (mid >= clipStart && mid <= clipEnd && w.text.length > 0) out.push(w)
    }
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

const MAX_PAUSE_IN_GROUP_SEC = 0.9

/** Most lines a caption group may occupy. Three-line captions cover the face. */
export const CAPTION_MAX_LINES = 2

/**
 * Share of the frame width caption text may span. The rest is a safe margin
 * so text never kisses the edge on either renderer.
 */
export const CAPTION_SAFE_WIDTH = 0.9

/**
 * Frequency-weighted average glyph advance, in em, for the bundled caption
 * fonts (measured from their hmtx tables over English letter frequencies).
 * Uppercase runs wider in most faces, so styles that shout get their own
 * figure. Unknown families (user uploads) use a deliberately wide default so a
 * line is more likely to come up short than to overflow.
 */
const GLYPH_WIDTH_EM: Record<string, { lower: number; upper: number }> = {
  Anton: { lower: 0.45, upper: 0.46 },
  Poppins: { lower: 0.58, upper: 0.65 },
  'Poppins Medium': { lower: 0.56, upper: 0.63 }
}
const DEFAULT_GLYPH_WIDTH_EM = { lower: 0.62, upper: 0.7 }

/**
 * Line pitch libass uses for the bundled fonts, in em: it advances each line
 * by the font size, which it scales to the OS/2 win ascent + descent (see
 * assFontSize), so the pitch is that span over the em. The preview sets its
 * line height from this so two-line captions and titles stack the same.
 * Unknown fonts use the same typical ratio as assFontSize's fallback.
 */
const LINE_PITCH_EM: Record<string, number> = { Anton: 1.733, Poppins: 1.762, 'Poppins Medium': 1.762 }

export function captionLinePitchEm(fontFamily: string): number {
  return LINE_PITCH_EM[fontFamily] ?? 1.75
}
/** A space is narrower than a letter in every face we ship. */
const SPACE_WIDTH_EM = 0.26
/**
 * The active word pops to 109% for a beat. Only one word grows at a time, so a
 * fixed allowance (about a long word's worth of growth) keeps the pop inside
 * the safe width without throwing away a whole line's share.
 */
const POP_ALLOWANCE_EM = 0.5

export interface CaptionLayoutBudget {
  /** Most words in one group (the style's rhythm knob). */
  maxWords: number
  /** Width available for one line of text, in em of the caption font. */
  lineWidthEm: number
  /** Average glyph advance in em for this style's font and case. */
  glyphWidthEm: number
  maxLines: number
}

/**
 * How much text fits on one caption line for a style on a frame of the given
 * aspect ratio (width / height). Font size is a fraction of frame height, so
 * the usable width in em is `aspect * safeWidth / fontScale`: a 9:16 frame
 * fits far fewer characters than a 16:9 one at the same style.
 */
export function captionLayoutBudget(style: CaptionStyle, aspectRatio: number): CaptionLayoutBudget {
  const widths = GLYPH_WIDTH_EM[style.fontFamily] ?? DEFAULT_GLYPH_WIDTH_EM
  const safeAspect = Math.max(0.1, aspectRatio)
  return {
    maxWords: style.wordsPerGroup,
    lineWidthEm: (safeAspect * CAPTION_SAFE_WIDTH) / style.fontScale - POP_ALLOWANCE_EM,
    glyphWidthEm: style.uppercase ? widths.upper : widths.lower,
    maxLines: CAPTION_MAX_LINES
  }
}

/**
 * Styles that show a few big words at a time drop the commas and full stops
 * a transcript carries: on a three-word card they are clutter ("WORKS." /
 * "SO,"), and the card break already marks the pause. Styles that read as
 * subtitles — a whole phrase per card — keep their punctuation.
 */
export function stripsCaptionPunctuation(style: Pick<CaptionStyle, 'wordsPerGroup'>): boolean {
  return style.wordsPerGroup <= 4
}

/**
 * A transcript word as a caption draws it, shared by the preview and the
 * burned-in ASS. Question and exclamation marks stay (they carry tone), as
 * does an ellipsis, and so does the final dot of an abbreviation ("U.S.") or
 * a word that is nothing but punctuation.
 */
export function captionWordText(text: string, style: Pick<CaptionStyle, 'wordsPerGroup' | 'uppercase'>): string {
  const cased = (value: string): string => (style.uppercase ? value.toUpperCase() : value)
  if (!stripsCaptionPunctuation(style)) return cased(text)
  // Closing quotes and brackets sit outside the punctuation: "done." -> "done"
  const [, body = text, closers = ''] = text.match(/^(.*?)(["'”’)\]]*)$/) ?? []
  let core = body
  if (/(…|\.{2,})$/.test(core)) return cased(text)
  if (/\p{L}\.\p{L}/u.test(core)) core = core.replace(/[,;:]+$/, '')
  else core = core.replace(/[.,;:]+$/, '')
  return /[\p{L}\p{N}]/u.test(core) ? cased(core + closers) : cased(text)
}

/** Estimated rendered width of a word, in em. */
function wordWidthEm(text: string, glyphWidthEm: number): number {
  return text.length * glyphWidthEm
}

/**
 * Group words into caption cards and lay each card out into lines.
 *
 * A group breaks on the style's word cap, on a long pause, after a sentence
 * end, or when the next word would need a third line. Within a group, words
 * fill the current line until the next word would overflow the em budget,
 * then start a new line. A single word wider than a whole line still gets a
 * line to itself — it cannot be split, and overflowing one line beats
 * dropping the word.
 */
export function groupWords(
  words: TranscriptWord[],
  budget: CaptionLayoutBudget,
  options: {
    /**
     * Times a group may not span: a cold open's seam, where the picture
     * jumps back to the clip's start (output seconds, like the words).
     */
    breaks?: number[]
    /** Extra width, in em, some words need (an emphasised word and its emoji). */
    extraWidth?: (word: TranscriptWord) => number
  } = {}
): WordGroup[] {
  const groups: WordGroup[] = []
  const maxLines = Math.max(1, budget.maxLines)
  const spaceEm = SPACE_WIDTH_EM
  const breaks = options.breaks ?? []
  let lines: TranscriptWord[][] = []
  let lineWidth = 0
  let count = 0

  const flush = (): void => {
    if (count === 0) return
    const flat = lines.flat()
    groups.push({
      words: flat,
      lines,
      start: flat[0].start,
      end: flat[flat.length - 1].end
    })
    lines = []
    lineWidth = 0
    count = 0
  }

  for (const w of words) {
    const prev = count > 0 ? lines[lines.length - 1][lines[lines.length - 1].length - 1] : undefined
    const endsSentence = prev ? /[.!?]["']?$/.test(prev.text) : false
    const crossesBreak = prev ? breaks.some((b) => prev.end <= b + 1e-6 && w.start >= b - 1e-6) : false
    const width = wordWidthEm(w.text, budget.glyphWidthEm) + (options.extraWidth?.(w) ?? 0)
    const fitsCurrentLine = count === 0 || lineWidth + spaceEm + width <= budget.lineWidthEm
    const needsNewLine = !fitsCurrentLine
    const canStartLine = lines.length < maxLines

    if (
      count >= budget.maxWords ||
      (prev && w.start - prev.end > MAX_PAUSE_IN_GROUP_SEC) ||
      endsSentence ||
      crossesBreak ||
      (needsNewLine && !canStartLine)
    ) {
      flush()
    }

    if (count === 0) {
      lines.push([w])
      lineWidth = width
    } else if (lineWidth + spaceEm + width <= budget.lineWidthEm) {
      lines[lines.length - 1].push(w)
      lineWidth += spaceEm + width
    } else {
      lines.push([w])
      lineWidth = width
    }
    count++
  }
  flush()
  return groups
}

/**
 * How long a finished group stays on screen after its last word. Captions
 * that vanish the instant a sentence ends leave an empty frame on every
 * pause; holding briefly reads as natural, but never into the next group.
 */
export const CAPTION_HOLD_SEC = 1.5

/**
 * The moment group `index` leaves the screen: its last word's end plus the
 * hold, cut short by the next group's first word or the clip end.
 */
export function groupDisplayEnd(groups: WordGroup[], index: number, clipEnd: number, breaks: number[] = []): number {
  const group = groups[index]
  const next = groups[index + 1]
  let end = group.end + CAPTION_HOLD_SEC
  if (next) end = Math.min(end, Math.max(group.end, next.start))
  // A cold open's words leave with it: the hold never crosses the seam.
  const seam = breaks.find((b) => b >= group.end - 1e-6)
  if (seam !== undefined) end = Math.min(end, seam)
  return Math.min(clipEnd, Math.max(group.end, end))
}

export interface CaptionGroupOptions {
  /** Output-time seams a group may not span (see groupWords). */
  breaks?: number[]
  /** Emphasise key words; off leaves every group with emphasis -1. */
  emphasis?: boolean
  /** Draw emoji after some emphasised words (needs `emphasis`). */
  emoji?: boolean
  /** Validated AI keywords; absent uses the heuristic. */
  keywords?: CaptionEmphasisWord[] | null
  /** The clip's hook line, for the heuristic. */
  hook?: string
}

/**
 * The caption cards for a span of a transcript, laid out and with their
 * emphasis chosen: exactly what both the ASS export and the live preview
 * draw. Words are taken from [clipStart, clipEnd] of `transcript`, in
 * whatever timeline its times are (the export and the preview both pass the
 * clip's output timeline, see shared/clipTimeline.ts).
 *
 * Emphasis widens a word, so the layout runs twice: once to see which word
 * each card would mark, then again with those words (and their emoji) taking
 * their real width. The second layout can move a card boundary; any card that
 * then holds two marked words keeps only the stronger one.
 */
export function captionGroupsFor(
  transcript: Transcript,
  clipStart: number,
  clipEnd: number,
  budget: CaptionLayoutBudget,
  options: CaptionGroupOptions = {}
): WordGroup[] {
  const words = wordsInRange(transcript, clipStart, clipEnd)
  const breaks = options.breaks ?? []
  const first = groupWords(words, budget, { breaks })
  if (!options.emphasis) return first.map((g) => ({ ...g, emphasis: -1, emoji: null }))

  const ctx = { words: options.keywords, hook: options.hook }
  const allScores = emphasisScores(words, ctx)
  const scores = new Map(words.map((w, i) => [w, allScores[i]]))
  const chosen = new Set<TranscriptWord>()
  pickGroupEmphasis(first.map((g) => g.words), scores).forEach((index, gi) => {
    if (index >= 0) chosen.add(first[gi].words[index])
  })
  const emojiFor = (w: TranscriptWord): string | null => (options.emoji ? emphasisEmoji(w, ctx) : null)
  const groups = groupWords(words, budget, {
    breaks,
    extraWidth: (w) => chosen.has(w)
      ? w.text.length * budget.glyphWidthEm * (EMPHASIS_SCALE - 1) + (emojiFor(w) ? EMOJI_WIDTH_EM : 0)
      : 0
  })
  const onlyChosen = new Map([...scores].map(([w, s]) => [w, chosen.has(w) ? s : 0]))
  const picks = pickGroupEmphasis(groups.map((g) => g.words), onlyChosen)
  const emoji = thinEmoji(groups.map((g, gi) => {
    const word = picks[gi] >= 0 ? g.words[picks[gi]] : null
    return { at: word?.start ?? g.start, emoji: word ? emojiFor(word) : null }
  }))
  return groups.map((g, gi) => ({ ...g, emphasis: picks[gi], emoji: emoji[gi] }))
}
