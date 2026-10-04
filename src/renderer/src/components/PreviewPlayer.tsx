import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, RotateCcw } from 'lucide-react'
import type { BrollItem, Clip, Project, WatermarkPosition } from '@shared/types'
import { hexToRgba, resolveCaptionStyle } from '@shared/captionStyles'
import {
  captionLayoutBudget,
  groupDisplayEnd,
  groupWords,
  wordsInRange
} from '@shared/captionLayout'
import { clipKeptSegments, TimeMap } from '@shared/tighten'
import { automaticLayoutShots, clipAllowsAutoZoom, compositionHidesTitle, detailCaptionRanges, layoutBlocksAutoZoom } from '@shared/contentType'
import { captionPositionAt } from '@shared/contentRegion'
import { computeZoomEvents, fitZoomEvents } from '@shared/zoom'
import { formatTimecode } from '../lib/format'
import {
  smoothPlaybackTime,
  type PlaybackClock,
  type PreviewFramePlan
} from '@shared/previewFrame'
import { applyPreviewVideoFrame } from '../lib/previewVideo'
import { usePreviewBus } from '../lib/previewBus'
import { useStore } from '../store'

/**
 * Live preview that mimics the exported result: bounded playback of the clip
 * range, CSS-simulated reframing (crop focus on the video, zoom on a wrapper
 * — same order as ffmpeg) and word-level karaoke captions from the transcript.
 */
