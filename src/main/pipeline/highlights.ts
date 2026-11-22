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
import { SCORE_PARTS, normalizeScoreParts, scoreFromParts } from '@shared/scoreBreakdown'
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

interface RawHighlight {
  /** One continuous clip. Absent when the model was asked for `segments`. */
  start?: number
  end?: number
  /** The clip's parts in source order, when joining moments is allowed. */
  segments?: Array<{ start: number; end: number }>
  /** Why the parts belong together; empty for a single part. */
  join_reason?: string
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
  const span = stitch
    ? {
        segments: {
          type: 'array',
          description: `The clip's parts in the order they occur in the video: one part for a continuous clip, up to ${MAX_SEGMENTS} when joining separate moments`,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: {
              start: { type: 'number', description: 'Part start time in seconds' },
              end: { type: 'number', description: 'Part end time in seconds' }
            }
          }
        },
        join_reason: {
          type: 'string',
          description: 'For a clip with more than one part: what was skipped between the parts and why the clip is better without it. Empty for one part.'
        }
      }
    : {
        start: { type: 'number', description: 'Clip start time in seconds' },
        end: { type: 'number', description: 'Clip end time in seconds' }
      }
  const properties = { ...span, ...CLIP_FIELDS }
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

/**
 * Length is a preference, not a straitjacket. We give the model a target band
 * and a hard upper cap, but let it come in shorter when the moment is complete
 * — a self-contained 20s beat beats the same beat padded to 30s with trailing
 * filler. Platforms rank on completion rate, and padding a tight moment to hit
 * a number is the fastest way to tank it, so we never pad after the fact.
 */
function lengthGuidance(pref: ClipLengthPreference): string {
  switch (pref) {
    case 'short':
      return 'Aim for clips around 15-30 seconds long (end minus start). Never exceed 45 seconds. If a moment is complete in less time, keep it short rather than padding it.'
    case 'medium':
      return 'Aim for clips around 30-60 seconds long (end minus start). Never exceed 75 seconds. Favour the length the moment actually needs — do not pad a complete moment to fill the range.'
    case 'long':
      return 'Aim for clips around 60-90 seconds long (end minus start). Never exceed 100 seconds. Only reach the top of the range when the moment genuinely sustains it; do not pad with setup or tangents.'
    case 'auto':
      return 'Choose whatever length lets each moment land — anywhere from about 15 to 90 seconds (never exceed 100). Cut to the moment; do not pad it to reach a length.'
    default: {
      const exhaustive: never = pref
      return exhaustive
    }
  }
}

