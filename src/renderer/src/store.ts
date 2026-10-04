import { create } from 'zustand'
import type {
  AnalyzeOptions,
  AppSettings,
  CaptionVideoOptions,
  Clip,
  CustomFont,
  HandoffEvent,
  ImportProgress,
  PipelineProgress,
  Project,
  ProjectMode,
  ProjectSummary,
  SettingsUpdate,
  UpdateCheckResult,
  UpdateDownloadState
} from '@shared/types'

import { findWholeVideoClip, highlightClips, isWholeVideoClip } from '@shared/wholeVideo'
import { mergeReframeResult, needsReframe } from '@shared/reframe'
import { clearHistory, noteExternal, recordSave, redo as redoEdit, trackClip, undo as undoEdit } from '@shared/editHistory'

/** Font faces already registered with document.fonts (FontFace API). */
const loadedFontFaces = new Map<string, FontFace>()
/** Saved trim changes that arrived while a reframe request was in flight. */
const queuedReframes = new Set<string>()

/** Analysis and caption results are not user edits: keep them out of undo steps. */
function absorbExternal(clipId: string): void {
  const clip = useStore.getState().project?.clips.find((c) => c.id === clipId)
  if (clip) noteExternal(clip)
}

/** Apply an undo/redo step and save it without recording a new step. */
async function stepHistory(clipId: string, step: (clip: Clip) => Clip | null): Promise<void> {
  const { project } = useStore.getState()
  const clip = project?.clips.find((c) => c.id === clipId)
  const next = clip && step(clip)
  if (!project || !next) return
  useStore.getState().updateClipLocal(next)
  useStore.setState({ historyVersion: useStore.getState().historyVersion + 1 })
  await window.cutawan.updateClip(project.id, next)
  if (useStore.getState().selectedClipId === clipId) await useStore.getState().ensureReframe(clipId)
}

/** Register custom fonts with the renderer so previews match exports. */
async function registerFonts(fonts: CustomFont[]): Promise<void> {
  for (const f of fonts) {
    if (loadedFontFaces.has(f.family)) continue
    try {
      const face = new FontFace(f.family, `url("${window.cutawan.mediaUrl(f.path)}")`)
      await face.load()
      document.fonts.add(face)
      loadedFontFaces.set(f.family, face)
    } catch {
      /* unloadable font: preview falls back to sans-serif */
    }
  }
}

function unregisterFontFamily(family: string): void {
  const face = loadedFontFaces.get(family)
  if (!face) return
  document.fonts.delete(face)
  loadedFontFaces.delete(family)
}

/** Command-line imports whose outcome has arrived; later progress for them is stale. */
const settledImports = new Set<number>()

/**
 * An agent ran `cutawan --import-package`: show the import on the home
 * screen, then open the project it made (or say why it failed).
 */
function handleHandoffEvent(event: HandoffEvent): void {
  if (settledImports.has(event.importId)) return
  const store = useStore
  if (event.state === 'importing') {
    const first = store.getState().importProgress === null
    store.setState({
      importProgress: { progress: event.progress, message: event.message },
      // The home screen is where import progress shows; jump there once.
      ...(first ? { project: null, screen: 'home' as const, selectedClipId: null, pipelineError: null } : {})
    })
    return
  }
  settledImports.add(event.importId)
  store.setState({ importProgress: null })
  if (event.state === 'failed') {
    store.setState({ project: null, screen: 'home', selectedClipId: null, pipelineError: cleanIpcError(event.message) })
    return
  }
  void store.getState().refreshProjects()
  void store.getState().openProject(event.projectId).catch((err: unknown) => {
    store.setState({ pipelineError: err instanceof Error ? cleanIpcError(err.message) : String(err) })
  })
}

export type Screen = 'home' | 'processing' | 'clips' | 'editor'

/**
 * Where the editor's back button lands. A full-video edit has no clip grid
 * behind it unless the project also has AI-found clips.
 */
export function editorBackScreen(project: Project | null, clipId: string | null): Screen {
  const clip = project?.clips.find((c) => c.id === clipId) ?? null
  if (project && clip && isWholeVideoClip(clip) && highlightClips(project).length === 0) {
    return 'home'
  }
  return 'clips'
}

export interface ExportEntry {
  status: 'exporting' | 'done' | 'error'
  progress: number
  outputPath?: string
  error?: string
  bytes?: number
  sizeTargetBytes?: number
  downscaled?: boolean
  overBudget?: boolean
}


