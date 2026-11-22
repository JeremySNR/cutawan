import type { Transcript, TranscriptWord } from './types'
import type { CaptionStyle } from './captionStyles'

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
export function groupWords(words: TranscriptWord[], budget: CaptionLayoutBudget): WordGroup[] {
  const groups: WordGroup[] = []
  const maxLines = Math.max(1, budget.maxLines)
  const spaceEm = SPACE_WIDTH_EM
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
    const width = wordWidthEm(w.text, budget.glyphWidthEm)
    const fitsCurrentLine = count === 0 || lineWidth + spaceEm + width <= budget.lineWidthEm
    const needsNewLine = !fitsCurrentLine
    const canStartLine = lines.length < maxLines

    if (
      count >= budget.maxWords ||
      (prev && w.start - prev.end > MAX_PAUSE_IN_GROUP_SEC) ||
      endsSentence ||
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
export function groupDisplayEnd(groups: WordGroup[], index: number, clipEnd: number): number {
  const group = groups[index]
  const next = groups[index + 1]
  let end = group.end + CAPTION_HOLD_SEC
  if (next) end = Math.min(end, Math.max(group.end, next.start))
  return Math.min(clipEnd, Math.max(group.end, end))
}
