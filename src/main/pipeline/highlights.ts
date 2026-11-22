import { throwIfSubscriptionError, usesSubscription } from '../subscription'
import { randomUUID } from 'node:crypto'
import type {
  AnalyzeOptions,
  Clip,
  ClipLengthPreference,
  ScoreBreakdown,
  TimeRange,
  Transcript
} from '@shared/types'
import { SCORE_PARTS, normalizeScoreParts, rescaleScoreParts, scoreFromParts } from '@shared/scoreBreakdown'
import { MAX_REWIND_COUNT, isEnglishLanguage, reviewOpening, rewindOpening } from '@shared/clipOpenings'
import { mapLimit } from './concurrency'
import { MIN_JOIN_GAP_SEC, mergeNearbyRanges, selectedDuration, selectedRanges } from '@shared/clipSegments'
import { DEFAULT_CAPTION_STYLE_ID } from '@shared/captionStyles'
import { initialClipEditForVideoType } from '@shared/videoType'
import {
  normalizeClipEnd,
  padSpeechStart,
  padSpeechEnd,
  sentenceAt,
  sentencesInRange,
  transcriptSentences,
  type Sentence
} from '@shared/sentences'
import { chatJSON } from './openai'
import { buildVideoOutline, type OutlinePairing } from './outline'
import { CLIP_KINDS, diversifyClipOrder, parseClipKind } from '@shared/clipVariety'
import {
  NO_MARKS,
  MIN_REACTION_STRENGTH,
  REACTION_LAG_SEC,
  TOPIC_CHANGE_LINE,
  edgeSpeaker,
  hasMarks,
  reactionSuffix,
  speakerPrefix,
  topicChangeBetween,
  transcriptMarks,
  type LineMarks
} from './lineMarks'
import { detectTopics, type SentenceEmbedder, type TopicBoundaries } from './topics'
import { defaultSentenceEmbedder } from './sentenceEmbedder'
import { inferVideoType, videoTypeGuidance } from './videoTypePrompt'

/**
 * A clip's span as the model gave it: the numbers of the first and last
 * transcript lines it plays (inclusive), or — from a provider that ignored
 * the schema and fell back on old habits — start and end in seconds. Every
 * field is optional because nothing a non-strict provider returns can be
 * trusted to be present or well-typed.
 */
interface RawSpan {
  start_line?: unknown
  end_line?: unknown
  start?: unknown
  end?: unknown
}

interface RawHighlight extends RawSpan {
  /** The clip's parts in source order, when joining moments is allowed. */
  segments?: RawSpan[]
  /** Why the parts belong together; empty for a single part. */
  join_reason?: string
  /** One of CLIP_KINDS; anything else (or nothing, from a non-strict provider) is no kind. */
  kind?: unknown
  title: string
  hook: string
  summary: string
  payoff: string
  /** Rubric components; absent from models that ignore the schema. */
  score_parts?: Partial<Record<keyof ScoreBreakdown, number>>
  virality_score: number
  virality_reason: string
  hashtags: string[]
}

interface HighlightResponse {
  clips: RawHighlight[]
}

/** Fields every clip carries, whichever way its span is expressed. */
const CLIP_FIELDS = {
  title: {
    type: 'string',
    description: 'Punchy social-media title, max 60 characters, no hashtags'
  },
  hook: {
    type: 'string',
    description: 'Scroll-stopping first line to overlay during the first seconds'
  },
  summary: { type: 'string', description: 'One sentence describing the moment' },
  kind: {
    type: 'string',
    enum: CLIP_KINDS,
    description: 'What sort of moment this is: story (an anecdote told through), insight (a tip, lesson or insight the viewer can use), opinion (a hot take or strong stance), funny, emotional, explainer (how or why something works), or other'
  },
  payoff: {
    type: 'string',
    description:
      'The closing line or idea the clip ends on and why it lands (resolution, punchline, answer, takeaway, or pointed question). A clip whose ending does not land should not be selected.'
  },
  score_parts: {
    type: 'object',
    additionalProperties: false,
    required: SCORE_PARTS.map((part) => part.key),
    description: 'The rubric components, each scored on its own scale before anything is summed',
    properties: Object.fromEntries(
      SCORE_PARTS.map((part) => [part.key, { type: 'integer', description: `${part.rubric} (0-${part.max})` }])
    )
  },
  virality_score: {
    type: 'integer',
    description: 'The sum of score_parts (0-99)'
  },
  virality_reason: {
    type: 'string',
    description: 'Short explanation of the score citing hook/emotion/value'
  },
  hashtags: {
    type: 'array',
    items: { type: 'string' },
    description: '3-5 lowercase hashtags without the # symbol'
  }
} as const

/** Most separate moments one clip may join. */
const MAX_SEGMENTS = 3

/**
 * The reply shape. A clip is a single start and end unless joining moments
 * is allowed, in which case it is an ordered list of one to three parts.
 */
function responseSchema(stitch: boolean): Record<string, unknown> {
  const properties = clipProperties(stitch)
  return {
    type: 'object',
    additionalProperties: false,
    required: ['clips'],
    properties: {
      clips: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
      }
    }
  }
}

/** The fields of one clip in a reply: its span (one range, or segments) and the rest. */
function clipProperties(stitch: boolean): Record<string, unknown> {
  const span = stitch
    ? {
        segments: {
          type: 'array',
          description: `The clip's parts in the order they occur in the video: one part for a continuous clip, up to ${MAX_SEGMENTS} when joining separate moments`,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['start_line', 'end_line'],
            properties: {
              start_line: { type: 'integer', description: 'Number of the transcript line the part opens on' },
              end_line: { type: 'integer', description: 'Number of the transcript line the part closes on (included in the part)' }
            }
          }
        },
        join_reason: {
          type: 'string',
          description: 'For a clip with more than one part: what was skipped between the parts and why the clip is better without it. Empty for one part.'
        }
      }
    : {
        start_line: { type: 'integer', description: 'Number of the transcript line the clip opens on' },
        end_line: { type: 'integer', description: 'Number of the transcript line the clip closes on (included in the clip)' }
      }
  return { ...span, ...CLIP_FIELDS }
}

/**
 * Length is a preference, not a straitjacket. We give the model a target band
 * and a hard upper cap, but let it come in shorter when the moment is complete
 * — a self-contained 20s beat beats the same beat padded to 30s with trailing
 * filler. Platforms rank on completion rate, and padding a tight moment to hit
 * a number is the fastest way to tank it, so we never pad after the fact.
 */
/**
 * The length a clip should come back at when it was too long: the middle of
 * the preference's range, not just under the cap. Told only the cap, a model
 * trims to a second under it every time, which pads every clip to the limit.
 */
function repairLengthBand(pref: ClipLengthPreference): string {
  switch (pref) {
    case 'short': return '15 to 30 seconds'
    case 'medium': return '30 to 60 seconds'
    case 'long': return '60 to 90 seconds'
    default: return '30 to 60 seconds'
  }
}

function lengthGuidance(pref: ClipLengthPreference): string {
  const soft = softMaxDurationFor(pref)
  const ceiling = maxDurationFor(pref)
  const overrun = `Stay within ${soft} seconds. Go past it, never beyond ${ceiling}, only when the moment genuinely needs the extra seconds to land; an overrun counts against a clip when clips are ranked.`
  switch (pref) {
    case 'short':
      return `Aim for clips around 15-30 seconds long (from the start time of its first line to the end time of its last). ${overrun} If a moment is complete in less time, keep it short rather than padding it.`
    case 'medium':
      return `Aim for clips around 30-60 seconds long (from the start time of its first line to the end time of its last). ${overrun} Favour the length the moment actually needs — do not pad a complete moment to fill the range.`
    case 'long':
      return `Aim for clips around 60-90 seconds long (from the start time of its first line to the end time of its last). ${overrun} Only reach the top of the range when the moment genuinely sustains it; do not pad with setup or tangents.`
    case 'auto':
      return `Choose whatever length lets each moment land — anywhere from about 15 to 90 seconds. ${overrun} Cut to the moment; do not pad it to reach a length.`
    default: {
      const exhaustive: never = pref
      return exhaustive
    }
  }
}

/**
 * The length a clip should stay within for a preference. Not a wall: a clip
 * that runs past it, up to `maxDurationFor`, is kept whole and ranked a
 * little lower (see `lengthPenalty`). Cutting a strong clip short of its
 * payoff to honour a round number costs more than a few extra seconds.
 */
export function softMaxDurationFor(pref: ClipLengthPreference): number {
  switch (pref) {
    case 'short':
      return 45
    case 'medium':
      return 75
    case 'long':
      return 100
    case 'auto':
      return 100
    default: {
      const exhaustive: never = pref
      return exhaustive
    }
  }
}

/** How far past the soft limit a clip may run before it is trimmed or repaired. */
const OVERRUN_ALLOWANCE = 0.25

/**
 * Hard upper cap per preference, enforced after the LLM responds: a quarter
 * past the soft limit, and never past three minutes, the longest YouTube
 * Shorts and Instagram Reels accept. Past this a clip is not a strong moment
 * running long; in live runs it was a model that lost count of the seconds
 * (150 to 310 s against a 100 s limit), and it is repaired or trimmed.
 */
export function maxDurationFor(pref: ClipLengthPreference): number {
  return Math.min(PLATFORM_MAX_SEC, Math.round(softMaxDurationFor(pref) * (1 + OVERRUN_ALLOWANCE)))
}
const PLATFORM_MAX_SEC = 180

/**
 * Ranking points a clip loses for running past its soft limit: about one
 * point per four percent over, at most eight. Small enough that a clearly
 * better clip still ranks above a tidy ordinary one; large enough that of two
 * similar clips the one that fits comes first.
 */
export function lengthPenalty(playedSec: number, softMaxSec: number): number {
  if (!(playedSec > softMaxSec) || softMaxSec <= 0) return 0
  return Math.min(MAX_LENGTH_PENALTY, Math.ceil(((playedSec - softMaxSec) / softMaxSec) * 25))
}
const MAX_LENGTH_PENALTY = 8

/**
 * Apply the overrun penalty to every clip from its final played length, once,
 * after every review and the rerank have settled the clip and its score. The
 * points come off the structure part (pacing is part of structure), and the
 * clip says why.
 */
export function applyLengthPenalties(clips: Clip[], softMaxSec: number): Clip[] {
  return clips.map((clip) => {
    const played = selectedDuration(clip.edit)
    const points = lengthPenalty(played, softMaxSec)
    if (points === 0) return clip
    const note = `Runs ${Math.round(played)} seconds, past the ${softMaxSec}-second target for this length; kept whole rather than cut short.`
    const penalised = penalisePart(clip, 'structure', points)
    return { ...penalised, viralityReason: [clip.viralityReason?.trim(), note].filter(Boolean).join(' ') }
  })
}

/**
 * Plain seconds, not m:ss — models reliably echo the same unit back, whereas
 * "5:30" style timestamps get misread as 5.5 seconds on long videos.
 */
function formatTimestamp(sec: number): string {
  return `${sec.toFixed(1)}s`
}

/**
 * The transcript as the model sees it: one sentence per line with its number,
 * its start and end, and a delivery tag on the most and least energetic
 * lines. The number is the sentence's index in the whole transcript, so the
 * same line carries the same number in every analysis window. The model
 * answers with line numbers and the code looks the times up: a model asked to
 * copy a time back drifts by a word or a line, while a number either names a
 * line it was shown or is plainly wrong. The times stay on the line because
 * the model needs them to judge how long a clip runs.
 *
 * With `marks`, a line also says who speaks it, "(Speaker B)" after the times
 * (only when the video has more than one speaker), and carries a
 * "[laughter after]" style tag when the audience reacts right after it; and a
 * separator line stands between two lines where the topic changes. A line
 * still starts "#n [start - end] ", which providers and tests rely on.
 * Exported for tests.
 */
export function formatTranscriptForModel(sentences: Sentence[], opts: { durations?: boolean; marks?: LineMarks } = {}): string {
  const marks = opts.marks ?? NO_MARKS
  return sentences
    .map((s, i) => {
      const delivery =
        s.energy === undefined
          ? ''
          : s.energy >= 0.8
            ? ' [delivery: energetic]'
            : s.energy <= 0.2
              ? ' [delivery: subdued]'
              : ''
      // With durations, a model can add up a clip's length instead of
      // subtracting timestamps, which it does badly on long videos.
      const length = opts.durations ? `, ${(s.end - s.start).toFixed(1)}s long` : ''
      const line = `#${s.index} [${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}${length}] ${speakerPrefix(marks, s.index)}${s.text}${delivery}${reactionSuffix(marks, s.index)}`
      // Not above the first line shown: a block opening on a new topic has nothing before it to set it apart from.
      return i > 0 && marks.topicStarts.has(s.index) ? `${TOPIC_CHANGE_LINE}\n${line}` : line
    })
    .join('\n')
}

const MIN_CLIP_SEC = 8
/**
 * Shortest part of a joined clip. A two-second fragment spliced between
 * other footage reads as a glitch, not as an edit.
 */
const MIN_SEGMENT_SEC = 3

/** The source ranges a candidate plays, from its suggested span and its joins. */
function candidateRanges(clip: Clip): TimeRange[] {
  return selectedRanges({ start: clip.suggestedStart, end: clip.suggestedEnd, cuts: clip.edit.cuts })
}

/** Seconds of source a candidate skips between its parts. */
function skippedSec(clip: Clip): number {
  return clip.suggestedEnd - clip.suggestedStart -
    selectedDuration({ start: clip.suggestedStart, end: clip.suggestedEnd, cuts: clip.edit.cuts })
}

