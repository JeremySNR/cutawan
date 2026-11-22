import type { CaptionEmphasisWord, TranscriptWord } from './types'
import { isFiller } from './tighten'

/**
 * Caption emphasis: which spoken word in each caption card is drawn bigger in
 * an accent colour, and which of those get an emoji. Shared by the burned-in
 * ASS and the live preview so both mark the same words.
 *
 * The words come from the clip's visual review when it ran (one extra field
 * in a request that was being made anyway), else from a deterministic
 * heuristic: numbers, strong words, proper nouns and the hook's key words.
 * Either way only words actually spoken in the clip can be marked, at most
 * one per caption card, and never a filler or a function word.
 */

/**
 * The emoji the bundled "Cutawan Emoji" font carries (a subset of Noto Emoji,
 * see resources/fonts/OFL-NotoEmoji.txt). libass cannot draw colour emoji, so
 * these are outline glyphs tinted like the text: that is what renders the same
 * in the preview and the export. Anything outside this set is rejected.
 */
export const CAPTION_EMOJI = [
  '🔥', '💰', '🚀', '😂', '🤯', '💡', '✅', '❌', '⚠', '❤', '👀', '🎯', '📈', '📉', '💪', '🧠', '⏰', '🎉',
  '🙌', '😱', '🤔', '👏', '💯', '⭐', '🏆', '💥', '🤝', '😍', '🙏', '💸', '📱', '🌍', '⚡', '🔑', '🛑', '👉',
  '🤑', '😅', '💀', '🎬', '📚', '⏳', '💔', '😎', '🧐', '📣', '🔒', '💻', '🤖', '🎵', '🌱', '🚨', '👑', '💎',
  '✨', '📊', '💵', '😢', '😡', '👍'
] as const

/** Font family of the bundled emoji subset (resources/fonts/CutawanEmoji.ttf). */
export const CAPTION_EMOJI_FONT = 'Cutawan Emoji'

const EMOJI_SET = new Set<string>(CAPTION_EMOJI)

/** Strip variation selectors so "❤️" matches the font's "❤". */
export function normalizeEmoji(value: string | undefined | null): string | null {
  if (!value) return null
  const bare = value.replace(/[︎️]/g, '').trim()
  return EMOJI_SET.has(bare) ? bare : null
}

/** Emphasised words are drawn this much larger than the rest of the card. */
export const EMPHASIS_SCALE = 1.18
/** Width an emoji (plus its gap) adds to a line, in em of the caption font. */
export const EMOJI_WIDTH_EM = 1.3
/** Emoji em size relative to the caption's em (the ASS and the preview both use it). */
export const EMOJI_EM = 0.95
/** At most one emoji in this many seconds of output, and this many per clip. */
const EMOJI_MIN_GAP_SEC = 6
const EMOJI_MAX_PER_CLIP = 4

