import { BrowserWindow } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { BUNDLED_CAPTION_FONTS, COLOR_EMOJI_FONT } from '@shared/captionCanvas'
import {
  planFontFamilies,
  type CaptionFontFile,
  type CaptionFramesDrawn,
  type CaptionFramesInit,
  type CaptionFramesReady,
  type CaptionScene
} from '@shared/animatedCaptions'
import {
  CaptionRendererError,
  setCaptionFrameRenderer,
  type CaptionFrameRect,
  type CaptionFrameSession,
  type CaptionFrameSpec
} from './pipeline/animatedCaptions'
import { fontsDir } from './pipeline/captions'
import { parseFontFamily } from './fonts'

/**
 * The animated caption renderer's Electron half: a hidden, sandboxed window
 * per export that loads renderer/caption-frames.html, registers the caption
 * fonts from the fonts directory with the FontFace API (the same files the
 * preview's @font-face rules point at), and draws frames on request. It runs
 * on Chromium's software rasteriser when the GPU is off (Xvfb, CI), which is
 * also what makes every frame deterministic.
 */

/** Long enough for a cold start on a slow machine, short enough to fall back promptly. */
const OPEN_TIMEOUT_MS = 20_000
/** One batch of frames; a hung window must not hang the export. */
const DRAW_TIMEOUT_MS = 30_000

const FONT_EXTENSIONS = new Set(['.ttf', '.otf'])

/** Font files for the families a plan draws with, bundled ones by their known weight. */
async function fontFiles(families: string[], dirs: string[]): Promise<{ fonts: CaptionFontFile[]; missing: string[] }> {
  const fonts: CaptionFontFile[] = []
  const missing: string[] = []
  const wanted = [...new Set([...families, COLOR_EMOJI_FONT])]
  let directory: Array<{ path: string; family: string | null }> | null = null
  for (const family of wanted) {
    const bundled = BUNDLED_CAPTION_FONTS.filter((f) => f.family === family)
    let found = false
    for (const font of bundled) {
      for (const dir of dirs) {
        try {
          fonts.push({ family, weight: font.weight, data: new Uint8Array(await readFile(join(dir, font.file))) })
          found = true
          break
        } catch {
          /* try the next directory */
        }
      }
    }
    if (found) continue
    // A user upload: matched by the family inside the file, as libass and the
    // preview's FontFace registration match it.
    if (!directory) {
      directory = []
      for (const dir of dirs) {
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (!FONT_EXTENSIONS.has(extname(name).toLowerCase())) continue
          const path = join(dir, name)
          try {
            directory.push({ path, family: parseFontFamily(await readFile(path)) })
          } catch {
            /* unreadable: skip */
          }
        }
      }
    }
    const match = directory.find((f) => f.family?.trim().toLowerCase() === family.trim().toLowerCase())
    if (match) fonts.push({ family, weight: 'normal', data: new Uint8Array(await readFile(match.path)) })
    else missing.push(family)
  }
  return { fonts, missing }
}

function pageUrl(win: BrowserWindow): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) return win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/caption-frames.html`)
  return win.loadFile(join(__dirname, '../renderer/caption-frames.html'))
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptionRendererError(`${what} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Hidden export windows: never count as the app's own windows. */
const captionWindows = new WeakSet<BrowserWindow>()

/** The app's own windows, without hidden caption windows. */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !captionWindows.has(w))
}

export async function openCaptionFrameWindow(spec: CaptionFrameSpec, signal?: AbortSignal): Promise<CaptionFrameSession> {
  signal?.throwIfAborted()
  const families = planFontFamilies(spec.plan)
  const { fonts, missing } = await fontFiles(families, [spec.fontsDir, fontsDir()])
  if (missing.some((family) => families.includes(family))) {
    throw new CaptionRendererError(`the font ${missing.join(', ')} was not found`)
  }
  signal?.throwIfAborted()

  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    paintWhenInitiallyHidden: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/captionFrames.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  captionWindows.add(win)
  let closed = false
  let failure: Error | null = null
  const pending = new Map<number, { resolve: (frames: Array<CaptionFrameRect | null>) => void; reject: (error: Error) => void }>()
  // Settles when the window fails or closes, so start-up waits end at once
  // on a cancel or a crash instead of running out their timeouts.
  let rejectFailed: (error: Error) => void = () => {}
  const failed = new Promise<never>((_resolve, reject) => { rejectFailed = reject })
  failed.catch(() => undefined)
  const fail = (error: Error): void => {
    failure ??= error
    rejectFailed(failure)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  const close = (): void => {
    if (closed) return
    closed = true
    fail(new CaptionRendererError('the caption window was closed'))
    if (!win.isDestroyed()) win.destroy()
  }
  win.webContents.on('render-process-gone', (_e, details) => fail(new CaptionRendererError(`the caption window stopped (${details.reason})`)))
  win.on('closed', () => fail(new CaptionRendererError('the caption window was closed')))
  win.webContents.ipc.on('caption-frames:drawn', (_e, result: CaptionFramesDrawn) => {
    const entry = pending.get(result.id)
    if (!entry) return
    pending.delete(result.id)
    if ('error' in result) entry.reject(new CaptionRendererError(result.error))
    else entry.resolve(result.frames)
  })
  const abort = (): void => close()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()

  try {
    await withTimeout(Promise.race([pageUrl(win), failed]), OPEN_TIMEOUT_MS, 'opening the caption window')
    const ready = new Promise<CaptionFramesReady>((resolve) => {
      win.webContents.ipc.once('caption-frames:ready', (_e, result: CaptionFramesReady) => resolve(result))
    })
    const init: CaptionFramesInit = { plan: spec.plan, width: spec.width, height: spec.height, fonts, required: families }
    win.webContents.send('caption-frames:init', init)
    const result = await withTimeout(Promise.race([ready, failed]), OPEN_TIMEOUT_MS, 'loading the caption fonts')
    if (!result.ok) throw new CaptionRendererError(result.error)
    signal?.throwIfAborted()
  } catch (error) {
    signal?.removeEventListener('abort', abort)
    close()
    // A cancel reads as a cancel, not as a window failure to fall back from.
    signal?.throwIfAborted()
    throw error
  }

  let nextId = 1
  return {
    draw(scenes: CaptionScene[]): Promise<Array<CaptionFrameRect | null>> {
      if (failure) return Promise.reject(failure)
      if (closed || win.isDestroyed()) return Promise.reject(new CaptionRendererError('the caption window was closed'))
      const id = nextId++
      const done = new Promise<Array<CaptionFrameRect | null>>((resolve, reject) => pending.set(id, { resolve, reject }))
      win.webContents.send('caption-frames:draw', { id, scenes })
      return withTimeout(done, DRAW_TIMEOUT_MS, 'drawing caption frames').finally(() => pending.delete(id))
    },
    close(): void {
      signal?.removeEventListener('abort', abort)
      close()
    }
  }
}

/** Make the animated caption renderer available to exports (call once the app is ready). */
export function registerCaptionFrameRenderer(): void {
  if (process.env.CUTAWAN_DISABLE_ANIMATED_CAPTIONS) return
  setCaptionFrameRenderer(openCaptionFrameWindow)
}