/** Breathing room added before the first word of a clip. */
const START_PRE_ROLL_SEC = 0.25
/** How far the clip start may move to land on a sentence beginning. */
const START_SNAP_SEC = 2.5
/**
 * Tail padding after the last word so endings land softly instead of cutting
 * the instant the word finishes (the export adds an audio fade inside it).
 */
const END_POST_ROLL_SEC = 0.6
/** How far the clip end may move to land on a sentence boundary. */
const SENTENCE_SNAP_SEC = 2.5

/**
 * The scoring rubric operationalises published virality research rather than
 * vibes — primarily Berger & Milkman, "What Makes Online Content Viral?"
 * (Journal of Marketing Research, 2012): sharing is driven by physiological
 * AROUSAL. High-arousal emotions (awe, amusement/humour, excitement, anger,
 * anxiety) increase transmission; low-arousal/deactivating emotions (sadness)
 * decrease it, independent of positive/negative valence. Surprise, interest
 * and practical utility are independently positively linked to sharing, and
 * anger was the single strongest predictor in their model. Berger (2011,
 * Psychological Science) shows induced arousal alone increases sharing.
 */
const SYSTEM_PROMPT = `You are an expert short-form video editor who selects moments most likely to go viral as standalone vertical clips. You receive the transcript of a long video as one sentence per line, each prefixed with its line number (#12) and the second it starts and the second it ends. Some lines carry a [delivery: ...] tag measured from the actual audio — "energetic" marks the speaker's most aroused, animated delivery, "subdued" the flattest.

Selection rules:
- Every clip MUST have the shape of a complete micro-video: a HOOK that grabs in the first sentence, a BUILD that develops or escalates it, and an ENDING THAT LANDS. A statement or observation on its own — however interesting — is not a clip.
- What "lands" depends on the material. A story lands on its resolution or emotional beat. Comedy lands on the punchline. An argument lands on its sharpest, most quotable formulation. A reveal lands on the answer. Practical content lands on the takeaway. A deliberately provocative clip can even land on a pointed question that throws back to the hook. All of these are valid endings.
- What never lands: trailing setup or scene-setting, context that introduces an idea and stops, the middle of a list, or an aside (ending right after "People were experimenting with ChatGPT for the first time" leaves the thought hanging — the sentence exists to set up whatever comes next). If the beat that completes the thought arrives one or two sentences after the moment you picked, extend the clip to include it.
- Every clip MUST start at the beginning of a sentence or thought and end at a natural conclusion. A clip is given as the number of the line it opens on ("start_line") and the number of the line it closes on ("end_line"); both lines are part of the clip. A clip runs from the start time of its first line to the end time of its last; use those times to judge its length.
- Prefer moments with a strong hook in the first 3 seconds: bold claims, surprising facts, emotional peaks, controversy, humour, actionable value, or compelling storytelling.
- Clips must be self-contained: a viewer with zero context must understand them.
- Do not overlap clips. Order them by virality score, highest first.
- Use only line numbers that appear in the transcript you are given.

Virality scoring rubric (0-99), grounded in sharing research (Berger & Milkman 2012: physiological arousal drives transmission; anger, awe and anxiety are the strongest predictors; sadness suppresses sharing; surprise and practical value independently boost it):
- Hook strength in the first sentence — curiosity gap, bold claim, or open question (0-30)
- High-arousal emotion — awe, amusement, excitement, anger, anxiety, surprise. Weight moments tagged [delivery: energetic] upward; a flat, deactivating or sad moment scores low here even if well-worded (0-25)
- Value — practical utility the viewer can apply, or novel insight that makes the sharer look smart (0-20)
- Structure — a clear hook -> build -> landing arc; a clip that is just a statement, or whose final sentence is setup rather than a landing, scores 0 here (0-15)
- Shareability — would someone tag a friend, argue in the comments, or repost to signal identity? (0-9)
Score each part separately in score_parts, on its own scale, before summing; the final score is their sum. Be honest and discriminating: most clips score 40-75, reserve 85+ for exceptional moments. A clip is rarely strong on every part — give each part the number it earns rather than spreading one overall impression across all five.`

/**
 * Added to the selection prompt when clips may join separate moments. The
 * bar is deliberately high: a continuous clip is the default, and a join has
 * to earn its place by removing something specific.
 */
const STITCH_PROMPT = `Joining moments:
- Each clip is a list of "segments" in the order they occur in the video. Almost every clip should be ONE segment: a continuous moment. Never split a continuous moment into several segments to remove ordinary pauses, filler or a few words — that is done automatically afterwards.
- Use two segments (at most ${MAX_SEGMENTS}) only when skipping what lies between them makes a clearly better clip. The cases worth it: a question whose real answer comes after a tangent or interruption; a setup whose payoff arrives later; a claim and the single best piece of evidence for it. The skipped stretch should be at least several sentences long.
- The join must be invisible to a listener. Read the last line of one segment straight into the first line of the next: it has to follow as if nothing was removed. The later segment must not lean on anything that was skipped — no "that", "he", "this one" or "as I said" pointing at removed lines, and no answer to a question the viewer never heard.
- Never change what a speaker meant. Do not join a question to an answer that was given to a different question. Do not skip a qualification, a condition, a "but", a correction or a negation that changes the claim. Do not join lines from different speakers into what sounds like one statement. If you are not sure the joined clip is faithful to what was said, return the continuous moment instead.
- Every segment is a "start_line" and an "end_line" (both included), and holds at least one complete sentence. Segments are listed in video order and do not overlap. The clip's length is the total of its segments, each running from the start time of its first line to the end time of its last.
- State in join_reason what was skipped and why the clip is better without it.`

/**
 * What the selection prompt says about the marks on the lines, only for the
 * marks this transcript has, so a transcript without any reads the prompt it
 * always did. Speakers show who asks and who answers; a reaction shows where
 * a line landed, and that the payoff comes before it; a topic change shows
 * where a clip would start depending on a different subject. Exported for
 * tests.
 */
export function markingsGuidance(marks: LineMarks): string {
  const has = hasMarks(marks)
  const rules: string[] = []
  if (has.speakers) {
    rules.push('- Lines carry their speaker, measured from the voices: (Speaker A), (Speaker B) and so on, and (Speaker A, then B) for a line where the speaker changes partway. Use them to see who asks and who answers. A clip built on an answer needs the question that prompted it, or must make sense without it; a clip should not end on one speaker\'s question with the answer left out. Never present lines from two speakers as one person\'s statement, and never join one speaker\'s question to an answer that was given to someone else\'s.')
  }
  if (has.reactions) {
    rules.push('- A [laughter after], [applause after] or [reaction after] tag, measured from the audio, means the audience reacted right after that line: evidence that it landed, so weigh it in the emotion score. The reaction comes AFTER the payoff. A clip that uses it starts at the setup, includes the tagged line, and ends on it or a line or two after (the clip keeps a beat of the reaction itself). Never open a clip on the line right after a reaction: the viewer would hear the end of a laugh at a joke they missed.')
  }
  if (has.topics) {
    rules.push(`- A line reading "${TOPIC_CHANGE_LINE}" between two numbered lines marks where the subject changes, measured from the words, so it is approximate. A clip should normally stay within one topic: do not open a clip just before a topic change or run it past one, unless the lines after it are plainly the same thought continuing.`)
  }
  return rules.length > 0 ? `Marks on the transcript lines:\n${rules.join('\n')}` : ''
}

/**
 * How many clips to ask the LLM for: roughly one per minute of source video.
 * Exported for tests.
 */
export function targetClipCount(videoDurationSec: number): number {
  return Math.max(4, Math.min(40, Math.round(videoDurationSec / 60)))
}

/** Snap a time to the nearest transcript word boundary within a tolerance. */
function snap(time: number, boundaries: number[], toleranceSec: number): number {
  let best = time
  let bestDist = toleranceSec
  for (const b of boundaries) {
    const d = Math.abs(b - time)
    if (d < bestDist) {
      best = b
      bestDist = d
    }
  }
  return best
}

/**
 * Where a clip should open given the moment the model pointed at. The model
 * works from sentence lines, so its start is normally a sentence start
 * already; when it is not, prefer opening the sentence the moment falls
 * inside (the model wanted that thought) over skipping to the next one, and
 * only fall back to the nearest word boundary deep inside a long sentence.
 * Exported for tests.
 */
export function snapClipStart(start: number, sentences: Sentence[], wordStarts: number[]): number {
  const enclosing = sentenceAt(sentences, start)
  if (enclosing) {
    if (start - enclosing.start <= START_SNAP_SEC) return enclosing.start
    // Deep inside a long sentence: stay on this thought at the nearest word
    // rather than skipping ahead to the next sentence, which would drop the
    // rest of the line the model pointed into.
    return snap(start, wordStarts, 1.5)
  }
  const next = sentences.find((s) => s.start >= start)
  if (next && next.start - start <= START_SNAP_SEC) return next.start
  return snap(start, wordStarts, 1.5)
}

/**
 * Where a clip should close given the moment the model pointed at: the end
 * of the sentence it falls inside when that is near, the end of the sentence
 * just finished when the moment lands in the pause after it, otherwise the
 * nearest word end (normalizeClipEnd then completes the sentence). Exported
 * for tests.
 */
export function snapClipEnd(end: number, sentences: Sentence[], wordEnds: number[]): number {
  const enclosing = sentenceAt(sentences, end)
  if (enclosing) {
    if (enclosing.end - end <= SENTENCE_SNAP_SEC) return enclosing.end
    return snap(end, wordEnds, 1.5)
  }
  let previous: Sentence | null = null
  for (const s of sentences) {
    if (s.end <= end) previous = s
    else break
  }
  if (previous && end - previous.end <= SENTENCE_SNAP_SEC) return previous.end
  return snap(end, wordEnds, 1.5)
}

/** How far the ending review may move a clip's end. */
const MAX_END_EXTEND_SEC = 45
const MAX_END_TRIM_SEC = 20
/** How much transcript beyond a clip's end the ending review gets to see. */
const CONTINUATION_SEC = 45

/**
 * How far the opening review may push a clip's start forward, i.e. the most
 * leading setup it may trim. Bounded so the review can only drop throat-
 * clearing, never lop off the body of a clip.
 */
const MAX_START_ADVANCE_SEC = 20

function withNormalizedEnd(clip: Clip, transcript: Transcript, videoDurationSec: number, maxDuration: number): Clip {
  const end = normalizeClipEnd(clip.suggestedStart, clip.suggestedEnd, transcript, videoDurationSec, {
    postRollSec: END_POST_ROLL_SEC,
    maxExtendSec: MAX_END_EXTEND_SEC
  })
  if (end === clip.suggestedEnd || end - clip.suggestedStart - skippedSec(clip) > maxDuration) return clip
  return { ...clip, suggestedEnd: end, edit: { ...clip.edit, end } }
}

const REFINE_SYSTEM_PROMPT = `You quality-check the ENDINGS of short vertical clips cut from a longer video. A good clip has the shape of a complete micro-video — hook, build, and an ending that lands. What "lands" depends on the material: a story lands on its resolution or emotional beat, comedy on the punchline, an argument on its sharpest formulation, a reveal on the answer, practical content on the takeaway, and a provocative clip can land on a pointed question that throws back to the hook. An ending fails when the clip stops on setup, scene-setting context, the middle of a list, or a plain observation that promises more (e.g. ending on "People were experimenting with ChatGPT for the first time" — that sentence exists to set up whatever comes next).

For each clip you receive its transcript and the sentences that follow it in the source video, each tagged with its line number and the time it ends. Judge the current ending strictly. Punctuation is not proof that a thought is complete. Prefer trimming to an existing payoff over extending into a new topic. A host's next interview question, thanks, or conversational handoff is NOT a closing payoff: end before it unless its complete answer belongs to this same story and fits the limit. A rhetorical question addressed to the audience can work, but do not confuse it with a question addressed to another participant. If a fragment follows a complete ending, trim the fragment; do not automatically extend it. Never append a new scene merely to finish its sentence. Only use line numbers of tagged lines from that clip's own block.`

/**
 * Added to the ending review's instructions for the marks its lines carry.
 * A reaction tag tells it where a line landed; a speaker change in the
 * continuation is usually the next question; a topic change is where the
 * ending must stop. Exported for tests.
 */
export function endingMarksGuidance(marks: LineMarks): string {
  const has = hasMarks(marks)
  const rules: string[] = []
  if (has.speakers) rules.push('Lines carry their speaker, measured from the voices. When the continuation switches to another speaker, it is usually a new question or a reaction to the answer: end before it unless that speaker completes this same thought.')
  if (has.reactions) rules.push('A [laughter after], [applause after] or [reaction after] tag means the audience reacted right after that line, measured from the audio: that line landed. Ending on it is usually right, and the clip keeps a beat of the reaction automatically; do not run on past it into the next thought.')
  if (has.topics) rules.push(`A "${TOPIC_CHANGE_LINE}" line marks where the subject changes (approximate). Never move an ending past it.`)
  return rules.join(' ')
}

/** One line as a review shows it: number, a time, speaker, text and reaction tag. */
function reviewLine(s: Sentence, marks: LineMarks, time: string): string {
  return `  #${s.index} [${time}] ${speakerPrefix(marks, s.index)}${s.text}${reactionSuffix(marks, s.index)}`
}

interface RefinedEnding {
  index: number
  ends_with_payoff: boolean
  /** Line number of the tagged line the clip should close on. */
  better_end_line?: unknown
  /** Seconds, from a provider that ignored the schema. */
  better_end?: unknown
  reason: string
}

const REFINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['endings'],
  properties: {
    endings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'ends_with_payoff', 'better_end_line', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The clip number being judged' },
          ends_with_payoff: {
            type: 'boolean',
            description:
              'True when the current ending already lands (resolution, punchline, answer, takeaway, or pointed question)'
          },
          better_end_line: {
            type: 'integer',
            description:
              'Line number of the tagged line that completes the thought, which becomes the clip\'s last line; repeat the current last line when ends_with_payoff is true'
          },
          reason: { type: 'string', description: 'One short sentence justifying the verdict' }
        }
      }
    }
  }
} as const

