import type {
  CaptionLanguageMode,
  Clip,
  ClipTranslation,
  Transcript,
  TranscriptWord,
  TranslationLine
} from './types'
import { CAPTION_HOLD_SEC, CAPTION_MAX_LINES, captionLayoutBudget, captionWordText, wordsInRange } from './captionLayout'
import type { CaptionStyle } from './captionStyles'
import { transcriptSentences } from './sentences'
import { clipKeptSegments, TimeMap, type KeptSegment } from './tighten'

/**
 * Caption translation, shared by the live preview and the ASS export so the
 * two draw the same cards at the same moments.
 *
 * A translation is made of whole sentences, never caption fragments: word
 * order changes between languages, so a three-word card has no translation of
 * its own. Each translated sentence keeps its original sentence's time slot.
 * There are no word timings for the translation, so translated captions are
 * sentence-level: each sentence is split into cards that fit the style's line
 * budget, and the slot is shared between those cards by text length.
 */

export interface TranslationLanguage {
  /** BCP-47 code; also picks a regional font for Han text. */
  code: string
  name: string
}

/** Offered in the editor; anything else can be typed. */
export const TRANSLATION_LANGUAGES: TranslationLanguage[] = [
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'el', name: 'Greek' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)' },
  { code: 'en', name: 'English' }
]

/** The listed language matching a typed name, if any (case-insensitive). */
export function findTranslationLanguage(name: string): TranslationLanguage | undefined {
  const wanted = name.trim().toLowerCase()
  return TRANSLATION_LANGUAGES.find((l) => l.name.toLowerCase() === wanted || l.code.toLowerCase() === wanted)
}

// ---------------------------------------------------------------------------
// What plays, as sentences
// ---------------------------------------------------------------------------

export interface PlayedSentence {
  /** First played word's start and last played word's end, source seconds. */
  start: number
  end: number
  text: string
  words: TranscriptWord[]
}

/** Source ranges that play: kept segments, or the whole trim when nothing is cut. */
export function playedRanges(clip: Pick<Clip, 'edit' | 'visualStory' | 'gapActivity'>, transcript: Transcript | null): KeptSegment[] {
  return clipKeptSegments(clip, transcript) ?? [{ start: clip.edit.start, end: clip.edit.end }]
}

function plays(word: TranscriptWord, ranges: KeptSegment[]): boolean {
  const mid = (word.start + word.end) / 2
  return ranges.some((r) => mid >= r.start && mid <= r.end)
}

/**
 * The clip's played words grouped into the sentences they belong to. Words
 * cut out of a sentence are not sent (the viewer never hears them), so a
 * sentence with a cut in the middle is sent as what remains of it.
 */
