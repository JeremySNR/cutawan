import { useMemo, useState } from 'react'
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
  Sparkles,
  X
} from 'lucide-react'
import { useStore } from '../store'
import { formatBytes, formatDuration } from '../lib/format'
import { EditorialExplanation, EditorialRankingSummary, EditorialScore } from './EditorialSummary'
import MissingSourceBanner from './MissingSourceBanner'
import HandoffBanner from './HandoffBanner'
import DiscoverySummary from './DiscoverySummary'
import type { Clip } from '@shared/types'
import { findWholeVideoClip, highlightClips } from '@shared/wholeVideo'
import { editedClipDuration } from '@shared/tighten'
import { layoutReviewMessage } from '@shared/contentType'
import { editorialAssessmentCurrent, editorialReportMatchesClips } from '@shared/editorialRanking'

export default function ClipsScreen(): React.JSX.Element {
  const project = useStore((s) => s.project)
  const exportAll = useStore((s) => s.exportAll)
  const exports = useStore((s) => s.exports)
  const exportDir = useStore((s) => s.exportDir)
  const chooseExportDir = useStore((s) => s.chooseExportDir)
  const goHome = useStore((s) => s.goHome)
  const [exportingAll, setExportingAll] = useState(false)

  if (!project) return <div />

  // The full-video edit is not one of the found clips: it gets its own banner
  // and is exported from its editor, never swept into "Export all".
  const clips = highlightClips(project)
  const wholeVideo = findWholeVideoClip(project)
  const currentRanking = editorialReportMatchesClips(project)
  const earlierRanking = !!project.editorialRanking && !currentRanking
  const doneCount = clips.filter((c) => exports[c.id]?.status === 'done').length

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
        <HandoffBanner className="mt-5" />
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
  const duration = useMemo(() => editedClipDuration(clip, transcript), [clip, transcript])
  const assessmentCurrent = useMemo(() => editorialAssessmentCurrent(clip, transcript), [clip, transcript])

  return (
    <div className="group overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 transition hover:border-surface-600">
      <div
        data-testid="clip-thumb"
        className="relative aspect-video cursor-pointer bg-black"
        onClick={() => openEditor(clip.id)}
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
        <div className="absolute left-2.5 top-2.5 flex items-center gap-2">
          <span className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-zinc-300 backdrop-blur">
            #{rank}
          </span>
          <EditorialScore clip={clip} current={assessmentCurrent} />
        </div>
        {framing && (
          <span className="absolute bottom-2.5 left-2.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-zinc-300 backdrop-blur">
            <Loader2 size={11} className="animate-spin" />
            Framing…
          </span>
        )}
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
            onExport={() => void exportClip(clip.id)}
            onCancel={() => void cancelExport(clip.id)}
          />
        </div>
      </div>
    </div>
  )
}

export function ExportButton({
  status,
  progress,
  outputPath,
  error,
  bytes,
  downscaled,
  onExport,
  onCancel
}: {
  status?: 'exporting' | 'done' | 'error'
  progress: number
  outputPath?: string
  error?: string
  bytes?: number
  downscaled?: boolean
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
      <button
        onClick={() => void window.cutawan.showItemInFolder(outputPath)}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/25"
        title={
          downscaled
            ? `${outputPath} — scaled down to fit the size limit`
            : outputPath
        }
      >
        <Check size={13} /> Saved{sizeLabel}
        <FolderOpen size={13} />
      </button>
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