/** Hard upper cap per preference, enforced after the LLM responds. */
export function maxDurationFor(pref: ClipLengthPreference): number {
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

/**
 * Plain seconds, not m:ss — models reliably echo the same unit back, whereas
 * "5:30" style timestamps get misread as 5.5 seconds on long videos.
 */
function formatTimestamp(sec: number): string {
  return `${sec.toFixed(1)}s`
}

/**
 * The transcript as the model sees it: one sentence per line with its start
 * and end, plus a delivery tag on the most and least energetic lines.
 * Exported for tests.
 */
export function formatTranscriptForModel(sentences: Sentence[]): string {
  return sentences
    .map((s) => {
      const delivery =
        s.energy === undefined
          ? ''
          : s.energy >= 0.8
            ? ' [delivery: energetic]'
            : s.energy <= 0.2
              ? ' [delivery: subdued]'
              : ''
      return `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}] ${s.text}${delivery}`
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
const SYSTEM_PROMPT = `You are an expert short-form video editor who selects moments most likely to go viral as standalone vertical clips. You receive the transcript of a long video as one sentence per line, each prefixed with the second it starts and the second it ends. Some lines carry a [delivery: ...] tag measured from the actual audio — "energetic" marks the speaker's most aroused, animated delivery, "subdued" the flattest.

Selection rules:
- Every clip MUST have the shape of a complete micro-video: a HOOK that grabs in the first sentence, a BUILD that develops or escalates it, and an ENDING THAT LANDS. A statement or observation on its own — however interesting — is not a clip.
- What "lands" depends on the material. A story lands on its resolution or emotional beat. Comedy lands on the punchline. An argument lands on its sharpest, most quotable formulation. A reveal lands on the answer. Practical content lands on the takeaway. A deliberately provocative clip can even land on a pointed question that throws back to the hook. All of these are valid endings.
- What never lands: trailing setup or scene-setting, context that introduces an idea and stops, the middle of a list, or an aside (ending right after "People were experimenting with ChatGPT for the first time" leaves the thought hanging — the sentence exists to set up whatever comes next). If the beat that completes the thought arrives one or two sentences after the moment you picked, extend the clip to include it.
- Every clip MUST start at the beginning of a sentence or thought and end at a natural conclusion. Never cut mid-sentence: a clip's "start" is the start time of the line it opens on and its "end" is the end time of the line it closes on.
- Prefer moments with a strong hook in the first 3 seconds: bold claims, surprising facts, emotional peaks, controversy, humour, actionable value, or compelling storytelling.
- Clips must be self-contained: a viewer with zero context must understand them.
- Do not overlap clips. Order them by virality score, highest first.
- Use the line timestamps exactly as given; do not invent times outside the video.

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
- Every segment starts at the start time of a line and ends at the end time of a line, and holds at least one complete sentence. Segments do not overlap. The clip's length is the total of its segments.
- State in join_reason what was skipped and why the clip is better without it.`

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

For each clip you receive its transcript and the sentences that follow it in the source video, each tagged with the time it ends. Judge the current ending strictly. Punctuation is not proof that a thought is complete. Prefer trimming to an existing payoff over extending into a new topic. A host's next interview question, thanks, or conversational handoff is NOT a closing payoff: end before it unless its complete answer belongs to this same story and fits the limit. A rhetorical question addressed to the audience can work, but do not confuse it with a question addressed to another participant. If a fragment follows a complete ending, trim the fragment; do not automatically extend it. Never append a new scene merely to finish its sentence. Only use end times that appear in the tags.`

interface RefinedEnding {
  index: number
  ends_with_payoff: boolean
  better_end: number
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
        required: ['index', 'ends_with_payoff', 'better_end', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The clip number being judged' },
          ends_with_payoff: {
            type: 'boolean',
            description:
              'True when the current ending already lands (resolution, punchline, answer, takeaway, or pointed question)'
          },
          better_end: {
            type: 'number',
            description:
              'End time (seconds) of the sentence that completes the thought; repeat the current end when ends_with_payoff is true'
          },
          reason: { type: 'string', description: 'One short sentence justifying the verdict' }
        }
      }
    }
  }
} as const

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
  signal?: AbortSignal
): Promise<Clip[]> {
  if (clips.length === 0) return clips
  const sentences = transcriptSentences(transcript)
  const sentenceEnds = sentences.map((s) => s.end)

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
    return [
      `Clip ${i} — "${clip.title}" (currently ends at ${clip.suggestedEnd.toFixed(1)}s):`,
      `  Latest permitted end including tail: ${latestEnd.toFixed(1)}s. Preserve a complete thought within this limit.`,
      head ? `  …${head.slice(-500)}` : '',
      ...tail.map((s) => `  [ends ${s.end.toFixed(1)}s] ${s.text}`),
      continuation.length > 0
        ? '  Continues after the current end:'
        : '  (no continuation fits the video and duration limits)',
      ...continuation.map((s) => `  [ends ${s.end.toFixed(1)}s] ${s.text}`)
    ]
      .filter(Boolean)
      .join('\n')
  })

  try {
    const res = await chatJSON<{ endings: RefinedEnding[] }>(
      apiKey,
      model,
      [
        { role: 'system', content: REFINE_SYSTEM_PROMPT },
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
      refined[entry.index] = applyRefinedEnding(clip, entry.better_end, sentenceEnds, videoDurationSec, maxDuration, transcript)
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

For each clip you receive its intended hook and its opening sentences, each tagged with the time it starts. Judge the current opening strictly. If it already opens on the hook, say so. If it opens on skippable setup and the real hook is one of the later tagged sentences, return that sentence's start time so the dead opening is trimmed. Rules: only move the start FORWARD, only to a time that appears in the tags, and never trim so far that the hook loses the context a cold viewer needs to understand it. When in doubt, leave the opening where it is.`

interface RefinedStart {
  index: number
  opens_with_hook: boolean
  better_start: number
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
        required: ['index', 'opens_with_hook', 'better_start', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The clip number being judged' },
          opens_with_hook: {
            type: 'boolean',
            description: 'True when the clip already opens on its hook (no trimming needed)'
          },
          better_start: {
            type: 'number',
            description:
              'Start time (seconds) of the sentence where the hook begins; repeat the current start when opens_with_hook is true'
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

  const blocks = clips.map((clip, i) => {
    // Only the first stretch of the clip is eligible to be trimmed, so we show
    // just the opening sentences (plus a little slack) as candidates.
    const openWindowEnd = Math.min(clip.suggestedStart + MAX_START_ADVANCE_SEC + 5, candidateRanges(clip)[0]?.end ?? Infinity)
    const head = sentencesInRange(sentences, clip.suggestedStart + 0.2, openWindowEnd).slice(0, 6)
    return [
      `Clip ${i} — intended hook: "${clip.hook || clip.title}" (currently starts at ${clip.suggestedStart.toFixed(1)}s):`,
      ...head.map((s) => `  [starts ${s.start.toFixed(1)}s] ${s.text}`)
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
      refined[entry.index] = applyRefinedStart(clip, entry.better_start, sentenceStarts, transcript)
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
  await mapLimit(batches, WINDOW_CONCURRENCY, async (batch, i) => {
    reviewed[i] = await review(batch)
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
  signal?: AbortSignal
): Promise<Clip[]> {
  return reviewInBatches(clips, (batch) =>
    refineEndingBatch(apiKey, model, transcript, batch, videoDurationSec, maxDuration, signal))
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
          `    Plays after: ${after.map((s) => s.text).join(' ')}`
        ].join('\n')
      })
      return [`Clip ${i} — "${clip.title}". Editor's reason for the join: ${clip.stitch?.reason || 'none given'}`, ...joins].join('\n')
    })
    const res = await chatJSON<{ clips: JoinVerdict[] }>(
      apiKey,
      model,
      [
        { role: 'system', content: JOIN_SYSTEM_PROMPT },
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
 * analysis that relates moments further apart than one clip. Exported for
 * tests.
 */
export function planAnalysisWindows(sentences: Sentence[], maxClipSec: number, minOverlapSec = 0): AnalysisWindow[] {
  if (sentences.length === 0) return []
  const from = sentences[0].start
  const to = sentences[sentences.length - 1].end
  const span = to - from
  if (span <= SINGLE_PASS_MAX_SEC) return [{ index: 0, from, to, sentences }]

  const overlap = Math.max(maxClipSec + WINDOW_OVERLAP_SLACK_SEC, Math.min(minOverlapSec, WINDOW_TARGET_SEC * 0.75))
  const count = Math.ceil((span - overlap) / (WINDOW_TARGET_SEC - overlap))
  const length = (span + (count - 1) * overlap) / count
  const windows: AnalysisWindow[] = []
  for (let i = 0; i < count; i++) {
    const start = from + i * (length - overlap)
    const end = i === count - 1 ? to : start + length
    const inside = sentences.filter((s) => s.end > start && s.start < end)
    if (inside.length > 0) windows.push({ index: windows.length, from: start, to: end, sentences: inside })
  }
  return windows
}

/** How many clips to ask one window for: about one per minute it covers. */
function windowClipCount(window: AnalysisWindow): number {
  return Math.max(3, Math.min(12, Math.round((window.to - window.from) / 60)))
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
  onProgress?: (progress: HighlightProgress) => void
): Promise<Clip[]> {
  const maxDuration = maxDurationFor(options.clipLength)
  // One sentence per line. Whisper segments break mid-sentence, and a model
  // that only sees segment boundaries can only propose segment boundaries;
  // sentence lines let it cut where a thought actually starts and stops.
  const sentences = transcriptSentences(transcript)
  const windows = requestsAreScarce() && sentences.length > 0
    ? [{ index: 0, from: sentences[0].start, to: sentences[sentences.length - 1].end, sentences }]
    : planAnalysisWindows(sentences, maxDuration, options.stitch ? STITCH_WINDOW_OVERLAP_SEC : 0)
  const windowed = windows.length > 1

  const find = async (insist: boolean): Promise<Clip[]> => {
    const found: Clip[][] = new Array(windows.length)
    let finished = 0
    await mapLimit(windows, WINDOW_CONCURRENCY, async (window, i) => {
      signal?.throwIfAborted()
      found[i] = await requestHighlights(apiKey, model, transcript, sentences, options, videoDurationSec, {
        insist,
        window: windowed ? { ...window, count: windows.length } : null
      }, signal)
      finished++
      onProgress?.({
        fraction: (finished / windows.length) * FIND_SHARE,
        message: windowed ? `Finding spoken moments (${finished}/${windows.length})…` : 'Finding spoken moments…'
      })
    })
    const clips = found.flat().sort((a, b) => b.viralityScore - a.viralityScore)
    // Overlapping windows propose the same moment twice; keep the better take.
    // Then hold the list to the size a single request would have been asked
    // for, so every later per-clip stage costs what it did before.
    return windowed ? dedupeClips(clips).slice(0, targetClipCount(videoDurationSec)) : clips
  }

  // LLM output is nondeterministic: occasionally it returns an empty list on
  // perfectly clippable material, so retry once with a firmer instruction.
  const first = await find(false)
  const found = first.length > 0 ? first : await find(true)
  if (found.some((clip) => clip.stitch)) onProgress?.({ fraction: FIND_SHARE, message: 'Checking joined moments…' })
  const clips = await reviewJoins(apiKey, model, transcript, found, signal)
  onProgress?.({ fraction: FIND_SHARE, message: 'Checking clip endings…' })
  const refined = await refineClipEndings(apiKey, model, transcript, clips, videoDurationSec, maxDuration, signal)
  if (options.hookFirst) onProgress?.({ fraction: (1 + FIND_SHARE) / 2, message: 'Checking clip openings…' })
  const trimmed = options.hookFirst
    ? await refineClipStarts(apiKey, model, transcript, refined, signal)
    : refined
  onProgress?.({ fraction: 1, message: 'Finding spoken moments…' })
  // Refinement can pull two clips onto the same landing beat; dedupe again.
  return dedupeClips(trimmed.filter((c) =>
    Number.isFinite(c.edit.start) && Number.isFinite(c.edit.end) &&
    c.edit.start >= 0 && c.edit.end <= videoDurationSec &&
    c.edit.end > c.edit.start && selectedDuration(c.edit) <= maxDuration
  ))
}

interface HighlightRequest {
  insist: boolean
  /** The part of a long transcript this request covers; null for the whole of it. */
  window: (AnalysisWindow & { count: number }) | null
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
  const { insist, window } = request
  const stitch = options.stitch === true
  const shown = window ? window.sentences : sentences
  const transcriptText = formatTranscriptForModel(shown)

  const targetCount = window ? windowClipCount(window) : targetClipCount(videoDurationSec)
  const scope = window ? 'this part' : 'the whole video'

  const userPrompt = [
    `Video duration: ${videoDurationSec.toFixed(1)} seconds.`,
    window
      ? `This is part ${window.index + 1} of ${window.count} of the transcript, covering ${formatTimestamp(window.from)} to ${formatTimestamp(window.to)}; the other parts are analysed separately. Choose clips only from the lines below, and score them on the rubric's absolute scale so they can be ranked against clips from the other parts: an ordinary part of the video should produce ordinary scores.`
      : '',
    lengthGuidance(options.clipLength),
    insist
      ? 'You MUST return at least 3 clips. Even if no moment feels exceptional, select the 3 strongest available moments and score them honestly (low scores are fine). All timestamps are in seconds from the start of the video. Express "start" and "end" as plain seconds (e.g. 132.4).'
      : `Aim for about ${targetCount} clips spread across ${scope}. Be generous: return every distinct moment strong enough to stand alone as a clip and let honest scores rank them — err on the side of more clips rather than fewer (at least ${Math.min(4, targetCount)}; fewer only if the material genuinely cannot support more). All timestamps are in seconds from the start of the video. Express "start" and "end" as plain seconds (e.g. 132.4).`,
    options.prompt.trim()
      ? `The creator gave these special instructions, which take priority when choosing moments: "${options.prompt.trim()}"`
      : '',
    `Transcript, one sentence per line, each prefixed with [start - end] in seconds from the start of the video. Start every ${stitch ? 'segment' : 'clip'} on the start time of a line and end it on the end time of a line:`,
    transcriptText
  ]
    .filter(Boolean)
    .join('\n\n')

  const res = await chatJSON<HighlightResponse>(
    apiKey,
    model,
    [
      { role: 'system', content: stitch ? `${SYSTEM_PROMPT}\n\n${STITCH_PROMPT}` : SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    'viral_clips',
    responseSchema(stitch),
    signal
  )

  const wordStarts: number[] = []
  const wordEnds: number[] = []
  for (const seg of transcript.segments) {
    for (const w of seg.words) {
      wordStarts.push(w.start)
      wordEnds.push(w.end)
    }
  }
  const sentenceEnds = sentences.map((s) => s.end)
  const maxDur = maxDurationFor(options.clipLength)
  const normalizeEnd = (start: number, end: number): number =>
    normalizeClipEnd(start, end, transcript, videoDurationSec, {
      postRollSec: END_POST_ROLL_SEC,
      maxExtendSec: MAX_END_EXTEND_SEC
    })

  if (process.env.CUTAWAN_DEBUG) {
    console.error('[highlights] raw LLM response:', JSON.stringify(res, null, 2))
  }

  /** One part of a clip, landed on sentence boundaries with its roll. */
  const landed = (rawStart: number, rawEnd: number): TimeRange | null => {
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null
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

  const clips: Clip[] = []
  for (const raw of res.clips ?? []) {
    const proposed = raw.segments?.length ? raw.segments : [{ start: raw.start as number, end: raw.end as number }]
    if (proposed.length > MAX_SEGMENTS) continue
    const parts = proposed.map((part) => landed(part.start, part.end))
    if (parts.some((part) => part === null)) continue
    // Picks that touch, overlap or sit a breath apart are one moment.
    const moments = mergeNearbyRanges(parts as TimeRange[], MIN_JOIN_GAP_SEC)
    const start = moments[0].start
    let end = moments[moments.length - 1].end
    if (moments.length > 1) {
      // A joined clip is taken as proposed or not at all: trimming one part
      // to fit the cap, or dropping a fragment, would leave a different clip
      // from the one the model judged.
      const played = moments.reduce((sum, m) => sum + m.end - m.start, 0)
      if (played > maxDur || moments.some((m) => m.end - m.start < MIN_SEGMENT_SEC)) {
        if (process.env.CUTAWAN_DEBUG) console.error(`[highlights] dropped joined clip "${raw.title}": ${played.toFixed(1)}s in ${moments.length} parts`)
        continue
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
      if (lastSentenceEnd === undefined) continue
      end = padSpeechEnd(lastSentenceEnd, transcript, videoDurationSec, END_POST_ROLL_SEC)
    }
    const cuts = moments.slice(1).map((moment, n) => ({ start: moments[n].end, end: moment.start }))
    if (end - start - cuts.reduce((sum, c) => sum + c.end - c.start, 0) < Math.min(MIN_CLIP_SEC, videoDurationSec * 0.5)) {
      if (process.env.CUTAWAN_DEBUG) {
        console.error(`[highlights] dropped too-short clip "${raw.title}" -> ${start.toFixed(1)}-${end.toFixed(1)}`)
      }
      continue
    }
    const typeDefaults = initialClipEditForVideoType(options.videoType)
    // The parts are summed here rather than trusting the model's own total.
    const scoreParts = normalizeScoreParts(raw.score_parts)
    const fallbackScore = Number.isFinite(raw.virality_score) ? Math.round(raw.virality_score) : 0
    clips.push({
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
      visualSummary: null,
      hashtags: (raw.hashtags ?? []).map((h) => h.replace(/^#/, '').toLowerCase()),
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
    })
  }

  clips.sort((a, b) => b.viralityScore - a.viralityScore)
  return dedupeClips(clips)
}