/**
 * The time a review verdict points at: the start or end of the tagged line it
 * names, or its seconds when a provider that ignored the schema answered in
 * the old field. Null when the verdict names a line that was not tagged for
 * that clip (it is ignored, never moved to a nearby line) or gives nothing
 * usable. Exported for tests.
 */
export function reviewedTime(
  lineId: unknown,
  seconds: unknown,
  tagged: Map<number, Sentence> | undefined,
  edge: 'start' | 'end'
): number | null {
  const id = parseLineId(lineId)
  if (id !== undefined) {
    const line = tagged?.get(id)
    return line ? line[edge] : null
  }
  return finiteNumber(seconds)
}

/**
 * Clamp and snap an ending-review suggestion onto a sentence boundary, or
 * return the clip unchanged when the suggestion is a no-op or implausible.
 * Exported for tests.
 */
export function applyRefinedEnding(
  clip: Clip,
  betterEnd: number,
  sentenceEnds: number[],
  videoDurationSec: number,
  maxDuration: number = Infinity,
  transcript?: Transcript
): Clip {
  if (!Number.isFinite(betterEnd)) return clip
  const snapped = snap(betterEnd, sentenceEnds, SENTENCE_SNAP_SEC)
  const newEnd = transcript
    ? padSpeechEnd(snapped, transcript, videoDurationSec, END_POST_ROLL_SEC)
    : Math.min(videoDurationSec, snapped + END_POST_ROLL_SEC)
  const current = clip.suggestedEnd
  // Lengths are of what plays; a joined clip's span includes what it skips.
  const skipped = skippedSec(clip)
  const lastPart = candidateRanges(clip).at(-1)
  if (
    Math.abs(newEnd - current) < 0.05 ||
    newEnd > current + MAX_END_EXTEND_SEC ||
    newEnd < current - MAX_END_TRIM_SEC ||
    newEnd - clip.suggestedStart - skipped > maxDuration ||
    newEnd - clip.suggestedStart - skipped < MIN_CLIP_SEC ||
    // The ending moves within the last part; it never trims a join away.
    (skipped > 0 && lastPart !== undefined && newEnd - lastPart.start < MIN_SEGMENT_SEC)
  ) {
    return clip
  }
  return { ...clip, suggestedEnd: newEnd, edit: { ...clip.edit, end: newEnd } }
}

/**
 * Second LLM pass over the candidate clips: verify each one ends on a beat
 * that lands and move the end to the sentence that completes the thought
 * when it does not. Selection quality problems concentrate at clip tails —
 * the first pass reliably finds hooks but often stops on setup. Failures
 * never break the pipeline; the unrefined clips are returned instead.
 */
async function refineEndingBatch(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clips: Clip[],
  videoDurationSec: number,
  maxDuration: number,
  marks: LineMarks,
  signal?: AbortSignal
): Promise<Clip[]> {
  if (clips.length === 0) return clips
  const sentences = transcriptSentences(transcript)
  const sentenceEnds = sentences.map((s) => s.end)
  const tagged: Array<Map<number, Sentence>> = []

  const blocks = clips.map((clip, i) => {
    // Only what plays: the lines a joined clip skips are not part of it.
    const inClip = candidateRanges(clip).flatMap((part) => sentencesInRange(sentences, part.start + 0.2, part.end - 0.2))
    const latestEnd = Math.min(videoDurationSec, clip.suggestedEnd + maxDuration - (clip.suggestedEnd - clip.suggestedStart - skippedSec(clip)))
    // Tag the closing sentences with end times; earlier text is context only.
    const tail = inClip.slice(-3)
    const head = inClip
      .slice(0, -3)
      .map((s) => s.text)
      .join(' ')
    const continuation = sentences.filter(
      (s) => s.start >= clip.suggestedEnd - 0.5 && s.start < clip.suggestedEnd + CONTINUATION_SEC &&
        s.end + END_POST_ROLL_SEC <= latestEnd
    )
    // The lines a verdict may name for this clip; any other number is ignored.
    tagged.push(new Map([...tail, ...continuation].map((s) => [s.index, s])))
    const last = tail.at(-1)
    return [
      `Clip ${i} — "${clip.title}" (currently ends ${last ? `on line #${last.index} ` : ''}at ${clip.suggestedEnd.toFixed(1)}s):`,
      `  Latest permitted end including tail: ${latestEnd.toFixed(1)}s. Preserve a complete thought within this limit.`,
      head ? `  …${head.slice(-500)}` : '',
      ...tail.map((s) => reviewLine(s, marks, `ends ${s.end.toFixed(1)}s`)),
      continuation.length > 0
        ? '  Continues after the current end:'
        : '  (no continuation fits the video and duration limits)',
      ...continuation.flatMap((s) => [
        ...(marks.topicStarts.has(s.index) ? [`  ${TOPIC_CHANGE_LINE}`] : []),
        reviewLine(s, marks, `ends ${s.end.toFixed(1)}s`)
      ])
    ]
      .filter(Boolean)
      .join('\n')
  })

  try {
    const res = await chatJSON<{ endings: RefinedEnding[] }>(
      apiKey,
      model,
      [
        { role: 'system', content: [REFINE_SYSTEM_PROMPT, endingMarksGuidance(marks)].filter(Boolean).join('\n\n') },
        {
          role: 'user',
          content: `Judge the ending of each clip below. Return one entry per clip, in order.\n\n${blocks.join('\n\n')}`
        }
      ],
      'clip_endings',
      REFINE_SCHEMA as unknown as Record<string, unknown>,
      signal
    )

    const refined = [...clips]
    for (const entry of res.endings ?? []) {
      const clip = refined[entry.index]
      if (!clip || entry.ends_with_payoff) continue
      const betterEnd = reviewedTime(entry.better_end_line, entry.better_end, tagged[entry.index], 'end')
      if (betterEnd === null) {
        if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] ending review named a line not shown for clip ${entry.index}; ignored`)
        continue
      }
      refined[entry.index] = applyRefinedEnding(clip, betterEnd, sentenceEnds, videoDurationSec, maxDuration, transcript)
      if (process.env.CUTAWAN_DEBUG && refined[entry.index] !== clip) {
        console.error(
          `[highlights] ending review moved clip ${entry.index} end ` +
            `${clip.suggestedEnd.toFixed(1)}s -> ${refined[entry.index].suggestedEnd.toFixed(1)}s: ${entry.reason}`
        )
      }
    }
    return refined.map((c) => withNormalizedEnd(c, transcript, videoDurationSec, maxDuration))
  } catch (err) {
    throwIfSubscriptionError(err)
    if (signal?.aborted) throw err
    // The candidates are still usable without the ending review.
    console.error('Clip ending review failed; keeping original endings:', err)
    return clips.map((c) => withNormalizedEnd(c, transcript, videoDurationSec, maxDuration))
  }
}

const REFINE_START_SYSTEM_PROMPT = `You quality-check the OPENINGS of short vertical clips cut from a longer video. The first 1-3 seconds decide whether a viewer keeps scrolling, so a clip must open on its HOOK — a bold claim, a surprising statement, a vivid moment, or a pointed question — not on throat-clearing, greetings, connective filler ("so", "and", "you know"), or setup whose only job is to lead into a later line.

For each clip you receive its intended hook and its opening sentences, each tagged with its line number and the time it starts. Judge the current opening strictly. If it already opens on the hook, say so. If it opens on skippable setup and the real hook is one of the later tagged sentences, return that sentence's line number so the dead opening is trimmed. Rules: only move the start FORWARD, only to a line tagged in that clip's own block, and never trim so far that the hook loses the context a cold viewer needs to understand it. When in doubt, leave the opening where it is.`

interface RefinedStart {
  index: number
  opens_with_hook: boolean
  /** Line number of the tagged line the clip should open on. */
  better_start_line?: unknown
  /** Seconds, from a provider that ignored the schema. */
  better_start?: unknown
  reason: string
}

const REFINE_START_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['starts'],
  properties: {
    starts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'opens_with_hook', 'better_start_line', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The clip number being judged' },
          opens_with_hook: {
            type: 'boolean',
            description: 'True when the clip already opens on its hook (no trimming needed)'
          },
          better_start_line: {
            type: 'integer',
            description:
              'Line number of the tagged line where the hook begins, which becomes the clip\'s first line; repeat the current first line when opens_with_hook is true'
          },
          reason: { type: 'string', description: 'One short sentence justifying the verdict' }
        }
      }
    }
  }
} as const

/**
 * Clamp and snap an opening-review suggestion onto a sentence beginning, or
 * return the clip unchanged when the suggestion is a no-op, moves backwards,
 * reaches too far, or would leave too little clip. Only ever advances the
 * start (drops leading setup). Exported for tests.
 */
export function applyRefinedStart(clip: Clip, betterStart: number, sentenceStarts: number[], transcript?: Transcript): Clip {
  if (!Number.isFinite(betterStart)) return clip
  const snapped = snap(betterStart, sentenceStarts, START_SNAP_SEC)
  const newStart = transcript ? padSpeechStart(snapped, transcript, START_PRE_ROLL_SEC) : Math.max(0, snapped - START_PRE_ROLL_SEC)
  const current = clip.suggestedStart
  const skipped = skippedSec(clip)
  const firstPart = candidateRanges(clip)[0]
  if (
    newStart <= current + 0.5 ||
    newStart > current + MAX_START_ADVANCE_SEC ||
    clip.suggestedEnd - newStart - skipped < MIN_CLIP_SEC ||
    (skipped > 0 && firstPart !== undefined && firstPart.end - newStart < MIN_SEGMENT_SEC)
  ) {
    return clip
  }
  return { ...clip, suggestedStart: newStart, edit: { ...clip.edit, start: newStart } }
}

/**
 * Second LLM pass mirroring the ending review, but on clip OPENINGS: verify
 * each clip starts on its hook and push the start forward past leading setup
 * when it does not. The first pass reliably finds hooks but often opens on a
 * sentence or two of throat-clearing before them. Failures never break the
 * pipeline; the unrefined clips are returned instead.
 */
async function refineStartBatch(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clips: Clip[],
  signal?: AbortSignal
): Promise<Clip[]> {
  if (clips.length === 0) return clips
  const sentences = transcriptSentences(transcript)
  const sentenceStarts = sentences.map((s) => s.start)
  const tagged: Array<Map<number, Sentence>> = []

  const blocks = clips.map((clip, i) => {
    // Only the first stretch of the clip is eligible to be trimmed, so we show
    // just the opening sentences (plus a little slack) as candidates.
    const openWindowEnd = Math.min(clip.suggestedStart + MAX_START_ADVANCE_SEC + 5, candidateRanges(clip)[0]?.end ?? Infinity)
    const head = sentencesInRange(sentences, clip.suggestedStart + 0.2, openWindowEnd).slice(0, 6)
    tagged.push(new Map(head.map((s) => [s.index, s])))
    return [
      `Clip ${i} — intended hook: "${clip.hook || clip.title}" (currently starts ${head[0] ? `on line #${head[0].index} ` : ''}at ${clip.suggestedStart.toFixed(1)}s):`,
      ...head.map((s) => `  #${s.index} [starts ${s.start.toFixed(1)}s] ${s.text}`)
    ].join('\n')
  })

  try {
    const res = await chatJSON<{ starts: RefinedStart[] }>(
      apiKey,
      model,
      [
        { role: 'system', content: REFINE_START_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Judge the opening of each clip below. Return one entry per clip, in order.\n\n${blocks.join('\n\n')}`
        }
      ],
      'clip_openings',
      REFINE_START_SCHEMA as unknown as Record<string, unknown>,
      signal
    )

    const refined = [...clips]
    for (const entry of res.starts ?? []) {
      const clip = refined[entry.index]
      if (!clip || entry.opens_with_hook) continue
      const betterStart = reviewedTime(entry.better_start_line, entry.better_start, tagged[entry.index], 'start')
      if (betterStart === null) {
        if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] opening review named a line not shown for clip ${entry.index}; ignored`)
        continue
      }
      refined[entry.index] = applyRefinedStart(clip, betterStart, sentenceStarts, transcript)
      if (process.env.CUTAWAN_DEBUG && refined[entry.index] !== clip) {
        console.error(
          `[highlights] opening review moved clip ${entry.index} start ` +
            `${clip.suggestedStart.toFixed(1)}s -> ${refined[entry.index].suggestedStart.toFixed(1)}s: ${entry.reason}`
        )
      }
    }
    return refined
  } catch (err) {
    throwIfSubscriptionError(err)
    if (signal?.aborted) throw err
    // The candidates are still usable without the opening review.
    console.error('Clip opening review failed; keeping original starts:', err)
    return clips
  }
}

/**
 * ChatGPT sign-in counts every request against a small daily cap and never
 * retries one, so on that route the analysis keeps to the fewest requests it
 * can: one for the whole transcript and one per review, however long the
 * video. Splitting the work is for connections where a request is cheap.
 */
function requestsAreScarce(): boolean {
  return usesSubscription()
}

/**
 * Run a review over the clips in small batches, a few at a time. One request
 * judging forty clips returns forty verdicts that must each line up with the
 * right clip, and it is the long lists where a model skips or misnumbers
 * entries; batches keep every request short and let them overlap.
 */