/** Lower-case, letters and digits only: how spoken words and keywords are compared. */
export function emphasisKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/['’]s$/u, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Function words and conversational glue that never carry the point. */
const STOPWORDS = new Set((
  'a an the and or but so if then than that this these those there here it its it\'s is are was were be been being ' +
  'am do does did doing have has had having i me my mine we us our you your yours he him his she her they them their ' +
  'to of in on at by for with from up down out over under about into onto off as just like really very also too ' +
  'what which who whom whose when where why how all any some no not nor only own same such can could will would ' +
  'should shall may might must one ones get got gets go goes going gonna wanna kind sort thing things stuff yeah yes ' +
  'okay ok right well know mean think actually basically literally because cause im youre theyre thats dont doesnt ' +
  'didnt cant wont isnt arent wasnt let lets say said says see make made way much many more most lot lots even ' +
  'still now back time something anything everything someone people guy guys let\'s been other another again'
).split(' ').map(emphasisKey))

/** Words that land as emphasis on their own in short-form captions. */
const STRONG_WORDS = new Set((
  'never always best worst biggest secret secrets free mistake mistakes million millions billion billions ' +
  'thousand hundred percent insane crazy huge massive impossible incredible dangerous deadly fastest ' +
  'cheapest expensive richest broke money cash rich wealth profit fail failed failure win won winning ' +
  'lost lose truth lie lies wrong shocking stop warning exactly only first last ever nobody everyone ' +
  'zero double triple love hate fear dream quit fired hired banned illegal genius stupid perfect ' +
  'brutal hardest easiest simple simplest proven guaranteed'
).split(' '))

/** A few unambiguous word-to-emoji pairs for the no-AI path. */
const HEURISTIC_EMOJI: Record<string, string> = {
  money: '💰', cash: '💵', rich: '🤑', profit: '📈', million: '💰', millions: '💰', billion: '💰', billions: '💰',
  fire: '🔥', hot: '🔥', love: '❤', heart: '❤', idea: '💡', ideas: '💡', brain: '🧠', think: '🤔', time: '⏰',
  win: '🏆', won: '🏆', winning: '🏆', champion: '🏆', growth: '📈', grow: '📈', crash: '📉', rocket: '🚀',
  launch: '🚀', phone: '📱', world: '🌍', secret: '🔒', key: '🔑', stop: '🛑', warning: '⚠', danger: '⚠',
  goal: '🎯', target: '🎯', music: '🎵', robot: '🤖', ai: '🤖', computer: '💻', crazy: '🤯', insane: '🤯',
  mindblowing: '🤯', strong: '💪', perfect: '💯', book: '📚', books: '📚', dead: '💀', party: '🎉', king: '👑'
}

export interface EmphasisContext {
  /** Validated AI keywords; when present they are the only candidates. */
  words?: CaptionEmphasisWord[] | null
  /** The clip's hook line; its content words count in the heuristic. */
  hook?: string
}

function isNumberish(text: string): boolean {
  return /\d/.test(text) || /^(?:[$€£¥]|.*%$)/.test(text)
}

/**
 * How strongly each word asks to be emphasised; 0 means never. AI keywords
 * outrank everything and switch the heuristic off.
 */
export function emphasisScores(words: TranscriptWord[], ctx: EmphasisContext): number[] {
  const ai = (ctx.words ?? []).map((w) => ({ key: emphasisKey(w.text), emoji: w.emoji }))
    .filter((w) => w.key.length > 0)
  if (ai.length) {
    return words.map((w) => {
      const key = emphasisKey(w.text)
      const rank = ai.findIndex((k) => k.key === key)
      return rank === -1 || !isEmphasisCandidate(w.text) ? 0 : 10 + (ai.length - rank) / ai.length
    })
  }
  const hookKeys = new Set((ctx.hook ?? '').split(/\s+/).map(emphasisKey)
    .filter((k) => k.length >= 4 && !STOPWORDS.has(k)))
  return words.map((w, i) => {
    if (!isEmphasisCandidate(w.text)) return 0
    const key = emphasisKey(w.text)
    let score = 0
    if (isNumberish(w.text)) score = Math.max(score, 4)
    if (STRONG_WORDS.has(key)) score = Math.max(score, 3)
    if (hookKeys.has(key)) score = Math.max(score, 3)
    const previous = words[i - 1]
    const sentenceStart = !previous || /[.!?]["'”’)]*$/.test(previous.text) || w.start - previous.end > 1.2
    if (!sentenceStart && /^\p{Lu}\p{Ll}/u.test(w.text) && key !== 'i') score = Math.max(score, 2.5)
    if (score > 0 && key.length >= 8) score += 0.5
    return score
  })
}

/** Below this a heuristic word is not worth marking. */
const MIN_SCORE = 2.5

/** True for a word that may be emphasised: spoken content, not filler or glue. */
export function isEmphasisCandidate(text: string): boolean {
  const key = emphasisKey(text)
  if (!key || isFiller(text)) return false
  if (isNumberish(text)) return true
  return key.length >= 3 && !STOPWORDS.has(key)
}

/** The emoji to draw after an emphasised word, from the AI pick or the heuristic map. */
export function emphasisEmoji(word: TranscriptWord, ctx: EmphasisContext): string | null {
  const key = emphasisKey(word.text)
  const ai = ctx.words?.find((w) => emphasisKey(w.text) === key)
  if (ctx.words?.length) return normalizeEmoji(ai?.emoji)
  return HEURISTIC_EMOJI[key] ?? null
}

/**
 * Pick at most one word per group: the best-scoring eligible word. Returns a
 * word index into each group, or -1. `groups` are word arrays in display order.
 */
export function pickGroupEmphasis(groups: TranscriptWord[][], scores: Map<TranscriptWord, number>): number[] {
  return groups.map((words) => {
    let best = -1
    let bestScore = MIN_SCORE
    words.forEach((w, i) => {
      const s = scores.get(w) ?? 0
      if (s >= bestScore && (best === -1 || s > bestScore)) {
        best = i
        bestScore = s
      }
    })
    return best
  })
}

/**
 * Thin emoji out to the occasional one: at least EMOJI_MIN_GAP_SEC apart and
 * no more than EMOJI_MAX_PER_CLIP. `candidates` are (time, emoji|null) per
 * group in order; returns the emoji kept per group.
 */
export function thinEmoji(candidates: Array<{ at: number; emoji: string | null }>): Array<string | null> {
  let last = -Infinity
  let count = 0
  return candidates.map((c) => {
    if (!c.emoji || count >= EMOJI_MAX_PER_CLIP || c.at - last < EMOJI_MIN_GAP_SEC) return null
    last = c.at
    count++
    return c.emoji
  })
}

/**
 * Keep only AI keywords that were really spoken in the clip, are not filler or
 * function words, and carry an emoji from the bundled set (or none).
 * `spoken` is the clip's words. Returns at most eight, in the model's order.
 */
export function validateEmphasisWords(raw: unknown, spoken: Array<Pick<TranscriptWord, 'text'>>): CaptionEmphasisWord[] {
  if (!Array.isArray(raw)) return []
  const said = new Set(spoken.map((w) => emphasisKey(w.text)).filter(Boolean))
  const out: CaptionEmphasisWord[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const text = typeof entry.word === 'string' ? entry.word.trim() : typeof entry.text === 'string' ? entry.text.trim() : ''
    // One word only: a phrase cannot be matched to a single caption word.
    if (!text || /\s/.test(text)) continue
    const key = emphasisKey(text)
    if (!key || seen.has(key) || !said.has(key) || !isEmphasisCandidate(text)) continue
    seen.add(key)
    const emoji = normalizeEmoji(typeof entry.emoji === 'string' ? entry.emoji : null)
    out.push(emoji ? { text, emoji } : { text })
    if (out.length >= 8) break
  }
  return out
}
