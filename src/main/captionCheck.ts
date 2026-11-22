import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { Clip, Transcript, VideoInfo } from '@shared/types'
import { CAPTION_STYLES, getCaptionStyle, resolveCaptionStyle } from '@shared/captionStyles'
import { animatedCaptionPlan, captionSceneAt, type AnimatedCaptionPlan } from '@shared/animatedCaptions'
import { ClipTimeline } from '@shared/clipTimeline'
import { planTitle } from '@shared/titleLayout'
import { FFMPEG_PATH, probeVideo, runFfmpeg } from './pipeline/ffmpeg'
import { renderClip, type RenderResult } from './pipeline/render'
import { fontsDir } from './pipeline/captions'
import { openCaptionFrames, setCaptionFrameRenderer, writeCaptionFrames, type CaptionFrameRenderer } from './pipeline/animatedCaptions'
import { Writable } from 'node:stream'

/**
 * Real-export check for the animated caption styles, run inside Electron
 * (`CUTAWAN_CAPTION_CHECK=<dir>`, see scripts/test-animated-captions.sh) so
 * the hidden caption window is the real one. For every animated style it
 * exports a clip over a flat background and decodes frames from the file:
 * captions present while words are spoken and where the plan puts them, gone
 * in the pause, the title at the top, nothing else touched, and the exported
 * frame matching the window's own drawing composited over the background
 * (which checks alpha handling and frame timing together). Then the fallbacks:
 * a renderer that cannot open, one that dies mid-export, and a size-capped
 * two-pass export. `CUTAWAN_CAPTION_BENCH=1` adds the 60 s 1080x1920 timing
 * against libass.
 */

const W = 1080
const H = 1920
const FPS = 30
/** Background of the check clip (flat, so any caption ink stands out). */
const BG = [0x30, 0x50, 0x70]

function speech(text: string, from: number, step: number): Transcript['segments'][number] {
  const words = text.split(' ').map((t, i) => ({ text: t, start: from + i * step, end: from + (i + 1) * step - 0.04 }))
  return { id: Math.round(from * 10), text, start: words[0].start, end: words[words.length - 1].end, words }
}

function checkTranscript(): Transcript {
  return {
    language: 'english',
    durationSec: 12,
    segments: [
      speech('The secret to growing fast is simple.', 0.6, 0.4),
      // A pause long enough for the card's hold to run out (4.4 s -> 7.0 s empty).
      speech('Money changes everything about your life', 7.0, 0.4)
    ]
  }
}

function makeClip(edit: Partial<Clip['edit']>, end = 12): Clip {
  return {
    id: 'caption-check',
    suggestedStart: 0,
    suggestedEnd: end,
    title: 'Animated captions',
    hook: 'The secret nobody tells you',
    summary: '',
    viralityScore: 80,
    visualSummary: null,
    viralityReason: '',
    hashtags: [],
    thumbnailPath: null,
    focusTrack: null,
    broll: [],
    edit: {
      aspect: '9:16',
      reframeMode: 'crop',
      framing: 'manual',
      tightenCuts: false,
      focusX: 0.5,
      captionsEnabled: true,
      captionStyleId: 'pop',
      showTitle: true,
      start: 0,
      end,
      ...edit
    }
  }
}

/** Decode the given frame indices of a file as RGB24 frames. */
function decodeFrames(path: string, frames: number[]): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const select = frames.map((n) => `eq(n\\,${n})`).join('+')
    const child = spawn(FFMPEG_PATH, ['-v', 'error', '-i', path, '-vf', `select='${select}'`, '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr))
      const all = Buffer.concat(chunks)
      const size = W * H * 3
      if (all.length !== size * frames.length) return reject(new Error(`decoded ${all.length / size} of ${frames.length} frames`))
      resolve(frames.map((_, i) => all.subarray(i * size, (i + 1) * size)))
    })
  })
}