async function reviewInBatches(clips: Clip[], review: (batch: Clip[]) => Promise<Clip[]>): Promise<Clip[]> {
  if (clips.length <= REVIEW_BATCH_SIZE || requestsAreScarce()) return review(clips)
  const batchCount = Math.ceil(clips.length / REVIEW_BATCH_SIZE)
  const size = Math.ceil(clips.length / batchCount)
  const batches = Array.from({ length: batchCount }, (_, i) => clips.slice(i * size, (i + 1) * size))
  const reviewed: Clip[][] = new Array(batches.length)
  // A failed batch fails the review (the callers fall back as a whole), so
  // once one has failed, start no more: their requests would go unread.
  let failed = false
  await mapLimit(batches, WINDOW_CONCURRENCY, async (batch, i) => {
    if (failed) return
    try {
      reviewed[i] = await review(batch)
    } catch (err) {
      failed = true
      throw err
    }
  })
  return reviewed.flat()
}

function refineClipEndings(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clips: Clip[],
  videoDurationSec: number,
  maxDuration: number,
  marks: LineMarks,
  signal?: AbortSignal
): Promise<Clip[]> {
  return reviewInBatches(clips, (batch) =>
    refineEndingBatch(apiKey, model, transcript, batch, videoDurationSec, maxDuration, marks, signal))
}

function refineClipStarts(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clips: Clip[],
  signal?: AbortSignal
): Promise<Clip[]> {
  return reviewInBatches(clips, (batch) => refineStartBatch(apiKey, model, transcript, batch, signal))
}

const JOIN_SYSTEM_PROMPT = `You check edits that join separate moments of one video into a single short clip. For each clip you are shown every join: the lines that play before it, the lines that were skipped, and the lines that play after it. You decide two things, strictly.

seamless — Would a viewer who hears only the lines that play notice nothing missing? It fails when the lines after the join lean on something skipped (a pronoun, "that", "as I said", an answer to a question that was removed), when the topic or speaker changes with no bridge, or when the join lands mid-thought.

faithful — Does the joined clip mean what the speakers meant? It fails when the skipped lines hold a qualification, condition, correction, "but" or negation that changes the claim; when a question is joined to an answer that was given to a different question; when lines from different speakers are made to sound like one statement; or when the clip implies a cause, a sequence or an agreement that the full conversation does not support.

Judge from the text you are given. If you cannot tell whether a join is faithful, it is not. Skipping a tangent, a repetition, an interruption or an example is fine when the lines either side still say what they said.`

/**
 * Added to the join review's instructions when its input names speakers or
 * topic changes, measured locally: concrete facts about each join that the
 * text alone leaves the model to guess. Exported for tests.
 */
export function joinMarksGuidance(marks: LineMarks): string {
  const has = hasMarks(marks)
  const rules: string[] = []
  if (has.speakers) rules.push('Each join says which speaker, measured from the voices, says the last line before it and the first line after it. When they differ, the join is faithful only if the clip still plays as two people, a question and its answer for instance; a join that makes two speakers sound like one statement, or answers one person\'s question with what was said to another, is not faithful.')
  if (has.topics) rules.push('A join marked as crossing a topic change puts together moments from different subjects, measured from the words: it is seamless only when the lines after it plainly continue the thought before it.')
  return rules.join(' ')
}

interface JoinVerdict {
  index: number
  seamless: boolean
  faithful: boolean
  reason: string
}

const JOIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clips'],
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'seamless', 'faithful', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The clip number being judged' },
          seamless: { type: 'boolean', description: 'True when every join in the clip plays as if nothing was removed' },
          faithful: { type: 'boolean', description: 'True when the joined clip keeps what the speakers meant' },
          reason: { type: 'string', description: 'One short sentence justifying the verdict' }
        }
      }
    }
  }
} as const

/** How much of the lines around a join the review is shown. */
const JOIN_CONTEXT_SENTENCES = 3
const JOIN_SKIPPED_CHARS = 1600

/** The skipped lines, whole when short, otherwise their opening and close. */
function skippedExcerpt(lines: Sentence[]): string {
  const text = lines.map((s) => s.text).join(' ')
  if (text.length <= JOIN_SKIPPED_CHARS) return text
  const half = JOIN_SKIPPED_CHARS / 2
  return `${text.slice(0, half)} […] ${text.slice(-half)}`
}

/**
 * What the local analysis knows about one join, as lines for the join
 * review: who says the line either side of it, and whether it crosses a topic
 * change. Nothing when neither is known. Exported for tests.
 */
export function joinFacts(lastBefore: Sentence | undefined, firstAfter: Sentence | undefined, marks: LineMarks): string[] {
  if (!lastBefore || !firstAfter) return []
  const facts: string[] = []
  const said = edgeSpeaker(marks, lastBefore.index, 'last')
  const answered = edgeSpeaker(marks, firstAfter.index, 'first')
  if (said && answered) {
    facts.push(said === answered
      ? `    Speakers: Speaker ${said} says the line before the join and the line after it.`
      : `    Speakers: Speaker ${said} says the line before the join; a different speaker, Speaker ${answered}, says the line after it.`)
  }
  if (topicChangeBetween(marks, lastBefore.index, firstAfter.index)) facts.push('    Topic: the join crosses a topic change.')
  return facts
}

/**
 * Third pass, for clips that join separate moments: every join is judged for
 * whether it plays seamlessly and whether it keeps what was said. A joined
 * clip is the one place this pipeline can put words together that were not
 * spoken together, so the default runs the other way from the ending and
 * opening reviews — a clip is kept only on an explicit pass, and when the
 * review cannot run, the joined clips are dropped rather than shipped
 * unchecked. Continuous clips pass through untouched.
 */
async function reviewJoins(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clips: Clip[],
  marks: LineMarks,
  signal?: AbortSignal
): Promise<Clip[]> {
  const joined = clips.filter((clip) => clip.stitch)
  if (joined.length === 0) return clips
  const sentences = transcriptSentences(transcript)

  const judge = async (batch: Clip[]): Promise<Clip[]> => {
    const blocks = batch.map((clip, i) => {
      const parts = candidateRanges(clip)
      const joins = parts.slice(1).map((part, n) => {
        const before = sentencesInRange(sentences, parts[n].start + 0.2, parts[n].end - 0.2).slice(-JOIN_CONTEXT_SENTENCES)
        const skipped = sentencesInRange(sentences, parts[n].end + 0.2, part.start - 0.2)
          .filter((s) => s.start >= parts[n].end - 0.2 && s.end <= part.start + 0.2)
        const after = sentencesInRange(sentences, part.start + 0.2, part.end - 0.2).slice(0, JOIN_CONTEXT_SENTENCES)
        return [
          `  Join ${n + 1} (skips ${(part.start - parts[n].end).toFixed(0)}s):`,
          `    Plays before: ${before.map((s) => s.text).join(' ')}`,
          `    Skipped: ${skippedExcerpt(skipped) || '(no speech)'}`,
          `    Plays after: ${after.map((s) => s.text).join(' ')}`,
          ...joinFacts(before.at(-1), after[0], marks)
        ].join('\n')
      })
      return [`Clip ${i} — "${clip.title}". Editor's reason for the join: ${clip.stitch?.reason || 'none given'}`, ...joins].join('\n')
    })
    const res = await chatJSON<{ clips: JoinVerdict[] }>(
      apiKey,
      model,
      [
        { role: 'system', content: [JOIN_SYSTEM_PROMPT, joinMarksGuidance(marks)].filter(Boolean).join('\n\n') },
        { role: 'user', content: `Judge each joined clip below. Return one entry per clip, in order.\n\n${blocks.join('\n\n')}` }
      ],
      'clip_joins',
      JOIN_SCHEMA as unknown as Record<string, unknown>,
      signal
    )
    const passed = new Set<number>()
    for (const verdict of res.clips ?? []) {
      const ok = verdict.seamless === true && verdict.faithful === true
      if (ok) passed.add(verdict.index)
      else if (process.env.CUTAWAN_DEBUG && batch[verdict.index]) {
        console.error(`[highlights] join review rejected "${batch[verdict.index].title}": ${verdict.reason}`)
      }
    }
    // A clip with no verdict was not checked, so it does not pass.
    return batch.filter((_, i) => passed.has(i))
  }

  let passed: Clip[]
  try {
    passed = await reviewInBatches(joined, judge)
  } catch (err) {
    throwIfSubscriptionError(err)
    if (signal?.aborted) throw err
    console.error('Join review failed; dropping the joined clips and keeping the continuous ones:', err)
    passed = []
  }
  const keep = new Set(passed.map((clip) => clip.id))
  return clips.filter((clip) => !clip.stitch || keep.has(clip.id))
}

/**
 * Hook points a backward-leaning opener costs. Enough to move a clip down a
 * few places among clips scored alike, not enough to bury a strong one: the
 * check reads words, not meaning, so it only ever nudges.
 */
const DANGLING_HOOK_PENALTY = 8

/** A clip's hook part (and total) lowered by `points`. Exported for tests. */
export function penaliseHook(clip: Clip, points: number): Clip {
  return penalisePart(clip, 'hook', points)
}

/**
 * Take `points` off one rubric part and the total. What the part cannot
 * absorb (a part already near zero, say after a rerank rescaled it) comes
 * off the other parts in proportion, so a penalty is never partly lost.
 */
export function penalisePart(clip: Clip, part: 'hook' | 'structure', points: number): Clip {
  if (clip.scoreBreakdown) {
    const taken = Math.min(points, clip.scoreBreakdown[part])
    const reduced = { ...clip.scoreBreakdown, [part]: clip.scoreBreakdown[part] - taken }
    const scoreBreakdown = points > taken ? rescaleScoreParts(reduced, scoreFromParts(reduced) - (points - taken)) : reduced
    return { ...clip, scoreBreakdown, viralityScore: scoreFromParts(scoreBreakdown) }
  }
  // No parts from a provider that ignored the schema: lower the total itself.
  return { ...clip, viralityScore: Math.max(0, clip.viralityScore - points) }
}

/** Sentence-cased opener for a reason line: "that's why" -> "That's why". */
function quoteOpener(opener: string): string {
  return opener.charAt(0).toUpperCase() + opener.slice(1)
}

/**
 * The deterministic opening check (no model call), on English transcripts
 * only. A clip that opens on throwaway lead-ins ("Yeah." "Okay, so.") starts
 * on the sentence after them instead, as long as the clip and its first part
 * stay long enough. A clip whose first real sentence leans on something said
 * before it ("And…", "That's why…") cannot be fixed without judging content,
 * so it keeps its span, loses some hook score, and says why in its score
 * reason, which the clip card shows. Returns the clips and the ids of the
 * penalised ones (a later comparative rescore must not wash the penalty out).
 * Exported for tests.
 */
