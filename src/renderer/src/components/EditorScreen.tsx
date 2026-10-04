import { useEffect, useState } from 'react'
import {
  Captions,
  CaseUpper,
  Check,
  Copy,
  Crop,
  ExternalLink,
  GalleryVerticalEnd,
  ImagePlus,
  Loader2,
  Quote,
  ScanFace,
  Scissors,
  Share2,
  Sparkles,
  Trash2,
  Type
} from 'lucide-react'
import type { TimelineData } from '@shared/types'
import { isWholeVideoClip } from '@shared/wholeVideo'
import { needsReframe, userClipEdit } from '@shared/reframe'
import { automaticLayoutShots, validLayoutShots } from '@shared/contentType'
import { useStore } from '../store'
import PreviewPlayer from './PreviewPlayer'
import HandoffBanner from './HandoffBanner'
import CompositionControls from './CompositionControls'
import TimelineEditor from './TimelineEditor'
import { cutRange, keepsPlayback } from '@shared/editOps'
import { trackClip } from '@shared/editHistory'
import { EditorialExplanation, EditorialScore } from './EditorialSummary'
import { editorialAssessmentCurrent } from '@shared/editorialRanking'
import TranscriptEditor from './TranscriptEditor'
import { ExportButton } from './ClipsScreen'
import SizeTargetControls from './SizeTargetControls'
import { CAPTION_STYLES, resolveCaptionStyle } from '@shared/captionStyles'
import { formatBytes, formatTimecode } from '../lib/format'
import type { AspectRatio, BrollItem, BrollMode, Clip, FramingMode, ReframeMode } from '@shared/types'

/**
 * Edits longer than this get a warning on the tighten-cuts toggle: over a
 * whole video it splits the timeline into hundreds of segments, and the render
 * cost is not obvious from a toggle labelled "remove pauses".
 */
const TIGHTEN_WARN_SEC = 240

const ASPECTS: Array<{ value: AspectRatio; label: string }> = [
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: 'original', label: 'Original' }
]