export default function PreviewPlayer({
  project,
  clip
}: {
  project: Project
  clip: Clip
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const zoomLayerRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const publishedRef = useRef(-Infinity)
  const playbackClockRef = useRef<PlaybackClock>({ mediaTime: 0, wallAt: 0 })
  const previewPlanRef = useRef<PreviewFramePlan>({
    zoomEvents: null,
    focusTrack: null,
    framing: 'manual',
    manualFocusX: 0.5,
    isCrop: false
  })
  /**
   * Seek requests issued while the browser is still completing a previous
   * seek are coalesced here and flushed on `seeked`. Setting currentTime on
   * every pointermove/rAF frame queues seeks faster than the demuxer can
   * serve them, which made scrubbing sluggish and could wedge the element in
   * a permanent `seeking` state (playback "randomly stopping").
   */
  const pendingSeekRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTimeState] = useState(clip.edit.start)
  const setBusTime = usePreviewBus((s) => s.setTime)
  const setSeekHandler = usePreviewBus((s) => s.setSeekHandler)
  const setScrubHandler = usePreviewBus((s) => s.setScrubHandler)

  const setTime = useCallback(
    (t: number): void => {
      setTimeState(t)
      setBusTime(t)
    },
    [setBusTime]
  )

  const applyFrame = useCallback((t: number): void => {
    const video = videoRef.current
    const layer = zoomLayerRef.current
    if (!video || !layer) return
    applyPreviewVideoFrame(video, layer, previewPlanRef.current, t, overviewRef.current)
  }, [])

  const requestSeek = useCallback(
    (t: number): void => {
      const video = videoRef.current
      if (!video) return
      if (video.seeking) {
        pendingSeekRef.current = t
      } else {
        pendingSeekRef.current = null
        video.currentTime = t
      }
      playbackClockRef.current = { mediaTime: t, wallAt: performance.now() }
      applyFrame(t)
      setTime(t)
    },
    [setTime, applyFrame]
  )

  const handleSeeked = useCallback((): void => {
    const video = videoRef.current
    const target = pendingSeekRef.current
    pendingSeekRef.current = null
    if (video && target !== null && Math.abs(video.currentTime - target) > 0.05) {
      video.currentTime = target
    }
    if (video) {
      playbackClockRef.current = { mediaTime: video.currentTime, wallAt: performance.now() }
      applyFrame(video.currentTime)
    }
  }, [applyFrame])

  const { start, end } = clip.edit
  const duration = Math.max(0.1, end - start)

  const aspectStyle = useMemo(() => {
    switch (clip.edit.aspect) {
      case '9:16':
        return 9 / 16
      case '1:1':
        return 1
      case '16:9':
        return 16 / 9
      case 'original':
        return project.video.width / Math.max(1, project.video.height)
      default: {
        const exhaustive: never = clip.edit.aspect
        return exhaustive
      }
    }
  }, [clip.edit.aspect, project.video.width, project.video.height])

  // Keep playback inside [start, end], snapping to whichever bound was
  // crossed. Always seeking to `start` meant dragging the out point jumped the
  // preview to the top of the clip instead of showing the frame being set.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.currentTime < start - 0.05) requestSeek(start)
    else if (video.currentTime > end + 0.05) requestSeek(end)
  }, [start, end, requestSeek])

  // Region masks use viewport pixels, so update them even when paused and resized.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const observer = new ResizeObserver(() => applyFrame(video.currentTime))
    observer.observe(video)
    return () => observer.disconnect()
  }, [applyFrame])

  // loadeddata can precede Chromium making the decoded frame drawable. Refresh
  // paused canvases on frame delivery too (initial load and completed seeks).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let handle: number
    const delivered = (): void => {
      if (video.paused) applyFrame(video.currentTime)
      handle = video.requestVideoFrameCallback(delivered)
    }
    handle = video.requestVideoFrameCallback(delivered)
    return () => video.cancelVideoFrameCallback(handle)
  }, [applyFrame])

  // Let the sidebar (timeline, transcript) seek the preview.
  useEffect(() => {
    setSeekHandler((t: number) => {
      requestSeek(Math.max(start, Math.min(end, t)))
    })
    return () => setSeekHandler(null)
  }, [start, end, setSeekHandler, requestSeek])

  // Trim handles scrub to the exact frame being dragged to. Deliberately not
  // clamped to [start, end]: the drag is what moves those bounds, and this
  // handler must not close over them or it would lag a render behind.
  useEffect(() => {
    setScrubHandler((t: number) => {
      const video = videoRef.current
      if (video && !video.paused) {
        video.pause()
        setPlaying(false)
      }
      requestSeek(t)
    })
    return () => setScrubHandler(null)
  }, [setScrubHandler, requestSeek])

  // Mirrors the export by skipping removed pauses and the user's cuts.
  // An edit with nothing left plays the trim rather than seeking every frame;
  // export reports it instead.
  const keptSegments = useMemo(() => {
    const kept = clipKeptSegments(clip, project.transcript)
    return kept?.length ? kept : null
  }, [clip, project.transcript])
  const timeMap = useMemo(() => (keptSegments ? new TimeMap(keptSegments) : null), [keptSegments])
  const outputDuration = timeMap?.outputDuration ?? duration
  const outputTime = timeMap ? timeMap.toOutput(time) : Math.max(0, time - start)

  // Mirrors the export's auto-zoom plan (same shared generator), including the
  // trim the export has to make when a plan outgrows one ffmpeg expression.
  const zoomEvents = useMemo(() => {
    if (!clipAllowsAutoZoom(clip.edit) || layoutBlocksAutoZoom(clip)) return null
    const events = fitZoomEvents(computeZoomEvents(project.transcript, start, end, keptSegments))
    return events.length > 0 ? events : null
  }, [clip, project.transcript, start, end, keptSegments])

  const src = window.cutawan.mediaUrl(project.video.path)
  const isCrop = clip.edit.aspect !== 'original' && clip.edit.reframeMode === 'crop'
  const isFitBlur = clip.edit.aspect !== 'original' && clip.edit.reframeMode === 'fit-blur'

  useEffect(() => {
    previewPlanRef.current = {
      zoomEvents,
      focusTrack: clip.focusTrack,
      framing: clip.edit.framing,
      manualFocusX: clip.edit.focusX,
      fitRanges: automaticLayoutShots(clip).filter((shot) => shot.mode === 'fit'),
      isCrop
    }
    const t = videoRef.current?.currentTime ?? start
    applyFrame(t)
  }, [
    clip,
    zoomEvents,
    clip.focusTrack,
    clip.visualLayout,
    clip.edit,
    clip.edit.framing,
    clip.edit.focusX,
    isCrop,
    applyFrame,
    start
  ])

  useEffect(() => {
    const tick = (): void => {
      const video = videoRef.current
      // While a seek is in flight, leave the element alone: issuing more
      // seeks (loop reset / tighten skip) before `seeked` fires is what
      // caused the stutter-then-freeze after edits.
      if (video && !video.seeking && pendingSeekRef.current === null) {
        if (video.currentTime >= end) {
          video.currentTime = start
          playbackClockRef.current = { mediaTime: start, wallAt: performance.now() }
        } else if (timeMap && !video.paused && timeMap.isRemoved(video.currentTime)) {
          const next = timeMap.nextKeptStart(video.currentTime)
          video.currentTime = next ?? end
          playbackClockRef.current = { mediaTime: video.currentTime, wallAt: performance.now() }
        }
        const smoothed = smoothPlaybackTime(video, playbackClockRef.current)
        playbackClockRef.current = smoothed.clock
        // Zoom and crop follow every display frame directly on the DOM.
        // React (captions, playhead, transcript) only needs ~30 updates a
        // second; re-rendering it every frame dropped frames and made the
        // zoom stutter.
        applyFrame(smoothed.t)
        if (Math.abs(smoothed.t - publishedRef.current) >= 1 / 30) {
          publishedRef.current = smoothed.t
          setTime(smoothed.t)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    if (playing) rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, start, end, timeMap, setTime, applyFrame])

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      video.pause()
      playbackClockRef.current = { mediaTime: video.currentTime, wallAt: 0 }
      setPlaying(false)
    } else {
      if (video.currentTime >= end - 0.05) requestSeek(start)
      playbackClockRef.current = { mediaTime: video.currentTime, wallAt: performance.now() }
      void video.play()
      setPlaying(true)
    }
  }

  // Keyboard shortcuts play/pause through the bus; the ref keeps the handler current.
  const togglePlayRef = useRef(togglePlay)
  useEffect(() => { togglePlayRef.current = togglePlay })
  const setToggleHandler = usePreviewBus((s) => s.setToggleHandler)
  useEffect(() => {
    setToggleHandler(() => togglePlayRef.current())
    return () => setToggleHandler(null)
  }, [setToggleHandler])

  const restart = (): void => {
    requestSeek(start)
  }

  const seek = (fraction: number): void => {
    requestSeek(timeMap ? timeMap.toSource(fraction * outputDuration) : start + fraction * duration)
  }

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3">
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-surface-700 bg-black"
        style={{ aspectRatio: String(aspectStyle), containerType: 'size', maxWidth: '100%' }}
      >
        {isFitBlur && clip.thumbnailPath && (
          <img
            src={window.cutawan.mediaUrl(clip.thumbnailPath)}
            alt=""
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-70 blur-2xl brightness-75"
          />
        )}
        <div ref={zoomLayerRef} className="absolute inset-0 will-change-transform" onClick={togglePlay}>
          <video
            ref={videoRef}
            src={src}
            poster={clip.thumbnailPath ? window.cutawan.mediaUrl(clip.thumbnailPath) : undefined}
            className="h-full w-full"
            style={{ objectFit: isCrop ? 'cover' : 'contain' }}
            onEnded={() => setPlaying(false)}
            onSeeked={handleSeeked}
            onLoadedData={() => applyFrame(videoRef.current?.currentTime ?? start)}
            preload="auto"
          />
        </div>
        <canvas ref={overviewRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 hidden w-full" />
        <BrollOverlay clip={clip} time={time} playing={playing} />
        <WatermarkOverlay />
        {clip.edit.captionsEnabled && project.transcript && (
          <CaptionOverlay
            transcript={project.transcript}
            clip={clip}
            time={time}
            aspectRatio={aspectStyle}
          />
        )}
        {clip.edit.showTitle && !compositionHidesTitle(clip) && (clip.hook || clip.title) && time - start < Math.min(4, duration) && (
          <HookOverlay clip={clip} />
        )}
        {!playing && (
          <button
            onClick={togglePlay}
            className="absolute inset-0 flex items-center justify-center bg-black/25 transition hover:bg-black/35"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/95 shadow-xl">
              <Play size={22} className="ml-1 text-black" />
            </span>
          </button>
        )}
      </div>

      <div className="flex w-full max-w-md items-center gap-3">
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-800 text-zinc-200 transition hover:bg-surface-700"
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>
        <button
          onClick={restart}
          aria-label="Restart preview"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-800 text-zinc-400 transition hover:bg-surface-700"
        >
          <RotateCcw size={14} />
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round((outputTime / outputDuration) * 1000)}
          onChange={(e) => seek(Number(e.target.value) / 1000)}
          className="flex-1"
        />
        <span className="shrink-0 text-xs tabular-nums text-zinc-500">
          {formatTimecode(outputTime)} / {formatTimecode(outputDuration)}
        </span>
      </div>
    </div>
  )
}