/** Rows (fractions of height) that hold pixels clearly unlike the background. */
function inkRows(frame: Buffer, threshold = 40): { rows: Set<number>; count: number; minX: number; maxX: number } {
  const rows = new Set<number>()
  let count = 0
  let minX = W
  let maxX = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const d = Math.abs(frame[i] - BG[0]) + Math.abs(frame[i + 1] - BG[1]) + Math.abs(frame[i + 2] - BG[2])
      if (d > threshold) {
        rows.add(y)
        count++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  return { rows, count, minX, maxX }
}

function rowsBetween(rows: Set<number>, from: number, to: number): number {
  let n = 0
  for (const r of rows) if (r >= from * H && r < to * H) n++
  return n
}

/** Composite the window's drawing of the scene at `t` over the background. */
async function expectedFrame(plan: AnimatedCaptionPlan, t: number): Promise<{ frame: Buffer; rect: { x: number; y: number; w: number; h: number } }> {
  const session = await openCaptionFrames({ plan, width: W, height: H, fontsDir: fontsDir() })
  try {
    const [rect] = await session.draw([captionSceneAt(plan, t)])
    assert.ok(rect, `nothing drawn at ${t}s`)
    const frame = Buffer.alloc(W * H * 3)
    for (let i = 0; i < W * H; i++) frame.set(BG, i * 3)
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const s = (y * rect.w + x) * 4
        const a = rect.data[s + 3] / 255
        const d = ((rect.y + y) * W + rect.x + x) * 3
        for (let c = 0; c < 3; c++) frame[d + c] = Math.round(rect.data[s + c] * a + BG[c] * (1 - a))
      }
    }
    return { frame, rect }
  } finally {
    session.close()
  }
}

/**
 * Mean RGB error over the pixels the window actually inked (expected frame
 * differs from the background), so empty margins do not dilute it.
 */
function inkError(actual: Buffer, expected: Buffer, rect: { x: number; y: number; w: number; h: number }): number {
  let sum = 0
  let n = 0
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * W + x) * 3
      const inked = Math.abs(expected[i] - BG[0]) + Math.abs(expected[i + 1] - BG[1]) + Math.abs(expected[i + 2] - BG[2]) > 24
      if (!inked) continue
      sum += Math.abs(actual[i] - expected[i]) + Math.abs(actual[i + 1] - expected[i + 1]) + Math.abs(actual[i + 2] - expected[i + 2])
      n++
    }
  }
  return n ? sum / (n * 3) : Infinity
}

function planFor(clip: Clip, transcript: Transcript): AnimatedCaptionPlan {
  const style = resolveCaptionStyle(clip.edit.captionStyleId)
  const timeline = new ClipTimeline([{ start: clip.edit.start, end: clip.edit.end }])
  return animatedCaptionPlan({
    transcript,
    clip,
    timeline,
    style,
    aspectRatio: W / H,
    captions: true,
    title: planTitle(clip.hook, { styleId: clip.edit.titleStyle, captionStyle: style, aspectRatio: W / H, start: 0, duration: timeline.outputDuration }),
    translation: null,
    positionRanges: []
  })
}

async function pngOf(frame: Buffer, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', 'pipe:0',
      '-vf', 'scale=540:-1', path])
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`png ${code}`))))
    child.stdin.end(frame)
  })
}

async function exportClip(source: VideoInfo, clip: Clip, transcript: Transcript, out: string, extra: { sizeTargetBytes?: number } = {}): Promise<{ result: RenderResult; seconds: number }> {
  const started = performance.now()
  const result = await renderClip({ clip, source, transcript, outputPath: out, encoder: 'cpu', quality: 'standard', ...extra })
  return { result, seconds: (performance.now() - started) / 1000 }
}

