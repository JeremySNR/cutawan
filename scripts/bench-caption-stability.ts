/**
 * Measures how steady burned-in karaoke captions are while the highlight moves
 * from word to word, and whether the highlighted word ends up the size the
 * live preview shows.
 *
 * The preview pops the active word with a CSS transform, which never moves the
 * other words. libass has no transform: scaling one word changes its advance
 * width, so a centred line re-flows and every other word slides sideways.
 * This renders real frames through libass and reports, per caption style:
 *
 *   settled      largest ink-edge difference from the same captions rendered
 *                with no pop at all (the preview's settled layout), measured
 *                once each word's pop has finished (px)
 *   during pop   the same, sampled every 20ms through the first 160ms of each
 *                word while the pop animates (px)
 *   active size  settled width of the highlighted word / its width unpopped

Both drift figures track the words that are not highlighted (their own colour)
against the no-pop render, so group changes and pill outlines cancel out:
0px means no other word ever moves. Styles whose highlight shares the base
colour fall back to all visible ink.
 *
 * Makes no API calls. Run with:
 *   npx tsx --tsconfig tsconfig.node.json scripts/bench-caption-stability.ts [--check]
 *
 * `--check` fails when a settled style moves more than 1px or settles off
 * preview size.
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { buildAss } from '../src/main/pipeline/captions'
import { parseFontMetrics } from '../src/main/fonts'
import { CAPTION_STYLES } from '../src/shared/captionStyles'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import type { Transcript } from '../src/shared/types'

const WORK = join(process.cwd(), '.tmp', 'caption-stability')
const W = 1080
const H = 1920
const FPS = 100
/** Long enough for any pop animation to finish before the measured frame. */
const WORD_SEC = 0.6
const SETTLE_SEC = 0.4
/** Mixed widths, so a re-flow cannot cancel out across words. */
const WORDS = ['I', 'ABSOLUTELY', 'LOVE', 'IT', 'WHEN', 'EVERYTHING', 'WORKS', 'OUT']

const FONT_FILES: Record<string, string> = {
  Anton: 'resources/fonts/Anton-Regular.ttf',
  Poppins: 'resources/fonts/Poppins-Bold.ttf',
  'Poppins Medium': 'resources/fonts/Poppins-Medium.ttf'
}

function transcript(): Transcript {
  const words = WORDS.map((text, i) => ({ text, start: i * WORD_SEC, end: (i + 1) * WORD_SEC - 0.05 }))
  const end = WORDS.length * WORD_SEC
  return {
    language: 'en',
    durationSec: end,
    segments: [{ id: 0, start: 0, end, text: WORDS.join(' '), words }]
  }
}

function esc(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function run(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true })
    const out: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))))
  })
}