export function playedSentences(clip: Pick<Clip, 'edit' | 'visualStory' | 'gapActivity'>, transcript: Transcript): PlayedSentence[] {
  const ranges = playedRanges(clip, transcript)
  const sentenceOf = new Map<TranscriptWord, number>()
  for (const sentence of transcriptSentences(transcript)) {
    for (const word of sentence.words) sentenceOf.set(word, sentence.index)
  }
  const out: PlayedSentence[] = []
  let current: { index: number; words: TranscriptWord[] } | null = null
  const flush = (): void => {
    if (!current?.words.length) return
    const words = current.words
    out.push({ start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.text).join(' '), words })
  }
  for (const word of wordsInRange(transcript, clip.edit.start, clip.edit.end)) {
    if (!plays(word, ranges)) continue
    const index = sentenceOf.get(word) ?? -1
    if (!current || current.index !== index) {
      flush()
      current = { index, words: [] }
    }
    current.words.push(word)
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------
// Keeping a stored translation valid against later edits
// ---------------------------------------------------------------------------

/** Word timestamps are rounded on save; allow a hair either side of a slot. */
const SLOT_EPSILON_SEC = 0.02

export type TranslationLineStatus = 'plays' | 'dropped' | 'changed'

export interface TranslationState {
  /** Lines whose every word still plays, in order: what is displayed and dubbed. */
  playable: TranslationLine[]
  /** Per stored line, in order. */
  status: TranslationLineStatus[]
  /** Lines only partly playing now (a cut through the sentence). */
  changed: number
  /** Lines entirely outside what plays now. */
  dropped: number
  /** Played words no line covers (the trim grew, or a cut was restored). */
  uncovered: number
  /** The selection changed under the translation: it should be refreshed. */
  needsRefresh: boolean
}

/**
 * Check a stored translation against what the clip plays now. A line whose
 * words all still play keeps its slot (pause removal can shorten the slot on
 * screen; the words are what matter). A line with no word left is dropped
 * quietly. A line with only some words left, or played speech no line covers,
 * means the translation no longer matches the edit: those lines are hidden
 * and the editor asks for a refresh instead of showing misaligned text.
 */
export function translationState(
  clip: Pick<Clip, 'edit' | 'visualStory' | 'gapActivity'>,
  translation: ClipTranslation,
  transcript: Transcript | null
): TranslationState {
  const empty: TranslationState = { playable: [], status: translation.lines.map(() => 'dropped'), changed: 0, dropped: translation.lines.length, uncovered: 0, needsRefresh: false }
  if (!transcript) return empty
  const ranges = playedRanges(clip, transcript)
  const words = wordsInRange(transcript, clip.edit.start, clip.edit.end)
  const inSlot = (w: TranscriptWord, line: TranslationLine): boolean => {
    const mid = (w.start + w.end) / 2
    return mid >= line.start - SLOT_EPSILON_SEC && mid <= line.end + SLOT_EPSILON_SEC
  }
  const status: TranslationLineStatus[] = []
  const playable: TranslationLine[] = []
  let changed = 0
  let dropped = 0
  for (const line of translation.lines) {
    const own = words.filter((w) => inSlot(w, line))
    const played = own.filter((w) => plays(w, ranges)).length
    if (own.length > 0 && played === own.length) {
      status.push('plays')
      playable.push(line)
    } else if (played === 0) {
      status.push('dropped')
      dropped++
    } else {
      status.push('changed')
      changed++
    }
  }
  const uncovered = words.filter((w) => w.text.trim().length > 0 && plays(w, ranges) &&
    !translation.lines.some((line) => inSlot(w, line))).length
  return { playable, status, changed, dropped, uncovered, needsRefresh: changed > 0 || uncovered > 0 }
}

/**
 * What the captions show. A translation only takes over once it has been
 * reviewed and accepted; until then (or with no translation) it is the
 * original.
 */
export function effectiveCaptionLanguage(clip: Pick<Clip, 'edit' | 'translation'>): CaptionLanguageMode {
  const mode = clip.edit.captionLanguage ?? 'original'
  if (mode === 'original' || !clip.translation?.accepted || clip.translation.lines.length === 0) return 'original'
  return mode
}

/** Whether the original (word-timed karaoke) captions are drawn. */
export function showsOriginalCaptions(clip: Pick<Clip, 'edit' | 'translation'>): boolean {
  return effectiveCaptionLanguage(clip) !== 'translated'
}

// ---------------------------------------------------------------------------
// Scripts and fonts
// ---------------------------------------------------------------------------

export type CaptionScript =
  | 'latin'
  | 'vietnamese'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'devanagari'
  | 'thai'
  | 'han'
  | 'japanese'
  | 'korean'

const SCRIPT_TESTS: Array<[CaptionScript, RegExp]> = [
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
  ['han', /\p{Script=Han}/u]
]

/**
 * The script a caption text is written in. Kana marks Japanese and Hangul
 * Korean even among Han characters; otherwise the most frequent non-Latin
 * script wins, since kept names and numbers are usually Latin.
 */
export function detectScript(text: string): CaptionScript {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'japanese'
  if (/\p{Script=Hangul}/u.test(text)) return 'korean'
  const counts = new Map<CaptionScript, number>()
  for (const char of text) {
    for (const [script, test] of SCRIPT_TESTS) {
      if (test.test(char)) counts.set(script, (counts.get(script) ?? 0) + 1)
    }
  }
  let best: CaptionScript | null = null
  for (const [script, count] of counts) if (!best || count > (counts.get(best) ?? 0)) best = script
  if (best) return best
  // Letters with a horn or a dot below are Vietnamese-only.
  return /[\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/u.test(text) ? 'vietnamese' : 'latin'
}

export function isRightToLeft(script: CaptionScript): boolean {
  return script === 'arabic' || script === 'hebrew'
}

/** Scripts written without spaces between words. */
function isUnspaced(script: CaptionScript): boolean {
  return script === 'han' || script === 'japanese' || script === 'thai'
}

/**
 * Scripts the bundled caption fonts actually cover, read from their cmap
 * tables (resources/fonts). Every other script needs a system font.
 */
const BUNDLED_FONT_SCRIPTS: Record<string, CaptionScript[]> = {
  Anton: ['latin', 'vietnamese'],
  Poppins: ['latin', 'devanagari'],
  'Poppins Medium': ['latin', 'devanagari']
}

export type CaptionPlatform = 'darwin' | 'win32' | 'linux' | string

/**
 * System fonts per script and OS, best first. The first entry is what the
 * export names in the ASS (libass then finds it, or the closest cover, via
 * the OS font provider) and what the preview puts first in its CSS stack,
 * so both start from the same face.
 */
const SYSTEM_FALLBACKS: Record<'darwin' | 'win32' | 'linux', Partial<Record<CaptionScript | 'han-tc' | 'han-sc', string[]>>> = {
  darwin: {
    latin: ['Helvetica Neue'],
    vietnamese: ['Helvetica Neue'],
    cyrillic: ['Helvetica Neue'],
    greek: ['Helvetica Neue'],
    arabic: ['Geeza Pro'],
    hebrew: ['Arial Hebrew'],
    devanagari: ['Kohinoor Devanagari'],
    thai: ['Thonburi'],
    'han-sc': ['PingFang SC'],
    'han-tc': ['PingFang TC'],
    japanese: ['Hiragino Sans'],
    korean: ['Apple SD Gothic Neo']
  },
  win32: {
    latin: ['Segoe UI'],
    vietnamese: ['Segoe UI'],
    cyrillic: ['Segoe UI'],
    greek: ['Segoe UI'],
    arabic: ['Segoe UI'],
    hebrew: ['Segoe UI'],
    devanagari: ['Nirmala UI'],
    thai: ['Leelawadee UI'],
    'han-sc': ['Microsoft YaHei'],
    'han-tc': ['Microsoft JhengHei'],
    japanese: ['Yu Gothic'],
    korean: ['Malgun Gothic']
  },
  linux: {
    latin: ['Noto Sans', 'DejaVu Sans'],
    vietnamese: ['Noto Sans', 'DejaVu Sans'],
    cyrillic: ['Noto Sans', 'DejaVu Sans'],
    greek: ['Noto Sans', 'DejaVu Sans'],
    arabic: ['Noto Sans Arabic', 'DejaVu Sans'],
    hebrew: ['Noto Sans Hebrew', 'DejaVu Sans'],
    devanagari: ['Noto Sans Devanagari'],
    thai: ['Noto Sans Thai'],
    'han-sc': ['Noto Sans CJK SC', 'WenQuanYi Zen Hei'],
    'han-tc': ['Noto Sans CJK TC', 'WenQuanYi Zen Hei'],
    japanese: ['Noto Sans CJK JP', 'WenQuanYi Zen Hei'],
    korean: ['Noto Sans CJK KR', 'WenQuanYi Zen Hei']
  }
}

export interface TranslationFont {
  /** Family both renderers draw with. */
  family: string
  /** Further families for the CSS stack (the export relies on libass's own fallback). */
  cssFallbacks: string[]
  /** A system font replaced the style's font because it lacks the script. */
  systemFallback: boolean
  script: CaptionScript
}

/**
 * The font translated captions use. The style's font when it covers the
 * script (custom uploaded fonts are trusted to: the user chose them), and a
 * system font for the platform otherwise.
 */
export function translationFont(
  styleFamily: string,
  text: string,
  platform: CaptionPlatform,
  languageCode?: string
): TranslationFont {
  const script = detectScript(text)
  const covered = BUNDLED_FONT_SCRIPTS[styleFamily]
  if (!covered || covered.includes(script)) {
    return { family: styleFamily, cssFallbacks: [], systemFallback: false, script }
  }
  const table = SYSTEM_FALLBACKS[platform === 'darwin' || platform === 'win32' ? platform : 'linux']
  const key = script === 'han' ? (/^zh-(hant|tw|hk|mo)/i.test(languageCode ?? '') ? 'han-tc' : 'han-sc') : script
  const families = table[key] ?? table.latin ?? ['sans-serif']
  return { family: families[0], cssFallbacks: families.slice(1), systemFallback: true, script }
}

/** The preview's CSS font stack for a translation font. */
export function translationCssFontStack(font: TranslationFont): string {
  return [font.family, ...font.cssFallbacks].map((f) => `'${f}'`).concat('sans-serif').join(', ')
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** Same as the space allowance in captionLayout's width model. */
const SPACE_WIDTH_EM = 0.26
/** Full-width glyphs (Han, kana, Hangul, full-width forms) are one em wide. */
const FULL_WIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u
/**
 * Width assumed for a system fallback face we have no measurements for —
 * the same deliberately wide default captionLayout uses for unknown fonts.
 */
const UNKNOWN_FACE_GLYPH_EM = { lower: 0.62, upper: 0.7 }

/** Translated captions under the original are this much smaller. */
export const TRANSLATED_SECONDARY_SCALE = 0.72
/** Line height both renderers use for caption blocks, in em. */
export const CAPTION_LINE_HEIGHT_EM = 1.25

interface Token {
  text: string
  /** Whether a space separates it from the token before. */
  spaced: boolean
}

function tokenize(text: string, script: CaptionScript, languageCode?: string): Token[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (!isUnspaced(script)) return clean.split(' ').map((t) => ({ text: t, spaced: true }))
  // Han, kana and Thai have no spaces: break between words where ICU knows
  // them, keeping punctuation on the word it follows.
  const tokens: Token[] = []
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(languageCode || undefined, { granularity: 'word' })
    : null
  for (const [i, part] of clean.split(' ').entries()) {
    const pieces = segmenter ? [...segmenter.segment(part)].map((s) => s.segment) : [...part]
    pieces.forEach((piece, j) => {
      const previous = tokens[tokens.length - 1]
      if (previous && j > 0 && !/[\p{L}\p{N}]/u.test(piece)) previous.text += piece
      else tokens.push({ text: piece, spaced: i > 0 && j === 0 })
    })
  }
  return tokens
}

function tokenWidthEm(text: string, glyphEm: number): number {
  let width = 0
  for (const char of text) width += FULL_WIDTH.test(char) ? 1 : glyphEm
  return width
}

function visibleLength(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

export interface TranslatedCardBudget {
  /** Most tokens per card; unspaced scripts are limited by width only. */
  maxTokens: number
  lineWidthEm: number
  glyphWidthEm: number
  maxLines: number
}

/**
 * The style's line budget, applied to the translation's font and size. A
 * smaller secondary line fits proportionally more text per line.
 */
export function translatedCardBudget(
  style: CaptionStyle,
  aspectRatio: number,
  font: TranslationFont,
  scale = 1
): TranslatedCardBudget {
  const base = captionLayoutBudget(style, aspectRatio)
  const glyph = font.systemFallback ? (style.uppercase ? UNKNOWN_FACE_GLYPH_EM.upper : UNKNOWN_FACE_GLYPH_EM.lower) : base.glyphWidthEm
  return {
    maxTokens: isUnspaced(font.script) ? Number.POSITIVE_INFINITY : base.maxWords,
    lineWidthEm: base.lineWidthEm / scale,
    glyphWidthEm: glyph,
    maxLines: base.maxLines
  }
}

/** Greedy packing; `maxFor(card)` is the token cap of the card being filled. */
function packCards(tokens: Token[], budget: TranslatedCardBudget, maxFor: (card: number) => number): Token[][][] {
  const cards: Token[][][] = []
  let lines: Token[][] = []
  let lineWidth = 0
  let count = 0
  const flush = (): void => {
    if (count) cards.push(lines)
    lines = []
    lineWidth = 0
    count = 0
  }
  for (const token of tokens) {
    const width = tokenWidthEm(token.text, budget.glyphWidthEm)
    const gap = token.spaced ? SPACE_WIDTH_EM : 0
    const fits = count === 0 || lineWidth + gap + width <= budget.lineWidthEm
    if (count >= maxFor(cards.length) || (!fits && lines.length >= Math.max(1, budget.maxLines))) flush()
    if (count === 0) {
      lines.push([token])
      lineWidth = width
    } else if (lineWidth + gap + width <= budget.lineWidthEm) {
      lines[lines.length - 1].push(token)
      lineWidth += gap + width
    } else {
      lines.push([token])
      lineWidth = width
    }
    count++
  }
  flush()
  return cards
}

/**
 * Split one translated sentence into cards of display lines. Cards are
 * balanced: seven words on a three-word style become 3+2+2, not 3+3+1, so
 * no card flashes up with a lone word.
 */
export function splitTranslatedSentence(
  text: string,
  budget: TranslatedCardBudget,
  style: Pick<CaptionStyle, 'wordsPerGroup' | 'uppercase'>,
  script: CaptionScript,
  languageCode?: string
): string[][] {
  const tokens = tokenize(text, script, languageCode).map((t) => {
    // Punctuation follows the style's rule for its cards; case follows the
    // target language's own rules (Turkish dotted I, German ß).
    const shown = captionWordText(t.text, { ...style, uppercase: false })
    return { ...t, text: style.uppercase ? shown.toLocaleUpperCase(languageCode || undefined) : shown }
  }).filter((t) => t.text.length > 0)
  if (!tokens.length) return []
  let cards = packCards(tokens, budget, () => budget.maxTokens)
  if (cards.length > 1 && Number.isFinite(budget.maxTokens)) {
    // Spread the tokens evenly over the same number of cards, larger first.
    const n = cards.length
    const base = Math.floor(tokens.length / n)
    const extra = tokens.length % n
    const balanced = packCards(tokens, budget, (card) => base + (card < extra ? 1 : 0))
    if (balanced.length === n) cards = balanced
  }
  return cards.map((lines) => lines.map((line) => line.map((t, i) => (i > 0 && t.spaced ? ' ' : '') + t.text).join('')))
}

export interface TranslatedCaptionEvent {
  /** Clip-relative output seconds (after cuts and pause removal). */
  start: number
  end: number
  lines: string[]
  rtl: boolean
}

export interface TranslatedCaptionOptions {
  /** Output seconds before the clip proper starts (a cold open); events shift by it. */
  outputOffset?: number
  style: CaptionStyle
  /** Output frame width / height. */
  aspectRatio: number
  font: TranslationFont
  /** 1 for translated-only captions, TRANSLATED_SECONDARY_SCALE under the original. */
  scale: number
  languageCode?: string
}

/**
 * Cards for the playable translated lines, in output time. Each sentence's
 * slot is mapped through the same time map as the original captions (kept
 * segments, or the trim when nothing is cut), shared between its cards in
 * proportion to their text length, and the last card holds briefly after the
 * sentence the way original captions do — never into the next sentence or
 * past the clip end.
 */
export function translatedCaptionEvents(
  lines: TranslationLine[],
  segments: KeptSegment[] | null,
  clipStart: number,
  clipEnd: number,
  opts: TranslatedCaptionOptions
): TranslatedCaptionEvent[] {
  const map = new TimeMap(segments?.length ? segments : [{ start: clipStart, end: clipEnd }])
  const offset = opts.outputOffset ?? 0
  const duration = offset + map.outputDuration
  const budget = translatedCardBudget(opts.style, opts.aspectRatio, opts.font, opts.scale)
  const rtl = isRightToLeft(opts.font.script)
  const slots = lines.map((line) => ({ line, start: offset + map.toOutput(line.start), end: offset + map.toOutput(line.end) }))
  const events: TranslatedCaptionEvent[] = []
  slots.forEach((slot, index) => {
    const cards = splitTranslatedSentence(slot.line.text, budget, opts.style, opts.font.script, opts.languageCode)
    const span = slot.end - slot.start
    if (!cards.length || span <= 0.01) return
    const weights = cards.map((card) => Math.max(1, visibleLength(card.join(''))))
    const total = weights.reduce((a, b) => a + b, 0)
    const nextStart = slots[index + 1]?.start ?? duration
    let at = slot.start
    cards.forEach((card, i) => {
      const last = i === cards.length - 1
      const start = at
      let end = last ? slot.end : at + (span * weights[i]) / total
      at = end
      if (last) end = Math.min(duration, Math.max(slot.end, Math.min(slot.end + CAPTION_HOLD_SEC, nextStart)))
      events.push({ start, end, lines: card, rtl })
    })
  })
  return events
}

export interface TranslatedCaptionLayout {
  fontScale: number
  /** 'center': block centred on its line (as originals); 'top': hangs below it. */
  anchor: 'center' | 'top'
}

/** Size and anchoring of translated captions for a mode. */
export function translatedCaptionLayout(style: CaptionStyle, mode: Exclude<CaptionLanguageMode, 'original'>): TranslatedCaptionLayout {
  return mode === 'both'
    ? { fontScale: style.fontScale * TRANSLATED_SECONDARY_SCALE, anchor: 'top' }
    : { fontScale: style.fontScale, anchor: 'center' }
}

/**
 * Outline for translated text. Pill styles have no outline of their own (the
 * pill behind the active word carries them), and translated cards have no
 * active word, so they get a modest outline to stay legible on video.
 */
export function translatedOutlineWidth(style: CaptionStyle, scale: number): number {
  return (style.outlineWidth > 0 ? style.outlineWidth : 2) * scale
}

/**
 * Everything a renderer needs to draw a clip's translated captions, or null
 * when the clip shows only its original captions.
 */
export interface TranslatedCaptionPlan {
  mode: Exclude<CaptionLanguageMode, 'original'>
  font: TranslationFont
  layout: TranslatedCaptionLayout
  events: TranslatedCaptionEvent[]
}

export function translatedCaptionPlan(
  clip: Pick<Clip, 'edit' | 'visualStory' | 'gapActivity' | 'translation'>,
  transcript: Transcript | null,
  segments: KeptSegment[] | null,
  style: CaptionStyle,
  aspectRatio: number,
  platform: CaptionPlatform,
  outputOffset = 0
): TranslatedCaptionPlan | null {
  const mode = effectiveCaptionLanguage(clip)
  const translation = clip.translation
  if (mode === 'original' || !translation) return null
  const lines = translationState(clip, translation, transcript).playable
  const font = translationFont(style.fontFamily, lines.map((l) => l.text).join(' '), platform, translation.languageCode)
  const layout = translatedCaptionLayout(style, mode)
  const events = translatedCaptionEvents(lines, segments, clip.edit.start, clip.edit.end, {
    style,
    aspectRatio,
    font,
    scale: layout.fontScale / style.fontScale,
    languageCode: translation.languageCode,
    outputOffset
  })
  return { mode, font, layout, events }
}

/**
 * Vertical position (fraction of frame height) of the translated block. Alone
 * it takes the original's place. Under the original it hangs below the
 * tallest original block (two lines), so it does not jump as the original
 * changes between one and two lines, and is pulled up if it would leave the
 * frame.
 */
export function translatedCaptionY(style: CaptionStyle, mode: Exclude<CaptionLanguageMode, 'original'>, basePosition: number): number {
  if (mode === 'translated') return basePosition
  const layout = translatedCaptionLayout(style, mode)
  const below = basePosition + (CAPTION_MAX_LINES * style.fontScale * CAPTION_LINE_HEIGHT_EM) / 2 + style.fontScale * 0.3
  const blockHeight = CAPTION_MAX_LINES * layout.fontScale * CAPTION_LINE_HEIGHT_EM
  return Math.min(below, 0.98 - blockHeight)
}
