import type { Transcript, VideoType } from '@shared/types'
import type { Sentence } from '@shared/sentences'

/**
 * What makes a strong clip depends on the format: a podcast's best moment is
 * a guest's answer, a webinar's is one takeaway with its proof, a demo's is a
 * problem and the feature that solves it. The setup screen asks for the
 * format; this turns the answer (or, for "auto", a guess made from the
 * transcript without a request) into a paragraph of the selection prompt.
 */

export type ConcreteVideoType = Exclude<VideoType, 'auto'>

const GUIDANCE: Record<ConcreteVideoType, string> = {
  'talking-head': 'One person speaking to camera. A strong clip carries one idea from its claim to where it lands: the bold statement, the reason or example behind it, and the line that settles it. Avoid stretches that list several ideas without developing any, the intro and sign-off ("in this video", "like and subscribe"), and openings that lean on an earlier point.',
  podcast: 'A conversation between hosts and guests. Strong clips are a guest\'s story told from start to finish, a disagreement where both sides are heard, and a quotable answer with just enough of its question to stand alone. Never a host\'s question on its own, the introduction of a guest, a sponsor read, or talk about the recording itself. A clip that opens on a question must include the answer that settles it.',
  webinar: 'A presentation, often with slides and a Q&A. A strong clip is one concrete takeaway together with the example, number or story that proves it. Skip housekeeping (sound checks, the agenda, "can everyone see my screen"), speaker introductions, lines that only point at a slide the viewer cannot see ("as you can see here"), and Q&A logistics; an answer from the Q&A is fine when the question is stated in the clip.',
  'product-demo': 'A walkthrough of a product. A strong clip shows a problem the viewer recognises, the feature that solves it, and the visible result, in that order. Skip setup and log-in steps, waiting for things to load, and narration that only names buttons. End on the result being shown or stated, not on the next step.'
}

const NAMES: Record<ConcreteVideoType, string> = {
  'talking-head': 'a talking-head video',
  podcast: 'a podcast or interview',
  webinar: 'a webinar or presentation',
  'product-demo': 'a product demo'
}

/**
 * The format paragraph for the selection prompt, or '' when the format is
 * "auto" and the transcript gave no clear answer. An inferred format is
 * offered as a hint, since it is a guess from words and turns.
 */
export function videoTypeGuidance(chosen: VideoType, inferred: ConcreteVideoType | null): string {
  if (chosen !== 'auto') return `Format: this is ${NAMES[chosen]}. ${GUIDANCE[chosen]}`
  if (!inferred) return ''
  return `Format: this looks like ${NAMES[inferred]} (judged from the transcript, so treat it as a hint and trust the lines over it). ${GUIDANCE[inferred]}`
}

/**
 * Words that a screen walkthrough says over and over and other formats
 * rarely do. English only; in another language nothing matches and the guess
 * rests on the speaker turns.
 */
const DEMO_CUES = /\b(click|clicks|clicking|clicked|button|buttons|dropdown|drop-down|dashboard|toggle|drag|tab|sidebar|menu|settings|workspace|let me show you|you can see|go ahead and)\b/g
const WEBINAR_CUES = /\b(slide|slides|agenda|webinar|q&a|q and a|in the chat|the chat|poll|attendees|presentation|housekeeping|recording will be|questions from)\b/g
/** Cue matches per thousand words above which the format is taken as that one. */
const DEMO_CUES_PER_K = 8
const WEBINAR_CUES_PER_K = 5
/** A speaker with at least this share of the speech is a real participant, not an interjection. */
const PARTICIPANT_SHARE = 0.15
/** One speaker with this share of the speech is a monologue. */
const MONOLOGUE_SHARE = 0.85
/** Share of lines ending on a question mark that marks an interview when no turns are known. */
const INTERVIEW_QUESTION_SHARE = 0.18
/** Too little text to judge from. */
const MIN_WORDS = 300

/**
 * A guess at the format from the transcript alone, for "auto": no request.
 * Screen-walkthrough and presentation vocabulary decide first (a demo or a
 * webinar can have two voices); then speaker turns (two or more people each
 * holding a real share of the speech is a conversation, one holding nearly
 * all of it a monologue); and with no turns, a high share of questions reads
 * as an interview. Absent turns say nothing either way (diarization did not
 * run, or heard one voice), so they never decide "talking head" on their own.
 * Null when nothing is clear. Exported for tests.
 */
export function inferVideoType(transcript: Transcript, sentences: Sentence[]): ConcreteVideoType | null {
  const text = sentences.map((s) => s.text).join(' ').toLowerCase()
  const words = text.split(/\s+/).filter(Boolean).length
  if (words < MIN_WORDS) return null
  const perK = (re: RegExp): number => ((text.match(re)?.length ?? 0) / words) * 1000
  if (perK(DEMO_CUES) >= DEMO_CUES_PER_K) return 'product-demo'
  if (perK(WEBINAR_CUES) >= WEBINAR_CUES_PER_K) return 'webinar'

  const turns = transcript.speakerTurns ?? []
  if (turns.length > 0) {
    const bySpeaker = new Map<number, number>()
    for (const t of turns) bySpeaker.set(t.speaker, (bySpeaker.get(t.speaker) ?? 0) + Math.max(0, t.end - t.start))
    const total = [...bySpeaker.values()].reduce((a, b) => a + b, 0)
    if (total > 0) {
      const shares = [...bySpeaker.values()].map((sec) => sec / total)
      if (shares.filter((share) => share >= PARTICIPANT_SHARE).length >= 2) return 'podcast'
      if (Math.max(...shares) >= MONOLOGUE_SHARE) return 'talking-head'
    }
  }
  const questions = sentences.filter((s) => /\?["']?$/.test(s.text.trim())).length
  if (sentences.length > 0 && questions / sentences.length >= INTERVIEW_QUESTION_SHARE) return 'podcast'
  return null
}
