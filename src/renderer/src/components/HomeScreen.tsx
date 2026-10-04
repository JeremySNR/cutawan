import { useState } from 'react'
import {
  Upload,
  Captions,
  Crop,
  Film,
  ImagePlus,
  Link2,
  Loader2,
  PackageOpen,
  ScanFace,
  Sparkles,
  Trash2,
  AlertTriangle,
  Wand2,
  Clock,
  Zap,
  ZoomIn
} from 'lucide-react'
import { useStore } from '../store'
import { formatDuration, formatBytes } from '../lib/format'
import MissingSourceBanner from './MissingSourceBanner'
import DiscoverySummary from './DiscoverySummary'
import { EditorialRankingSummary } from './EditorialSummary'
import { SOURCE_DISCOVERY_BUDGET } from '@shared/sourceAnalysis'
import { EDITORIAL_BUDGET, editorialReportMatchesClips } from '@shared/editorialRanking'
import type {
  AspectRatio,
  BrowserCookieSource,
  ClipLengthPreference,
  ProjectMode,
  VideoType
} from '@shared/types'
import { findWholeVideoClip, highlightClips } from '@shared/wholeVideo'
import { VIDEO_TYPE_OPTIONS } from '@shared/videoType'
import { isChromiumBrowser } from '@shared/cookies'
import { isVideoFile } from '@shared/video'

const COOKIE_BROWSERS: Array<{ value: BrowserCookieSource; label: string }> = [
  { value: '', label: 'No login' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'brave', label: 'Brave' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' },
  ...(navigator.platform.toLowerCase().includes('mac')
    ? [{ value: 'safari' as BrowserCookieSource, label: 'Safari' }]
    : [])
]

const LENGTH_OPTIONS: Array<{ value: ClipLengthPreference; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'AI decides' },
  { value: 'short', label: 'Short', hint: '15–30s' },
  { value: 'medium', label: 'Medium', hint: '30–60s' },
  { value: 'long', label: 'Long', hint: '60–90s' }
]

export default function HomeScreen(): React.JSX.Element {
  const project = useStore((s) => s.project)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-10">
        {project ? <SetupPanel /> : <ImportHero />}
        <RecentProjects />
      </div>
    </div>
  )
}

