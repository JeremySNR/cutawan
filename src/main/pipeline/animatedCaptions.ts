import type { Writable } from 'node:stream'
import {
  captionFrameCount,
  captionFrameRate,
  captionFrameTime,
  captionSceneAt,
  sceneKey,
  type AnimatedCaptionPlan,
  type CaptionScene
} from '@shared/animatedCaptions'

/**
 * Export side of the animated caption styles. The frames are drawn by the
 * shared canvas code (shared/captionCanvas.ts) in a hidden Chromium window
 * the main process opens (main/captionFrames.ts registers it here, so this
 * module and render.ts never import Electron and still run in plain Node
 * scripts, where they report the renderer as unavailable and the export
 * burns the libass equivalent instead).
 *
 * Frames reach ffmpeg as raw RGBA on its stdin, one per output frame at the
 * export frame rate, and are overlaid where the `ass` filter would be. The
 * scene for each frame is computed here first: runs of identical scenes (a
 * settled word, a pause with nothing on screen) are drawn once and written
 * again, and empty frames are written from a zeroed buffer without asking the
 * window at all. Only the region a scene touched comes back over IPC.
 */

export interface CaptionFrameRect {
  x: number
  y: number
  w: number
  h: number
  /** RGBA, straight alpha, `w * h * 4` bytes. */
  data: Uint8Array
}

export interface CaptionFrameSession {
  /** Draw each scene on a cleared frame; null where nothing was drawn. */
  draw(scenes: CaptionScene[]): Promise<Array<CaptionFrameRect | null>>
  close(): void
}

export interface CaptionFrameSpec {
  plan: AnimatedCaptionPlan
  width: number
  height: number
  /** Directory holding the caption fonts (bundled plus the user's). */
  fontsDir: string
}

export type CaptionFrameRenderer = (spec: CaptionFrameSpec, signal?: AbortSignal) => Promise<CaptionFrameSession>

let renderer: CaptionFrameRenderer | null = null

/** Installed by the Electron main process at startup (main/captionFrames.ts). */
export function setCaptionFrameRenderer(next: CaptionFrameRenderer | null): void {
  renderer = next
}

/** A failure of the animated renderer, as opposed to the rest of the export. */
export class CaptionRendererError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CaptionRendererError'
  }
}

function asRendererError(error: unknown): CaptionRendererError {
  if (error instanceof CaptionRendererError) return error
  return new CaptionRendererError(error instanceof Error ? error.message : String(error), { cause: error })
}

/** Open a frame session, or say why the animated renderer cannot run. */
export async function openCaptionFrames(spec: CaptionFrameSpec, signal?: AbortSignal): Promise<CaptionFrameSession> {
  if (!renderer) throw new CaptionRendererError('the animated caption renderer is not available here')
  try {
    return await renderer(spec, signal)
  } catch (error) {
    signal?.throwIfAborted()
    throw asRendererError(error)
  }
}

/** The user-facing note when an animated style was burned with libass instead. */
export function captionFallbackNotice(styleName: string, fallbackName: string, reason: string): string {
  return `${styleName} captions could not be animated (${reason.replace(/\s+/g, ' ').slice(0, 160)}), so this file uses the ${fallbackName} style instead.`
}

/** ffmpeg input arguments for the caption frames on stdin. */
export function captionFrameInputArgs(width: number, height: number, fps: number): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', captionFrameRate(fps).arg, '-i', 'pipe:0']
}

/** One stretch of identical frames. */
interface Run {
  key: string
  scene: CaptionScene
  count: number
}

/** Runs of identical scenes over the clip, produced lazily. */
function* runs(plan: AnimatedCaptionPlan, fps: number, frames: number): Generator<Run> {
  let current: Run | null = null
  for (let n = 0; n < frames; n++) {
    const scene = captionSceneAt(plan, captionFrameTime(n, fps))
    const key = sceneKey(scene)
    if (current && current.key === key) {
      current.count++
      continue
    }
    if (current) yield current
    current = { key, scene, count: 1 }
  }
  if (current) yield current
}

/** Scenes drawn per round trip to the window. */
const BATCH = 6

export interface CaptionFrameStats {
  frames: number
  drawn: number
  empty: number
}

function isBrokenPipe(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET'
}