async function checkStyles(dir: string, source: VideoInfo): Promise<void> {
  const transcript = checkTranscript()
  const animated = CAPTION_STYLES.filter((s) => s.animation)
  assert.ok(animated.length >= 4, 'at least four animated styles')
  for (const preset of animated) {
    const clip = makeClip({ captionStyleId: preset.id })
    const out = join(dir, `${preset.id}.mp4`)
    const { result, seconds } = await exportClip(source, clip, transcript, out)
    assert.equal(result.captionNotice, undefined, `${preset.id}: fell back to libass: ${result.captionNotice}`)
    const info = await probeVideo(out)
    assert.equal(info.width, W)
    assert.equal(info.height, H)

    const plan = planFor(clip, transcript)
    const firstWord = plan.cards[0].lines[0][0]
    // Mid-animation (a word 3 frames into its pop), so a frame of timing error shows.
    const word = plan.cards[0].lines.flat()[2]
    const animFrame = Math.round(word.start * FPS) + 3
    const frames = { early: 3, title: 30, speech: Math.round(2.0 * FPS), anim: animFrame, pause: Math.round(5.6 * FPS), later: Math.round(8.4 * FPS) }
    const order = Object.entries(frames).sort((a, b) => a[1] - b[1])
    const decoded = await decodeFrames(out, order.map(([, n]) => n))
    const get = (name: keyof typeof frames): Buffer => decoded[order.findIndex(([k]) => k === name)]

    const y = preset.positionY
    const band = [y - 0.09, y + 0.09]
    const titleBottom = 0.3
    // Before the first word: title only, no caption.
    assert.ok(firstWord.start > frames.early / FPS)
    const early = inkRows(get('early'))
    assert.equal(rowsBetween(early.rows, titleBottom, 1), 0, `${preset.id}: caption ink before the first word`)
    // The hook title at the top while it shows.
    const title = inkRows(get('title'))
    assert.ok(rowsBetween(title.rows, 0.05, titleBottom) > 40, `${preset.id}: no hook title`)
    // Speaking: ink in the caption band, inside the safe width, and nowhere
    // between the title and the caption or below it.
    for (const name of ['speech', 'later'] as const) {
      const ink = inkRows(get(name))
      assert.ok(rowsBetween(ink.rows, band[0], band[1]) > 30, `${preset.id}: no caption at ${name}`)
      assert.equal(rowsBetween(ink.rows, titleBottom, band[0] - 0.04), 0, `${preset.id}: ink above the caption at ${name}`)
      assert.equal(rowsBetween(ink.rows, band[1] + 0.04, 1), 0, `${preset.id}: ink below the caption at ${name}`)
      assert.ok(ink.minX >= W * 0.04 && ink.maxX <= W * 0.96, `${preset.id}: caption outside the safe width at ${name} (${ink.minX}-${ink.maxX})`)
    }
    // The pause: the card's hold has run out and the title is gone.
    const pause = inkRows(get('pause'))
    assert.ok(pause.count < 50, `${preset.id}: ${pause.count} stray pixels in the pause`)
    // The exported frame is the window's drawing over the picture.
    const expected = await expectedFrame(plan, animFrame / FPS)
    const error = inkError(get('anim'), expected.frame, expected.rect)
    const neighbour = await expectedFrame(plan, (animFrame + 2) / FPS)
    const offByTwo = inkError(get('anim'), neighbour.frame, expected.rect)
    await pngOf(get('anim'), join(dir, `${preset.id}-export.png`))
    await pngOf(expected.frame, join(dir, `${preset.id}-window.png`))
    console.log(`PASS ${preset.id}: ${seconds.toFixed(1)}s export, mean error vs window ${error.toFixed(2)} (two frames off: ${offByTwo.toFixed(2)})`)
    // Over inked pixels only: x264 and 4:2:0 chroma cost a few levels at
    // glyph edges; a wrong alpha mode or a missing word costs tens.
    assert.ok(error < 12, `${preset.id}: export differs from the window's drawing (${error.toFixed(2)})`)
    assert.ok(error < offByTwo, `${preset.id}: the export matches a different frame better (timing off)`)
  }
}

async function checkFallbacks(dir: string, source: VideoInfo, real: CaptionFrameRenderer): Promise<void> {
  const transcript = checkTranscript()
  // 1. The window cannot open at all.
  setCaptionFrameRenderer(async () => {
    throw new Error('GPU process unavailable')
  })
  const clip = makeClip({ captionStyleId: 'pop' })
  const noWindow = await exportClip(source, clip, transcript, join(dir, 'fallback-open.mp4'))
  assert.match(noWindow.result.captionNotice ?? '', /Pop captions could not be animated \(GPU process unavailable\), so this file uses the Beast style/)
  const [frame] = await decodeFrames(join(dir, 'fallback-open.mp4'), [60])
  assert.ok(rowsBetween(inkRows(frame).rows, 0.62, 0.82) > 30, 'libass fallback burned no captions')
  console.log(`PASS fallback when the window cannot open: "${noWindow.result.captionNotice}"`)

  // 2. The window dies part-way through the frames.
  setCaptionFrameRenderer(async (spec, signal) => {
    const session = await real(spec, signal)
    let calls = 0
    return {
      draw: (scenes) => (++calls > 3 ? Promise.reject(new Error('render process gone (crashed)')) : session.draw(scenes)),
      close: () => session.close()
    }
  })
  const midway = await exportClip(source, makeClip({ captionStyleId: 'glide' }), transcript, join(dir, 'fallback-midway.mp4'))
  assert.match(midway.result.captionNotice ?? '', /Glide captions could not be animated .*Bubble style/)
  console.log(`PASS fallback when the window dies mid-export: "${midway.result.captionNotice}"`)
  setCaptionFrameRenderer(real)

  // 3. Size-capped two-pass export: the frames feed both passes.
  const capped = await exportClip(source, makeClip({ captionStyleId: 'sweep' }), transcript, join(dir, 'capped.mp4'), { sizeTargetBytes: 2_500_000 })
  assert.equal(capped.result.captionNotice, undefined)
  assert.ok(capped.result.sizePlan, 'size plan used')
  assert.ok(capped.result.bytes <= 2_500_000 * 1.05, `capped export is ${capped.result.bytes} bytes`)
  const capInfo = await probeVideo(join(dir, 'capped.mp4'))
  const scale = capInfo.width / W
  assert.ok(scale > 0)
  console.log(`PASS size-capped two-pass export: ${(capped.result.bytes / 1e6).toFixed(2)} MB at ${capInfo.width}x${capInfo.height}`)
}