export function checkClipOpenings(
  transcript: Transcript,
  clips: Clip[],
  videoDurationSec: number,
  maxDuration = Infinity
): { clips: Clip[]; dangling: Set<string> } {
  const dangling = new Set<string>()
  if (!isEnglishLanguage(transcript.language)) return { clips, dangling }
  const sentences = transcriptSentences(transcript)
  const minPlayedSec = Math.min(MIN_CLIP_SEC, videoDurationSec * 0.5)
  const checked = clips.map((clip) => {
    const parts = candidateRanges(clip)
    const firstPart = parts[0]
    if (!firstPart) return clip
    const lines = sentencesInRange(sentences, clip.suggestedStart, firstPart.end)
      .filter((s) => s.start < firstPart.end)
      .slice(0, 6)
    // A clip that opens partway into a sentence is not read for its opener:
    // the words it plays are not the sentence's first words.
    if (lines.length === 0 || lines[0].start < clip.suggestedStart - 0.01) return clip
    const verdict = reviewOpening(lines, {
      clipStart: clip.suggestedStart,
      firstPartEnd: firstPart.end,
      playedSec: clip.suggestedEnd - clip.suggestedStart - skippedSec(clip),
      minPlayedSec,
      minFirstPartSec: parts.length > 1 ? MIN_SEGMENT_SEC : 0
    })
    let out = clip
    if (verdict.skip > 0) {
      const start = padSpeechStart(lines[verdict.skip].start, transcript, START_PRE_ROLL_SEC)
      if (start > clip.suggestedStart) {
        out = { ...out, suggestedStart: start, edit: { ...out.edit, start } }
        if (process.env.CUTAWAN_DEBUG) {
          console.error(`[highlights] opening check skipped ${lines.slice(0, verdict.skip).map((l) => `"${l.text}"`).join(' ')} in "${clip.title}"`)
        }
      }
    }
    if (verdict.dangling && verdict.skip === 0) {
      // First try to open on the line it continues: take in up to two lines
      // before it when they stand on their own and the clip stays in its cap.
      const firstIndex = lines[0].index
      const before = sentences.slice(Math.max(0, firstIndex - MAX_REWIND_COUNT), firstIndex)
      const back = rewindOpening(before, {
        playedSec: clip.suggestedEnd - clip.suggestedStart - skippedSec(clip),
        maxPlayedSec: maxDuration,
        firstLineStart: lines[0].start
      })
      if (back > 0) {
        const start = padSpeechStart(before[before.length - back].start, transcript, START_PRE_ROLL_SEC)
        if (start < out.suggestedStart) {
          if (process.env.CUTAWAN_DEBUG) {
            console.error(`[highlights] opening check moved "${clip.title}" back to "${before[before.length - back].text}" (it opened on "${quoteOpener(verdict.dangling)}")`)
          }
          return { ...out, suggestedStart: start, edit: { ...out.edit, start } }
        }
      }
    }
    if (verdict.dangling) {
      const note = `Opens on "${quoteOpener(verdict.dangling)}", which leans on something said before the clip.`
      out = penaliseHook(out, DANGLING_HOOK_PENALTY)
      out = { ...out, viralityReason: [out.viralityReason?.trim(), note].filter(Boolean).join(' ') }
      dangling.add(clip.id)
      if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] opening check: "${clip.title}" ${note}`)
    }
    return out
  })
  return { clips: checked, dangling }
}

const RERANK_SYSTEM_PROMPT = `You compare candidate short vertical clips cut from one long video and score each one against the others. The candidates were found in separate parts of the video by separate passes, each scoring only what it saw, so their scores are not on one scale; your job is to put them on one.

Score each candidate 0-99 on the same rubric used to find it: hook strength in the first sentence — curiosity gap, bold claim or open question (0-30); high-arousal emotion — awe, amusement, excitement, anger, anxiety, surprise (0-25); value — practical utility or novel insight (0-20); structure — a hook, a build and an ending that lands (0-15); shareability — would someone tag a friend, argue in the comments or repost it (0-9). Add the parts up in your head and give the total.

Judge the clips against each other, not each in isolation: the best candidate here should score clearly above an ordinary one and the weakest clearly below. Spread the scores over the range the clips deserve instead of giving most of them nearly the same number. Judge only from the text shown, which is what plays. A clip that opens on something said before it, or stops before its point lands, scores low on hook and structure however good its topic.`

/** Said to the rerank when some candidates carry audience reactions. */
const RERANK_REACTIONS_NOTE = 'A [laughter], [applause] or [reaction] after a line means the audience reacted to it, measured from the audio: count it as evidence the moment lands, not as a substitute for a hook.'

const RERANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'score', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The candidate number being scored' },
          score: { type: 'integer', description: 'Comparative score on the rubric (0-99)' },
          reason: { type: 'string', description: 'One short sentence on what sets this clip above or below the others' }
        }
      }
    }
  }
} as const

/** Characters of each candidate's text the rerank sees; keeps one request bounded at 40 clips. */
const RERANK_TEXT_CHARS = 900

/**
 * What a candidate plays, as text: only its played parts (a join is marked),
 * and for a long clip its opening and its close, which the rubric weighs
 * most, with the middle elided. With `marks`, a line the audience reacted to
 * is followed by "[laughter]", "[applause]" or "[reaction]". Exported for tests.
 */
export function playedText(clip: Clip, sentences: Sentence[], maxChars = RERANK_TEXT_CHARS, marks: LineMarks = NO_MARKS): string {
  const text = candidateRanges(clip)
    .map((part) => sentencesInRange(sentences, part.start + 0.2, part.end - 0.2)
      .map((s) => `${s.text}${marks.reactions.has(s.index) ? ` [${marks.reactions.get(s.index)}]` : ''}`)
      .join(' '))
    .filter(Boolean)
    .join(' [cut] ')
  if (text.length <= maxChars) return text
  const head = Math.round(maxChars * 0.65)
  return `${text.slice(0, head).trimEnd()} … ${text.slice(text.length - (maxChars - head)).trimStart()}`
}

/**
 * Apply comparative scores: each scored clip's total becomes its new score and
 * its rubric parts are rescaled to add up to it; clips without a usable score
 * keep theirs. Only the first verdict per clip counts. Returns the list
 * re-sorted by score. Exported for tests.
 */
export function applyComparativeScores(clips: Clip[], scores: Array<{ index?: unknown; score?: unknown }>): Clip[] {
  const out = [...clips]
  const seen = new Set<number>()
  for (const entry of scores) {
    const index = entry?.index
    const score = entry?.score
    if (typeof index !== 'number' || !Number.isInteger(index) || !out[index] || seen.has(index)) continue
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    seen.add(index)
    const total = Math.max(0, Math.min(99, Math.round(score)))
    const clip = out[index]
    out[index] = {
      ...clip,
      viralityScore: total,
      ...(clip.scoreBreakdown ? { scoreBreakdown: rescaleScoreParts(clip.scoreBreakdown, total) } : {})
    }
  }
  // Stable: clips the model scored the same keep their earlier order.
  return out.sort((a, b) => b.viralityScore - a.viralityScore)
}

/**
 * One comparative pass over every candidate of a video analysed in windows.
 * Each window scored its clips seeing only its own part of the video, so a
 * dull hour can produce the same numbers as a brilliant one; this request
 * sees all the candidates side by side and puts them on one scale. A clip the
 * opening check penalised keeps its penalty on top of the new score. Failures
 * keep the first-pass scores.
 */
async function rerankCandidates(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clips: Clip[],
  dangling: Set<string>,
  marks: LineMarks,
  signal?: AbortSignal
): Promise<Clip[]> {
  if (clips.length < 2) return clips
  const sentences = transcriptSentences(transcript)
  const blocks = clips.map((clip, i) => {
    const played = clip.suggestedEnd - clip.suggestedStart - skippedSec(clip)
    return `Candidate ${i} — "${clip.title}" (${Math.round(played)}s${clip.stitch ? ', joined from separate moments' : ''}):\n  ${playedText(clip, sentences, RERANK_TEXT_CHARS, marks)}`
  })
  const reacted = marks.reactions.size > 0
  try {
    const res = await chatJSON<{ scores?: Array<{ index?: unknown; score?: unknown; reason?: unknown }> }>(
      apiKey,
      model,
      [
        { role: 'system', content: reacted ? `${RERANK_SYSTEM_PROMPT}\n\n${RERANK_REACTIONS_NOTE}` : RERANK_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Score every candidate below against the others. Return one entry per candidate.\n\n${blocks.join('\n\n')}`
        }
      ],
      'clip_rerank',
      RERANK_SCHEMA as unknown as Record<string, unknown>,
      signal
    )
    const scores = Array.isArray(res?.scores) ? res.scores : []
    if (process.env.CUTAWAN_DEBUG) console.error('[highlights] comparative scores:', JSON.stringify(scores, null, 2))
    const reranked = applyComparativeScores(clips, scores)
    const before = new Map(clips.map((clip) => [clip.id, clip]))
    return reranked
      .map((clip) => (dangling.has(clip.id) && before.get(clip.id) !== clip ? penaliseHook(clip, DANGLING_HOOK_PENALTY) : clip))
      .sort((a, b) => b.viralityScore - a.viralityScore)
  } catch (err) {
    throwIfSubscriptionError(err)
    if (signal?.aborted) throw err
    console.error('Comparative clip rerank failed; keeping first-pass scores:', err)
    return clips
  }
}

/**
 * Drop clips that substantially overlap a higher-scored clip, so the results
 * grid never shows two near-identical moments. Input must be sorted by score
 * descending. Exported for tests.
 */
export function dedupeClips(clips: Clip[], maxOverlapFraction = 0.4): Clip[] {
  const kept: Array<{ ranges: TimeRange[]; played: number }> = []
  const out: Clip[] = []
  for (const clip of clips) {
    // Compared on what plays: a joined clip does not overlap the moments it skips.
    const ranges = candidateRanges(clip)
    const played = ranges.reduce((sum, r) => sum + r.end - r.start, 0)
    const tooSimilar = kept.some((k) => {
      let overlap = 0
      for (const a of ranges) {
        for (const b of k.ranges) overlap += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
      }
      return overlap > 0 && overlap / Math.min(played, k.played) > maxOverlapFraction
    })
    if (tooSimilar) continue
    kept.push({ ranges, played })
    out.push(clip)
  }
  return out
}

/**
 * Transcripts up to this long go to the model in one request. Past it the
 * selection is made window by window: one request holding a two-hour
 * transcript has to produce forty clips from a context where the middle
 * hour gets far less attention than the opening, and its picks thin out
 * accordingly.
 */
const SINGLE_PASS_MAX_SEC = 20 * 60
/** Roughly how much speech one window holds. */
const WINDOW_TARGET_SEC = 12 * 60
/** Slack on top of the longest clip in the overlap between two windows. */
const WINDOW_OVERLAP_SLACK_SEC = 30
/**
 * Overlap between windows when clips may join separate moments. A join can
 * only be proposed by a request that sees both moments, so half a window of
 * overlap guarantees any two moments up to this far apart are seen together.
 */
const STITCH_WINDOW_OVERLAP_SEC = WINDOW_TARGET_SEC / 2
/** Windows analysed at once. */
const WINDOW_CONCURRENCY = 3
/** Clips judged per ending/opening review request. */
const REVIEW_BATCH_SIZE = 8

export interface AnalysisWindow {
  /** Position among the windows, 0-based. */
  index: number
  /** Source seconds the window covers. */
  from: number
  to: number
  sentences: Sentence[]
}

/**
 * Split a long transcript into overlapping windows for clip selection.
 *
 * Neighbouring windows overlap by more than the longest clip allowed, so
 * every possible clip lies wholly inside at least one window and a moment
 * that straddles a boundary is never invisible. The duplicates that overlap
 * produces are removed by `dedupeClips`. Windows are equal in length rather
 * than fixed-size with a stub at the end, and a window with no speech (a
 * music break) is dropped. Returns one window when the speech is short
 * enough for a single request. `minOverlapSec` widens the overlap, for
 * analysis that relates moments further apart than one clip.
 *
 * With `topics` (line numbers that open a new topic), each inner window
 * edge is moved outward to the nearest topic change within TOPIC_SNAP_SEC:
 * a start earlier, an end later, preferring a coarse change (a change of
 * subject) to a fine one when both are in reach. Only ever outward, so every
 * overlap only grows and the coverage above still holds; a window ends on a
 * change of subject instead of halfway through one, and grows by at most
 * TOPIC_SNAP_SEC at each edge. Exported for tests.
 */
export function planAnalysisWindows(
  sentences: Sentence[],
  maxClipSec: number,
  minOverlapSec = 0,
  topics: TopicBoundaries = { fine: [], coarse: [] }
): AnalysisWindow[] {
  if (sentences.length === 0) return []
  const from = sentences[0].start
  const to = sentences[sentences.length - 1].end
  const span = to - from
  if (span <= SINGLE_PASS_MAX_SEC) return [{ index: 0, from, to, sentences }]

  const overlap = Math.max(maxClipSec + WINDOW_OVERLAP_SLACK_SEC, Math.min(minOverlapSec, WINDOW_TARGET_SEC * 0.75))
  const count = Math.ceil((span - overlap) / (WINDOW_TARGET_SEC - overlap))
  const length = (span + (count - 1) * overlap) / count
  const windows: AnalysisWindow[] = []
  const fine = topicChangeTimes(sentences, topics.fine)
  const coarse = topicChangeTimes(sentences, topics.coarse)
  const snapEdge = (time: number, direction: 'earlier' | 'later', limit: number): number => {
    const major = snapOutward(time, coarse, direction, limit)
    return major !== time ? major : snapOutward(time, fine, direction, limit)
  }
  for (let i = 0; i < count; i++) {
    const planned = from + i * (length - overlap)
    const start = i === 0 ? planned : snapEdge(planned, 'earlier', from)
    const end = i === count - 1 ? to : snapEdge(planned + length, 'later', to)
    const inside = sentences.filter((s) => s.end > start && s.start < end)
    if (inside.length > 0) windows.push({ index: windows.length, from: start, to: end, sentences: inside })
  }
  return windows
}

/** Furthest a window edge moves to land on a topic change. */
const TOPIC_SNAP_SEC = 90

/** The time of each topic change: the middle of the pause before the line that opens the topic. */
function topicChangeTimes(sentences: Sentence[], topicStarts: number[]): number[] {
  if (topicStarts.length === 0) return []
  const position = new Map(sentences.map((s, i) => [s.index, i]))
  return topicStarts
    .flatMap((line) => {
      const i = position.get(line)
      return i === undefined || i === 0 ? [] : [(sentences[i - 1].end + sentences[i].start) / 2]
    })
    .sort((a, b) => a - b)
}

/** The nearest change at or beyond `time` in one direction within TOPIC_SNAP_SEC, kept inside `limit`; otherwise `time`. */
function snapOutward(time: number, changes: number[], direction: 'earlier' | 'later', limit: number): number {
  let best = time
  let bestDist = TOPIC_SNAP_SEC
  for (const t of changes) {
    const dist = direction === 'earlier' ? time - t : t - time
    if (dist >= 0 && dist <= bestDist) {
      best = t
      bestDist = dist
    }
  }
  return direction === 'earlier' ? Math.max(limit, best) : Math.min(limit, best)
}

/** How many clips to ask one window for: about one per minute it covers. */
function windowClipCount(window: AnalysisWindow): number {
  return Math.max(3, Math.min(12, Math.round((window.to - window.from) / 60)))
}

/**
 * Windows for the video outline. The outline names moments, it does not cut
 * them, so no clip has to fit whole inside one part and the overlap is only
 * the planner's slack: enough that a line at a boundary is read with a little
 * of what leads into it. Same window size as selection, so for speech that
 * spans S seconds past the single-request limit this is
 * ceil((S - 30) / 690) parts: eleven for two hours. Exported for tests.
 */
export function planOutlineWindows(sentences: Sentence[]): AnalysisWindow[] {
  return planAnalysisWindows(sentences, 0)
}

/** Most outline pairings the long-range request considers. */
const MAX_LONG_RANGE_PAIRINGS = 8
/** Lines shown before and after each end of a pairing, so a part can open on the lead-in or run on to the landing. */
const PAIRING_CONTEXT_LINES = 4
/**
 * Most lines of one end's own range shown. A joined clip plays at most 100
 * seconds across both ends, and a good one far less, so each end needs only
 * the lines around its point. Showing thirty lines a side invited the model
 * to take most of them (measured live: a 303 s first answer).
 */
const PAIRING_RANGE_LINES = 12

/**
 * Whether some analysis window holds both ends of a pairing. Such a pairing
 * was in front of one selection request already, which could have joined it;
 * sending it again would only buy a second opinion. Exported for tests.
 */
export function pairingFitsOneWindow(pairing: Pick<OutlinePairing, 'setup' | 'payoff'>, windows: AnalysisWindow[]): boolean {
  return windows.some((w) => {
    const first = w.sentences[0]?.index
    const last = w.sentences[w.sentences.length - 1]?.index
    return first !== undefined && last !== undefined && pairing.setup.startLine >= first && pairing.payoff.endLine <= last
  })
}

