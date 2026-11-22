import type { Transcript } from './types'
import type { CaptionStyle } from './captionStyles'
import { captionWordText, groupDisplayEnd } from './captionLayout'
import { captionPositionAt, type CaptionPositionRange } from './contentRegion'
import { clipCaptionGroups, type OverlayClip } from './clipOverlays'
import type { ClipTimeline } from './clipTimeline'
import type { TitlePlan } from './titleLayout'
import { translatedCaptionY, translationCssFontStack, type TranslatedCaptionPlan } from './captionTranslation'

/**
 * Timing for the animated caption styles, shared by the live preview and the
 * export. A clip's captions, hook title and translated cards are planned once
 * into an `AnimatedCaptionPlan` (plain JSON, so it can be posted to the
 * offscreen export window), and `captionSceneAt(plan, t)` turns an output
 * time into everything that is visible and how far each animation has run.
 * Scenes are pure functions of `t` with values rounded to 1/1000, so the same
 * time always draws the same pixels, and a settled stretch (a word that has
 * finished popping, an empty pause) gives identical scenes the export can
 * reuse without drawing again. Drawing lives in shared/captionCanvas.ts.
 */

export interface PlannedWord {
  /** As drawn: case and punctuation already applied (captionWordText). */
  text: string
  /** Output seconds. */
  start: number
  end: number
  emphasis: boolean
  emoji: string | null
}

export interface PlannedCard {
  /** Output seconds the card is on screen (its hold included). */
  start: number
  end: number
  lines: PlannedWord[][]
}

export interface PlannedTranslation {
  mode: TranslatedCaptionPlan['mode']
  /** CSS font stack for the translation's font. */
  fontStack: string
  fontScale: number
  anchor: 'center' | 'top'
  events: Array<{ start: number; end: number; lines: string[]; rtl: boolean }>
}

export interface AnimatedCaptionPlan {
  /** The resolved style (brand colours and font override applied). */
  style: CaptionStyle
  cards: PlannedCard[]
  /** Caption anchor moves (faces, burned-in text, detail views), output seconds. */
  positionRanges: CaptionPositionRange[]
  title: TitlePlan | null
  translation: PlannedTranslation | null
  /** Output duration of the clip. */
  duration: number
}

export interface AnimatedPlanInput {
  transcript: Transcript | null
  clip: OverlayClip
  timeline: ClipTimeline
  style: CaptionStyle
  /** Output width / height. */
  aspectRatio: number
  /** Original-language captions are drawn (on, with a transcript, and not translated-only). */
  captions: boolean
  title: TitlePlan | null
  translation: TranslatedCaptionPlan | null
  /** Output seconds. */
  positionRanges: CaptionPositionRange[]
}

/**
 * The plan for one clip. Cards come from clipCaptionGroups, the same grouping,
 * two-line layout, emphasis and emoji the libass export and the static preview
 * use, so switching between an animated and a libass style never re-flows a
 * caption.
 */