export default function EditorScreen(): React.JSX.Element {
  const project = useStore((s) => s.project)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const updateClip = useStore((s) => s.updateClip)
  const updateClipLocal = useStore((s) => s.updateClipLocal)
  const exportClip = useStore((s) => s.exportClip)
  const cancelExport = useStore((s) => s.cancelExport)
  const exports = useStore((s) => s.exports)
  const customFonts = useStore((s) => s.customFonts)
  const brandColors = useStore((s) => s.settings?.branding.colors)
  const ensureReframe = useStore((s) => s.ensureReframe)
  const reframeError = useStore((s) => s.reframeError)

  const clip = project?.clips.find((c) => c.id === selectedClipId) ?? null

  const videoPath = project?.video.path
  const sourceMissing = project?.sourceMissing ?? false
  const windowStart = clip ? Math.max(0, clip.suggestedStart - 15) : 0
  const windowEnd =
    project && clip
      ? Math.min(project.video.durationSec, clip.suggestedEnd + 15)
      : 0

  // Filmstrip + waveform for the trim window (cached in the main process).
  // Keyed so a stale window's data never renders for the current clip.
  const timelineKey = `${videoPath}|${windowStart.toFixed(2)}|${windowEnd.toFixed(2)}`
  const [loadedTimeline, setLoadedTimeline] = useState<{ key: string; data: TimelineData } | null>(
    null
  )
  useEffect(() => {
    if (!videoPath || sourceMissing) return
    let alive = true
    window.cutawan
      .getTimeline(videoPath, windowStart, windowEnd)
      .then((data) => {
        if (alive) setLoadedTimeline({ key: timelineKey, data })
      })
      .catch(() => undefined) // timeline is progressive enhancement
    return () => {
      alive = false
    }
  }, [videoPath, sourceMissing, windowStart, windowEnd, timelineKey])
  const timeline = loadedTimeline?.key === timelineKey ? loadedTimeline.data : null

  // Clips outside the pipeline's top tier arrive without speaker framing;
  // opening one is what triggers the analysis (see shared/reframe.ts).
  const clipId = clip?.id ?? null
  const reframePending = clip ? needsReframe(clip) : false
  // Undo history starts from the clip as opened, whichever screen led here
  // (whole-video projects open straight into the editor).
  useEffect(() => {
    const opened = useStore.getState().project?.clips.find((c) => c.id === clipId)
    if (opened) trackClip(opened)
  }, [clipId])
  useEffect(() => {
    if (clipId && !sourceMissing) void ensureReframe(clipId)
    // Later trim changes trigger analysis after updateClip has saved them.
  }, [clipId, sourceMissing, ensureReframe])

  if (!project || !clip) return <div />

  // A full-video edit has no virality score, hashtags or B-roll behind it —
  // nothing found it, so those panels would only show empty AI furniture.
  const wholeVideo = isWholeVideoClip(clip)
  const assessmentCurrent = editorialAssessmentCurrent(clip, project.transcript)

  const set = (edit: Partial<Clip['edit']>): void => {
    void updateClip({ ...clip, edit: userClipEdit(clip.edit, edit) })
  }
  const setLocal = (edit: Partial<Clip['edit']>): void => {
    updateClipLocal({ ...clip, edit: userClipEdit(clip.edit, edit) })
  }
  const updateBroll = (id: string, patch: Partial<BrollItem>): void => {
    void updateClip({
      ...clip,
      broll: clip.broll.map((b) => (b.id === id ? { ...b, ...patch } : b))
    })
  }
  const removeBroll = (id: string): void => {
    void updateClip({ ...clip, broll: clip.broll.filter((b) => b.id !== id) })
  }

  const entry = exports[clip.id]
  const capExceeded =
    entry?.status === 'done' &&
    entry.sizeTargetBytes != null &&
    entry.bytes != null &&
    entry.bytes > entry.sizeTargetBytes
  const cropDisabled = clip.edit.aspect === 'original'
  const hasShotLayout = validLayoutShots(clip.visualLayout, clip.edit.start, clip.edit.end)
  const automaticLayout = automaticLayoutShots(clip).length > 0

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <HandoffBanner className="mb-4 shrink-0" />
        <PreviewPlayer project={project} clip={clip} />
      </div>

      <aside className="flex w-[400px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-surface-700 bg-surface-900 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <input
              value={clip.title}
              onChange={(e) => updateClipLocal({ ...clip, title: e.target.value })}
              onBlur={() => void updateClip(clip)}
              className="w-full text-ellipsis rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold focus:border-surface-600 focus:bg-surface-850 focus:outline-none"
            />
            <p className="mt-1 px-1 text-xs leading-relaxed text-zinc-500">
              {wholeVideo ? 'The whole video. The title names the exported file.' : clip.summary}
            </p>
          </div>
          {wholeVideo ? (
            <span
              data-testid="whole-video-badge"
              className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-400"
            >
              Full video
            </span>
          ) : (
            <EditorialScore clip={clip} current={assessmentCurrent} size="lg" />
          )}
        </div>

        {!wholeVideo && <EditorialExplanation clip={clip} current={assessmentCurrent} />}

        <Section icon={Scissors} title="Trim">
          <TimelineEditor
            clip={clip}
            windowStart={windowStart}
            windowEnd={windowEnd}
            fps={project.video.fps || 30}
            timeline={timeline}
            // Timeline edits never touch layout fields, so they save as-is
            // (userClipEdit would mark the layout as manually chosen).
            onLocal={(edit) => updateClipLocal({ ...clip, edit })}
            onSave={(edit) => {
              const live = useStore.getState().project?.clips.find((c) => c.id === clip.id) ?? clip
              void updateClip({ ...live, edit })
            }}
          />
          <div className="mt-3">
            <Toggle
              label="Tighten cuts — remove pauses and filler words"
              checked={clip.edit.tightenCuts}
              onChange={(v) => {
                // Pause removal must not remove the last playable span.
                if (keepsPlayback({ ...clip, edit: { ...clip.edit, tightenCuts: v } }, project.transcript)) set({ tightenCuts: v })
              }}
            />
            {clip.edit.end - clip.edit.start > TIGHTEN_WARN_SEC && (
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                Over an edit this long, tightening makes hundreds of cuts and a much slower
                render.
              </p>
            )}
          </div>
          <div className="mt-2">
            <Toggle
              label="Auto zoom — punch-ins on emphasis, jump zooms covering cuts"
              checked={clip.edit.autoZoom ?? false}
              disabled={clip.edit.reframeMode !== 'crop' || automaticLayout}
              onChange={(v) => set({ autoZoom: v })}
            />
            {(clip.edit.reframeMode !== 'crop' || automaticLayout) && (
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                {automaticLayout ? 'Automatic composition keeps its checked framing; switch to Manual to add zoom.' : 'Auto zoom is only available with fill (crop) reframing.'}
              </p>
            )}
          </div>
        </Section>

        <Section icon={Crop} title="Layout">
          <div className="grid grid-cols-4 gap-1.5">
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                onClick={() => set({ aspect: a.value })}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${
                  clip.edit.aspect === a.value
                    ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                    : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <CompositionControls clip={clip} />
          {!cropDisabled && (
            <>
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {(
                  [
                    { value: 'crop', label: automaticLayout ? 'Auto layout' : 'Fill (crop)' },
                    { value: 'fit-letterbox', label: 'Fit (letterbox)' },
                    { value: 'fit-blur', label: 'Fit + blur' }
                  ] as Array<{ value: ReframeMode; label: string }>
                ).map((m) => (
                  <button
                    key={m.value}
                    onClick={() => set({ reframeMode: m.value })}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${
                      clip.edit.reframeMode === m.value
                        ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                        : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {clip.contentType === 'screencast' && clip.edit.reframeMode !== 'crop' && (
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  The full source frame stays visible in this layout.
                </p>
              )}
              {reframePending && (
                <p
                  data-testid="reframe-pending"
                  className="mt-2 flex items-center gap-1.5 text-[11px] leading-relaxed text-zinc-500"
                >
                  {reframeError[clip.id] ? (
                    <>
                      <ScanFace size={12} className="shrink-0" />
                      <span>
                        Speaker framing could not be analysed ({reframeError[clip.id]}).{' '}
                        <button
                          type="button"
                          onClick={() => void ensureReframe(clip.id, true)}
                          className="underline decoration-zinc-600 hover:text-zinc-300"
                        >
                          Retry
                        </button>
                      </span>
                    </>
                  ) : (
                    <>
                      <Loader2 size={12} className="shrink-0 animate-spin" />
                      Preparing framing and content layout… You can keep editing while this
                      finishes. Layout choices you make now are kept.
                    </>
                  )}
                </p>
              )}
              {clip.edit.reframeMode === 'crop' && (
                <>
                  {(clip.focusTrack || hasShotLayout) && (
                    <div className="mt-3 grid grid-cols-2 gap-1.5">
                      {(
                        [
                          { value: 'auto', label: 'Automatic' },
                          { value: 'manual', label: 'Manual' }
                        ] as Array<{ value: FramingMode; label: string }>
                      ).map((f) => (
                        <button
                          key={f.value}
                          onClick={() => set({ framing: f.value })}
                          className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition ${
                            clip.edit.framing === f.value
                              ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                              : 'border-surface-600 text-zinc-400 hover:bg-surface-800'
                          }`}
                        >
                          {f.value === 'auto' && <ScanFace size={13} />}
                          {f.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {automaticLayout ? (
                    <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                      Automatic composition preserves the important content in each shot. Choose Manual to set your own crop, or Fit to show the full source.
                    </p>
                  ) : clip.edit.framing === 'auto' && clip.focusTrack ? (
                    <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                      Following {clip.focusTrack.length} tracked speaker position
                      {clip.focusTrack.length === 1 ? '' : 's'} — the crop pans smoothly as the
                      speaker moves and cuts on camera or speaker changes.
                    </p>
                  ) : (
                    <div className="mt-3">
                      <div className="mb-1.5 flex justify-between text-[11px] text-zinc-500">
                        <span>Focus left</span>
                        <span>Focus right</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(clip.edit.focusX * 100)}
                        onChange={(e) => setLocal({ focusX: Number(e.target.value) / 100 })}
                        onMouseUp={() => void updateClip(clip)}
                        onTouchEnd={() => void updateClip(clip)}
                        className="w-full"
                      />
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </Section>

        <Section icon={Captions} title="Captions">
          <Toggle
            label="Burn in captions"
            checked={clip.edit.captionsEnabled}
            onChange={(v) => set({ captionsEnabled: v })}
          />
          {clip.edit.captionsEnabled && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {CAPTION_STYLES.map((preset) => {
                const style = resolveCaptionStyle(preset.id, brandColors)
                return (
                <button
                  key={preset.id}
                  onClick={() => set({ captionStyleId: preset.id })}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    clip.edit.captionStyleId === preset.id
                      ? 'border-white/30 bg-white/[0.07]'
                      : 'border-surface-600 hover:bg-surface-800'
                  }`}
                >
                  <div
                    className="text-sm"
                    style={{
                      fontFamily: `'${style.fontFamily}', sans-serif`,
                      fontWeight: style.bold ? 700 : 400,
                      color: style.textColor
                    }}
                  >
                    {style.uppercase ? 'SO I ' : 'so I '}
                    <span
                      style={{
                        color: style.highlightColor,
                        backgroundColor: style.highlightBoxColor ?? 'transparent',
                        borderRadius: 4,
                        padding: style.highlightBoxColor ? '0 3px' : 0
                      }}
                    >
                      {style.uppercase ? 'SAID' : 'said'}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">{preset.name}</div>
                </button>
              )})}
            </div>
          )}
          {clip.edit.captionsEnabled && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Type size={13} /> Caption font
              </div>
              {customFonts.length > 0 ? (
                <select
                  value={clip.edit.captionFontFamily ?? ''}
                  onChange={(e) => set({ captionFontFamily: e.target.value || null })}
                  className="w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-xs text-zinc-200 focus:border-white/25 focus:outline-none"
                >
                  <option value="">Style default</option>
                  {customFonts.map((f) => (
                    <option key={f.fileName} value={f.family}>
                      {f.family}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  Using the style’s built-in font. Upload your own fonts in Settings → Custom
                  fonts to pick them here.
                </p>
              )}
            </div>
          )}
          <div className="mt-3">
            <Toggle
              label="Show hook title at start"
              checked={clip.edit.showTitle}
              onChange={(v) => set({ showTitle: v })}
            />
          </div>
          {clip.edit.showTitle && (
            <div className="mt-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                <CaseUpper size={13} /> Hook text
              </div>
              <input
                value={clip.hook}
                onChange={(e) => updateClipLocal({ ...clip, hook: e.target.value })}
                onBlur={() => void updateClip(clip)}
                className="w-full rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-xs text-zinc-200 focus:border-white/25 focus:outline-none"
              />
            </div>
          )}
        </Section>

        {/* A full-video edit only has B-roll when a package brought inserts. */}
        {(!wholeVideo || clip.broll.length > 0) && (
        <Section icon={ImagePlus} title="B-roll">
          {clip.broll.length === 0 ? (
            <p className="text-xs leading-relaxed text-zinc-500">
              No image inserts for this clip. Enable “AI B-roll images” when generating clips to
              get keyword-triggered visuals.
            </p>
          ) : (
            <div className="space-y-2">
              {clip.broll.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 rounded-xl border border-surface-600 p-2.5 transition ${
                    item.enabled ? '' : 'opacity-50'
                  }`}
                >
                  {item.imagePath && item.kind === 'video' ? (
                    // The media fragment shows the insert's first frame, not the file's.
                    <video
                      src={`${window.cutawan.mediaUrl(item.imagePath)}#t=${(item.mediaIn ?? 0).toFixed(2)}`}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-12 w-16 shrink-0 rounded-lg bg-black object-cover"
                    />
                  ) : item.imagePath && (
                    <img
                      src={window.cutawan.mediaUrl(item.imagePath)}
                      alt={item.trigger}
                      className="h-12 w-16 shrink-0 rounded-lg bg-black object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">“{item.trigger}”</div>
                    <div className="mt-0.5 text-[11px] tabular-nums text-zinc-500">
                      {item.kind === 'video' ? 'Video · ' : ''}
                      {formatTimecode(item.start - clip.edit.start)} ·{' '}
                      {(item.end - item.start).toFixed(1)}s
                    </div>
                    <div className="mt-1.5 flex gap-1">
                      {(
                        [
                          { value: 'fullscreen', label: 'Full' },
                          { value: 'overlay', label: 'Overlay' }
                        ] as Array<{ value: BrollMode; label: string }>
                      ).map((m) => (
                        <button
                          key={m.value}
                          onClick={() => updateBroll(item.id, { mode: m.value })}
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition ${
                            item.mode === m.value
                              ? 'border-white/30 bg-white/[0.07] text-zinc-200'
                              : 'border-surface-600 text-zinc-500 hover:bg-surface-800'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      onClick={() => updateBroll(item.id, { enabled: !item.enabled })}
                      title={item.enabled ? 'Disable this insert' : 'Enable this insert'}
                      className={`relative h-5 w-9 rounded-full transition ${
                        item.enabled ? 'bg-zinc-100' : 'bg-surface-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
                          item.enabled ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'
                        }`}
                      />
                    </button>
                    <button
                      onClick={() => removeBroll(item.id)}
                      title="Remove this insert"
                      className="rounded-md p-1 text-zinc-600 transition hover:bg-surface-700 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
        )}

        <Section icon={Quote} title="Transcript">
          {project.transcript ? (
            <TranscriptEditor
              transcript={project.transcript}
              clipStart={clip.edit.start}
              clipEnd={clip.edit.end}
              cuts={clip.edit.cuts}
              onCut={(range) => {
                const next = { ...clip, edit: cutRange(clip.edit, range) }
                if (keepsPlayback(next, project.transcript)) void updateClip(next)
              }}
              onTrim={(start, end) => {
                const next = { ...clip, edit: { ...clip.edit, start: Math.max(windowStart, start), end: Math.min(windowEnd, end) } }
                if (keepsPlayback(next, project.transcript)) void updateClip(next)
              }}
            />
          ) : (
            <p className="text-xs leading-relaxed text-zinc-500">No transcript available.</p>
          )}
        </Section>

        {!wholeVideo && (
          <Section icon={GalleryVerticalEnd} title="Hashtags">
            <div className="flex flex-wrap gap-1.5">
              {clip.hashtags.map((h) => (
                <span
                  key={h}
                  className="select-text rounded-full border border-white/[0.06] bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300"
                >
                  #{h}
                </span>
              ))}
            </div>
          </Section>
        )}

        <ShareSection clip={clip} />

        <div className="sticky bottom-0 -mx-5 -mb-5 border-t border-white/[0.06] bg-surface-900/80 p-4 backdrop-blur-xl">
          <SizeTargetControls compact />
          <div className="flex">
            <ExportButton
              status={entry?.status}
              progress={entry?.progress ?? 0}
              outputPath={entry?.outputPath}
              error={entry?.error}
              bytes={entry?.bytes}
              downscaled={entry?.downscaled}
              onExport={() => void exportClip(clip.id)}
              onCancel={() => void cancelExport(clip.id)}
            />
          </div>
          {entry?.status === 'done' && entry.downscaled && !capExceeded && (
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              Scaled the frame down so the file would fit
              {entry.sizeTargetBytes ? ` under ${formatBytes(entry.sizeTargetBytes)}` : ''}.
            </p>
          )}
          {entry?.status === 'done' && entry.overBudget && !capExceeded && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
              This edit is long for the size cap — the picture may look soft. A shorter trim would
              hold up better.
            </p>
          )}
          {capExceeded && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-400">
              This export is over your size limit
              {entry.sizeTargetBytes ? ` (${formatBytes(entry.sizeTargetBytes)})` : ''}. Shorten the
              clip or raise the cap.
            </p>
          )}
          {entry?.status === 'error' && entry.error && (
            <p className="mt-2 text-[11px] leading-relaxed text-red-400">{entry.error}</p>
          )}
        </div>
      </aside>
    </div>
  )
}

/**
 * Post-to-social helpers. Direct in-app posting to TikTok needs an audited
 * TikTok developer app (unaudited clients are forced to private-only posts),
 * so the local-first flow is: generate the caption here, copy it, and hand
 * off to TikTok Studio's upload page with the exported file.
 */
function ShareSection({ clip }: { clip: Clip }): React.JSX.Element {
  const updateClip = useStore((s) => s.updateClip)
  const updateClipLocal = useStore((s) => s.updateClipLocal)
  const generateCaption = useStore((s) => s.generateCaption)
  const busy = useStore((s) => s.captionBusy[clip.id] ?? false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async (): Promise<void> => {
    setError(null)
    try {
      await generateCaption(clip.id)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : String(err))
    }
  }

  const copy = async (): Promise<void> => {
    if (!clip.caption) return
    await navigator.clipboard.writeText(clip.caption)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Section icon={Share2} title="Share">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] text-zinc-500">Post caption (AI)</span>
        <button
          onClick={() => void generate()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-surface-600 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-60"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          {busy ? 'Writing…' : clip.caption ? 'Regenerate' : 'Generate caption'}
        </button>
      </div>
      <textarea
        value={clip.caption ?? ''}
        onChange={(e) => updateClipLocal({ ...clip, caption: e.target.value })}
        onBlur={() => void updateClip(clip)}
        placeholder="Generate a scroll-stopping caption for TikTok / Reels / Shorts, or write your own."
        rows={3}
        className="w-full resize-none rounded-lg border border-surface-600 bg-surface-850 px-3 py-2 text-xs leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none"
      />
      {error && <p className="mt-1.5 text-[11px] leading-relaxed text-red-400">{error}</p>}
      <div className="mt-2 flex gap-1.5">
        <button
          onClick={() => void copy()}
          disabled={!clip.caption}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 disabled:opacity-40"
        >
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy caption'}
        </button>
        <a
          href="https://www.tiktok.com/tiktokstudio/upload"
          target="_blank"
          rel="noreferrer"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
        >
          <ExternalLink size={13} />
          Open TikTok upload
        </a>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Export the clip, then drop the file into TikTok Studio and paste the caption. TikTok
        only allows fully public in-app posting for audited web services, so this hand-off is
        the reliable local route.
      </p>
    </Section>
  )
}

function Section({
  icon: Icon,
  title,
  children
}: {
  icon: React.ElementType
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        <Icon size={13} />
        {title}
      </h3>
      {children}
    </section>
  )
}

function Toggle({
  label,
  checked,
  disabled = false,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border border-surface-600 px-3 py-2.5 text-left text-xs font-medium transition ${
        disabled
          ? 'cursor-not-allowed text-zinc-600 opacity-60'
          : 'text-zinc-300 hover:bg-surface-800'
      }`}
    >
      {label}
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-zinc-100' : 'bg-surface-600'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${checked ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`}
        />
      </span>
    </button>
  )
}