/**
 * The outline pairings worth a long-range request: those no single window
 * saw whole, strongest first as the matching step ranked them, at most `max`.
 * Exported for tests.
 */
export function longRangePairings(pairings: OutlinePairing[], windows: AnalysisWindow[], max = MAX_LONG_RANGE_PAIRINGS): OutlinePairing[] {
  return pairings.filter((p) => !pairingFitsOneWindow(p, windows)).slice(0, max)
}

/**
 * The lines shown for one end of a pairing: its range (at most
 * PAIRING_RANGE_LINES of it) with a few lines either side. `sentences` is the
 * whole transcript, where a sentence's index is its position. Exported for
 * tests.
 */
export function pairingLines(range: { startLine: number; endLine: number }, sentences: Sentence[]): Sentence[] {
  const first = Math.max(0, range.startLine - PAIRING_CONTEXT_LINES)
  const last = Math.min(sentences.length - 1, Math.min(range.endLine, range.startLine + PAIRING_RANGE_LINES - 1) + PAIRING_CONTEXT_LINES)
  return sentences.slice(first, last + 1)
}

/**
 * Added to the selection and joining prompts for the long-range request. The
 * selection rules and the joining rules above it still apply in full; this
 * only explains that the request is about given pairings, and that saying no
 * is a good answer.
 */
const JOINED_BAND = '30 to 60 seconds'
const LONG_RANGE_PROMPT = `Joining distant moments:
- This time you are not choosing clips from a whole transcript. An outline of the video has paired moments that are far apart: a setup and the payoff that comes much later, a question and its answer, a claim and its evidence, the start of a story and its end. For each pairing you are shown the numbered lines around the first moment and the numbered lines around the second.
- For each pairing, either return ONE clip that joins the two moments or decline the pairing. A clip for a pairing has at least one segment from the first moment's lines and at least one from the second moment's lines (at most ${MAX_SEGMENTS} segments in all), uses only that pairing's lines, and gives the pairing's number in "pairing".
- Everything between the two moments is skipped, so the rules for joining apply with full force: the second moment must not lean on anything the viewer did not hear.
- The whole clip — every segment added together — must fit the length limit given below, and a good joined clip is usually ${JOINED_BAND}: take only the few lines of each moment that carry it (the question and the start of the answer that settles it, the setup line and the payoff line), not the whole stretch shown.
- Decline when the two moments do not make one clip that a viewer with no context would follow, when the payoff only makes sense with what was said in between, or when the lines do not bear out the outline's reason for the pairing. Declining is often the right answer; list each declined pairing with a short reason.`

/** The long-range reply: joined clips in the selection schema, each naming its pairing, and the pairings declined. */
function longRangeSchema(): Record<string, unknown> {
  const properties = {
    pairing: { type: 'integer', description: 'The number of the pairing this clip joins' },
    ...clipProperties(true)
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['clips', 'declined'],
    properties: {
      clips: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
      },
      declined: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pairing', 'reason'],
          properties: {
            pairing: { type: 'integer', description: 'The number of the pairing declined' },
            reason: { type: 'string', description: 'One short sentence on why the two moments do not make one clip' }
          }
        }
      }
    }
  }
}

interface LongRangeResponse {
  clips?: Array<RawHighlight & { pairing?: unknown }>
  declined?: Array<{ pairing?: unknown; reason?: unknown }>
}

/**
 * One request over the outline's distant pairings: for each, the model sees
 * the real numbered lines around both ends and returns a joined clip or
 * declines. Each clip is landed by `landSelection` with only its own
 * pairing's lines as valid ids, so the usual rules hold (played time under
 * the cap, no fragment, at most three parts), and a clip that does not
 * actually join the two moments is dropped: a continuous stretch of one of
 * them is what the windowed pass already offers. An answer that breaks a rule
 * gets one correction request, and a clip still over the ceiling after it is
 * fitted by `fitJoinedSegments`, so the cost is at most two. A failure costs
 * only these clips.
 */
async function proposeLongRangeJoins(
  apiKey: string,
  model: string,
  transcript: Transcript,
  sentences: Sentence[],
  options: AnalyzeOptions,
  videoDurationSec: number,
  pairings: OutlinePairing[],
  marks: LineMarks,
  signal?: AbortSignal
): Promise<Clip[]> {
  const shown = pairings
    .map((pairing) => ({ pairing, setup: pairingLines(pairing.setup, sentences), payoff: pairingLines(pairing.payoff, sentences) }))
    // Neighbourhoods that touch are not distant moments; nothing here to join.
    .filter((p) => p.setup.length > 0 && p.payoff.length > 0 && p.setup[p.setup.length - 1].index < p.payoff[0].index)
  if (shown.length === 0) return []
  const system = [SYSTEM_PROMPT, markingsGuidance(marks), STITCH_PROMPT, LONG_RANGE_PROMPT].filter(Boolean).join('\n\n')

  const blocks = shown.map(({ pairing, setup, payoff }, i) => [
    `Pairing ${i} — the outline's reason: "${pairing.reason || 'none given'}"`,
    `First moment (${pairing.setupLabel}), lines #${setup[0].index} to #${setup[setup.length - 1].index}:`,
    formatTranscriptForModel(setup, { durations: true, marks }),
    `Second moment (${pairing.payoffLabel}), lines #${payoff[0].index} to #${payoff[payoff.length - 1].index}:`,
    formatTranscriptForModel(payoff, { durations: true, marks })
  ].join('\n'))
  const user = [
    `Video duration: ${videoDurationSec.toFixed(1)} seconds.`,
    lengthGuidance(options.clipLength),
    options.prompt.trim()
      ? `The creator gave these special instructions, which take priority when choosing moments: "${options.prompt.trim()}"`
      : '',
    `Return a joined clip or a refusal for each of the ${shown.length} pairings below. Give each segment as the number of the line it opens on ("start_line") and the number of the line it closes on ("end_line"), both included. Lines are prefixed with their line number, [start - end] in seconds from the start of the video, and how long the line plays. A clip's length is the sum of the lengths of the lines it plays; add them up before answering.`,
    blocks.join('\n\n')
  ].filter(Boolean).join('\n\n')

  let res: LongRangeResponse
  try {
    res = await chatJSON<LongRangeResponse>(
      apiKey,
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      'long_range_joins',
      longRangeSchema(),
      signal
    )
  } catch (err) {
    throwIfSubscriptionError(err)
    if (signal?.aborted) throw err
    console.error('Joining distant moments failed; keeping the clips found so far:', err)
    return []
  }
  if (process.env.CUTAWAN_DEBUG) console.error('[highlights] long-range joins:', JSON.stringify(res, null, 2))

  /** Land every answered pairing; what could not be landed comes back as plain-words problems. */
  const land = (answer: LongRangeResponse, fit = false): { clips: Clip[]; violations: string[] } => {
    const clips: Clip[] = []
    const violations: string[] = []
    const answered = new Set<number>()
    for (const raw of Array.isArray(answer?.clips) ? answer.clips : []) {
      if (!raw || typeof raw !== 'object') continue
      const n = parseLineId(raw.pairing)
      // One clip per pairing, and only for a pairing that was shown.
      if (n === undefined || Number.isNaN(n) || !shown[n] || answered.has(n)) continue
      answered.add(n)
      const { setup, payoff } = shown[n]
      const fitted = fit ? fitRaw(raw, [...setup, ...payoff]) : raw
      const landed = landSelection({ clips: [fitted] }, {
        transcript,
        sentences,
        shown: new Map([...setup, ...payoff].map((s) => [s.index, s])),
        options,
        videoDurationSec
      })
      const clip = landed.clips[0]
      const parts = clip ? candidateRanges(clip) : []
      const joinsBoth = clip?.stitch !== undefined && parts.length > 1 &&
        parts[0].start <= setup[setup.length - 1].end && parts[parts.length - 1].end >= payoff[0].start
      if (clip && joinsBoth) {
        clips.push(clip)
        continue
      }
      const why = landed.violations.length > 0
        ? landed.violations.map((v) => v.replace(/^Clip \d+/, `Pairing ${n}`)).join(' ')
        : `Pairing ${n}: the clip must include lines from both the first and the second moment.`
      violations.push(why)
      if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] long-range pairing ${n} gave no joined clip: ${why}`)
    }
    return { clips, violations }
  }

  /** The raw clip with its segments fitted to the cap, when that is possible; otherwise unchanged. */
  const fitRaw = (raw: RawHighlight & { pairing?: unknown }, lines: Sentence[]): RawHighlight & { pairing?: unknown } => {
    if (!Array.isArray(raw.segments)) return raw
    const byIndex = new Map(lines.map((l) => [l.index, l]))
    const spans = raw.segments.map((seg) => ({ start: parseLineId(seg?.start_line), end: parseLineId(seg?.end_line) }))
    if (spans.some((sp) => sp.start === undefined || sp.end === undefined || Number.isNaN(sp.start) || Number.isNaN(sp.end))) return raw
    const fittedSpans = fitJoinedSegments(spans as Array<{ start: number; end: number }>, (i) => byIndex.get(i), maxDurationFor(options.clipLength))
    if (!fittedSpans) return raw
    return { ...raw, segments: fittedSpans.map((sp) => ({ start_line: sp.start, end_line: sp.end })) }
  }

  let result = land(res)
  // The same single correction the selection pass gets: a joined clip that
  // came back over the cap is the commonest slip, and the model can fix it.
  if (result.violations.length > 0 && result.violations.length <= MAX_REPAIR_VIOLATIONS) {
    try {
      const repaired = await chatJSON<LongRangeResponse>(
        apiKey,
        model,
        [
          { role: 'system', content: system },
          { role: 'user', content: repairPrompt(user, res, result.violations) }
        ],
        'long_range_joins',
        longRangeSchema(),
        signal
      )
      if (process.env.CUTAWAN_DEBUG) console.error('[highlights] corrected long-range joins:', JSON.stringify(repaired, null, 2))
      let second = land(repaired)
      // Still over the cap after the correction: trim whole sentences
      // (see fitJoinedSegments); the reviews that follow judge the result.
      if (second.clips.length === 0 && result.clips.length === 0) {
        const fitted = land(repaired, true)
        if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] long-range joins fitted to the cap: ${fitted.clips.length} clip(s)`)
        second = fitted
      }
      if (second.clips.length > result.clips.length) result = second
    } catch (err) {
      throwIfSubscriptionError(err)
      if (signal?.aborted) throw err
      console.error('Long-range join repair failed; keeping the first answer:', err)
    }
  }
  const clips = result.clips
  return dedupeClips(clips.sort((a, b) => b.viralityScore - a.viralityScore))
}

/**
 * A last resort for a joined clip that is still over the length cap after
 * its one correction: drop whole sentences from the end of the first
 * segment, then of the last, until it fits, keeping every segment's opening
 * line. Both openings are what the pairing is about (the setup's question,
 * the start of its answer); what goes is elaboration. The clip still has to
 * pass the join review and the ending review, so a trim that cuts away the
 * point is caught there rather than shipped. Returns null when even the
 * openings do not fit. Exported for tests.
 */
export function fitJoinedSegments(
  segments: Array<{ start: number; end: number }>,
  lineTime: (index: number) => { start: number; end: number } | undefined,
  maxPlayedSec: number
): Array<{ start: number; end: number }> | null {
  const out = segments.map((s) => ({ ...s }))
  const played = (): number => out.reduce((sum, seg) => {
    const a = lineTime(seg.start), b = lineTime(seg.end)
    return a && b ? sum + b.end - a.start : Infinity
  }, 0)
  // A margin for the roll added around each part when it is landed.
  const budget = maxPlayedSec - 1.5 * out.length
  const order = out.length > 1 ? [0, out.length - 1, ...out.slice(1, -1).map((_, i) => i + 1)] : [0]
  for (const i of order) {
    while (played() > budget && out[i].end > out[i].start) out[i].end--
  }
  return played() <= budget ? out : null
}

/** Where the outline lives between runs, and whose model built it. */
export interface HighlightContext {
  /**
   * Directory for what is derived from the transcript alone and reused across
   * regenerations (the video outline, topic boundaries), inside the project
   * folder; no caching without it.
   */
  cacheDir?: string
  /** The effective provider and model identity, as in settings' analysisProviderKey. */
  providerCacheKey?: string
  /**
   * The sentence embedder for topic boundaries. Absent: the downloaded local
   * model, when this process may use it; null: no topic boundaries.
   */
  embedder?: SentenceEmbedder | null
}

/**
 * Topic boundaries for the transcript, local and request-free; null when
 * there is no embedder or detection fails, and selection carries on without.
 */
async function findTopics(
  sentences: Sentence[],
  context: HighlightContext | undefined,
  signal?: AbortSignal,
  onProgress?: (progress: HighlightProgress) => void
): Promise<TopicBoundaries | null> {
  try {
    const embedder = context?.embedder !== undefined
      ? context.embedder
      : await defaultSentenceEmbedder(signal, () => onProgress?.({ fraction: 0, message: 'Downloading the topic model…' }))
    if (!embedder) return null
    onProgress?.({ fraction: 0, message: 'Finding topic changes…' })
    return await detectTopics({ sentences, embedder, cacheDir: context?.cacheDir, signal })
  } catch (err) {
    signal?.throwIfAborted()
    console.error('Topic detection failed; clips are chosen without topic boundaries:', err)
    return null
  }
}

/** A beat of the audience's reaction kept after a clip's last line. */
const REACTION_BEAT_SEC = 1.5

