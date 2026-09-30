import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AnalyzeOptions,
  CaptionVideoOptions,
  AppSettings,
  Clip,
  CustomFont,
  ExportOptions,
  BackgroundReframeEvent,
  ExportProgress,
  ExportResult,
  GpuEncoderStatus,
  ImportProgress,
  PipelineProgress,
  Project,
  ProjectSummary,
  SettingsUpdate,
  TimelineData,
  UpdateCheckResult,
  UpdateDownloadState
} from '@shared/types'
import type { OpenRouterCatalog } from '@shared/openrouter'

const api = {
  checkSubscriptionSetup: (): Promise<{ message: string; requestsToday: number }> => ipcRenderer.invoke('settings:checkSubscription'),
  checkLocalWhisperSetup: (): Promise<{ message: string }> => ipcRenderer.invoke('settings:checkLocalWhisper'),
  listOpenRouterModels: (refresh = false): Promise<OpenRouterCatalog> => ipcRenderer.invoke('openrouter:models', refresh),
  checkOpenRouterKey: (key?: string): Promise<{ message: string }> => ipcRenderer.invoke('openrouter:checkKey', key),
  installLocalWhisper: (model: 'small' | 'large-v3', pythonPath: string): Promise<{ pythonPath: string; modelPath: string }> =>
    ipcRenderer.invoke('settings:installLocalWhisper', model, pythonPath),
  cancelLocalWhisperInstall: (): Promise<void> => ipcRenderer.invoke('settings:cancelLocalWhisperInstall'),
  onLocalWhisperInstallProgress: (cb: (p: ImportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ImportProgress): void => cb(p)
    ipcRenderer.on('whisper:installProgress', listener)
    return () => ipcRenderer.removeListener('whisper:installProgress', listener)
  },
  selectVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectVideo'),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory'),

  createProject: (videoPath: string): Promise<Project> => ipcRenderer.invoke('project:create', videoPath),
  createProjectFromUrl: (url: string): Promise<Project> =>
    ipcRenderer.invoke('project:createFromUrl', url),
  analyzeProject: (projectId: string, options: AnalyzeOptions): Promise<Project> =>
    ipcRenderer.invoke('project:analyze', projectId, options),
  captionWholeVideo: (projectId: string, options: CaptionVideoOptions): Promise<Project> =>
    ipcRenderer.invoke('project:captionWholeVideo', projectId, options),
  cancelAnalyze: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:cancelAnalyze', projectId),
  listProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:list'),
  loadProject: (id: string): Promise<Project> => ipcRenderer.invoke('project:load', id),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('project:delete', id),
  renameProject: (id: string, name: string): Promise<Project> => ipcRenderer.invoke('project:rename', id, name),
  relinkVideo: (projectId: string): Promise<Project> =>
    ipcRenderer.invoke('project:relinkVideo', projectId),
  updateClip: (projectId: string, clip: Clip): Promise<Project> =>
    ipcRenderer.invoke('project:updateClip', projectId, clip),
  ensureReframe: (projectId: string, clipId: string, retryLayout = false): Promise<Project> =>
    ipcRenderer.invoke('clip:ensureReframe', projectId, clipId, retryLayout),
  updateTranscriptWord: (
    projectId: string,
    segmentId: number,
    wordIndex: number,
    text: string
  ): Promise<Project> =>
    ipcRenderer.invoke('project:updateTranscriptWord', projectId, segmentId, wordIndex, text),

  exportClip: (projectId: string, opts: ExportOptions): Promise<ExportResult> =>
    ipcRenderer.invoke('clip:export', projectId, opts),
  cancelExport: (clipId: string): Promise<void> => ipcRenderer.invoke('clip:cancelExport', clipId),
  generateCaption: (projectId: string, clipId: string): Promise<Project> =>
    ipcRenderer.invoke('clip:generateCaption', projectId, clipId),

  getTimeline: (videoPath: string, startSec: number, endSec: number): Promise<TimelineData> =>
    ipcRenderer.invoke('video:timeline', videoPath, startSec, endSec),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (update: SettingsUpdate): Promise<AppSettings> => ipcRenderer.invoke('settings:update', update),
  listFonts: (): Promise<CustomFont[]> => ipcRenderer.invoke('fonts:list'),
  addFonts: (): Promise<CustomFont[]> => ipcRenderer.invoke('fonts:add'),
  removeFont: (fileName: string): Promise<CustomFont[]> => ipcRenderer.invoke('fonts:remove', fileName),
  importCookiesFile: (): Promise<AppSettings> => ipcRenderer.invoke('cookies:import'),
  clearCookiesFile: (): Promise<AppSettings> => ipcRenderer.invoke('cookies:clear'),
  selectBrandingLogo: (): Promise<AppSettings> => ipcRenderer.invoke('branding:selectLogo'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  downloadUpdate: (): Promise<UpdateDownloadState> => ipcRenderer.invoke('updates:download'),
  getUpdateDownloadState: (): Promise<UpdateDownloadState> => ipcRenderer.invoke('updates:state'),
  openUpdateInstaller: (): Promise<void> => ipcRenderer.invoke('updates:openInstaller'),
  cancelUpdateDownload: (): Promise<void> => ipcRenderer.invoke('updates:cancel'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  updateFromSource: (): Promise<void> => ipcRenderer.invoke('updates:updateFromSource'),
  onSourceUpdateProgress: (cb: (p: ImportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ImportProgress): void => cb(p)
    ipcRenderer.on('update:sourceProgress', listener)
    return () => ipcRenderer.removeListener('update:sourceProgress', listener)
  },
  onUpdateDownloadState: (cb: (p: UpdateDownloadState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: UpdateDownloadState): void => cb(p)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
  downloadGpuFfmpeg: (): Promise<GpuEncoderStatus> => ipcRenderer.invoke('settings:downloadGpuFfmpeg'),
  onGpuProgress: (cb: (p: ImportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ImportProgress): void => cb(p)
    ipcRenderer.on('gpu:progress', listener)
    return () => ipcRenderer.removeListener('gpu:progress', listener)
  },

  showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:showItemInFolder', path),

  onPipelineProgress: (cb: (p: PipelineProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: PipelineProgress): void => cb(p)
    ipcRenderer.on('pipeline:progress', listener)
    return () => ipcRenderer.removeListener('pipeline:progress', listener)
  },
  onBackgroundReframe: (cb: (e: BackgroundReframeEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, e: BackgroundReframeEvent): void => cb(e)
    ipcRenderer.on('clip:backgroundReframe', listener)
    return () => ipcRenderer.removeListener('clip:backgroundReframe', listener)
  },
  onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ExportProgress): void => cb(p)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },
  onImportProgress: (cb: (p: ImportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ImportProgress): void => cb(p)
    ipcRenderer.on('import:progress', listener)
    return () => ipcRenderer.removeListener('import:progress', listener)
  },

  /** Build a media:// URL the renderer can use in <video>/<img> tags. */
  mediaUrl: (absolutePath: string): string => `media://file/${encodeURIComponent(absolutePath)}`,

  /**
   * Absolute path for a dropped File. Electron removed File.path under the
   * sandbox, so drag-and-drop has to resolve the path through webUtils here in
   * the preload rather than reading it off the File in the renderer.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** OS platform, for platform-specific chrome (mac vibrancy, drag regions). */
  platform: process.env.CUTAWAN_FORCE_GLASS ? 'darwin' : process.platform
}

export type CutawanApi = typeof api

contextBridge.exposeInMainWorld('cutawan', api)