/** Mirrors the export's branding watermark (same corner, size and opacity). */
function WatermarkOverlay(): React.JSX.Element | null {
  const branding = useStore((s) => s.settings?.branding)
  if (!branding?.enabled || !branding.imagePath) return null
  const margin = '3cqw'
  const corner: Record<WatermarkPosition, React.CSSProperties> = {
    'top-left': { top: margin, left: margin },
    'top-right': { top: margin, right: margin },
    'bottom-left': { bottom: margin, left: margin },
    'bottom-right': { bottom: margin, right: margin }
  }
  return (
    <img
      src={window.cutawan.mediaUrl(branding.imagePath)}
      alt=""
      className="pointer-events-none absolute"
      style={{
        width: `${Math.min(0.5, Math.max(0.04, branding.scale)) * 100}cqw`,
        opacity: Math.min(1, Math.max(0.05, branding.opacity)),
        ...corner[branding.position]
      }}
    />
  )
}

/**
 * Hook "card" shown for the first seconds of the clip. Mirrors the ASS Title
 * style burned in on export (`captions.ts`): a filled translucent label at the
 * top with a soft shadow, in the clip's caption font, so the preview matches
 * the render.
 */
function HookOverlay({ clip }: { clip: Clip }): React.JSX.Element {
  const brandColors = useStore((s) => s.settings?.branding.colors)
  const style = resolveCaptionStyle(
    clip.edit.captionStyleId,
    brandColors,
    clip.edit.captionFontFamily
  )
  const hookTextColor = brandColors?.enabled ? brandColors.hookTextColor : '#FFFFFF'
  const hookBackgroundColor = brandColors?.enabled
    ? hexToRgba(brandColors.hookBackgroundColor, 0.75)
    : 'rgba(0,0,0,0.75)'
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center px-[6cqw]"
      style={{ top: '7cqh' }}
    >
      <span
        className="hook-in inline-block max-w-[80cqw] text-center"
        style={{
          fontFamily: `'${style.fontFamily}', sans-serif`,
          fontWeight: 700,
          fontSize: '4.4cqh',
          lineHeight: 1.2,
          color: hookTextColor,
          padding: '0.7cqh 1.4cqh',
          borderRadius: '0.8cqh',
          backgroundColor: hookBackgroundColor,
          boxShadow: '0 0.4cqh 1.4cqh rgba(0,0,0,0.45)',
          textWrap: 'balance'
        }}
      >
        {clip.hook || clip.title}
      </span>
    </div>
  )
}