export function animatedCaptionPlan(input: AnimatedPlanInput): AnimatedCaptionPlan {
  const { style, timeline } = input
  const duration = timeline.outputDuration
  const breaks = timeline.hasColdOpen ? [timeline.coldOpenDuration] : []
  const groups = input.captions && input.transcript && input.translation?.mode !== 'translated'
    ? clipCaptionGroups(input.transcript, input.clip, timeline, style, input.aspectRatio)
    : []
  const cards: PlannedCard[] = groups.map((group, gi) => {
    let index = 0
    return {
      start: group.start,
      end: groupDisplayEnd(groups, gi, duration, breaks),
      lines: group.lines.map((line) => line.map((w) => {
        const emphasised = index++ === group.emphasis
        return {
          text: captionWordText(w.text, style),
          start: w.start,
          end: w.end,
          emphasis: emphasised,
          emoji: emphasised ? group.emoji ?? null : null
        }
      }))
    }
  })
  const t = input.translation
  return {
    style,
    cards,
    positionRanges: input.positionRanges,
    title: input.title,
    translation: t
      ? {
          mode: t.mode,
          fontStack: translationCssFontStack(t.font),
          fontScale: t.layout.fontScale,
          anchor: t.layout.anchor,
          events: t.events.map((e) => ({ start: e.start, end: e.end, lines: e.lines, rtl: e.rtl }))
        }
      : null,
    duration
  }
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export interface Spring {
  /** Natural frequency, rad/s. */
  omega: number
  /** Damping ratio; below 1 overshoots. */
  zeta: number
}

/** Springs used by the animated styles. */
export const SPRINGS = {
  /** A word popping in: about 13% overshoot, settled in ~0.4 s. */
  pop: { omega: 32, zeta: 0.55 },
  /** The box gliding to the next word: a small overshoot, quick. */
  glide: { omega: 34, zeta: 0.7 },
  /** A whole card springing in. */
  card: { omega: 20, zeta: 0.55 },
  /** The hook title settling. */
  title: { omega: 16, zeta: 0.62 }
} satisfies Record<string, Spring>

/**
 * Residual motion below which a spring counts as settled (exactly 1): 0.2% of
 * a scale is well under a pixel at caption sizes, and settling sooner lets the
 * export reuse more frames.
 */
const SPRING_EPSILON = 0.002

/** Seconds until an underdamped spring's envelope stays inside SPRING_EPSILON. */
export function springSettleTime(spring: Spring): number {
  const decay = spring.zeta * spring.omega
  const damped = spring.omega * Math.sqrt(Math.max(1e-6, 1 - spring.zeta * spring.zeta))
  return Math.log((1 + decay / damped) / SPRING_EPSILON) / decay
}

/**
 * Position of a unit step response of a damped spring released at 0 towards
 * 1, `age` seconds after release: 0 before, then overshooting and ringing
 * down. Exactly 1 once settled, so settled frames are identical.
 */
export function springValue(age: number, spring: Spring): number {
  if (age <= 0) return 0
  if (age >= springSettleTime(spring)) return 1
  const decay = spring.zeta * spring.omega
  if (spring.zeta >= 1) return 1 - Math.exp(-spring.omega * age) * (1 + spring.omega * age)
  const damped = spring.omega * Math.sqrt(1 - spring.zeta * spring.zeta)
  return 1 - Math.exp(-decay * age) * (Math.cos(damped * age) + (decay / damped) * Math.sin(damped * age))
}

/** 0..1 over `duration` seconds from `from`, eased out (cubic). */
export function easeOutProgress(t: number, from: number, duration: number): number {
  if (duration <= 0) return t >= from ? 1 : 0
  const x = Math.min(1, Math.max(0, (t - from) / duration))
  return 1 - Math.pow(1 - x, 3)
}

/** Round to 1/1000 so tiny float noise never makes two equal frames differ. */
export function q(value: number): number {
  return Math.round(value * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** A card's quick fade at the end of its time on screen. */
export const CARD_EXIT_SEC = 0.12
/** Translated cards and the title fade in and out over these. */
export const TRANSLATED_FADE_SEC = 0.15
export const TITLE_FADE_IN_SEC = 0.2
export const TITLE_FADE_OUT_SEC = 0.3

export interface WordState {
  /** 0 before the word is spoken, spring towards 1 after (overshoots). */
  appear: number
  /**
   * How highlighted the word is: springs to 1 when it becomes the active
   * (most recently started) word and back to 0 once the next word starts.
   */
  lift: number
  /** Spring of the word's own start (0..~1.15..1), for its emoji. */
  pop: number
  /** Karaoke fill, 0..1 across the word's spoken time. */
  fill: number
}

export interface CardScene {
  index: number
  /** Anchor line, fraction of frame height (the block is centred on it). */
  y: number
  /** Card entry spring (0..~1.1..1) and the exit fade (1 -> 0). */
  enter: number
  exit: number
  words: WordState[]
  /** The highlight box: from word `from` to word `to`, `progress` of the way (glide). */
  box: { from: number; to: number; progress: number } | null
}

export interface TitleScene {
  enter: number
  /** Opacity: fade in, hold, fade out. */
  opacity: number
}

export interface TranslatedScene {
  index: number
  y: number
  opacity: number
}

export interface CaptionScene {
  card: CardScene | null
  title: TitleScene | null
  translated: TranslatedScene | null
}

/** The index of the card on screen at `t`, or -1. */
export function cardIndexAt(cards: PlannedCard[], t: number): number {
  // Cards are in time order and never overlap: binary search.
  let lo = 0
  let hi = cards.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const card = cards[mid]
    if (t < card.start) hi = mid - 1
    else if (t >= card.end) lo = mid + 1
    else return mid
  }
  return -1
}

function cardScene(plan: AnimatedCaptionPlan, index: number, t: number): CardScene {
  const card = plan.cards[index]
  const kind = plan.style.animation?.kind
  const words = card.lines.flat()
  let active = -1
  for (let i = 0; i < words.length; i++) if (t >= words[i].start) active = i
  const states: WordState[] = words.map((w, i) => {
    const age = t - w.start
    const spoken = Math.max(1e-3, w.end - w.start)
    const pop = springValue(age, SPRINGS.pop)
    // The last word stays active until the card leaves, as in the libass export.
    const lift = i === active ? pop : i < active ? 1 - springValue(t - words[i + 1].start, SPRINGS.pop) : 0
    return {
      // Pop shows each word as it is said; the other styles show the card whole.
      appear: kind === 'pop' ? q(pop) : 1,
      lift: q(lift),
      pop: q(pop),
      fill: kind === 'sweep' ? q(Math.min(1, Math.max(0, age / spoken))) : age >= 0 ? 1 : 0
    }
  })
  let box: CardScene['box'] = null
  if (kind === 'glide' && active >= 0) {
    // The box slides from the previous word to the active one as it starts.
    box = { from: Math.max(0, active - 1), to: active, progress: q(springValue(t - words[active].start, SPRINGS.glide)) }
  }
  const enterSpring = kind === 'spark' ? SPRINGS.card : SPRINGS.pop
  const remaining = card.end - t
  return {
    index,
    y: q(captionPositionAt(plan.positionRanges, t, plan.style.positionY)),
    enter: q(springValue(t - card.start, enterSpring)),
    exit: q(Math.min(1, remaining / CARD_EXIT_SEC)),
    words: states,
    box
  }
}

/**
 * Everything visible at output time `t`. Shared by the preview (driven by the
 * playhead) and the export (driven frame by frame), so a time always looks
 * the same in both.
 */
export function captionSceneAt(plan: AnimatedCaptionPlan, t: number): CaptionScene {
  const index = cardIndexAt(plan.cards, t)
  const card = index >= 0 ? cardScene(plan, index, t) : null

  let title: TitleScene | null = null
  const tp = plan.title
  if (tp && t >= tp.start && t < tp.end) {
    const fadeIn = Math.min(1, (t - tp.start) / TITLE_FADE_IN_SEC)
    const fadeOut = Math.min(1, (tp.end - t) / TITLE_FADE_OUT_SEC)
    title = { enter: q(springValue(t - tp.start, SPRINGS.title)), opacity: q(Math.min(fadeIn, fadeOut)) }
  }

  let translated: TranslatedScene | null = null
  const tr = plan.translation
  if (tr) {
    const ti = tr.events.findIndex((e) => t >= e.start && t < e.end)
    if (ti >= 0) {
      const e = tr.events[ti]
      const base = captionPositionAt(plan.positionRanges, t, plan.style.positionY)
      translated = {
        index: ti,
        y: q(translatedCaptionY(plan.style, tr.mode, base)),
        opacity: q(Math.min(1, (t - e.start) / TRANSLATED_FADE_SEC, (e.end - t) / TRANSLATED_FADE_SEC))
      }
    }
  }
  return { card, title, translated }
}

export function sceneIsEmpty(scene: CaptionScene): boolean {
  return !scene.card && !scene.title && !scene.translated
}

/** A string equal for two scenes exactly when they draw the same pixels. */
export function sceneKey(scene: CaptionScene): string {
  return sceneIsEmpty(scene) ? '' : JSON.stringify(scene)
}

/** Output time of export frame `n` at `fps`: frame n shows the scene at n / fps. */
/**
 * The exact rate behind a probed frame rate. Probing rounds 30000/1001 to
 * 29.97; fed to ffmpeg as 29.97, caption frame n lands a hair after video
 * frame n, and overlay shows frame n-1 instead (243 of 257 frames a frame
 * late in a measured run). The NTSC rates go to ffmpeg as their rationals.
 */
export function captionFrameRate(fps: number): { arg: string; value: number } {
  for (const base of [24, 30, 48, 60, 120, 240]) {
    const ntsc = (base * 1000) / 1001
    if (Math.abs(fps - ntsc) < 0.006) return { arg: `${base * 1000}/1001`, value: ntsc }
  }
  if (Math.abs(fps - Math.round(fps)) < 1e-3) return { arg: String(Math.round(fps)), value: Math.round(fps) }
  return { arg: fps.toFixed(6), value: Number(fps.toFixed(6)) }
}

export function captionFrameTime(n: number, fps: number): number {
  return n / fps
}

/** How many caption frames cover `duration` seconds at `fps`. */
export function captionFrameCount(duration: number, fps: number): number {
  return Math.max(1, Math.ceil(duration * fps - 1e-6))
}

/** Font families a plan draws with, for loading before the first frame. */
export function planFontFamilies(plan: AnimatedCaptionPlan): string[] {
  const families = new Set<string>([plan.style.fontFamily])
  if (plan.title) families.add(plan.title.fontFamily)
  return [...families]
}

// ---------------------------------------------------------------------------
// Export window protocol (main/captionFrames.ts <-> renderer/src/captionFrames.ts)
// ---------------------------------------------------------------------------

export interface CaptionFontFile {
  family: string
  /** CSS weight descriptor, e.g. '700'; 'normal' for user uploads. */
  weight: string
  data: Uint8Array
}

export interface CaptionFramesInit {
  plan: AnimatedCaptionPlan
  width: number
  height: number
  fonts: CaptionFontFile[]
  /** Families that must load before the first frame. */
  required: string[]
}

export type CaptionFramesReady = { ok: true } | { ok: false; error: string }

export interface CaptionFramesDraw {
  id: number
  scenes: CaptionScene[]
}

export type CaptionFramesDrawn =
  | { id: number; frames: Array<{ x: number; y: number; w: number; h: number; data: Uint8Array } | null> }
  | { id: number; error: string }
