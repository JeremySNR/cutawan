import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, RotateCcw } from 'lucide-react'
import type { Clip, Project, WatermarkPosition } from '@shared/types'
import { captionEmphasisLook, hexToRgba, resolveCaptionStyle, type CaptionStyle } from '@shared/captionStyles'
import { captionLinePitchEm, captionWordText, groupDisplayEnd, type WordGroup } from '@shared/captionLayout'
import { CAPTION_EMOJI_FONT, EMOJI_EM, EMPHASIS_SCALE } from '@shared/captionEmphasis'
import { ClipTimeline, clipTimelineParts, timelineTranscript } from '@shared/clipTimeline'
import { clipCaptionGroups, clipSoundEffects, clipTitlePlan } from '@shared/clipOverlays'
import { clipCaptionPositionRanges } from '@shared/captionPlacement'
import type { TitlePlan } from '@shared/titleLayout'
import { musicGainEnvelope, pickMusicTrack, speechSpans } from '@shared/audioMix'
import { automaticLayoutShots, clipAllowsAutoZoom, compositionHidesTitle, layoutBlocksAutoZoom } from '@shared/contentType'
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
import { PreviewAudio, type PreviewMix } from '../lib/previewAudio'
import { useMusicTracks } from '../lib/musicTracks'
import { useStore } from '../store'