function BrollOverlay({ clip, time, playing }: { clip: Clip; time: number; playing: boolean }): React.JSX.Element | null {
  const active = clip.broll.find(
    (b) => b.enabled && b.imagePath && time >= b.start && time <= b.end
  )
  if (!active) return null
  const src = window.cutawan.mediaUrl(active.imagePath!)
  if (active.mode === 'fullscreen') {
    return active.kind === 'video' ? (
      <BrollVideo
        key={active.id}
        item={active}
        src={src}
        time={time}
        playing={playing}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
    ) : (
      <img
        src={src}
        alt={active.trigger}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
    )
  }
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center"
      style={{ top: '10cqh' }}
    >
      {active.kind === 'video' ? (
        <BrollVideo
          key={active.id}
          item={active}
          src={src}
          time={time}
          playing={playing}
          className="border-4 border-white shadow-2xl"
          style={{ width: '62%', height: 'auto' }}
        />
      ) : (
        <img
          src={src}
          alt={active.trigger}
          className="border-4 border-white shadow-2xl"
          style={{ width: '62%', height: 'auto' }}
        />
      )}
    </div>
  )
}

/** Drift a playing insert may build up before it is re-seeked; seeking every tick stutters. */
const BROLL_VIDEO_DRIFT_SEC = 0.25