interface AppState {
  screen: Screen
  project: Project | null
  projects: ProjectSummary[]
  settings: AppSettings | null
  settingsOpen: boolean
  settingsInitialSection: 'general' | 'updates'
  pipelineProgress: PipelineProgress | null
  pipelineError: string | null
  /** Which flow the processing screen is showing, so it lists the right stages. */
  pipelineMode: ProjectMode
  /** Whether the running whole-video job was asked to track the speaker. */
  pipelineFollowSpeaker: boolean
  importProgress: ImportProgress | null
  selectedClipId: string | null
  exports: Record<string, ExportEntry>
  exportDir: string | null
  customFonts: CustomFont[]
  updateCheck: UpdateCheckResult | null
  checkingForUpdates: boolean
  updateDownload: UpdateDownloadState
  sourceUpdate: { status: 'idle' | 'running' | 'error'; message: string; error?: string }

  init: () => Promise<void>
  refreshProjects: () => Promise<void>
  importVideo: () => Promise<void>
  importVideoFromPath: (path: string) => Promise<void>
  importVideoFromUrl: (url: string) => Promise<void>
  /** Pick a Metachlorian package (folder, manifest.json or .zip) and open it as a project. */
  importPackage: () => Promise<void>
  importPackageFromPath: (path: string) => Promise<void>
  openProject: (id: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  relinkVideo: () => Promise<void>
  goHome: () => void
  newProject: () => void
  setSettingsOpen: (open: boolean, section?: 'general' | 'updates') => void
  saveSettings: (update: SettingsUpdate) => Promise<void>
  refreshSettings: () => Promise<void>
  analyze: (options: AnalyzeOptions) => Promise<void>
  captionWholeVideo: (options: CaptionVideoOptions) => Promise<void>
  cancelAnalyze: () => Promise<void>
  openEditor: (clipId: string) => void
  closeEditor: () => void
  updateClip: (clip: Clip) => Promise<void>
  /** Step the clip's own edits back or forward (see lib/editHistory.ts). */
  undo: (clipId: string) => Promise<void>
  redo: (clipId: string) => Promise<void>
  /** Bumped on every undo-history change so undo/redo buttons re-render. */
  historyVersion: number
  updateClipLocal: (clip: Clip) => void
  generateCaption: (clipId: string) => Promise<void>
  captionBusy: Record<string, boolean>
  /**
   * Run the deferred reframe analysis for a clip the pipeline left pending.
   * A clip whose last attempt failed is skipped until `retry` is passed, so
   * a broken clip does not loop; the editor offers the retry.
   */
  ensureReframe: (clipId: string, retry?: boolean) => Promise<void>
  reframeBusy: Record<string, boolean>
  reframeError: Record<string, string>
  /** Clips whose layout is being analysed in the background after the pipeline. */
  backgroundReframing: Record<string, boolean>
  updateTranscriptWord: (segmentId: number, wordIndex: number, text: string) => Promise<void>
  exportClip: (clipId: string) => Promise<void>
  cancelExport: (clipId: string) => Promise<void>
  exportAll: () => Promise<void>
  chooseExportDir: () => Promise<void>
  clearExport: (clipId: string) => void
  addFonts: () => Promise<void>
  removeFont: (fileName: string) => Promise<void>
  importCookiesFile: () => Promise<void>
  clearCookiesFile: () => Promise<void>
  selectBrandingLogo: () => Promise<void>
  checkForUpdates: (silent?: boolean) => Promise<boolean>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  openUpdateInstaller: () => Promise<void>
  cancelUpdateDownload: () => Promise<void>
  updateFromSource: () => Promise<void>
}

export const useStore = create<AppState>((set, get) => ({
  screen: 'home',
  project: null,
  projects: [],
  settings: null,
  settingsOpen: false,
  settingsInitialSection: 'general',
  pipelineProgress: null,
  pipelineError: null,
  pipelineMode: 'clips',
  pipelineFollowSpeaker: false,
  importProgress: null,
  selectedClipId: null,
  exports: {},
  exportDir: null,
  customFonts: [],
  updateCheck: null,
  checkingForUpdates: false,
  updateDownload: { status: 'idle', progress: 0 },
  sourceUpdate: { status: 'idle', message: '' },
  captionBusy: {},
  reframeBusy: {},
  reframeError: {},
  backgroundReframing: {},
  historyVersion: 0,

  init: async () => {
    // Before any await: an import launched from the command line reports here,
    // and the queue drained below holds whatever finished before we listened.
    window.cutawan.onHandoffEvent(handleHandoffEvent)
    const [settings, projects, customFonts] = await Promise.all([
      window.cutawan.getSettings(),
      window.cutawan.listProjects(),
      window.cutawan.listFonts()
    ])
    set({ settings, projects, customFonts })
    void registerFonts(customFonts)
    for (const event of await window.cutawan.drainHandoffEvents()) handleHandoffEvent(event)
    window.cutawan.onPipelineProgress((p) => set({ pipelineProgress: p }))
    window.cutawan.onImportProgress((p) => {
      if (get().importProgress !== null) set({ importProgress: p })
    })
    window.cutawan.onBackgroundReframe((event) => {
      const running = { ...get().backgroundReframing }
      if (event.state === 'running') running[event.clipId] = true
      else delete running[event.clipId]
      const current = get().project
      if (event.state === 'done' && current?.id === event.projectId) {
        // Graft only what the analysis owns: edits made while it ran stay.
        set({
          backgroundReframing: running,
          project: {
            ...current,
            clips: current.clips.map((c) =>
              c.id === event.clipId ? mergeReframeResult(c, event.clip, current.videoType) : c
            )
          }
        })
        absorbExternal(event.clipId)
      } else {
        // A failed background run stays pending without an error, so opening
        // the clip retries it.
        set({ backgroundReframing: running })
      }
    })
    window.cutawan.onExportProgress((p) => {
      const entry = get().exports[p.clipId]
      if (entry?.status === 'exporting') {
        set({ exports: { ...get().exports, [p.clipId]: { ...entry, progress: p.progress } } })
      }
    })
  },

  refreshProjects: async () => {
    set({ projects: await window.cutawan.listProjects() })
  },

  importVideo: async () => {
    const path = await window.cutawan.selectVideo()
    if (!path) return
    await get().importVideoFromPath(path)
  },

  importVideoFromPath: async (path) => {
    try {
      const project = await window.cutawan.createProject(path)
      set({ project, screen: 'home', pipelineError: null })
      await get().refreshProjects()
    } catch (err) {
      set({ pipelineError: err instanceof Error ? cleanIpcError(err.message) : String(err) })
    }
  },

  importVideoFromUrl: async (url) => {
    set({ importProgress: { progress: -1, message: 'Starting…' }, pipelineError: null })
    try {
      const project = await window.cutawan.createProjectFromUrl(url.trim())
      set({ project, screen: 'home', importProgress: null })
      await get().refreshProjects()
    } catch (err) {
      set({
        importProgress: null,
        pipelineError: err instanceof Error ? cleanIpcError(err.message) : String(err)
      })
    }
  },

  importPackage: async () => {
    const path = await window.cutawan.selectPackage()
    if (!path) return
    await get().importPackageFromPath(path)
  },

  importPackageFromPath: async (path) => {
    set({ importProgress: { progress: -1, message: 'Importing Metachlorian package…' }, pipelineError: null })
    try {
      const project = await window.cutawan.importPackage(path)
      set({ importProgress: null })
      await get().refreshProjects()
      await get().openProject(project.id)
    } catch (err) {
      set({
        importProgress: null,
        pipelineError: err instanceof Error ? cleanIpcError(err.message) : String(err)
      })
    }
  },

  openProject: async (id) => {
    clearHistory()
    const project = await window.cutawan.loadProject(id)
    // A whole-video project reopens on its edit; a clip project on the grid.
    const wholeVideo = project.mode === 'whole-video' ? findWholeVideoClip(project) : null
    set({
      project,
      screen: wholeVideo ? 'editor' : project.clips.length > 0 ? 'clips' : 'home',
      selectedClipId: wholeVideo?.id ?? null,
      pipelineError: null
    })
  },

  deleteProject: async (id) => {
    await window.cutawan.deleteProject(id)
    if (get().project?.id === id) set({ project: null, screen: 'home' })
    await get().refreshProjects()
  },

  relinkVideo: async () => {
    const project = get().project
    if (!project) return
    try {
      const updated = await window.cutawan.relinkVideo(project.id)
      set({ project: updated, pipelineError: null })
    } catch (err) {
      set({ pipelineError: err instanceof Error ? cleanIpcError(err.message) : String(err) })
    }
  },

  goHome: () => {
    clearHistory()
    set({ screen: 'home', selectedClipId: null, pipelineError: null })
  },

  // Deselect the current project and return to the import screen so a new
  // video can be added. Non-destructive: the project stays saved on disk and
  // remains in "Recent projects".
  newProject: () => set({ project: null, screen: 'home', selectedClipId: null, pipelineError: null }),

  setSettingsOpen: (open, section = 'general') => set({ settingsOpen: open, settingsInitialSection: section }),

  saveSettings: async (update) => {
    const settings = await window.cutawan.updateSettings(update)
    set({ settings })
  },

  refreshSettings: async () => {
    set({ settings: await window.cutawan.getSettings() })
  },

  analyze: async (options) => {
    const project = get().project
    if (!project) return
    set({
      screen: 'processing',
      pipelineError: null,
      pipelineMode: 'clips',
      pipelineProgress: { stage: 'audio', progress: 0, message: 'Starting…' }
    })
    try {
      const updated = await window.cutawan.analyzeProject(project.id, options)
      set({ project: updated, screen: 'clips', pipelineProgress: null })
    } catch (err) {
      const message = err instanceof Error ? cleanIpcError(err.message) : String(err)
      const cancelled = message.includes('Analysis cancelled')
      // Pick up any checkpoint (e.g. saved transcript) the failed run left.
      const reloaded = await window.cutawan.loadProject(project.id).catch(() => project)
      set({
        project: reloaded,
        screen: 'home',
        pipelineProgress: null,
        pipelineError: cancelled ? null : message
      })
    }
    await get().refreshProjects()
  },

  captionWholeVideo: async (options) => {
    const project = get().project
    if (!project) return
    set({
      screen: 'processing',
      pipelineError: null,
      pipelineMode: 'whole-video',
      pipelineFollowSpeaker: options.followSpeaker,
      pipelineProgress: { stage: 'audio', progress: 0, message: 'Starting…' }
    })
    try {
      const updated = await window.cutawan.captionWholeVideo(project.id, options)
      const clip = findWholeVideoClip(updated)
      // Straight into the editor: captions and framing are what this mode is
      // for, and there is no clip grid to choose from.
      set({
        project: updated,
        screen: clip ? 'editor' : 'home',
        selectedClipId: clip?.id ?? null,
        pipelineProgress: null
      })
    } catch (err) {
      const message = err instanceof Error ? cleanIpcError(err.message) : String(err)
      const cancelled = message.includes('Analysis cancelled')
      // Pick up any checkpoint (e.g. saved transcript) the failed run left.
      const reloaded = await window.cutawan.loadProject(project.id).catch(() => project)
      set({
        project: reloaded,
        screen: 'home',
        pipelineProgress: null,
        pipelineError: cancelled ? null : message
      })
    }
    await get().refreshProjects()
  },

  cancelAnalyze: async () => {
    const project = get().project
    if (project) await window.cutawan.cancelAnalyze(project.id)
  },

  openEditor: (clipId) => {
    const clip = get().project?.clips.find((c) => c.id === clipId)
    if (clip) trackClip(clip)
    set({ selectedClipId: clipId, screen: 'editor' })
  },
  closeEditor: () =>
    set({
      selectedClipId: null,
      screen: editorBackScreen(get().project, get().selectedClipId)
    }),

  updateClipLocal: (clip) => {
    const project = get().project
    if (!project) return
    set({
      project: { ...project, clips: project.clips.map((c) => (c.id === clip.id ? clip : c)) }
    })
  },

  updateClip: async (clip) => {
    const project = get().project
    if (!project) return
    // The stored copy is the last saved state (local edits during typing and
    // drags replace it only here), so start history from it whichever way
    // the editor was opened.
    const saved = project.clips.find((c) => c.id === clip.id)
    if (saved) trackClip(saved)
    get().updateClipLocal(clip)
    if (recordSave(clip)) set({ historyVersion: get().historyVersion + 1 })
    await window.cutawan.updateClip(project.id, clip)
    if (get().project?.id === project.id && get().selectedClipId === clip.id) {
      await get().ensureReframe(clip.id)
    }
  },

  undo: async (clipId) => stepHistory(clipId, undoEdit),
  redo: async (clipId) => stepHistory(clipId, redoEdit),

  generateCaption: async (clipId) => {
    const project = get().project
    if (!project || get().captionBusy[clipId]) return
    set({ captionBusy: { ...get().captionBusy, [clipId]: true } })
    try {
      const updated = await window.cutawan.generateCaption(project.id, clipId)
      const fresh = updated.clips.find((c) => c.id === clipId)
      const current = get().project
      // Only graft the caption on: other clip edits may be in flight.
      if (fresh && current?.id === updated.id) {
        set({
          project: {
            ...current,
            clips: current.clips.map((c) =>
              c.id === clipId ? { ...c, caption: fresh.caption } : c
            )
          }
        })
        absorbExternal(clipId)
      }
    } finally {
      const busy = { ...get().captionBusy }
      delete busy[clipId]
      set({ captionBusy: busy })
    }
  },

  ensureReframe: async (clipId, retry = false) => {
    const project = get().project
    if (!project) return
    if (get().reframeBusy[clipId]) {
      queuedReframes.add(clipId)
      return
    }
    if (get().reframeError[clipId] && !retry) return
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip || (!retry && !needsReframe(clip))) return
    const retryLayout = retry && !needsReframe(clip)
    const errors = { ...get().reframeError }
    delete errors[clipId]
    set({ reframeBusy: { ...get().reframeBusy, [clipId]: true }, reframeError: errors })
    try {
      const updated = await window.cutawan.ensureReframe(project.id, clipId, retryLayout)
      const fresh = updated.clips.find((c) => c.id === clipId)
      const current = get().project
      // Graft only what the analysis owns: edits made while it ran stay.
      if (fresh && current?.id === updated.id) {
        set({
          project: {
            ...current,
            clips: current.clips.map((c) =>
              c.id === clipId ? mergeReframeResult(c, fresh, updated.videoType, retryLayout) : c
            )
          }
        })
        absorbExternal(clipId)
      }
    } catch (err) {
      // The clip stays pending; the editor shows the failure with a retry and
      // works meanwhile on the default centre crop.
      const message = err instanceof Error ? cleanIpcError(err.message) : String(err)
      set({ reframeError: { ...get().reframeError, [clipId]: message } })
    } finally {
      const busy = { ...get().reframeBusy }
      delete busy[clipId]
      set({ reframeBusy: busy })
      if (queuedReframes.delete(clipId) && get().project?.id === project.id) {
        void get().ensureReframe(clipId)
      }
    }
  },

  updateTranscriptWord: async (segmentId, wordIndex, text) => {
    const project = get().project
    if (!project) return
    const updated = await window.cutawan.updateTranscriptWord(
      project.id,
      segmentId,
      wordIndex,
      text
    )
    // Only replace the transcript: clip edits in flight must not be clobbered.
    const current = get().project
    if (current?.id === updated.id) {
      set({ project: { ...current, transcript: updated.transcript } })
    }
  },

  exportClip: async (clipId) => {
    const project = get().project
    if (!project) return
    let dir = get().exportDir
    if (!dir) {
      dir = await window.cutawan.selectDirectory()
      if (!dir) return
      set({ exportDir: dir })
    }
    set({ exports: { ...get().exports, [clipId]: { status: 'exporting', progress: 0 } } })
    try {
      const result = await window.cutawan.exportClip(project.id, { clipId, outputDir: dir })
      set({
        exports: {
          ...get().exports,
          [clipId]: {
            status: 'done',
            progress: 1,
            outputPath: result.outputPath,
            bytes: result.bytes,
            sizeTargetBytes: result.sizeTargetBytes,
            downscaled: result.downscaled,
            overBudget: result.overBudget
          }
        }
      })
    } catch (err) {
      const message = err instanceof Error ? cleanIpcError(err.message) : String(err)
      if (message.includes('Export cancelled')) {
        get().clearExport(clipId)
        return
      }
      set({
        exports: {
          ...get().exports,
          [clipId]: { status: 'error', progress: 0, error: message }
        }
      })
    }
  },

  cancelExport: async (clipId) => {
    await window.cutawan.cancelExport(clipId)
  },

  exportAll: async () => {
    const project = get().project
    if (!project) return
    // The clip grid's "Export all" means the AI clips. A full-video edit is
    // exported deliberately from its own editor, never swept up here.
    for (const clip of highlightClips(project)) {
      const status = get().exports[clip.id]?.status
      if (status === 'exporting' || status === 'done') continue
      await get().exportClip(clip.id)
      // The folder picker was dismissed — don't re-prompt for every clip.
      if (!get().exportDir) return
    }
  },

  chooseExportDir: async () => {
    const dir = await window.cutawan.selectDirectory()
    if (dir) set({ exportDir: dir })
  },

  clearExport: (clipId) => {
    const exports = { ...get().exports }
    delete exports[clipId]
    set({ exports })
  },

  addFonts: async () => {
    const customFonts = await window.cutawan.addFonts()
    set({ customFonts })
    await registerFonts(customFonts)
  },

  removeFont: async (fileName) => {
    const removed = get().customFonts.find((f) => f.fileName === fileName)
    const customFonts = await window.cutawan.removeFont(fileName)
    if (removed && !customFonts.some((f) => f.family === removed.family)) {
      unregisterFontFamily(removed.family)
    }
    set({ customFonts })
  },

  importCookiesFile: async () => {
    set({ settings: await window.cutawan.importCookiesFile() })
  },

  clearCookiesFile: async () => {
    set({ settings: await window.cutawan.clearCookiesFile() })
  },

  selectBrandingLogo: async () => {
    set({ settings: await window.cutawan.selectBrandingLogo() })
  },

  checkForUpdates: async (silent = false) => {
    if (get().checkingForUpdates) return false
    set({ checkingForUpdates: true })
    try {
      const updateCheck = await window.cutawan.checkForUpdates()
      const previous = get().updateCheck
      if (updateCheck.error && previous?.updateAvailable) {
        set({ updateCheck: { ...previous, error: updateCheck.error, checkedAt: updateCheck.checkedAt } })
      } else if (!silent || !updateCheck.error || !previous) set({ updateCheck })
      return !updateCheck.error
    } catch (err) {
      const previous = get().updateCheck
      set({ updateCheck: {
        currentVersion: get().settings?.appVersion ?? '', latestVersion: null, releaseUrl: null,
        updateAvailable: false, autoUpdateSupported: false, sourceUpdateSupported: false,
        ...previous, checkedAt: Date.now(),
        error: `Could not check for updates: ${err instanceof Error ? cleanIpcError(err.message) : String(err)}`
      } })
      return false
    } finally { set({ checkingForUpdates: false }) }
  },

  downloadUpdate: async () => {
    if (get().updateDownload.status === 'downloading') return
    try { set({ updateDownload: await window.cutawan.downloadUpdate() }) }
    catch (err) {
      set({ updateDownload: { ...get().updateDownload, status: 'error',
        error: err instanceof Error ? cleanIpcError(err.message) : String(err) } })
    }
  },

  cancelUpdateDownload: async () => {
    try { await window.cutawan.cancelUpdateDownload() }
    catch (err) { set({ updateDownload: { ...get().updateDownload, error: String(err) } }) }
  },

  openUpdateInstaller: async () => {
    try {
      await window.cutawan.openUpdateInstaller()
      set({ updateDownload: { ...get().updateDownload, error: undefined } })
    } catch (err) {
      set({ updateDownload: { ...get().updateDownload,
        error: err instanceof Error ? cleanIpcError(err.message) : String(err) } })
    }
  },

  installUpdate: async () => {
    try { await window.cutawan.installUpdate() }
    catch (err) {
      set({ updateDownload: { ...get().updateDownload,
        error: err instanceof Error ? cleanIpcError(err.message) : String(err) } })
    }
  },

  updateFromSource: async () => {
    if (get().sourceUpdate.status === 'running') return
    set({ sourceUpdate: { status: 'running', message: 'Starting…' } })
    const unsubscribe = window.cutawan.onSourceUpdateProgress((p) => {
      if (get().sourceUpdate.status === 'running') {
        set({ sourceUpdate: { status: 'running', message: p.message } })
      }
    })
    try {
      // On success the main process relaunches the app; this state only
      // matters for the brief "Restarting…" moment.
      await window.cutawan.updateFromSource()
    } catch (err) {
      set({
        sourceUpdate: {
          status: 'error',
          message: '',
          error: err instanceof Error ? cleanIpcError(err.message) : String(err)
        }
      })
    } finally {
      unsubscribe()
    }
  }
}))

/** Electron prefixes IPC errors with "Error invoking remote method '...': Error:". */
function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