/**
 * Write every caption frame of the clip to `out` (ffmpeg's stdin) as raw RGBA
 * at `fps`, then end it. Memory stays at two frames: a zeroed one for empty
 * frames and one that drawn regions are composed into, each reused only once
 * its previous write has been flushed. The next batch is drawn while the
 * current one is written.
 */
export async function writeCaptionFrames(
  session: CaptionFrameSession,
  plan: AnimatedCaptionPlan,
  opts: { width: number; height: number; fps: number },
  out: Writable,
  signal?: AbortSignal
): Promise<CaptionFrameStats> {
  const { width, height, fps } = opts
  const frames = captionFrameCount(plan.duration, fps)
  const frameBytes = width * height * 4
  const empty = Buffer.alloc(frameBytes)
  const canvas = Buffer.alloc(frameBytes)
  let painted: { x: number; y: number; w: number; h: number } | null = null
  const stats: CaptionFrameStats = { frames: 0, drawn: 0, empty: 0 }
  let closed = false
  const onError = (error: unknown): void => {
    if (isBrokenPipe(error)) closed = true
  }
  out.on('error', onError)

  const write = (buffer: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (closed || out.destroyed) {
      closed = true
      resolve()
      return
    }
    out.write(buffer, (error) => {
      if (!error) resolve()
      else if (isBrokenPipe(error)) {
        // ffmpeg stopped reading (it has every frame it needs): not a failure.
        closed = true
        resolve()
      } else reject(error)
    })
  })

  const compose = (rect: CaptionFrameRect | null): Buffer => {
    if (painted) {
      const rowBytes = painted.w * 4
      for (let row = 0; row < painted.h; row++) {
        const at = ((painted.y + row) * width + painted.x) * 4
        canvas.fill(0, at, at + rowBytes)
      }
      painted = null
    }
    if (!rect) return empty
    const x = Math.max(0, Math.min(width, rect.x))
    const y = Math.max(0, Math.min(height, rect.y))
    const w = Math.min(rect.w, width - x)
    const h = Math.min(rect.h, height - y)
    if (w <= 0 || h <= 0 || rect.data.length < rect.w * rect.h * 4) return empty
    const source = Buffer.from(rect.data.buffer, rect.data.byteOffset, rect.data.byteLength)
    for (let row = 0; row < h; row++) {
      source.copy(canvas, ((y + row) * width + x) * 4, row * rect.w * 4, row * rect.w * 4 + w * 4)
    }
    painted = { x, y, w, h }
    return canvas
  }

  const iterator = runs(plan, fps, frames)
  const takeBatch = (): Run[] => {
    const batch: Run[] = []
    while (batch.length < BATCH) {
      const next = iterator.next()
      if (next.done) break
      batch.push(next.value)
    }
    return batch
  }
  const drawBatch = (batch: Run[]): Promise<Array<CaptionFrameRect | null>> => {
    const needed = batch.filter((run) => run.key !== '')
    if (!needed.length) return Promise.resolve(batch.map(() => null))
    return session.draw(needed.map((run) => run.scene)).then((drawn) => {
      if (drawn.length !== needed.length) throw new CaptionRendererError('the caption window returned the wrong number of frames')
      let i = 0
      return batch.map((run) => (run.key === '' ? null : drawn[i++]))
    })
  }

  try {
    let batch = takeBatch()
    let pending = drawBatch(batch).catch((error: unknown) => {
      throw asRendererError(error)
    })
    // Awaited in the loop; this only stops an early abort leaving it unhandled.
    pending.catch(() => undefined)
    while (batch.length && !closed) {
      signal?.throwIfAborted()
      const rects = await pending
      const next = takeBatch()
      // Draw ahead while this batch is written.
      pending = next.length
        ? drawBatch(next).catch((error: unknown) => {
            throw asRendererError(error)
          })
        : Promise.resolve([])
      // A failed prefetch must not surface as an unhandled rejection while
      // this batch is still being written; it is awaited on the next turn.
      pending.catch(() => undefined)
      for (let i = 0; i < batch.length && !closed; i++) {
        const run = batch[i]
        const buffer = run.key === '' ? compose(null) : compose(rects[i])
        if (run.key === '') stats.empty += run.count
        else stats.drawn++
        for (let k = 0; k < run.count && !closed; k++) {
          signal?.throwIfAborted()
          await write(buffer)
          stats.frames++
        }
      }
      batch = next
    }
  } finally {
    out.off('error', onError)
    if (!out.destroyed) out.end()
  }
  return stats
}