/**
 * A video insert, muted (the A-roll keeps talking underneath, as in the
 * export) and slaved to the preview clock: it shows the frame at
 * mediaIn + (t - start), the same footage the export's -ss/setpts picks.
 */
function BrollVideo({ item, src, time, playing, className, style }: {
  item: BrollItem
  src: string
  time: number
  playing: boolean
  className: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const target = (item.mediaIn ?? 0) + Math.max(0, time - item.start)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    // Paused (scrubbing, stepping frames) must land exactly; playing only corrects drift.
    if (Math.abs(video.currentTime - target) > (playing ? BROLL_VIDEO_DRIFT_SEC : 1 / 60)) video.currentTime = target
  }, [target, playing])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [playing])
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={(e) => { e.currentTarget.currentTime = target }}
      className={className}
      style={style}
    />
  )
}

function CaptionOverlay({
  transcript,
  clip,
  time,
  aspectRatio
}: {
  transcript: NonNullable<Project['transcript']>
  clip: Clip
  time: number
  /** Output frame width / height; decides how much text fits on a line. */
  aspectRatio: number
}): React.JSX.Element | null {
  const brandColors = useStore((s) => s.settings?.branding.colors)
  const style = useMemo(
    () => resolveCaptionStyle(clip.edit.captionStyleId, brandColors, clip.edit.captionFontFamily),
    [clip.edit.captionStyleId, brandColors, clip.edit.captionFontFamily]
  )

  // Same grouping and line layout the ASS export uses, so what wraps here
  // wraps identically in the file.
  const groups = useMemo(() => {
    const words = wordsInRange(transcript, clip.edit.start, clip.edit.end)
    return groupWords(words, captionLayoutBudget(style, aspectRatio))
  }, [transcript, clip.edit.start, clip.edit.end, style, aspectRatio])

  const groupIndex = groups.findIndex(
    (g, i) => time >= g.start && time < groupDisplayEnd(groups, i, clip.edit.end)
  )
  if (groupIndex === -1) return null
  const group = groups[groupIndex]

  let activeIdx = -1
  for (let i = 0; i < group.words.length; i++) {
    if (time >= group.words[i].start) activeIdx = i
  }

  let index = 0
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex flex-col items-center text-center"
      style={{ top: `${captionPositionAt(detailCaptionRanges(clip), time, style.positionY) * 100}cqh`, transform: 'translateY(-50%)' }}
    >
      {group.lines.map((line, li) => (
        <div
          key={li}
          className="whitespace-nowrap"
          style={{
            fontFamily: `'${style.fontFamily}', sans-serif`,
            fontSize: `${style.fontScale * 100}cqh`,
            fontWeight: style.bold ? 700 : 400,
            lineHeight: 1.25,
            textShadow:
              style.outlineWidth > 0
                ? `0 0 ${style.outlineWidth * 2}px ${style.outlineColor}, 2px 2px ${style.outlineWidth}px ${style.outlineColor}, -2px 2px ${style.outlineWidth}px ${style.outlineColor}, 2px -2px ${style.outlineWidth}px ${style.outlineColor}, -2px -2px ${style.outlineWidth}px ${style.outlineColor}`
                : 'none'
          }}
        >
          {line.map((w, wi) => {
            const wordIndex = index++
            const active = wordIndex === activeIdx
            const text = style.uppercase ? w.text.toUpperCase() : w.text
            return (
              <span
                key={`${w.start}-${wordIndex}`}
                className={active ? 'caption-pop inline-block' : 'inline-block'}
                style={{
                  color: active ? style.highlightColor : style.textColor,
                  backgroundColor:
                    active && style.highlightBoxColor ? style.highlightBoxColor : 'transparent',
                  borderRadius: style.highlightBoxColor ? '0.35em' : undefined,
                  padding: style.highlightBoxColor ? '0 0.18em' : undefined,
                  // Word gap mirrors the ASS space; none after the line's last word.
                  marginRight: wi === line.length - 1 ? undefined : '0.28em'
                }}
              >
                {text}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}
