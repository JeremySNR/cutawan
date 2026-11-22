import { drawCaptionScene, type DirtyRect } from '@shared/captionCanvas'
import type {
  AnimatedCaptionPlan,
  CaptionFramesDraw,
  CaptionFramesDrawn,
  CaptionFramesInit,
  CaptionFramesReady
} from '@shared/animatedCaptions'

/**
 * The hidden export window's page (main/captionFrames.ts opens it): loads the
 * caption fonts it is sent, then draws each requested scene with the same
 * shared canvas code the editor preview uses and posts back the pixels of
 * the region the scene touched.
 */

interface CaptionFramesBridge {
  onInit(cb: (spec: CaptionFramesInit) => void): void
  onDraw(cb: (request: CaptionFramesDraw) => void): void
  ready(result: CaptionFramesReady): void
  drawn(result: CaptionFramesDrawn): void
}

const bridge = (window as unknown as { captionFrames: CaptionFramesBridge }).captionFrames

let plan: AnimatedCaptionPlan | null = null
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
/** What the previous frame touched: all that needs clearing before the next. */
let dirty: DirtyRect | null = null

async function init(spec: CaptionFramesInit): Promise<void> {
  const loaded = new Set<string>()
  const failures: string[] = []
  for (const font of spec.fonts) {
    try {
      const face = new FontFace(font.family, font.data as Uint8Array<ArrayBuffer>, { weight: font.weight })
      await face.load()
      document.fonts.add(face)
      loaded.add(font.family)
    } catch (error) {
      failures.push(`${font.family}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const missing = spec.required.filter((family) => !loaded.has(family))
  if (missing.length) {
    throw new Error(`the font ${missing.join(', ')} could not be loaded${failures.length ? ` (${failures.join('; ')})` : ''}`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = spec.width
  canvas.height = spec.height
  // Software-backed and read every frame: identical pixels on every machine
  // with or without a GPU, and no readback stall.
  ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true })
  if (!ctx) throw new Error('no 2D canvas')
  plan = spec.plan
  width = spec.width
  height = spec.height
  dirty = null
}

function draw(request: CaptionFramesDraw): CaptionFramesDrawn {
  if (!ctx || !plan) return { id: request.id, error: 'the caption window was not initialised' }
  const frames = request.scenes.map((scene) => {
    if (dirty) ctx!.clearRect(dirty.x, dirty.y, dirty.w, dirty.h)
    ctx!.setTransform(1, 0, 0, 1, 0, 0)
    const rect = drawCaptionScene(ctx!, plan!, scene, width, height)
    dirty = rect
    if (!rect) return null
    const image = ctx!.getImageData(rect.x, rect.y, rect.w, rect.h)
    return { ...rect, data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) }
  })
  return { id: request.id, frames }
}

bridge.onInit((spec) => {
  init(spec).then(
    () => bridge.ready({ ok: true }),
    (error: unknown) => bridge.ready({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})

bridge.onDraw((request) => {
  try {
    bridge.drawn(draw(request))
  } catch (error) {
    bridge.drawn({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
})
