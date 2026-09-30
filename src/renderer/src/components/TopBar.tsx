import { Settings, ChevronLeft, ArrowUpCircle, Plus } from 'lucide-react'
import appIcon from '../assets/icon.webp'
import { editorBackScreen, useStore } from '../store'

export default function TopBar(): React.JSX.Element {
  const screen = useStore((s) => s.screen)
  const project = useStore((s) => s.project)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const goHome = useStore((s) => s.goHome)
  const closeEditor = useStore((s) => s.closeEditor)
  const newProject = useStore((s) => s.newProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  const updateCheck = useStore((s) => s.updateCheck)
  const download = useStore((s) => s.updateDownload)

  const showBack = screen === 'clips' || screen === 'editor'
  // A full-video edit with no AI clips behind it goes back to the setup screen.
  const backLabel =
    screen === 'editor' && editorBackScreen(project, selectedClipId) === 'clips'
      ? 'All clips'
      : 'Home'
  // A non-destructive way back to the import screen from anywhere a project is
  // open (the old only route was deleting the current project).
  const showNewVideo = project !== null && screen !== 'processing'

  return (
    <header className="app-topbar flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-surface-950/70 px-4 backdrop-blur-xl">
      {showBack ? (
        <button
          onClick={() => (screen === 'editor' ? closeEditor() : goHome())}
          data-testid="back-button"
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-zinc-400 transition hover:bg-surface-800 hover:text-zinc-100"
        >
          <ChevronLeft size={16} />
          {backLabel}
        </button>
      ) : (
        <div className="flex items-center gap-2.5">
          <img
            src={appIcon}
            alt=""
            className="h-8 w-8 rounded-lg object-cover shadow-inner shadow-purple-500/20"
          />
          <span className="text-[15px] font-semibold tracking-tight">Cutawan</span>
          <span className="rounded-full border border-surface-600 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Open source
          </span>
        </div>
      )}

      {showBack && project && (
        <div className="min-w-0 flex-1 truncate text-center text-sm font-medium text-zinc-300">
          {project.name}
        </div>
      )}
      {!showBack && <div className="flex-1" />}

      <div className="flex items-center gap-2">
        {showNewVideo && (
          <button
            onClick={newProject}
            title="Start over with a different video — your current project stays saved in Recent projects"
            className="flex items-center gap-1.5 rounded-lg border border-surface-600 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-surface-800 hover:text-zinc-100"
          >
            <Plus size={14} />
            New video
          </button>
        )}
        {(updateCheck?.updateAvailable || download.status !== 'idle') && (
          <button
            onClick={() => setSettingsOpen(true, 'updates')}
            data-testid="update-notification"
            aria-live="polite"
            title="Open app updates"
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/25"
          >
            <ArrowUpCircle size={14} />
            {download.status === 'downloading' ? `Downloading update… ${Math.round(download.progress * 100)}%`
              : download.status === 'downloaded' ? (download.mode === 'manual' ? 'Installer ready' : 'Restart to update')
              : download.status === 'error' ? 'Update needs attention' : 'Update available'}
          </button>
        )}
        {settings && settings.subscription.provider === 'openrouter' && !settings.hasOpenRouterKey && (
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-400 transition hover:bg-amber-500/25"
          >
            {settings.subscription.localTranscription ? 'Add an OpenRouter key to find clips' : 'Add OpenRouter key to get started'}
          </button>
        )}
        {settings && settings.subscription.provider === 'api' && !settings.hasApiKey && (
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-400 transition hover:bg-amber-500/25"
          >
            {settings.subscription.localTranscription ? 'Add an API key to find clips' : 'Add OpenAI API key to get started'}
          </button>
        )}
        <button
          onClick={() => setSettingsOpen(true)}
          data-testid="settings-button"
          className="rounded-lg p-2 text-zinc-400 transition hover:bg-surface-800 hover:text-zinc-100"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  )
}
