import { useEffect, useMemo, useRef } from 'react'
import type { Clip, Project } from '@shared/types'
import { resolveCaptionStyle } from '@shared/captionStyles'
import { captionPositionAt, type CaptionPositionRange } from '@shared/contentRegion'
import {
  CAPTION_LINE_HEIGHT_EM,
  translatedCaptionPlan,
  translatedCaptionY,
  translatedOutlineWidth,
  translationCssFontStack
} from '@shared/captionTranslation'
import { duckGainAt, duckWindows, planDubCues } from '@shared/dubPlan'
import type { KeptSegment } from '@shared/tighten'
import { useStore } from '../store'

/**
 * Preview side of caption translation and the AI dub. The cards and the dub
 * cues come from the same shared planners the export uses
 * (@shared/captionTranslation, @shared/dubPlan), timed on the output
 * timeline, so the preview shows and plays what the file will.
 */

export function TranslatedCaptionOverlay({
  project,
  clip,
  segments,
  outputTime,
  outputOffset = 0,
  sourceTime,
  positionRanges,
  aspectRatio
}: {
  project: Project
  clip: Clip
  /** Kept segments the preview plays (null: the whole trim). */
  segments: KeptSegment[] | null
  /** Output seconds before the clip proper starts (a cold open). */
  outputOffset?: number
  /** Playhead on the output timeline (after cuts and pause removal). */
  outputTime: number
  /** Playhead in source seconds, for layout bands. */
  sourceTime: number
  /**
   * Caption moves in source time, the same clipCaptionPositionRanges plan the
   * original captions and the export follow (faces, burned-in text, detail
   * views).
   */
  positionRanges: CaptionPositionRange[]
  aspectRatio: number
}): React.JSX.Element | null {
  const brandColors = useStore((s) => s.settings?.branding.colors)
  const style = useMemo(
    () => resolveCaptionStyle(clip.edit.captionStyleId, brandColors, clip.edit.captionFontFamily),
    [clip.edit.captionStyleId, brandColors, clip.edit.captionFontFamily]
  )
  const plan = useMemo(
    () => clip.edit.captionsEnabled
      ? translatedCaptionPlan(clip, project.transcript, segments, style, aspectRatio, window.cutawan.osPlatform, outputOffset)
      : null,
    [clip, project.transcript, segments, style, aspectRatio, outputOffset]
  )
  if (!plan) return null
  const event = plan.events.find((e) => outputTime >= e.start && outputTime < e.end)
  if (!event) return null

  const scale = plan.layout.fontScale / style.fontScale
  const outline = translatedOutlineWidth(style, scale)
  const y = translatedCaptionY(style, plan.mode, captionPositionAt(positionRanges, sourceTime, style.positionY))
  return (
    <div
      data-testid="translated-captions"
      className="pointer-events-none absolute inset-x-0 flex flex-col items-center text-center"
      style={{ top: `${y * 100}cqh`, transform: plan.layout.anchor === 'top' ? undefined : 'translateY(-50%)' }}
    >
      {event.lines.map((line, i) => (
        <div
          key={i}
          dir={event.rtl ? 'rtl' : 'ltr'}
          className="whitespace-nowrap"
          style={{
            fontFamily: translationCssFontStack(plan.font),
            fontSize: `${plan.layout.fontScale * 100}cqh`,
            fontWeight: style.bold ? 700 : 400,
            lineHeight: CAPTION_LINE_HEIGHT_EM,
            color: style.textColor,
            textShadow: `0 0 ${outline * 2}px ${style.outlineColor}, 2px 2px ${outline}px ${style.outlineColor}, -2px 2px ${outline}px ${style.outlineColor}, 2px -2px ${outline}px ${style.outlineColor}, -2px -2px ${outline}px ${style.outlineColor}`
          }}
        >
          {line}
        </div>
      ))}
    </div>
  )
}

/** Resync an audio element when it drifts this far from the timeline. */
const DUB_RESYNC_SEC = 0.2

/**
 * Plays the clip's dub in the preview: one <audio> per cue, started at the
 * cue's output time at its tempo (pitch preserved, as atempo does on
 * export), faded where the export truncates, with the video's own volume
 * following the same duck envelope the export applies.
 */
export function useDubPlayback(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  project: Project,
  clip: Clip,
  segments: KeptSegment[] | null,
  outputTime: number,
  playing: boolean,
  outputOffset = 0
): void {
  const cues = useMemo(() => planDubCues(clip, project.transcript, segments, undefined, outputOffset), [clip, project.transcript, segments, outputOffset])
  const windows = useMemo(() => duckWindows(cues), [cues])
  const players = useRef<HTMLAudioElement[]>([])
  // The cues are replanned on any clip edit (typing the hook text, say);
  // the audio elements follow only the files they play, so an unrelated
  // edit does not cut off the line that is speaking.
  const audioKey = JSON.stringify(cues.map((cue) => cue.audioPath))

  useEffect(() => {
    const created = (JSON.parse(audioKey) as string[]).map((audioPath) => {
      const audio = new Audio(window.cutawan.mediaUrl(audioPath))
      audio.preload = 'auto'
      audio.preservesPitch = true
      return audio
    })
    players.current = created
    return () => {
      for (const audio of created) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      players.current = []
    }
  }, [audioKey])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.volume = cues.length ? duckGainAt(windows, outputTime) : 1
    cues.forEach((cue, i) => {
      const audio = players.current[i]
      if (!audio) return
      const into = outputTime - cue.start
      const active = playing && into >= 0 && into < cue.duration
      if (!active) {
        if (!audio.paused) audio.pause()
        return
      }
      audio.playbackRate = cue.tempo
      const fadeLeft = cue.truncated && cue.fadeOutSec > 0 ? (cue.duration - into) / cue.fadeOutSec : 1
      audio.volume = Math.min(1, Math.max(0, fadeLeft))
      const position = into * cue.tempo
      if (audio.paused || Math.abs(audio.currentTime - position) > DUB_RESYNC_SEC) audio.currentTime = position
      if (audio.paused) void audio.play().catch(() => undefined)
    })
  }, [cues, windows, outputTime, playing, videoRef])

  // Leave the element at full volume when the dub goes away.
  useEffect(() => () => {
    if (videoRef.current) videoRef.current.volume = 1
  }, [videoRef])
}