/**
 * Let a clip that ends on a line the audience reacts to run a beat into the
 * reaction: a punchline cut off before the laugh lands flat. The end moves
 * to REACTION_BEAT_SEC into the reaction (or its end, if sooner), never past
 * the next word spoken, the video's end or the length cap, and never earlier.
 * Only reactions as loud as the ones marked for the model, and no music.
 * Exported for tests.
 */
export function extendIntoReactions(
  clips: Clip[],
  transcript: Transcript,
  sentences: Sentence[],
  videoDurationSec: number,
  maxDuration: number
): Clip[] {
  const reactions = (transcript.reactions ?? [])
    .filter((r) => r.strength >= MIN_REACTION_STRENGTH && r.kind !== 'music')
    .sort((a, b) => a.start - b.start)
  if (reactions.length === 0) return clips
  const wordStarts = transcript.segments
    .flatMap((seg) => seg.words.filter((w) => w.text.length > 0).map((w) => w.start))
    .sort((a, b) => a - b)
  return clips.map((clip) => {
    const end = clip.suggestedEnd
    const lastPart = candidateRanges(clip).at(-1)
    if (!lastPart) return clip
    // The last line the clip plays.
    let last: Sentence | undefined
    for (const s of sentences) {
      if (s.end > end + 0.05) break
      if (s.start >= lastPart.start - 0.5) last = s
    }
    if (!last) return clip
    const line = last
    const reaction = reactions.find((r) => r.start >= line.start && r.start <= line.end + REACTION_LAG_SEC && r.end > end)
    if (!reaction) return clip
    const nextWord = wordStarts.find((t) => t > line.end + 0.01)
    let target = Math.min(reaction.start + REACTION_BEAT_SEC, reaction.end, videoDurationSec)
    if (nextWord !== undefined) target = Math.min(target, nextWord - 0.05)
    const played = clip.suggestedEnd - clip.suggestedStart - skippedSec(clip)
    if (target <= end + 0.05 || played + (target - end) > maxDuration) return clip
    return { ...clip, suggestedEnd: target, edit: { ...clip.edit, end: target } }
  })
}

/**
 * Joined clips of moments too far apart for any one selection request to
 * see both: build (or load) the outline, keep the pairings no window held
 * whole, and ask for those in one request. Costs one request per outline
 * window plus one to match on a first run, nothing for the outline when it is
 * cached, and one for the proposals when there is a distant pairing at all.
 */
async function joinDistantMoments(
  apiKey: string,
  model: string,
  transcript: Transcript,
  sentences: Sentence[],
  options: AnalyzeOptions,
  videoDurationSec: number,
  windows: AnalysisWindow[],
  context: HighlightContext | undefined,
  marks: LineMarks,
  signal?: AbortSignal,
  onProgress?: (progress: HighlightProgress) => void
): Promise<Clip[]> {
  const report = (message: string): void => onProgress?.({ fraction: FIND_SHARE, message })
  const outline = await buildVideoOutline({
    apiKey,
    model,
    sentences,
    windows: planOutlineWindows(sentences).map((w) => w.sentences),
    cacheDir: context?.cacheDir,
    providerCacheKey: context?.providerCacheKey,
    signal,
    onProgress: report
  })
  if (!outline) return []
  const pairings = longRangePairings(outline.pairings, windows)
  if (pairings.length === 0) return []
  report('Joining distant moments…')
  return proposeLongRangeJoins(apiKey, model, transcript, sentences, options, videoDurationSec, pairings, marks, signal)
}

export interface HighlightProgress {
  /** 0..1 across the whole highlight pass. */
  fraction: number
  message: string
}

/** Share of the highlight pass spent finding moments; the rest is the reviews. */
const FIND_SHARE = 0.7

export async function detectHighlights(
  apiKey: string,
  model: string,
  transcript: Transcript,
  options: AnalyzeOptions,
  videoDurationSec: number,
  signal?: AbortSignal,
  onProgress?: (progress: HighlightProgress) => void,
  context?: HighlightContext
): Promise<Clip[]> {
  const maxDuration = maxDurationFor(options.clipLength)
  // One sentence per line. Whisper segments break mid-sentence, and a model
  // that only sees segment boundaries can only propose segment boundaries;
  // sentence lines let it cut where a thought actually starts and stops.
  const sentences = transcriptSentences(transcript)
  // Local, request-free context for the model: who speaks each line (from
  // diarization), where the audience reacts (from the audio), where the
  // topic changes (TextTiling) and what format the video is. Each is
  // optional; without them the requests are exactly what they were.
  const topics = await findTopics(sentences, context, signal, onProgress)
  const marks = transcriptMarks(transcript, sentences, topics?.fine ?? [])
  const format = videoTypeGuidance(options.videoType, options.videoType === 'auto' ? inferVideoType(transcript, sentences) : null)
  const windows = requestsAreScarce() && sentences.length > 0
    ? [{ index: 0, from: sentences[0].start, to: sentences[sentences.length - 1].end, sentences }]
    : planAnalysisWindows(sentences, maxDuration, options.stitch ? STITCH_WINDOW_OVERLAP_SEC : 0, topics ?? undefined)
  const windowed = windows.length > 1

  const find = async (insist: boolean): Promise<Clip[]> => {
    const found: Clip[][] = new Array(windows.length).fill([])
    let finished = 0
    let failed = 0
    let firstError: unknown
    await mapLimit(windows, WINDOW_CONCURRENCY, async (window, i) => {
      signal?.throwIfAborted()
      try {
        found[i] = await requestHighlights(apiKey, model, transcript, sentences, options, videoDurationSec, {
          insist,
          window: windowed ? { ...window, count: windows.length } : null,
          marks,
          format
        }, signal)
      } catch (err) {
        // One part of a long video failing (after the client's own retries)
        // costs that part's clips, not the whole analysis; the other parts
        // carry on and are used. Cancellation and a ChatGPT limit still stop it.
        throwIfSubscriptionError(err)
        if (signal?.aborted) throw err
        failed++
        firstError ??= err
        console.error(`Finding clips in part ${i + 1} of ${windows.length} failed; continuing with the other parts:`, err)
      }
      finished++
      onProgress?.({
        fraction: (finished / windows.length) * FIND_SHARE,
        message: windowed ? `Finding spoken moments (${finished}/${windows.length})…` : 'Finding spoken moments…'
      })
    })
    // Nothing was found at all: report the failure rather than "no moments".
    if (failed === windows.length) throw firstError
    const clips = found.flat().sort((a, b) => b.viralityScore - a.viralityScore)
    // Overlapping windows propose the same moment twice; keep the better take.
    // Then hold the list to the size a single request would have been asked
    // for, so every later per-clip stage costs what it did before.
    return windowed ? dedupeClips(clips).slice(0, targetClipCount(videoDurationSec)) : clips
  }

  // LLM output is nondeterministic: occasionally it returns an empty list on
  // perfectly clippable material, so retry once with a firmer instruction.
  const first = await find(false)
  let found = first.length > 0 ? first : await find(true)
  // Windows overlap enough to join moments a few minutes apart; anything
  // further apart only the outline can pair. Never on the scarce route, and a
  // single window already showed the model every pair of moments.
  if (options.stitch && windowed && !requestsAreScarce()) {
    const distant = await joinDistantMoments(apiKey, model, transcript, sentences, options, videoDurationSec, windows, context, marks, signal, onProgress)
    if (distant.length > 0) {
      // Into the same list as the windowed clips, before the join review, so
      // they are judged like any other join; the list keeps its size so the
      // later per-clip reviews cost what they did.
      found = dedupeClips([...found, ...distant].sort((a, b) => b.viralityScore - a.viralityScore))
        .slice(0, targetClipCount(videoDurationSec))
    }
  }
  if (found.some((clip) => clip.stitch)) onProgress?.({ fraction: FIND_SHARE, message: 'Checking joined moments…' })
  const joinChecked = await reviewJoins(apiKey, model, transcript, found, marks, signal)
  // Free and deterministic, so before the reviews: the ending and opening
  // reviews then judge the clip as it now opens.
  onProgress?.({ fraction: FIND_SHARE, message: 'Checking clip endings…' })
  const refined = await refineClipEndings(apiKey, model, transcript, joinChecked, videoDurationSec, maxDuration, marks, signal)
  if (options.hookFirst) onProgress?.({ fraction: (1 + FIND_SHARE) / 2, message: 'Checking clip openings…' })
  const reviewed = options.hookFirst
    ? await refineClipStarts(apiKey, model, transcript, refined, signal)
    : refined
  // Free and deterministic, and after the opening review so it judges each
  // clip's final opening: one the review already moved past "And…" is not
  // penalised for it, and one the review moved onto "And…" is caught.
  const { clips: opened, dangling } = checkClipOpenings(transcript, reviewed, videoDurationSec, maxDuration)
  // Free and deterministic: a punchline keeps a beat of its laugh.
  const trimmed = extendIntoReactions(opened, transcript, sentences, videoDurationSec, maxDuration)
  // Windows scored their clips blind to each other; put them on one scale.
  // Last, so it judges each clip as it will finally play. A single request
  // already compared every clip it returned, and the scarce route cannot
  // spare the request.
  let ranked = trimmed
  if (windowed && !requestsAreScarce() && trimmed.length > 1) {
    onProgress?.({ fraction: (3 + FIND_SHARE) / 4, message: 'Comparing clips across the video…' })
    ranked = await rerankCandidates(apiKey, model, transcript, trimmed, dangling, marks, signal)
  }
  onProgress?.({ fraction: 1, message: 'Finding spoken moments…' })
  // Last, on each clip as it will finally play, so neither a review nor the
  // rerank can wash it out.
  ranked = applyLengthPenalties(ranked, softMaxDurationFor(options.clipLength))
  // Refinement can pull two clips onto the same landing beat; dedupe again,
  // best first (the opening check's penalty may have changed the order).
  const final = dedupeClips([...ranked].sort((a, b) => b.viralityScore - a.viralityScore).filter((c) =>
    Number.isFinite(c.edit.start) && Number.isFinite(c.edit.end) &&
    c.edit.start >= 0 && c.edit.end <= videoDurationSec &&
    c.edit.end > c.edit.start && selectedDuration(c.edit) <= maxDuration
  ))
  // Last, on the final scores: the first few clips cover different kinds of
  // moment where that costs no clearly better clip its place.
  return diversifyClipOrder(final)
}

interface HighlightRequest {
  insist: boolean
  /** The part of a long transcript this request covers; null for the whole of it. */
  window: (AnalysisWindow & { count: number }) | null
  /** Speaker, reaction and topic marks for the lines. */
  marks: LineMarks
  /** The format paragraph for the prompt ('' for none). */
  format: string
}

/**
 * Most rule violations worth one repair request. Past this the reply is not
 * a few slips but a misunderstanding of the format, and a second attempt in
 * the same conversation tends to repeat it.
 */
const MAX_REPAIR_VIOLATIONS = 12

/** What landing one selection reply produced. */
export interface LandedSelection {
  /** The usable clips, after the drop and trim rules. */
  clips: Clip[]
  /** Concrete rule breaks in plain words, each naming the clip it is about. */
  violations: string[]
}

/** Everything landing a reply needs besides the reply itself. */
export interface LandingContext {
  transcript: Transcript
  /** Every sentence of the transcript (for snapping seconds and trimming to the cap). */
  sentences: Sentence[]
  /** The lines this request showed the model, by line number. */
  shown: Map<number, Sentence>
  options: AnalyzeOptions
  videoDurationSec: number
}

/**
 * A line number from a reply: undefined when the field is absent, NaN when it
 * is present but not a whole number (which no shown line can match). Numeric
 * strings, with or without the "#", are accepted from non-strict providers.
 */
