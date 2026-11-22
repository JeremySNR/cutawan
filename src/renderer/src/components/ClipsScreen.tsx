import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Pencil,
  Check,
  Loader2,
  AlertTriangle,
  Captions,
  FolderOpen,
  FolderCog,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import { useStore } from '../store'
import { formatBytes, formatDuration } from '../lib/format'
import { EditorialExplanation, EditorialRankingSummary, EditorialScore } from './EditorialSummary'
import MissingSourceBanner from './MissingSourceBanner'
import DiscoverySummary from './DiscoverySummary'
import { JoinedBadge } from './JoinedMoments'
import type { Clip, ExportCheckReport, TimeRange } from '@shared/types'
import { exportCheckSummary } from '@shared/exportCheck'
import { selectedRanges } from '@shared/clipSegments'
import { findWholeVideoClip, highlightClips } from '@shared/wholeVideo'
import { clipTimeline } from '@shared/clipTimeline'
import { layoutReviewMessage } from '@shared/contentType'
import { editorialAssessmentCurrent, editorialReportMatchesClips } from '@shared/editorialRanking'
import { CLIP_KIND_LABELS } from '@shared/clipVariety'

export default function ClipsScreen(): React.JSX.Element {
  const project = useStore((s) => s.project)
  const exportAll = useStore((s) => s.exportAll)
  const exports = useStore((s) => s.exports)
  const exportDir = useStore((s) => s.exportDir)
  const chooseExportDir = useStore((s) => s.chooseExportDir)
  const goHome = useStore((s) => s.goHome)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [exportingAll, setExportingAll] = useState(false)

  if (!project) return <div />

  // The full-video edit is not one of the found clips: it gets its own banner
  // and is exported from its editor, never swept into "Export all".
  const clips = highlightClips(project)
  const wholeVideo = findWholeVideoClip(project)
  const currentRanking = editorialReportMatchesClips(project)
  const earlierRanking = !!project.editorialRanking && !currentRanking
  const doneCount = clips.filter((c) => exports[c.id]?.status === 'done').length
  // Only for the run it applied to: a later run without it replaces the note.
  const personalised = project.personalised?.generationId === project.clipsGenerationId ? project.personalised : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
              <Sparkles size={20} className="text-accent-400" />
              {clips.length} clips found
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {earlierRanking ? 'Saved clips from an earlier run; the latest attempt did not replace them.' : currentRanking ? 'Ordered for complete stories, editorial quality and variety.' : 'Saved AI selections.'}
              {' '}Review each clip before exporting; scores estimate editorial quality, not audience performance.
            </p>
            {personalised && (
              <p data-testid="personalised-note" className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <Sparkles size={12} className="shrink-0 text-accent-400" />
                Ranking nudged towards clips like the {personalised.positives} you exported or edited.{' '}
                <button type="button" onClick={() => setSettingsOpen(true)} className="underline decoration-zinc-600 hover:text-zinc-300">
                  Change in Settings
                </button>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={goHome}
              data-testid="regenerate-button"
              title="Change the AI instructions and generate a new set of clips using the saved transcript"
              className="flex items-center gap-2 rounded-xl border border-surface-600 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-surface-800"
            >
              <RefreshCw size={15} />
              Regenerate
            </button>
            <button
              onClick={() => void chooseExportDir()}
              title={
                exportDir
                  ? `Exports go to ${exportDir} — click to change`
                  : 'Choose the export folder'
              }
              className="flex items-center gap-2 rounded-xl border border-surface-600 px-3 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-surface-800"
            >
              <FolderCog size={15} />
            </button>
            <button
              onClick={async () => {
                setExportingAll(true)
                try {
                  await exportAll()
                } finally {
                  setExportingAll(false)
                }
              }}
              disabled={exportingAll}
              className="flex items-center gap-2 rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 shadow-lg shadow-black/40 transition hover:bg-white disabled:opacity-60"
            >
              {exportingAll ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {exportingAll ? `Exporting… (${doneCount}/${clips.length})` : 'Export all'}
            </button>
          </div>
        </div>

        <MissingSourceBanner />
        <DiscoverySummary report={project.discoveryReport} earlierAttempt={!!project.discoveryReport?.generationId && project.discoveryReport.generationId !== project.clipsGenerationId} />
        <EditorialRankingSummary report={project.editorialRanking} earlierAttempt={earlierRanking} />

        {wholeVideo && <WholeVideoBanner clip={wholeVideo} />}

        <div className="mt-6 grid grid-cols-2 gap-5 xl:grid-cols-3">
          {clips.map((clip, i) => (
            <ClipCard key={clip.id} clip={clip} rank={i + 1} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * This project also has a captioned full-video edit. It is deliberately not a
 * card in the grid: it is not a found clip, has no score to rank, and is
 * exported on its own from the editor.
 */
function WholeVideoBanner({ clip }: { clip: Clip }): React.JSX.Element {
  const openEditor = useStore((s) => s.openEditor)
  return (
    <button
      onClick={() => openEditor(clip.id)}
      className="mt-6 flex w-full items-center gap-3 rounded-2xl border border-surface-700 bg-surface-900 px-4 py-3 text-left transition hover:border-surface-600 hover:bg-surface-850"
    >
      <Captions size={16} className="shrink-0 text-accent-400" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-zinc-200">
          Captioned full video ({formatDuration(clip.edit.end - clip.edit.start)})
        </span>
        <span className="mt-0.5 block text-xs text-zinc-500">
          The whole thing, cropped and captioned. Open it to style and export.
        </span>
      </span>
      <Pencil size={14} className="shrink-0 text-zinc-500" />
    </button>
  )
}

function ClipCard({ clip, rank }: { clip: Clip; rank: number }): React.JSX.Element {
  const openEditor = useStore((s) => s.openEditor)
  const exportClip = useStore((s) => s.exportClip)
  const cancelExport = useStore((s) => s.cancelExport)
  const exports = useStore((s) => s.exports)
  const entry = exports[clip.id]
  const framing = useStore((s) => s.backgroundReframing[clip.id] === true)
  const transcript = useStore((s) => s.project?.transcript ?? null)
  // What the export plays, cold open included.
  const duration = useMemo(() => clipTimeline(clip, transcript).outputDuration, [clip, transcript])
  const assessmentCurrent = useMemo(() => editorialAssessmentCurrent(clip, transcript), [clip, transcript])
  const videoPath = useStore((s) => s.project?.video.path)
  const [previewing, setPreviewing] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  return (
    <div className="group overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 transition hover:border-surface-600">
      <div
        data-testid="clip-thumb"
        className="relative aspect-video cursor-pointer bg-black"
        onClick={() => openEditor(clip.id)}
        onMouseEnter={() => {
          // A pointer crossing the grid should not start a decoder per card.
          hoverTimer.current = setTimeout(() => setPreviewing(true), HOVER_PREVIEW_DELAY_MS)
        }}
        onMouseLeave={() => {
          clearTimeout(hoverTimer.current)
          setPreviewing(false)
        }}
      >
        {clip.thumbnailPath ? (
          <img
            src={window.cutawan.mediaUrl(clip.thumbnailPath)}
            alt=""
            className="h-full w-full object-cover transition group-hover:opacity-90"
          />
        ) : (
          <div className="h-full w-full bg-surface-800" />
        )}
        {previewing && videoPath && (
          <HoverPreview
            src={window.cutawan.mediaUrl(videoPath)}
            ranges={selectedRanges(clip.edit)}
            onFailed={() => setPreviewing(false)}
          />
        )}
        <div className="absolute left-2.5 top-2.5 flex items-center gap-2">
          <span className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-zinc-300 backdrop-blur">
            #{rank}
          </span>
          <EditorialScore clip={clip} current={assessmentCurrent} />
          {clip.kind && (
            <span
              data-testid="clip-kind"
              className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-zinc-300 backdrop-blur"
            >
              {CLIP_KIND_LABELS[clip.kind]}
            </span>
          )}
        </div>
        <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5">
          {framing && (
            <span className="flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-zinc-300 backdrop-blur">
              <Loader2 size={11} className="animate-spin" />
              Framing…
            </span>
          )}
          <JoinedBadge clip={clip} />
        </div>
        <span className="absolute bottom-2.5 right-2.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-200 backdrop-blur">
          {formatDuration(duration)}
        </span>
      </div>

      <div className="p-4">
        <div className="line-clamp-1 text-sm font-semibold">{clip.title}</div>
        {clip.discovery?.origin === 'visual' && <p className="mt-1 text-xs text-zinc-400">
          Found from visual evidence · review the complete action before exporting
        </p>}
        {layoutReviewMessage(clip) && (
          <p className="mt-1 text-xs text-amber-300" title={layoutReviewMessage(clip)!}>Review layout</p>
        )}
        <p className="mt-1.5 line-clamp-2 min-h-[2.2rem] text-xs leading-relaxed text-zinc-500">
          {clip.summary}
        </p>
        <EditorialExplanation clip={clip} current={assessmentCurrent} compact />
        <div className="mt-2 line-clamp-1 text-[11px] text-zinc-500">
          {clip.hashtags.map((h) => `#${h}`).join(' ')}
        </div>

        <div className="mt-3.5 flex items-center gap-2">
          <button
            onClick={() => openEditor(clip.id)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
          >
            <Pencil size={13} /> Edit
          </button>
          <ExportButton
            status={entry?.status}
            progress={entry?.progress ?? 0}
            outputPath={entry?.outputPath}
            error={entry?.error}
            bytes={entry?.bytes}
            downscaled={entry?.downscaled}
            check={entry?.check}
            captionNotice={entry?.captionNotice}
            onExport={() => void exportClip(clip.id)}
            onCancel={() => void cancelExport(clip.id)}
          />
        </div>
      </div>
    </div>
  )
}

/** How long the pointer must rest on a card before its preview starts. */
const HOVER_PREVIEW_DELAY_MS = 180

/**
 * Plays what the clip selects from the source, muted, over its thumbnail
 * while the pointer rests on the card. It is the uncropped source, the same picture as
 * the thumbnail — enough to hear nothing and still tell which moment this is
 * without opening the editor. The element exists only while hovering, so an
 * idle grid holds no decoders.
 */
function HoverPreview({ src, ranges, onFailed }: {
  src: string
  /** What the clip plays, in order: one range, or the moments of a joined clip. */
  ranges: TimeRange[]
  onFailed: () => void
}): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const start = ranges[0]?.start ?? 0
  return (
    <video
      data-testid="clip-hover-preview"
      src={src}
      muted
      playsInline
      preload="auto"
      className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${ready ? 'opacity-100' : 'opacity-0'}`}
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = start
      }}
      onSeeked={(e) => {
        // Shown only once the frame at the clip start is decoded, so the
        // source's first frame never flashes over the thumbnail.
        setReady(true)
        void e.currentTarget.play().catch(() => undefined)
      }}
      onTimeUpdate={(e) => {
        // Past the end of a moment: on to the next one, or round to the first.
        const t = e.currentTarget.currentTime
        if (ranges.some((range) => t >= range.start && t < range.end)) return
        e.currentTarget.currentTime = ranges.find((range) => range.start > t)?.start ?? start
      }}
      onError={onFailed}
    />
  )
}

/**
 * What the check after export found: "Checked", "1 issue" or "Fixed 1",
 * with every finding in the tooltip. Absent for exports made before the
 * check existed.
 */
export function ExportCheckBadge({ check }: { check?: ExportCheckReport }): React.JSX.Element | null {
  const summary = exportCheckSummary(check)
  if (!summary) return null
  const tone = summary.issues
    ? 'bg-amber-500/15 text-amber-300'
    : summary.repaired
      ? 'bg-sky-500/15 text-sky-300'
      : check?.status === 'skipped'
        ? 'bg-surface-800 text-zinc-400'
        : 'bg-emerald-500/10 text-emerald-300/90'
  const Icon = summary.issues ? AlertTriangle : summary.repaired ? Wrench : ShieldCheck
  return (
    <span
      data-testid="export-check"
      title={summary.detail}
      className={`flex shrink-0 cursor-default items-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium ${tone}`}
    >
      <Icon size={12} /> {summary.label}
    </span>
  )
}

export function ExportButton({
  status,
  progress,
  outputPath,
  error,
  bytes,
  downscaled,
  check,
  captionNotice,
  onExport,
  onCancel
}: {
  status?: 'exporting' | 'done' | 'error'
  progress: number
  outputPath?: string
  error?: string
  bytes?: number
  downscaled?: boolean
  /** The check after the render, shown as a small badge with the details on hover. */
  check?: ExportCheckReport
  /** Set when an animated caption style had to be burned with its libass look. */
  captionNotice?: string
  onExport: () => void
  onCancel: () => void
}): React.JSX.Element {
  if (status === 'exporting') {
    return (
      <div className="relative flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-surface-800 px-3 py-2 text-xs font-medium text-zinc-300">
        <div
          className="absolute inset-y-0 left-0 bg-white/15 transition-all"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
        <Loader2 size={13} className="relative animate-spin" />
        <span className="relative tabular-nums">{Math.round(progress * 100)}%</span>
        <button
          onClick={onCancel}
          title="Cancel this export"
          className="relative rounded p-0.5 text-zinc-400 transition hover:bg-surface-600 hover:text-red-400"
        >
          <X size={13} />
        </button>
      </div>
    )
  }
  if (status === 'done' && outputPath) {
    const sizeLabel = bytes !== undefined ? ` · ${formatBytes(bytes)}` : ''
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <button
          onClick={() => void window.cutawan.showItemInFolder(outputPath)}
          className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/25"
          title={[
            downscaled ? `${outputPath} — scaled down to fit the size limit` : outputPath,
            captionNotice
          ].filter(Boolean).join('\n')}
        >
          <Check size={13} /> Saved{sizeLabel}
          <FolderOpen size={13} />
          {captionNotice && <AlertTriangle size={12} className="text-amber-400" aria-label={captionNotice} />}
        </button>
        <ExportCheckBadge check={check} />
      </div>
    )
  }
  if (status === 'error') {
    return (
      <button
        onClick={onExport}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-2 text-xs font-medium text-red-400 transition hover:bg-red-500/25"
        title={error}
      >
        <AlertTriangle size={13} /> Retry
      </button>
    )
  }
  return (
    <button
      onClick={onExport}
      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-white"
    >
      <Download size={13} /> Export
    </button>
  )
}
