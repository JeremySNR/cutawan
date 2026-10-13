/**
 * Measures clicks at the audio joins tighten cuts create.
 *
 * Removing a pause splices two pieces of audio together. Speech is quiet at
 * the cut, but music, game sound or room tone under it is not, so a splice at
 * an arbitrary sample leaves a step in the waveform that is heard as a click.
 * This renders the real tighten graph over a continuous music bed and reports:
 *
 *   click ratio  largest sample-to-sample step within 1ms of a join, divided
 *                by the 99.9th percentile step everywhere else (>1 = a step
 *                bigger than anything the music itself does)
 *   dip          lowest 5ms RMS within 10ms of a join, relative to the lowest
 *                5ms RMS away from joins (the cost of fading: how far the
 *                audio briefly drops below anything it does on its own)
 *   duration     output length minus the kept length (sync must not drift)
 *
 * Makes no API calls. Run with:
 *   npx tsx --tsconfig tsconfig.node.json scripts/bench-tighten-joins.ts [--check]
 *
 * `--check` fails on a click ratio above 1 or any duration drift over 1ms.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import { tightenGraph } from '../src/main/pipeline/render'

const WORK = join(process.cwd(), '.tmp', 'tighten-joins')
const RATE = 48000
/** Kept ranges with odd boundaries, so joins land at arbitrary phases. */
const SEGMENTS = [
  { start: 0, end: 1.137 },
  { start: 1.71, end: 2.903 },
  { start: 3.4, end: 4.555 },
  { start: 5.21, end: 6.0 },
  { start: 6.9, end: 8.333 },
  { start: 8.71, end: 9.5 }
]

const BEDS: Record<string, string> = {
  'music bed': '0.25*sin(2*PI*220*t)+0.15*sin(2*PI*330.5*t)+0.05*sin(2*PI*1250*t)',
  'bass note': '0.5*sin(2*PI*55*t)',
  'room tone': '0.02*sin(2*PI*120*t)+0.01*sin(2*PI*240*t)+0.004*sin(2*PI*3100*t)'
}

function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true })
    const out: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))))
  })
}

async function render(source: string): Promise<Float32Array> {
  const graph = tightenGraph(SEGMENTS, 0, true)
  const raw = await ffmpeg([
    '-i', source, '-filter_complex', graph,
    '-map', '[acat]', '-ac', '1', '-f', 'f32le', '-',
    '-map', '[vcat]', '-f', 'null', '-'
  ])
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
}

function rms(x: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += x[i] * x[i]
  return Math.sqrt(sum / Math.max(1, to - from))
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  const joins: number[] = []
  let t = 0
  for (const seg of SEGMENTS.slice(0, -1)) {
    t += seg.end - seg.start
    joins.push(Math.round(t * RATE))
  }
  const kept = SEGMENTS.reduce((s, seg) => s + seg.end - seg.start, 0)

  console.log('bed          click ratio     dip   duration')
  let failed = false
  for (const [name, expr] of Object.entries(BEDS)) {
    const source = join(WORK, `${name.replace(/\s+/g, '-')}.mkv`)
    await ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=25:d=10',
      '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=10`,
      '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', '-shortest', source
    ])
    const x = await render(source)
    const steps = new Float32Array(x.length - 1)
    for (let i = 1; i < x.length; i++) steps[i - 1] = Math.abs(x[i] - x[i - 1])
    const near = new Set<number>()
    for (const j of joins) for (let k = j - 48; k <= j + 48; k++) near.add(k)
    const elsewhere = Array.from(steps).filter((_, i) => !near.has(i)).sort((a, b) => a - b)
    const p999 = elsewhere[Math.floor(elsewhere.length * 0.999)]
    const atJoins = Math.max(...joins.map((j) => Math.max(...steps.subarray(j - 48, j + 48))))
    const lowest = (from: number, to: number): number => {
      let low = Infinity
      for (let k = from; k + 240 <= to; k += 24) low = Math.min(low, rms(x, k, k + 240))
      return low
    }
    const dip = Math.min(...joins.map((j) => lowest(j - 480, j + 480)))
    let natural = Infinity
    for (let k = 0; k < joins.length; k++) {
      const from = (k === 0 ? 0 : joins[k - 1]) + 960
      natural = Math.min(natural, lowest(from, joins[k] - 960))
    }
    const dipDb = 20 * Math.log10(Math.max(1e-9, dip) / natural)
    const drift = x.length / RATE - kept
    const ratio = atJoins / p999
    console.log(
      `${name.padEnd(12)} ${ratio.toFixed(1).padStart(10)}x ${dipDb.toFixed(1).padStart(6)} dB ${(drift * 1000).toFixed(1).padStart(7)} ms`
    )
    if (ratio > 1 || Math.abs(drift) > 0.001) failed = true
  }
  if (check) {
    if (failed) {
      console.error('Clicks at tighten joins, or the audio length drifted.')
      process.exit(1)
    }
    console.log('No join steps above the material itself, and no drift.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