function parseLineId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isInteger(value) ? value : Number.NaN
  if (typeof value === 'string' && /^\s*#?\d+\s*$/.test(value)) return Number(value.replace(/[#\s]/g, ''))
  return Number.NaN
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** "#12" for a line number, the raw value for anything that is not one. */
function describeLine(raw: unknown, id: number): string {
  return Number.isNaN(id) ? JSON.stringify(raw) : `#${id}`
}

/**
 * Turn a selection reply into clips, and list every rule it broke. Each part
 * is mapped from its line numbers to the exact start of its first sentence
 * and end of its last, then gets the same pre-roll, post-roll and sentence
 * completion as always. A line number the request did not show makes the
 * part invalid: it is never moved to a line nearby, which would be a clip the
 * model did not pick. Parts given in seconds instead (a provider that ignored
 * the schema) are snapped onto sentences as before. The violations do not
 * change what is kept here — the usual drop and trim rules decide that — they
 * are what a repair request tells the model. Exported for tests.
 */
export function landSelection(res: Partial<HighlightResponse> | null | undefined, ctx: LandingContext): LandedSelection {
  const { transcript, sentences, shown, options, videoDurationSec } = ctx
  const maxDur = maxDurationFor(options.clipLength)
  const minClip = Math.min(MIN_CLIP_SEC, videoDurationSec * 0.5)
  const wordStarts: number[] = []
  const wordEnds: number[] = []
  for (const seg of transcript.segments) {
    for (const w of seg.words) {
      wordStarts.push(w.start)
      wordEnds.push(w.end)
    }
  }
  const sentenceEnds = sentences.map((s) => s.end)
  const normalizeEnd = (start: number, end: number): number =>
    normalizeClipEnd(start, end, transcript, videoDurationSec, {
      postRollSec: END_POST_ROLL_SEC,
      maxExtendSec: MAX_END_EXTEND_SEC
    })

  /** One part given in seconds, landed on sentence boundaries with its roll. */
  const landSeconds = (rawStart: number, rawEnd: number): TimeRange | null => {
    let start = Math.max(0, Math.min(rawStart, videoDurationSec - 1))
    let end = Math.max(start + 1, Math.min(rawEnd, videoDurationSec))
    // Open on the sentence the model pointed into (plus a little pre-roll)
    // so the clip never starts mid-thought.
    start = padSpeechStart(snapClipStart(start, sentences, wordStarts), transcript, START_PRE_ROLL_SEC)
    // Close on a sentence end, then let normalizeClipEnd complete the thought
    // when the model stopped deep inside a long sentence.
    end = snapClipEnd(end, sentences, wordEnds)
    end = normalizeEnd(start, end)
    return end > start ? { start, end } : null
  }

  /** One part, landed; null (with the reason in `problems`) when it is invalid. */
  const landSpan = (span: RawSpan, problems: string[], label: string): TimeRange | null => {
    const startId = parseLineId(span.start_line)
    const endId = parseLineId(span.end_line)
    if (startId === undefined && endId === undefined) {
      // No line numbers: a provider answering in seconds out of habit.
      const start = finiteNumber(span.start)
      const end = finiteNumber(span.end)
      if (start !== null && end !== null) return landSeconds(start, end)
      problems.push(`${label} has no start_line and end_line.`)
      return null
    }
    if (startId === undefined || endId === undefined) {
      problems.push(`${label} needs both a start_line and an end_line.`)
      return null
    }
    const first = shown.get(startId)
    const last = shown.get(endId)
    if (!first) problems.push(`${label} starts on line ${describeLine(span.start_line, startId)}, which is not one of the numbered lines you were given.`)
    if (!last) problems.push(`${label} ends on line ${describeLine(span.end_line, endId)}, which is not one of the numbered lines you were given.`)
    if (!first || !last) return null
    if (endId < startId) {
      problems.push(`${label} ends on line #${endId}, before the line it starts on (#${startId}).`)
      return null
    }
    const start = padSpeechStart(first.start, transcript, START_PRE_ROLL_SEC)
    const end = normalizeEnd(start, last.end)
    return end > start ? { start, end } : null
  }

  const clips: Clip[] = []
  const violations: string[] = []
  const replyClips = Array.isArray(res?.clips) ? res.clips : []
  replyClips.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return
    const name = `Clip ${i + 1}${raw.title ? ` ("${String(raw.title).slice(0, 60)}")` : ''}`
    const problems: string[] = []
    const proposed: RawSpan[] = Array.isArray(raw.segments) && raw.segments.length > 0 ? raw.segments : [raw]
    const several = proposed.length > 1
    if (proposed.length > MAX_SEGMENTS) {
      problems.push(`${name} has ${proposed.length} segments; a clip may join at most ${MAX_SEGMENTS}.`)
    }
    const parts = proposed.map((span, n) => landSpan(span ?? {}, problems, several ? `${name}, segment ${n + 1},` : name))
    const landedParts = parts.filter((part): part is TimeRange => part !== null)
    if (landedParts.length === parts.length) {
      for (let n = 1; n < landedParts.length; n++) {
        if (landedParts[n].start < landedParts[n - 1].end - 0.01) {
          problems.push(`${name}: segment ${n + 1} starts before segment ${n} ends. Segments must be listed in video order and must not overlap.`)
        }
      }
    }

    let clip: Clip | null = null
    if (landedParts.length === parts.length && proposed.length <= MAX_SEGMENTS) {
      clip = buildClip(raw, landedParts, problems, name)
    }
    violations.push(...problems)
    if (clip) clips.push(clip)
  })

  /**
   * Apply the length rules to a landed clip, noting each break. A joined clip
   * is taken as proposed or not at all; a continuous one over the cap is
   * trimmed back to the last sentence that fits.
   */
  function buildClip(raw: RawHighlight, parts: TimeRange[], problems: string[], name: string): Clip | null {
    // Picks that touch, overlap or sit a breath apart are one moment.
    const moments = mergeNearbyRanges(parts, MIN_JOIN_GAP_SEC)
    const start = moments[0].start
    let end = moments[moments.length - 1].end
    const played = moments.reduce((sum, m) => sum + m.end - m.start, 0)
    if (played > maxDur) {
      // For a joined clip, say how long each part is and what to keep: told
      // only the total, a model shaves a few lines and comes back still over
      // (measured live: 303 s, then 122 s, against a 100 s cap).
      const perPart = moments.length > 1
        ? ` Its segments run ${moments.map((m) => `${Math.round(m.end - m.start)}`).join(', ')} seconds; keep only the lines of each that carry the clip, about ${Math.max(MIN_SEGMENT_SEC, Math.floor(maxDur * 0.45 / moments.length))} seconds or less per segment.`
        : ''
      problems.push(`${name} runs about ${Math.round(played)} seconds; the limit is ${maxDur} seconds. Do not just trim it to fit: choose the strongest complete stretch of that moment, usually ${repairLengthBand(ctx.options.clipLength)}.${perPart}`)
    }
    if (moments.length > 1) {
      const short = moments.filter((m) => m.end - m.start < MIN_SEGMENT_SEC)
      for (const m of short) {
        const n = parts.findIndex((part) => part.start === m.start) + 1
        problems.push(`${name}: segment ${n} runs about ${Math.round(m.end - m.start)} seconds; every segment must be at least ${MIN_SEGMENT_SEC} seconds.`)
      }
      // A joined clip is taken as proposed or not at all: trimming one part
      // to fit the cap, or dropping a fragment, would leave a different clip
      // from the one the model judged.
      if (played > maxDur || short.length > 0) {
        if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] dropped joined clip "${raw.title}": ${played.toFixed(1)}s in ${moments.length} parts`)
        return null
      }
    } else if (end - start > maxDur) {
      // Length is a preference, not a floor: we never pad a complete moment to
      // reach a target length (padding tanks completion rate). We only enforce
      // the hard upper cap, trimming an over-long clip back to the last sentence
      // that lands within the cap.
      const capTarget = start + maxDur
      const lastSentenceEnd = [...sentenceEnds]
        .reverse()
        .find((e) => padSpeechEnd(e, transcript, videoDurationSec, END_POST_ROLL_SEC) <= capTarget && e > start + MIN_CLIP_SEC)
      // If no complete sentence fits, reject the candidate instead of cutting
      // speech at an arbitrary cap to manufacture a short clip.
      if (lastSentenceEnd === undefined) return null
      end = padSpeechEnd(lastSentenceEnd, transcript, videoDurationSec, END_POST_ROLL_SEC)
    }
    const cuts = moments.slice(1).map((moment, n) => ({ start: moments[n].end, end: moment.start }))
    if (played < minClip) {
      problems.push(`${name} runs about ${Math.round(played)} seconds; clips must be at least ${MIN_CLIP_SEC} seconds.`)
    }
    if (end - start - cuts.reduce((sum, c) => sum + c.end - c.start, 0) < minClip) {
      if (process.env.CUTAWAN_DEBUG) {
        console.error(`[highlights] dropped too-short clip "${raw.title}" -> ${start.toFixed(1)}-${end.toFixed(1)}`)
      }
      return null
    }
    const typeDefaults = initialClipEditForVideoType(options.videoType)
    // The parts are summed here rather than trusting the model's own total.
    const scoreParts = normalizeScoreParts(raw.score_parts)
    const fallbackScore = Number.isFinite(raw.virality_score) ? Math.round(raw.virality_score) : 0
    const kind = parseClipKind(raw.kind)
    return {
      id: randomUUID(),
      suggestedStart: start,
      suggestedEnd: end,
      title: raw.title,
      hook: raw.hook,
      summary: raw.summary,
      viralityScore: scoreParts ? scoreFromParts(scoreParts) : Math.max(0, Math.min(99, fallbackScore)),
      viralityReason: raw.virality_reason,
      ...(scoreParts ? { scoreBreakdown: scoreParts } : {}),
      ...(cuts.length ? { stitch: { segments: moments, reason: (raw.join_reason ?? '').trim() } } : {}),
      ...(kind ? { kind } : {}),
      visualSummary: null,
      hashtags: (Array.isArray(raw.hashtags) ? raw.hashtags : []).map((h) => String(h).replace(/^#/, '').toLowerCase()),
      thumbnailPath: null,
      focusTrack: null,
      // The pipeline analyses the top tier itself and leaves the rest for
      // the editor/export to pick up (see shared/reframe.ts).
      reframeStatus: 'pending',
      broll: [],
      edit: {
        aspect: '9:16',
        reframeMode: 'crop',
        framing: 'manual',
        tightenCuts: true,
        autoZoom: true,
        focusX: 0.5,
        captionsEnabled: true,
        captionStyleId: DEFAULT_CAPTION_STYLE_ID,
        showTitle: false,
        start,
        end,
        ...(cuts.length ? { cuts } : {}),
        ...typeDefaults
      }
    }
  }

  return { clips, violations }
}

/**
 * The follow-up that asks for a corrected list. It repeats the original
 * request (the model needs the numbered lines to fix a line number) and then
 * shows the model its own answer and what was wrong with it, in plain words.
 */
function repairPrompt(originalPrompt: string, previous: unknown, violations: string[]): string {
  return [
    originalPrompt,
    `You already answered this request. Your answer was:\n${JSON.stringify(previous)}`,
    `That answer broke these rules:\n${violations.map((v, i) => `${i + 1}. ${v}`).join('\n')}`,
    'Return the full corrected list of clips in the same format: every clip, including the ones that had no problem, which should stay as they were. Fix each problem above by choosing different lines. If a clip cannot be fixed within the rules, leave it out rather than break a rule.'
  ].join('\n\n')
}

async function requestHighlights(
  apiKey: string,
  model: string,
  transcript: Transcript,
  sentences: Sentence[],
  options: AnalyzeOptions,
  videoDurationSec: number,
  request: HighlightRequest,
  signal?: AbortSignal
): Promise<Clip[]> {
  const { insist, window, marks } = request
  const stitch = options.stitch === true
  const shown = window ? window.sentences : sentences
  const transcriptText = formatTranscriptForModel(shown, { marks })

  const targetCount = window ? windowClipCount(window) : targetClipCount(videoDurationSec)
  const scope = window ? 'this part' : 'the whole video'
  const span = stitch
    ? 'Give each segment as the number of the line it opens on ("start_line") and the number of the line it closes on ("end_line"), both included.'
    : 'Give each clip as the number of the line it opens on ("start_line") and the number of the line it closes on ("end_line"), both included.'

  const userPrompt = [
    `Video duration: ${videoDurationSec.toFixed(1)} seconds.`,
    window
      ? `This is part ${window.index + 1} of ${window.count} of the transcript, covering ${formatTimestamp(window.from)} to ${formatTimestamp(window.to)}; the other parts are analysed separately. Choose clips only from the lines below, and score them on the rubric's absolute scale so they can be ranked against clips from the other parts: an ordinary part of the video should produce ordinary scores.`
      : '',
    lengthGuidance(options.clipLength),
    request.format,
    insist
      ? `You MUST return at least 3 clips. Even if no moment feels exceptional, select the 3 strongest available moments and score them honestly (low scores are fine). ${span}`
      : `Aim for about ${targetCount} clips spread across ${scope}. Be generous: return every distinct moment strong enough to stand alone as a clip and let honest scores rank them — err on the side of more clips rather than fewer (at least ${Math.min(4, targetCount)}; fewer only if the material genuinely cannot support more). ${span}`,
    options.prompt.trim()
      ? `The creator gave these special instructions, which take priority when choosing moments: "${options.prompt.trim()}"`
      : '',
    `Transcript, one sentence per line, each prefixed with its line number and [start - end] in seconds from the start of the video:`,
    transcriptText
  ]
    .filter(Boolean)
    .join('\n\n')

  const system = [SYSTEM_PROMPT, markingsGuidance(marks), stitch ? STITCH_PROMPT : ''].filter(Boolean).join('\n\n')
  const ask = (user: string): Promise<HighlightResponse> =>
    chatJSON<HighlightResponse>(
      apiKey,
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      'viral_clips',
      responseSchema(stitch),
      signal
    )

  const res = await ask(userPrompt)
  if (process.env.CUTAWAN_DEBUG) {
    console.error('[highlights] raw LLM response:', JSON.stringify(res, null, 2))
  }
  const ctx: LandingContext = {
    transcript,
    sentences,
    shown: new Map(shown.map((s) => [s.index, s])),
    options,
    videoDurationSec
  }
  let landed = landSelection(res, ctx)

  // One chance to fix concrete slips (a line it was not shown, a clip over
  // the cap, a fragment of a join) with the model's own judgement, instead of
  // the blunt drop-or-trim rules. Never on the scarce route, never twice.
  const count = landed.violations.length
  if (count > 0 && count <= MAX_REPAIR_VIOLATIONS && !requestsAreScarce()) {
    if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] asking for a corrected selection:\n${landed.violations.join('\n')}`)
    try {
      const repaired = await ask(repairPrompt(userPrompt, res, landed.violations))
      if (process.env.CUTAWAN_DEBUG) console.error('[highlights] corrected LLM response:', JSON.stringify(repaired, null, 2))
      const second = landSelection(repaired, ctx)
      // Fewer violations wins, ties go to the first answer, and an answer
      // that "fixes" its problems by returning fewer usable clips does not.
      // The one exception to the tie rule: a first answer with nothing usable
      // loses to a correction that has something.
      const fewer = second.violations.length < count
      const rescued = landed.clips.length === 0 && second.clips.length > 0 && second.violations.length <= count
      if ((fewer || rescued) && second.clips.length >= landed.clips.length) landed = second
    } catch (err) {
      throwIfSubscriptionError(err)
      if (signal?.aborted) throw err
      // The first answer is still usable under the ordinary rules.
      console.error('Clip selection repair request failed; keeping the first answer:', err)
    }
  }

  const clips = [...landed.clips].sort((a, b) => b.viralityScore - a.viralityScore)
  return dedupeClips(clips)
}