/** Renders the given times (seconds) of an ASS file onto black, as RGB frames. */
async function renderFrames(assPath: string, times: number[]): Promise<Buffer[]> {
  const frames = times.map((t) => Math.round(t * FPS))
  const select = [...new Set(frames)].map((n) => `eq(n\\,${n})`).join('+')
  const duration = (Math.max(...frames) + 2) / FPS
  const raw = await run([
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}:d=${duration}`,
    '-vf', `ass=filename='${esc(assPath)}':fontsdir='${esc('resources/fonts')}',select='${select}'`,
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'
  ])
  // select emits frames in stream order, whatever order they were asked for.
  const order = [...new Set(frames)].sort((a, b) => a - b)
  const size = W * H * 3
  if (raw.length !== size * order.length) throw new Error(`expected ${order.length} frames, got ${raw.length / size}`)
  return frames.map((n) => {
    const i = order.indexOf(n)
    return raw.subarray(i * size, (i + 1) * size)
  })
}

interface Box { left: number; right: number }

/** Horizontal ink extent of pixels matching a colour (or any visible ink). */
function inkBox(frame: Buffer, rgb?: number[]): Box | null {
  let left = W
  let right = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3
      const hit = rgb
        ? Math.abs(frame[p] - rgb[0]) < 40 && Math.abs(frame[p + 1] - rgb[1]) < 40 && Math.abs(frame[p + 2] - rgb[2]) < 40
        : frame[p] + frame[p + 1] + frame[p + 2] > 60
      if (hit) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return right < 0 ? null : { left, right }
}

function hexRgb(hex: string): number[] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

function distinct(a: number[], b: number[]): boolean {
  return a.some((v, i) => Math.abs(v - b[i]) > 80)
}

/** The same captions with every scale override removed: the preview's settled look. */
function withoutPop(ass: string): string {
  return ass.replace(/\\t\([^)]*\)/g, '').replace(/\\fsc[xy]\d+/g, '')
}

interface Row { style: string; settled: number; transient: number; activeSize: number | null }

/** Sample offsets into each word: settled first, then through the pop. */
const OFFSETS = [SETTLE_SEC, 0.01, 0.03, 0.05, 0.07, 0.09, 0.11, 0.13, 0.15]

async function measure(styleId: string, fontFamily: string, highlight: string, text: string): Promise<Row | null> {
  const file = FONT_FILES[fontFamily]
  if (!file) return null
  const metrics = parseFontMetrics(await readFile(file))
  const clipEnd = WORDS.length * WORD_SEC
  const ass = buildAss(transcript(), { styleId, width: W, height: H, clipStart: 0, clipEnd, fontMetrics: metrics })
  const popPath = join(WORK, `${styleId}.ass`)
  const staticPath = join(WORK, `${styleId}-static.ass`)
  await writeFile(popPath, ass, 'utf8')
  await writeFile(staticPath, withoutPop(ass), 'utf8')

  const times = WORDS.flatMap((_, i) => OFFSETS.map((o) => i * WORD_SEC + o))
  const [popFrames, staticFrames] = await Promise.all([renderFrames(popPath, times), renderFrames(staticPath, times)])

  let settled = 0
  let transient = 0
  const ratios: number[] = []
  const hl = hexRgb(highlight)
  const base = hexRgb(text)
  const visible = (c: number[]): boolean => c.some((v) => v > 96)
  const sizeMeasurable = distinct(hl, base) && visible(hl)
  // Track the words that are not highlighted (base colour) when that colour
  // stands apart; otherwise fall back to all visible ink.
  const othersColour = distinct(hl, base) && visible(base) ? base : undefined
  for (let i = 0; i < times.length; i++) {
    const box = inkBox(popFrames[i], othersColour)
    const ref = inkBox(staticFrames[i], othersColour)
    if (!box || !ref) continue
    const drift = Math.max(Math.abs(box.left - ref.left), Math.abs(box.right - ref.right))
    const isSettled = i % OFFSETS.length === 0
    if (isSettled) settled = Math.max(settled, drift)
    else transient = Math.max(transient, drift)
    if (isSettled && sizeMeasurable) {
      const a = inkBox(popFrames[i], hl)
      const b = inkBox(staticFrames[i], hl)
      if (a && b && b.right > b.left) ratios.push((a.right - a.left + 1) / (b.right - b.left + 1))
    }
  }
  const activeSize = ratios.length ? ratios.reduce((s, r) => s + r, 0) / ratios.length : null
  return { style: styleId, settled, transient, activeSize }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  const rows: Row[] = []
  for (const s of CAPTION_STYLES) {
    const row = await measure(s.id, s.fontFamily, s.highlightColor, s.textColor)
    if (row) rows.push(row)
  }

  console.log('style         settled  during pop  active size')
  for (const r of rows) {
    console.log(
      `${r.style.padEnd(10)} ${`${r.settled}px`.padStart(10)} ${`${r.transient}px`.padStart(11)}  ` +
        (r.activeSize === null ? '   n/a' : `${(r.activeSize * 100).toFixed(1)}%`.padStart(6))
    )
  }
  const worst = Math.max(...rows.map((r) => r.settled))
  const worstPop = Math.max(...rows.map((r) => r.transient))
  const sizes = rows.flatMap((r) => (r.activeSize === null ? [] : [r.activeSize]))
  const meanSize = sizes.reduce((s, v) => s + v, 0) / sizes.length
  console.log(`\n${rows.length} styles · worst settled drift ${worst}px · worst drift during pop ${worstPop}px · mean settled active-word size ${(meanSize * 100).toFixed(1)}%`)

  if (check) {
    const bad = rows.filter((r) => r.settled > 1 || (r.activeSize !== null && Math.abs(r.activeSize - 1) > 0.02))
    if (bad.length) {
      console.error(`Unstable or off-size captions: ${bad.map((r) => r.style).join(', ')}`)
      process.exit(1)
    }
    console.log('All styles hold their layout and settle at preview size.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
