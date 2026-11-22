import type { BrandColors, Clip, Transcript } from './types'
import { captionEmojiEnabled, type CaptionStyle } from './captionStyles'
import { captionGroupsFor, captionLayoutBudget, type CaptionGroupOptions, type WordGroup } from './captionLayout'
import { timelineTranscript, type ClipTimeline } from './clipTimeline'
import { planTitle, type TitlePlan } from './titleLayout'
import { planSoundEffects, type SfxCue } from './audioMix'
import { sourceStretches } from './clipSegments'

/**
 * What a clip draws and plays on top of its footage, on the output timeline:
 * caption cards, the hook title and the sound-effect cues. The preview reads
 * these directly; the export feeds the same inputs to the ASS generator and
 * the audio mix, so the two cannot drift apart.
 */

export type OverlayClip = Pick<Clip, 'id' | 'edit' | 'hook' | 'title' | 'emphasis'>

/** Caption options (seams and emphasis) for a clip on its timeline. */
export function clipCaptionOptions(clip: OverlayClip, timeline: ClipTimeline, origin = 0): CaptionGroupOptions {
  return {
    breaks: timeline.hasColdOpen ? [origin + timeline.coldOpenDuration] : [],
    emphasis: clip.edit.emphasis !== false,
    emoji: captionEmojiEnabled(clip.edit),
    keywords: clip.emphasis?.words,
    hook: clip.hook
  }
}

/** The caption cards of a clip, in output seconds, exactly as the export burns them. */
export function clipCaptionGroups(
  transcript: Transcript,
  clip: OverlayClip,
  timeline: ClipTimeline,
  style: CaptionStyle,
  aspectRatio: number
): WordGroup[] {
  const words = timelineTranscript(transcript, timeline, clip.edit.start, clip.edit.end)
  return captionGroupsFor(words, 0, timeline.outputDuration, captionLayoutBudget(style, aspectRatio),
    clipCaptionOptions(clip, timeline))
}

/** The hook title text a clip shows, or '' when the title is off. */
export function clipTitleText(clip: OverlayClip): string {
  return clip.edit.showTitle ? (clip.hook || clip.title).trim() : ''
}

/** The hook title, appearing once any cold open has played. */
export function clipTitlePlan(
  clip: OverlayClip,
  timeline: ClipTimeline,
  style: CaptionStyle,
  brandColors: BrandColors | null | undefined,
  aspectRatio: number
): TitlePlan | null {
  const text = clipTitleText(clip)
  if (!text) return null
  return planTitle(text, {
    styleId: clip.edit.titleStyle,
    captionStyle: style,
    brandColors,
    aspectRatio,
    start: timeline.coldOpenDuration,
    duration: timeline.outputDuration
  })
}

/** Sound-effect cues for a clip (empty while its effects are off). */
export function clipSoundEffects(clip: OverlayClip, timeline: ClipTimeline, titleAt: number | null): SfxCue[] {
  if (!clip.edit.soundEffects) return []
  return planSoundEffects({
    duration: timeline.outputDuration,
    coldOpenSeam: timeline.hasColdOpen ? timeline.coldOpenDuration : null,
    titleAt,
    joins: sourceStretches(clip.edit).slice(1).map((stretch) => timeline.toOutput(stretch.start))
  })
}