function ImportHero(): React.JSX.Element {
  const importVideo = useStore((s) => s.importVideo)
  const importVideoFromPath = useStore((s) => s.importVideoFromPath)
  const importVideoFromUrl = useStore((s) => s.importVideoFromUrl)
  const importPackage = useStore((s) => s.importPackage)
  const importPackageFromPath = useStore((s) => s.importPackageFromPath)
  const importProgress = useStore((s) => s.importProgress)
  const setPipelineError = (msg: string | null): void => useStore.setState({ pipelineError: msg })
  const pipelineError = useStore((s) => s.pipelineError)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [url, setUrl] = useState('')

  const importing = importProgress !== null
  const disabled = busy || importing
  const canSubmitUrl = /^https?:\/\/\S+$/.test(url.trim()) && !disabled

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    if (disabled) return
    const file = e.dataTransfer.files[0]
    if (!file) return
    // A Metachlorian package arrives as its .zip or its manifest.json.
    if (/\.zip$/i.test(file.name) || file.name === 'manifest.json') {
      const path = window.cutawan.pathForFile(file)
      if (path) void importPackageFromPath(path)
      return
    }
    if (!isVideoFile(file.name)) {
      setPipelineError(`"${file.name}" is not a supported video file (MP4, MOV, MKV, WEBM and more).`)
      return
    }
    const path = window.cutawan.pathForFile(file)
    if (!path) {
      setPipelineError('Could not read that file from disk. Try choosing it instead.')
      return
    }
    setBusy(true)
    void importVideoFromPath(path).finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-col items-center pb-4 pt-8 text-center">
      <h1 className="max-w-2xl text-4xl font-bold leading-tight tracking-tight">
        Turn long videos into{' '}
        <span className="bg-gradient-to-b from-white to-zinc-500 bg-clip-text text-transparent">
          compelling clips
        </span>
      </h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-zinc-400">
        Drop in a podcast, webinar or stream. Cutawan transcribes it, finds the best moments
        with AI, ranks them for editorial quality and renders caption-burned vertical clips.
      </p>

      {pipelineError && (
        <div className="mt-6 flex w-full max-w-xl items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left text-sm text-red-300">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-line">{pipelineError}</span>
        </div>
      )}

      <button
        onClick={async () => {
          setBusy(true)
          try {
            await importVideo()
          } finally {
            setBusy(false)
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        disabled={disabled}
        className={`mt-8 flex w-full max-w-xl cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed bg-white/[0.02] px-8 py-12 backdrop-blur transition disabled:opacity-60 ${
          dragOver
            ? 'border-white/40 bg-white/[0.06]'
            : 'border-surface-600 hover:border-white/25 hover:bg-white/[0.04]'
        }`}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/[0.05]">
          <Upload size={24} className="text-zinc-200" />
        </div>
        <div className="text-[15px] font-semibold">
          {busy
            ? 'Reading video…'
            : dragOver
              ? 'Drop the video to start'
              : 'Drag a video here, or click to choose'}
        </div>
        <div className="text-xs text-zinc-500">MP4, MOV, MKV, WEBM and more</div>
      </button>

      <div className="mt-4 w-full max-w-xl">
        {importing ? (
          <div className="rounded-2xl border border-surface-700 bg-surface-900 px-4 py-3.5">
            <div className="flex items-center gap-2.5 text-sm text-zinc-300">
              <Loader2 size={15} className="animate-spin text-zinc-300" />
              {importProgress.message}
            </div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-700">
              <div
                className={`h-full rounded-full bg-zinc-200 transition-all ${
                  importProgress.progress < 0 ? 'w-1/4 animate-pulse' : ''
                }`}
                style={
                  importProgress.progress >= 0
                    ? { width: `${Math.round(importProgress.progress * 100)}%` }
                    : undefined
                }
              />
            </div>
          </div>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (canSubmitUrl) void importVideoFromUrl(url)
              }}
              className="flex items-center gap-2 rounded-2xl border border-surface-700 bg-surface-900 py-2 pl-4 pr-2 focus-within:border-white/25"
            >
              <Link2 size={16} className="shrink-0 text-zinc-500" />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="…or paste a YouTube / Vimeo / TikTok / Twitch URL"
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!canSubmitUrl}
                className="shrink-0 rounded-xl bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-40"
              >
                Import
              </button>
            </form>
            <CookieBrowserPicker />
            <button
              type="button"
              data-testid="import-package-button"
              onClick={() => void importPackage()}
              disabled={disabled}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-surface-700 bg-surface-900 px-4 py-2.5 text-xs font-semibold text-zinc-300 transition hover:border-white/25 hover:bg-surface-800 disabled:opacity-40"
            >
              <PackageOpen size={15} className="text-zinc-500" />
              Import Metachlorian package…
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Private / SSO-protected videos (e.g. enterprise Vimeo): borrow the login from
 * a local browser, or import a cookies.txt export when Chromium locks its DB.
 */
function CookieBrowserPicker(): React.JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const importCookiesFile = useStore((s) => s.importCookiesFile)
  const clearCookiesFile = useStore((s) => s.clearCookiesFile)
  if (!settings) return null

  return (
    <div className="mt-2 space-y-2 px-1 text-left">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] leading-relaxed text-zinc-500">
          Video needs a login (private or company SSO, e.g. enterprise Vimeo)? Sign in to the site
          in your browser, then borrow that login:
        </span>
        <select
          value={settings.importCookiesBrowser}
          onChange={(e) =>
            void saveSettings({ importCookiesBrowser: e.target.value as BrowserCookieSource })
          }
          className="shrink-0 rounded-lg border border-surface-600 bg-surface-850 px-2.5 py-1.5 text-xs text-zinc-300 focus:border-white/25 focus:outline-none"
        >
          {COOKIE_BROWSERS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        {window.cutawan.platform === 'win32' &&
          isChromiumBrowser(settings.importCookiesBrowser) &&
          !settings.hasImportCookiesFile && (
            <p className="w-full rounded-lg bg-amber-500/10 px-2.5 py-2 text-amber-300">
              On Windows, Chrome and Edge cookies cannot be read by other apps. Use{' '}
              <strong>Import cookies file</strong> below (Get cookies.txt LOCALLY extension), or pick
              Firefox in the list.
            </p>
          )}
        <span>Chromium browsers lock cookies while open. If that fails, import a cookies file instead:</span>
        {settings.hasImportCookiesFile ? (
          <>
            <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-emerald-300">cookies.txt loaded</span>
            <button
              type="button"
              onClick={() => void clearCookiesFile()}
              className="rounded-md border border-surface-600 px-2 py-0.5 text-zinc-300 transition hover:bg-surface-800"
            >
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void importCookiesFile()}
            className="rounded-md border border-surface-600 px-2 py-0.5 text-zinc-300 transition hover:bg-surface-800"
          >
            Import cookies file
          </button>
        )}
      </div>
    </div>
  )
}

function SetupPanel(): React.JSX.Element {
  const project = useStore((s) => s.project)!
  const analyze = useStore((s) => s.analyze)
  const captionWholeVideo = useStore((s) => s.captionWholeVideo)
  const goHomeClear = useStore((s) => s.deleteProject)
  const openProject = useStore((s) => s.openProject)
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const pipelineError = useStore((s) => s.pipelineError)
  const [mode, setMode] = useState<ProjectMode>(project.mode ?? 'clips')
  const [captionAspect, setCaptionAspect] = useState<AspectRatio>('9:16')
  // Both off by default: speaker tracking costs minutes of local CPU, and auto
  // zoom is a taste call rather than something to apply to a whole video unasked.
  const [followSpeaker, setFollowSpeaker] = useState(false)
  const [captionZoom, setCaptionZoom] = useState(false)
  const [prompt, setPrompt] = useState(project.prompt)
  const [clipLength, setClipLength] = useState<ClipLengthPreference>('auto')
  const [videoType, setVideoType] = useState<VideoType>(project.videoType ?? 'auto')
  // Off by default: B-roll costs extra LLM/image calls and splits opinion.
  const [broll, setBroll] = useState(false)
  // Off by default: hook-first trimming rewrites clip starts with an extra LLM pass.
  const [hookFirst, setHookFirst] = useState(false)
  const [visualDiscovery, setVisualDiscovery] = useState(project.visualDiscovery ?? false)
  const [editorialRanking, setEditorialRanking] = useState(project.rankingEnabled ?? false)

  // Captioning an already-transcribed video makes no API calls, so it does not
  // need a key; clip finding always does.
  const needsKey =
    settings !== null &&
    settings.subscription.provider !== 'chatgpt' &&
    !(settings.subscription.provider === 'openrouter' ? settings.hasOpenRouterKey : settings.hasApiKey) &&
    !(mode === 'whole-video' && (project.transcript !== null || settings.subscription.localTranscription))
  const highlights = highlightClips(project)

  return (
    <div className="pb-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {mode === 'clips' ? 'Set up your clips' : 'Caption your video'}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {mode === 'clips'
              ? 'Tell the AI what to look for, then generate clips.'
              : 'No clip finding — the whole video, cropped vertical and captioned.'}
          </p>
        </div>
        {mode === 'clips' && highlights.length > 0 && (
          <button
            onClick={() => void openProject(project.id)}
            className="shrink-0 rounded-lg border border-surface-600 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-surface-800"
          >
            View current {highlights.length} clips →
          </button>
        )}
      </div>

      <MissingSourceBanner />

      <div className="mt-6 grid grid-cols-5 gap-6">
        <div className="col-span-2 rounded-2xl border border-surface-700 bg-surface-900 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-800">
              <Film size={18} className="text-accent-400" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{project.video.fileName}</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {formatDuration(project.video.durationSec)} · {project.video.width}×
                {project.video.height} · {formatBytes(project.video.sizeBytes)}
              </div>
            </div>
          </div>
          <video
            src={window.cutawan.mediaUrl(project.video.path)}
            className="mt-4 aspect-video w-full rounded-xl bg-black object-contain"
            controls
            preload="metadata"
          />
          <button
            onClick={() => {
              if (
                window.confirm(
                  `Delete "${project.name}"? This permanently removes the project and its ${project.clips.length} clip${project.clips.length === 1 ? '' : 's'}, and can't be undone.\n\nTo work on a different video without losing this one, use "New video" instead.`
                )
              ) {
                void goHomeClear(project.id)
              }
            }}
            className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-red-400"
          >
            <Trash2 size={13} /> Delete this project
          </button>
        </div>

        <div className="col-span-3 flex flex-col gap-5">
          <ModeSwitcher mode={mode} onChange={setMode} />

          {mode === 'clips' ? (
            <>
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <label className="flex items-start gap-3 text-sm font-semibold">
                <input type="checkbox" checked={editorialRanking} onChange={e => setEditorialRanking(e.target.checked)}
                  className="mt-1" data-testid="editorial-ranking-toggle" />
                <span>Review and rank complete stories <span className="font-normal text-zinc-400">(beta)</span>
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-zinc-400">
                    Check context, payoff and repeated ideas using source text and sampled frames.
                    Up to {EDITORIAL_BUDGET.maxReviewCalls + EDITORIAL_BUDGET.maxDiversityCalls} extra analysis calls plus provider retries.
                    {' '}Scores are model judgements; watch the clips before exporting.
                  </span>
                </span>
              </label>
              <EditorialRankingSummary report={project.editorialRanking} earlierAttempt={!!project.editorialRanking && !editorialReportMatchesClips(project)} />
            </div>
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <label className="flex items-start gap-3 text-sm font-semibold">
                <input type="checkbox" checked={visualDiscovery} onChange={e => setVisualDiscovery(e.target.checked)}
                  className="mt-1" data-testid="visual-discovery-toggle" />
                <span>Find visual moments <span className="font-normal text-zinc-400">(beta)</span>
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-zinc-400">
                    Look for demonstrations, reveals and reactions, including footage without speech.
                    Samples frames across the video through your configured AI connection, with up to {SOURCE_DISCOVERY_BUDGET.maxAnalysisRequests} extra
                    {' '}analysis calls plus any provider retries. Brief events between samples may be missed.
                    {' '}Reviewing and framing the resulting clips uses additional calls.
                  </span>
                </span>
              </label>
              <DiscoverySummary report={project.discoveryReport} earlierAttempt={!!project.discoveryReport?.generationId && project.discoveryReport.generationId !== project.clipsGenerationId} />
            </div>
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <Wand2 size={15} className="text-accent-400" />
                AI instructions <span className="font-normal text-zinc-500">(optional)</span>
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={'e.g. "Focus on the moments about pricing strategy" or "Find the funniest exchanges between the hosts"'}
                rows={3}
                className="mt-3 w-full resize-none rounded-xl border border-surface-600 bg-surface-850 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none"
              />
            </div>
  
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <button
                onClick={() => setBroll(!broll)}
                className="flex w-full items-center justify-between gap-4 text-left"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <ImagePlus size={15} className="text-accent-400" />
                    AI B-roll images
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-zinc-500">
                    When you mention a character, person or place ("Yoda"), a matching image pops
                    over the video at that exact word. Every insert is editable per clip.
                  </span>
                </span>
                <span
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${broll ? 'bg-zinc-100' : 'bg-surface-600'}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${broll ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`}
                  />
                </span>
              </button>
            </div>
  
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <button
                onClick={() => setHookFirst(!hookFirst)}
                className="flex w-full items-center justify-between gap-4 text-left"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Zap size={15} className="text-accent-400" />
                    Open on the hook
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-zinc-500">
                    Finds each clip&apos;s hook line and trims the start so the video opens on that
                    moment instead of throat-clearing. You can still turn on the hook title card per
                    clip in the editor.
                  </span>
                </span>
                <span
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${hookFirst ? 'bg-zinc-100' : 'bg-surface-600'}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${hookFirst ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`}
                  />
                </span>
              </button>
            </div>
  
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <Film size={15} className="text-accent-400" />
                What kind of video is this?
              </label>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Helps Cutawan pick the right 9:16 layout — crop and zoom for talking heads,
                letterbox for screen recordings.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {VIDEO_TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setVideoType(opt.value)}
                    className={`rounded-xl border px-3 py-2.5 text-left transition ${
                      videoType === opt.value
                        ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                        : 'border-surface-600 bg-surface-850 text-zinc-400 hover:border-surface-600 hover:bg-surface-800'
                    }`}
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{opt.hint}</div>
                  </button>
                ))}
              </div>
            </div>
  
            <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <Clock size={15} className="text-accent-400" />
                Preferred clip length
              </label>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {LENGTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setClipLength(opt.value)}
                    className={`rounded-xl border px-3 py-2.5 text-center transition ${
                      clipLength === opt.value
                        ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                        : 'border-surface-600 bg-surface-850 text-zinc-400 hover:border-surface-600 hover:bg-surface-800'
                    }`}
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">{opt.hint}</div>
                  </button>
                ))}
              </div>
            </div>
            </>
          ) : (
            <CaptionVideoOptions
              aspect={captionAspect}
              onAspect={setCaptionAspect}
              followSpeaker={followSpeaker}
              onFollowSpeaker={setFollowSpeaker}
              autoZoom={captionZoom}
              onAutoZoom={setCaptionZoom}
              durationSec={project.video.durationSec}
            />
          )}

          {pipelineError && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <AlertTriangle size={17} className="mt-0.5 shrink-0" />
              <span>{pipelineError}</span>
            </div>
          )}

          {needsKey ? (
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center justify-center gap-2 rounded-xl bg-amber-500/15 px-5 py-3.5 text-sm font-semibold text-amber-400 transition hover:bg-amber-500/25"
            >
              {settings?.subscription.provider === 'openrouter' ? 'Add your OpenRouter key first' : 'Add your OpenAI API key first'}
            </button>
          ) : (
            <div>
              <button
                data-testid="start-button"
                onClick={() =>
                  mode === 'clips'
                    ? void analyze({ prompt, clipLength, broll, hookFirst, videoType, visualDiscovery, editorialRanking })
                    : void captionWholeVideo({
                        aspect: captionAspect,
                        followSpeaker,
                        autoZoom: captionZoom
                      })
                }
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-5 py-3.5 text-sm font-semibold text-zinc-900 shadow-lg shadow-black/40 transition hover:bg-white"
              >
                {mode === 'clips' ? (
                  <>
                    <Sparkles size={17} />
                    {highlights.length > 0 ? 'Regenerate clips' : 'Get clips'}
                  </>
                ) : (
                  <>
                    <Captions size={17} />
                    {findWholeVideoClip(project)
                      ? 'Redo the captioned video'
                      : 'Transcribe and caption'}
                  </>
                )}
              </button>
              {project.transcript && (
                <p className="mt-2 text-center text-[11px] text-zinc-500">
                  Transcript already saved — this skips transcription. Clip analysis may still take time.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Pick between AI clip finding and captioning the whole video. */
function ModeSwitcher({
  mode,
  onChange
}: {
  mode: ProjectMode
  onChange: (mode: ProjectMode) => void
}): React.JSX.Element {
  const options: Array<{ value: ProjectMode; label: string; hint: string; icon: React.ElementType }> = [
    {
      value: 'clips',
      label: 'Find clips',
      hint: 'AI cuts the best moments out',
      icon: Sparkles
    },
    {
      value: 'whole-video',
      label: 'Caption whole video',
      hint: 'Vertical crop and captions, end to end',
      icon: Captions
    }
  ]
  return (
    <div className="grid grid-cols-2 gap-2 rounded-2xl border border-surface-700 bg-surface-900 p-2">
      {options.map((opt) => {
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={`mode-${opt.value}`}
            onClick={() => onChange(opt.value)}
            className={`rounded-xl border px-3.5 py-3 text-left transition ${
              mode === opt.value
                ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                : 'border-transparent text-zinc-400 hover:bg-surface-850'
            }`}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Icon size={15} className="text-accent-400" />
              {opt.label}
            </span>
            <span className="mt-1 block text-[11px] leading-snug text-zinc-500">{opt.hint}</span>
          </button>
        )
      })}
    </div>
  )
}

/** One toggle in its own card, matching the AI option cards above. */
function ToggleCard({
  icon: Icon,
  title,
  children,
  checked,
  onChange
}: {
  icon: React.ElementType
  title: string
  children: React.ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
      <button
        onClick={() => onChange(!checked)}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Icon size={15} className="text-accent-400" />
            {title}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-zinc-500">{children}</span>
        </span>
        <span
          className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-zinc-100' : 'bg-surface-600'}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${checked ? 'left-[18px] bg-zinc-900' : 'left-0.5 bg-white'}`}
          />
        </span>
      </button>
    </div>
  )
}

const CAPTION_ASPECTS: Array<{ value: AspectRatio; label: string; hint: string }> = [
  { value: '9:16', label: '9:16', hint: 'TikTok, Reels, Shorts' },
  { value: '1:1', label: '1:1', hint: 'Square feed posts' },
  { value: 'original', label: 'Original', hint: 'Keep the source shape' }
]

/**
 * Options for "caption whole video". Deliberately short: everything else —
 * caption style, font, trim, letterbox instead of crop — is a live change in
 * the editor afterwards, so it does not need deciding up front.
 */
function CaptionVideoOptions({
  aspect,
  onAspect,
  followSpeaker,
  onFollowSpeaker,
  autoZoom,
  onAutoZoom,
  durationSec
}: {
  aspect: AspectRatio
  onAspect: (aspect: AspectRatio) => void
  followSpeaker: boolean
  onFollowSpeaker: (on: boolean) => void
  autoZoom: boolean
  onAutoZoom: (on: boolean) => void
  durationSec: number
}): React.JSX.Element {
  // Tracking samples at 25 fps, so the wait scales with the video: a rough
  // minute-per-two-minutes-of-footage is closer to honest than "a moment".
  const trackingMinutes = Math.max(1, Math.round(durationSec / 120))

  return (
    <>
      <div className="rounded-2xl border border-surface-700 bg-surface-900 p-5">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <Crop size={15} className="text-accent-400" />
          Output shape
        </label>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          A 16:9 source is cropped to fit. You can switch to letterbox fit, or nudge the crop, in
          the editor.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {CAPTION_ASPECTS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onAspect(opt.value)}
              className={`rounded-xl border px-3 py-2.5 text-center transition ${
                aspect === opt.value
                  ? 'border-white/30 bg-white/[0.07] text-zinc-100'
                  : 'border-surface-600 bg-surface-850 text-zinc-400 hover:bg-surface-800'
              }`}
            >
              <div className="text-sm font-medium">{opt.label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{opt.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <ToggleCard
        icon={ScanFace}
        title="Follow the speaker"
        checked={followSpeaker}
        onChange={onFollowSpeaker}
      >
        Tracks who is actually talking and keeps the crop on them, cutting between speakers like a
        camera switch. Runs on your machine, and it is slow: roughly {trackingMinutes} minute
        {trackingMinutes === 1 ? '' : 's'} for this video. Leave it off for a fixed crop you set
        with the focus slider.
      </ToggleCard>

      <ToggleCard icon={ZoomIn} title="Auto zoom" checked={autoZoom} onChange={onAutoZoom}>
        Punch-ins on the most energetic lines and a slow creep over static stretches, so the frame
        never sits still. Off by default; you can toggle it in the editor and see it in the
        preview.
      </ToggleCard>
    </>
  )
}

function RecentProjects(): React.JSX.Element | null {
  const projects = useStore((s) => s.projects)
  const project = useStore((s) => s.project)
  const openProject = useStore((s) => s.openProject)
  const deleteProject = useStore((s) => s.deleteProject)

  const others = projects.filter((p) => p.id !== project?.id)
  if (others.length === 0) return null

  return (
    <div className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Recent projects
      </h2>
      <div className="mt-4 grid grid-cols-3 gap-4">
        {others.map((p) => (
          <div
            key={p.id}
            data-testid="project-card"
            className="group cursor-pointer overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 transition hover:border-surface-600 hover:bg-surface-850"
            onClick={() => void openProject(p.id)}
          >
            <div className="flex aspect-video items-center justify-center bg-black">
              {p.thumbnailPath ? (
                <img
                  src={window.cutawan.mediaUrl(p.thumbnailPath)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <Film size={28} className="text-zinc-700" />
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {formatDuration(p.durationSec)} ·{' '}
                  {p.mode === 'whole-video'
                    ? 'captioned video'
                    : `${p.clipCount} clip${p.clipCount === 1 ? '' : 's'}`}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (
                    window.confirm(
                      p.mode === 'whole-video'
                        ? `Delete "${p.name}"? This permanently removes the project and its captioned video, and can't be undone.`
                        : `Delete "${p.name}"? This permanently removes the project and its ${p.clipCount} clip${p.clipCount === 1 ? '' : 's'}, and can't be undone.`
                    )
                  ) {
                    void deleteProject(p.id)
                  }
                }}
                className="rounded-lg p-1.5 text-zinc-600 opacity-0 transition hover:bg-surface-700 hover:text-red-400 group-hover:opacity-100"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