/**
 * Live preview that mimics the exported result: plays the clip's output
 * timeline (an optional cold open, then the kept segments, shared with the
 * export via shared/clipTimeline.ts), CSS-simulated reframing (crop focus on
 * the video, zoom on a wrapper — same order as ffmpeg), the same caption
 * cards, emphasis and hook title the export burns in, and the sound effects
 * and music bed through WebAudio.
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
  /**
   * Which piece of the output timeline is playing. A cold open replays
   * footage from later in the clip, so the source time alone cannot say
   * whether the viewer is in the teaser or in the clip proper.
   */
  const pieceRef = useRef(0)
  const [piece, setPieceState] = useState(0)
  const setBusTime = usePreviewBus((s) => s.setTime)
  const setSeekHandler = usePreviewBus((s) => s.setSeekHandler)
  const setScrubHandler = usePreviewBus((s) => s.setScrubHandler)
  const brandColors = useStore((s) => s.settings?.branding.colors)
  const musicTracks = useMusicTracks()

  const { start, end } = clip.edit

  // The output timeline, shared with the export. An edit with nothing left
  // plays the trim rather than seeking every frame; export reports it instead.
  const timeline = useMemo(() => {
    const parts = clipTimelineParts(clip, project.transcript)
    return new ClipTimeline(parts.main.length ? parts.main : [{ start, end }], parts.coldOpen)
  }, [clip, project.transcript, start, end])
  const timelineRef = useRef(timeline)

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

  const setPiece = useCallback((index: number): void => {
    pieceRef.current = index
    setPieceState(index)
    previewPlanRef.current = { ...previewPlanRef.current, unzoomed: timelineRef.current.pieces[index]?.coldOpen === true }
  }, [])

  /** The clip-proper piece showing source time `t` (or the next one after it). */
  const mainPieceFor = useCallback((t: number): number => {
    const pieces = timelineRef.current.pieces
    const index = pieces.findIndex((p) => !p.coldOpen && t <= p.end + 1e-3)
    if (index >= 0) return index
    for (let i = pieces.length - 1; i >= 0; i--) if (!pieces[i].coldOpen) return i
    return 0
  }, [])

  // An edit can add or remove pieces (a cold open, a cut): re-find where the
  // playhead is on the new timeline.
  useEffect(() => {
    const before = timelineRef.current.pieces[pieceRef.current]
    timelineRef.current = timeline
    const after = timeline.pieces[pieceRef.current]
    const same = before && after && before.coldOpen === after.coldOpen &&
      Math.abs(before.start - after.start) < 1e-3 && Math.abs(before.end - after.end) < 1e-3
    if (!same) setPiece(mainPieceFor(videoRef.current?.currentTime ?? timeline.pieces[0]?.start ?? 0))
  }, [timeline, setPiece, mainPieceFor])

  const requestSeek = useCallback(
    (t: number, pieceIndex?: number): void => {
      const video = videoRef.current
      if (!video) return
      setPiece(pieceIndex ?? mainPieceFor(t))
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
    [setTime, applyFrame, setPiece, mainPieceFor]
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

  const outputDuration = timeline.outputDuration
  const currentPiece = timeline.pieces[Math.min(piece, timeline.pieces.length - 1)]
  const inColdOpen = currentPiece?.coldOpen === true
  const outputTime = Math.max(0, Math.min(outputDuration, timeline.toOutputIn(Math.min(piece, timeline.pieces.length - 1), time)))

  // Sound effects and the music bed, from the same cues and envelope the
  // export mixes (levels are estimated here; the export measures them).
  const style = useMemo(
    () => resolveCaptionStyle(clip.edit.captionStyleId, brandColors, clip.edit.captionFontFamily),
    [clip.edit.captionStyleId, brandColors, clip.edit.captionFontFamily]
  )
  const titlePlan = useMemo(
    () => (compositionHidesTitle(clip) ? null : clipTitlePlan(clip, timeline, style, brandColors, aspectStyle)),
    [clip, timeline, style, brandColors, aspectStyle]
  )
  const outputWords = useMemo(
    () => (project.transcript ? timelineTranscript(project.transcript, timeline, start, end).segments.flatMap((s) => s.words) : []),
    [project.transcript, timeline, start, end]
  )
  const musicPath = useMemo(() => {
    if (!clip.edit.music) return null
    const name = pickMusicTrack(musicTracks.map((t) => t.name), clip.id, clip.edit.musicTrack)
    return musicTracks.find((t) => t.name === name)?.path ?? null
  }, [clip.edit.music, clip.edit.musicTrack, clip.id, musicTracks])
  const mix = useMemo<PreviewMix>(() => ({
    cues: project.video.hasAudio ? clipSoundEffects(clip, timeline, titlePlan ? titlePlan.start : null) : [],
    musicUrl: musicPath && project.video.hasAudio ? window.cutawan.mediaUrl(musicPath) : null,
    envelope: musicGainEnvelope(speechSpans(outputWords), outputDuration)
  }), [clip, timeline, titlePlan, musicPath, outputWords, outputDuration, project.video.hasAudio])
  const audioRef = useRef<PreviewAudio | null>(null)
  useEffect(() => {
    if (!audioRef.current) audioRef.current = new PreviewAudio(mix)
    else audioRef.current.update(mix)
  }, [mix])
  useEffect(() => () => audioRef.current?.dispose(), [])
  /** Restart effects/music from output time `out` if playing (after any jump). */
  const resyncAudio = useCallback((out: number): void => {
    const video = videoRef.current
    if (video && !video.paused) audioRef.current?.sync(out)
  }, [])

  // Let the sidebar (timeline, transcript) seek the preview.
  useEffect(() => {
    setSeekHandler((t: number) => {
      const clamped = Math.max(start, Math.min(end, t))
      requestSeek(clamped)
      resyncAudio(timelineRef.current.toOutput(clamped))
    })
    return () => setSeekHandler(null)
  }, [start, end, setSeekHandler, requestSeek, resyncAudio])

  // Trim handles scrub to the exact frame being dragged to. Deliberately not
  // clamped to [start, end]: the drag is what moves those bounds, and this
  // handler must not close over them or it would lag a render behind.
  useEffect(() => {
    setScrubHandler((t: number) => {
      const video = videoRef.current
      if (video && !video.paused) {
        video.pause()
        audioRef.current?.stop()
        setPlaying(false)
      }
      requestSeek(t)
    })
    return () => setScrubHandler(null)
  }, [setScrubHandler, requestSeek])

  // Mirrors the export's auto-zoom plan (same shared generator), including the
  // trim the export has to make when a plan outgrows one ffmpeg expression.
  const keptSegments = useMemo(() => {
    const parts = clipTimelineParts(clip, project.transcript)
    return parts.tightened && parts.main.length ? parts.main : null
  }, [clip, project.transcript])
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
      isCrop,
      unzoomed: timeline.pieces[pieceRef.current]?.coldOpen === true
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
    start,
    timeline
  ])

  useEffect(() => {
    const tick = (): void => {
      const video = videoRef.current
      const tl = timelineRef.current
      // While a seek is in flight, leave the element alone: issuing more
      // seeks (loop reset / piece jump) before `seeked` fires is what
      // caused the stutter-then-freeze after edits.
      if (video && !video.seeking && pendingSeekRef.current === null) {
        const index = Math.min(pieceRef.current, tl.pieces.length - 1)
        const current = tl.pieces[index]
        const t = video.currentTime
        if (current && t >= current.end - 1e-3) {
          // End of a piece: on to the next (the clip after a cold open, the
          // next kept span after a cut), or round to the top at the end.
          const next = index + 1 < tl.pieces.length ? index + 1 : 0
          setPiece(next)
          video.currentTime = tl.pieces[next].start
          playbackClockRef.current = { mediaTime: video.currentTime, wallAt: performance.now() }
          if (next === 0) audioRef.current?.sync(0)
        } else if (current && t < current.start - 1e-3) {
          // Before its piece (a seek into removed footage): skip ahead to it.
          video.currentTime = current.start
          playbackClockRef.current = { mediaTime: video.currentTime, wallAt: performance.now() }
        }
        const smoothed = smoothPlaybackTime(video, playbackClockRef.current)
        playbackClockRef.current = smoothed.clock
        // Zoom and crop follow every display frame directly on the DOM.
        // React (captions, playhead, transcript) only needs ~30 updates a
        // second; re-rendering it every frame dropped frames and made the
        // zoom stutter.
        applyFrame(smoothed.t)
        audioRef.current?.tick(tl.toOutputIn(pieceRef.current, smoothed.t))
        if (Math.abs(smoothed.t - publishedRef.current) >= 1 / 30) {
          publishedRef.current = smoothed.t
          setTime(smoothed.t)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    if (playing) rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, setTime, applyFrame, setPiece])

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      video.pause()
      audioRef.current?.stop()
      playbackClockRef.current = { mediaTime: video.currentTime, wallAt: 0 }
      setPlaying(false)
    } else {
      let out = timeline.toOutputIn(pieceRef.current, video.currentTime)
      if (out >= outputDuration - 0.05) {
        requestSeek(timeline.pieces[0].start, 0)
        out = 0
      }
      playbackClockRef.current = { mediaTime: video.currentTime, wallAt: performance.now() }
      void video.play()
      audioRef.current?.sync(out)
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

  /** From the very top: the cold open when there is one. */
  const restart = (): void => {
    requestSeek(timeline.pieces[0].start, 0)
    resyncAudio(0)
  }

  const seek = (fraction: number): void => {
    const out = fraction * outputDuration
    requestSeek(timeline.toSource(out), timeline.pieceAt(out))
    resyncAudio(out)
  }

  const captionGroups = useMemo(
    () => (clip.edit.captionsEnabled && project.transcript
      ? clipCaptionGroups(project.transcript, clip, timeline, style, aspectStyle)
      : []),
    [clip, project.transcript, timeline, style, aspectStyle]
  )
  // Caption moves (detail views, faces, burned-in text) are planned in source
  // time; the footage on screen decides where captions sit, as in the export.
  const positionRanges = useMemo(
    () => clipCaptionPositionRanges(clip, style.positionY, style.fontScale, project.video.width, project.video.height),
    [clip, style.positionY, style.fontScale, project.video.width, project.video.height]
  )
  const captionY = captionPositionAt(positionRanges, time, style.positionY)
  const showTitle = titlePlan !== null && outputTime >= titlePlan.start && outputTime < titlePlan.end
  const heardInExport = mix.cues.length > 0 || mix.musicUrl !== null

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
            onEnded={() => {
              audioRef.current?.stop()
              setPlaying(false)
            }}
            onSeeked={handleSeeked}
            onLoadedData={() => applyFrame(videoRef.current?.currentTime ?? start)}
            preload="auto"
          />
        </div>
        <canvas ref={overviewRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 hidden w-full" />
        {!inColdOpen && <BrollOverlay clip={clip} time={time} />}
        <WatermarkOverlay />
        {captionGroups.length > 0 && (
          <CaptionOverlay
            groups={captionGroups}
            time={outputTime}
            end={outputDuration}
            breaks={timeline.hasColdOpen ? [timeline.coldOpenDuration] : []}
            positionY={captionY}
            style={style}
          />
        )}
        {showTitle && titlePlan && <TitleOverlay plan={titlePlan} />}
        {inColdOpen && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
            Cold open
          </span>
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
      {heardInExport && (
        <p className="-mt-1 text-[10px] text-zinc-600">
          Music and effects play here at estimated levels; the export measures and mixes them exactly.
        </p>
      )}
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

/** CSS approximation of a libass outline of `width` px (at the 1920-high reference). */
function outlineShadow(width: number, color: string): string {
  if (width <= 0) return 'none'
  return `0 0 ${width * 2}px ${color}, 2px 2px ${width}px ${color}, -2px 2px ${width}px ${color}, 2px -2px ${width}px ${color}, -2px -2px ${width}px ${color}`
}

/**
 * The hook title, drawn from the same plan the ASS Title event is built from
 * (shared/titleLayout.ts): the same lines, size, colours and top inset. Each
 * line gets its own box, as libass draws BorderStyle 3, and lines advance by
 * the font's win ascent + descent as libass advances them.
 */
function TitleOverlay({ plan }: { plan: TitlePlan }): React.JSX.Element {
  const boxed = plan.boxColor !== null
  const pitch = captionLinePitchEm(plan.fontFamily)
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex flex-col items-center"
      style={{ top: `${(plan.top - (boxed ? plan.boxPad : 0)) * 100}cqh` }}
      data-testid="hook-title"
    >
      {plan.lines.map((line, i) => (
        <div
          key={i}
          className="hook-in whitespace-nowrap text-center"
          style={{
            fontFamily: `'${plan.fontFamily}', sans-serif`,
            fontWeight: plan.bold ? 700 : 400,
            fontSize: `${plan.fontScale * 100}cqh`,
            lineHeight: pitch,
            color: plan.textColor,
            padding: boxed ? `${plan.boxPad * 100}cqh` : 0,
            // libass boxes neighbouring lines with overlapping padding.
            marginTop: boxed && i > 0 ? `${-2 * plan.boxPad * 100}cqh` : 0,
            backgroundColor: boxed ? hexToRgba(plan.boxColor!, plan.boxOpacity) : 'transparent',
            boxShadow: boxed ? '0 0.4cqh 1.2cqh rgba(0,0,0,0.35)' : undefined,
            textShadow: boxed ? undefined : outlineShadow(plan.outlineWidth * 1920 * 0.5, plan.outlineColor)
          }}
        >
          {line.map((w, wi) => (
            <span key={wi} style={{ color: w.accent ? plan.accentColor : undefined }}>
              {w.text}
              {wi < line.length - 1 ? ' ' : ''}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

function BrollOverlay({ clip, time }: { clip: Clip; time: number }): React.JSX.Element | null {
  const active = clip.broll.find(
    (b) => b.enabled && b.imagePath && time >= b.start && time <= b.end
  )
  if (!active) return null
  const src = window.cutawan.mediaUrl(active.imagePath!)
  if (active.mode === 'fullscreen') {
    return (
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
      <img
        src={src}
        alt={active.trigger}
        className="border-4 border-white shadow-2xl"
        style={{ width: '62%', height: 'auto' }}
      />
    </div>
  )
}

/**
 * The caption card on screen at output time `time`: the same cards, lines,
 * emphasis and emoji as the burned-in ASS (shared/clipOverlays.ts).
 */
function CaptionOverlay({
  groups,
  time,
  end,
  breaks,
  positionY,
  style
}: {
  groups: WordGroup[]
  /** Output seconds. */
  time: number
  end: number
  breaks: number[]
  positionY: number
  style: CaptionStyle
}): React.JSX.Element | null {
  const groupIndex = groups.findIndex(
    (g, i) => time >= g.start && time < groupDisplayEnd(groups, i, end, breaks)
  )
  if (groupIndex === -1) return null
  const group = groups[groupIndex]
  const look = captionEmphasisLook(style)

  let activeIdx = -1
  for (let i = 0; i < group.words.length; i++) {
    if (time >= group.words[i].start) activeIdx = i
  }

  let index = 0
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex flex-col items-center text-center"
      style={{ top: `${positionY * 100}cqh`, transform: 'translateY(-50%)' }}
      data-testid="caption-card"
    >
      {group.lines.map((line, li) => (
        <div
          key={li}
          className="whitespace-nowrap"
          style={{
            fontFamily: `'${style.fontFamily}', sans-serif`,
            fontSize: `${style.fontScale * 100}cqh`,
            fontWeight: style.bold ? 700 : 400,
            lineHeight: captionLinePitchEm(style.fontFamily),
            textShadow: outlineShadow(style.outlineWidth, style.outlineColor)
          }}
        >
          {line.map((w, wi) => {
            const wordIndex = index++
            const active = wordIndex === activeIdx
            const emphasised = wordIndex === group.emphasis
            const text = captionWordText(w.text, style)
            const boxColor = active ? style.highlightBoxColor : emphasised ? look.boxColor : null
            const gap = wi === line.length - 1 ? undefined : '0.28em'
            return (
              <span key={`${w.start}-${wordIndex}`} className="inline-block" style={{ marginRight: gap }}>
                <span
                  className={active ? 'caption-pop inline-block' : 'inline-block'}
                  data-emphasis={emphasised ? 'true' : undefined}
                  style={{
                    color: active ? style.highlightColor : emphasised ? look.color : style.textColor,
                    fontSize: emphasised ? `${EMPHASIS_SCALE}em` : undefined,
                    backgroundColor: boxColor ?? 'transparent',
                    borderRadius: boxColor ? '0.35em' : undefined,
                    padding: boxColor ? '0 0.18em' : undefined
                  }}
                >
                  {text}
                </span>
                {emphasised && group.emoji && (
                  <span
                    className="inline-block"
                    style={{ fontFamily: `'${CAPTION_EMOJI_FONT}'`, fontSize: `${EMOJI_EM}em`, color: look.color, marginLeft: '0.28em' }}
                  >
                    {group.emoji}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}