async function bench(dir: string): Promise<void> {
  const source = join(dir, 'bench-source.mp4')
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=62', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=62',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source])
  const info = await probeVideo(source)
  // A minute of fast talk with a breath every eight seconds.
  const words = 'so here is the thing nobody tells you about building something people actually want to use every single day'.split(' ')
  const segments: Transcript['segments'] = []
  for (let at = 0.5, id = 0; at < 59; at += 8, id++) {
    const all = Array.from({ length: 18 }, (_, i) => ({ text: words[(i + id) % words.length], start: at + i * 0.36, end: at + (i + 1) * 0.36 - 0.03 }))
    segments.push({ id, text: all.map((w) => w.text).join(' '), start: all[0].start, end: all[all.length - 1].end, words: all })
  }
  const transcript: Transcript = { language: 'english', durationSec: 62, segments }
  // libass first and last, so a busy machine shows up as drift between the two.
  const runs = ['beast', 'pop', 'glide', 'sweep', 'prism', 'spark', 'beast']
  const times: Record<string, number[]> = {}
  for (const [i, style] of runs.entries()) {
    const clip = makeClip({ captionStyleId: style, emoji: true }, 60)
    const { result, seconds } = await exportClip(info, clip, transcript, join(dir, `bench-${i}-${style}.mp4`))
    assert.equal(result.captionNotice, undefined)
    ;(times[style] ??= []).push(seconds)
    console.log(`BENCH ${style}: ${seconds.toFixed(1)}s for a 60 s 1080x1920 export${style === 'beast' ? ' (libass)' : ''}`)
  }
  const libass = times.beast.reduce((a, b) => a + b, 0) / times.beast.length
  for (const style of runs.slice(1, -1)) console.log(`BENCH ${style}: ${(times[style][0] / libass).toFixed(2)}x the libass export (${libass.toFixed(1)}s mean)`)
  // The caption side alone: every frame drawn in the window and written to a
  // sink, which is what the animated path adds on top of ffmpeg's overlay.
  for (const style of runs.slice(1, -1)) {
    const clip = makeClip({ captionStyleId: style, emoji: true }, 60)
    const plan = { ...planFor(clip, transcript), duration: 60 }
    const session = await openCaptionFrames({ plan, width: W, height: H, fontsDir: fontsDir() })
    const sink = new Writable({ write: (_chunk, _enc, done) => done() })
    const started = performance.now()
    const stats = await writeCaptionFrames(session, plan, { width: W, height: H, fps: 30 }, sink)
    session.close()
    console.log(`BENCH ${style} frames alone: ${((performance.now() - started) / 1000).toFixed(1)}s for ${stats.frames} frames (${stats.drawn} drawn, ${stats.empty} empty)`)
  }
  await writeFile(join(dir, 'bench.json'), JSON.stringify(times, null, 2))
}

export async function runCaptionCheck(dir: string, real: CaptionFrameRenderer): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const source = join(dir, 'source.mp4')
  const hex = BG.map((v) => v.toString(16).padStart(2, '0')).join('')
  await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${hex}:size=1920x1080:rate=${FPS}:duration=12`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-c:a', 'aac', source])
  const info = await probeVideo(source)
  console.log(`caption check in ${dir} (fonts from ${fontsDir()}, Electron ${process.versions.electron}, GPU ${app.getGPUFeatureStatus().gpu_compositing})`)
  await checkStyles(dir, info)
  await checkFallbacks(dir, info, real)
  if (process.env.CUTAWAN_CAPTION_BENCH) await bench(dir)
  // The shell script reads this (Electron's exit code is lost in its log filter).
  await writeFile(join(dir, '.passed'), new Date().toISOString())
  console.log(`All animated caption checks passed (${CAPTION_STYLES.filter((s) => s.animation).map((s) => getCaptionStyle(s.id).name).join(', ')}).`)
}
