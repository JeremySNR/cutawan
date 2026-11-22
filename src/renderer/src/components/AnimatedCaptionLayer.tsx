import { useEffect, useRef, useState } from 'react'
import { captionSceneAt, planFontFamilies, sceneKey, type AnimatedCaptionPlan } from '@shared/animatedCaptions'
import { COLOR_EMOJI_FONT, captionFont, drawCaptionScene } from '@shared/captionCanvas'
import type { CaptionStyle } from '@shared/captionStyles'

/**
 * Live preview of an animated caption style: a canvas over the video drawn
 * by the same module the export's hidden window uses (shared/captionCanvas),
 * from the same plan, at the playhead's output time. `getTime` is read on
 * every display frame, so springs and sweeps play smoothly however often
 * React re-renders, and a paused frame shows exactly what that frame of the
 * export will.
 */
export default function AnimatedCaptionLayer({
  plan,
  getTime
}: {
  plan: AnimatedCaptionPlan
  /** Output seconds at this display frame. */
  getTime: () => number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const getTimeRef = useRef(getTime)
  useEffect(() => {
    getTimeRef.current = getTime
  })
  // Canvas text only uses a web font once it has loaded; draw after that.
  const [fontsReady, setFontsReady] = useState(0)
  useEffect(() => {
    let cancelled = false
    const style = plan.style
    const loads = [
      ...planFontFamilies(plan).flatMap((family) => [captionFont(family, 400, 32), captionFont(family, 700, 32)]),
      `32px "${COLOR_EMOJI_FONT}"`
    ].map((font) => document.fonts.load(font, style.uppercase ? 'AB' : 'ab').catch(() => []))
    void Promise.all(loads).then(() => {
      if (!cancelled) setFontsReady((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [plan])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastKey: string | null = null
    let lastSize = ''
    const frame = (): void => {
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(rect.width * ratio))
      const height = Math.max(1, Math.round(rect.height * ratio))
      const size = `${width}x${height}`
      if (size !== lastSize) {
        canvas.width = width
        canvas.height = height
        lastSize = size
        lastKey = null
      }
      const scene = captionSceneAt(plan, getTimeRef.current())
      const key = sceneKey(scene)
      if (key !== lastKey) {
        lastKey = key
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, width, height)
        if (key) drawCaptionScene(ctx, plan, scene, width, height)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [plan, fontsReady])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="animated-captions"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}

/** Seconds one loop of the picker sample takes. */
const SAMPLE_LOOP_SEC = 2.6

/** A three-word card on a loop, for a style's button in the picker. */
function samplePlan(style: CaptionStyle): AnimatedCaptionPlan {
  const words = style.uppercase ? ['SO', 'I', 'SAID'] : ['so', 'I', 'said']
  return {
    // Sized to the button's small canvas rather than a video frame.
    style: { ...style, fontScale: 0.4, positionY: 0.5, outlineWidth: style.outlineWidth * 2 },
    cards: [{
      start: 0.15,
      end: 2.3,
      lines: [words.map((text, i) => ({
        text,
        start: 0.2 + i * 0.45,
        end: 0.6 + i * 0.45,
        emphasis: i === 2,
        emoji: i === 2 && style.animation?.emojiByDefault ? '💡' : null
      }))]
    }],
    positionRanges: [],
    title: null,
    translation: null,
    duration: SAMPLE_LOOP_SEC
  }
}

/**
 * The animated style's look, playing, in the caption style picker: the same
 * drawing as the preview and export, on a looping sample card. (Wall-clock
 * time is fine here: it is a swatch, not a frame of the clip.)
 */
export function AnimatedStyleSample({ style }: { style: CaptionStyle }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The picker resolves styles on every render; restart only on a real change.
  const styleKey = JSON.stringify(style)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const style = JSON.parse(styleKey) as CaptionStyle
    const plan = samplePlan(style)
    let raf = 0
    let lastKey: string | null = null
    const started = performance.now()
    const frame = (): void => {
      const ratio = window.devicePixelRatio || 1
      const width = Math.round(canvas.clientWidth * ratio)
      const height = Math.round(canvas.clientHeight * ratio)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        lastKey = null
      }
      const t = ((performance.now() - started) / 1000) % SAMPLE_LOOP_SEC
      const scene = captionSceneAt(plan, t)
      const key = sceneKey(scene)
      if (key !== lastKey) {
        lastKey = key
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, width, height)
        if (key) drawCaptionScene(ctx, plan, scene, width, height)
      }
      raf = requestAnimationFrame(frame)
    }
    void document.fonts.load(captionFont(style.fontFamily, style.bold ? 700 : 400, 16)).catch(() => undefined)
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [styleKey])
  return <canvas ref={canvasRef} aria-hidden="true" className="block h-7 w-full" />
}
