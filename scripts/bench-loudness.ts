/**
 * Checks that exports land on the loudness target without overshooting the
 * true-peak ceiling, for mono and stereo sources.
 *
 * Generates deterministic speech-like test signals (a voiced, syllable-paced
 * buzz with pauses, plus variants: quiet, with sharp transients, over a bright
 * music bed, already hot), runs each through the export's real master chain
 * (measure, then linear gain or gain + limiter, then AAC at the export bitrate)
 * and measures the result with ffmpeg's EBU R128 scanner.
 *
 * Makes no API calls. Run with:
 *   npx tsx --tsconfig tsconfig.node.json scripts/bench-loudness.ts [--check]
 *
 * `--check` fails when any export misses the target by more than 1.5 LU or
 * has a true peak above -1 dBTP.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import { STEREO, TARGET_I, loudnormFilter, measureLoudness, normalisationMode } from '../src/main/pipeline/loudness'

const WORK = join(process.cwd(), '.tmp', 'loudness-bench')
const SECONDS = 20

/**
 * Speech-like source: a 110-190 Hz buzz with harmonics, gated into ~4 Hz
 * syllables with a pause every few seconds, plus a little breath noise.
 */
const VOICE =
  "(0.55*sin(2*PI*(150+40*sin(2*PI*0.3*t))*t)+0.3*sin(4*PI*(150+40*sin(2*PI*0.3*t))*t)+0.15*sin(6*PI*(150+40*sin(2*PI*0.3*t))*t))" +
  '*pow(max(0,sin(2*PI*4.1*t)),2)*(0.6+0.4*sin(2*PI*0.23*t))*gt(mod(t,3.7),0.45)'

interface Signal { name: string; expr: string; gainDb: number }

const SIGNALS: Signal[] = [
  { name: 'speech', expr: VOICE, gainDb: -6 },
  { name: 'quiet', expr: VOICE, gainDb: -26 },
  { name: 'transients', expr: `${VOICE}*0.5+if(lt(mod(t,1.7),0.004),0.95*sin(2*PI*3000*t),0)`, gainDb: -3 },
  { name: 'music bed', expr: `${VOICE}*0.7+0.12*sgn(sin(2*PI*220*t))`, gainDb: -4 },
  { name: 'hot', expr: `min(0.98,max(-0.98,4*${VOICE}))`, gainDb: 0 }
]

function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-nostats', '-y', ...args], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))))
  })
}

async function measureOutput(path: string): Promise<{ i: number; tp: number }> {
  const log = await ffmpeg(['-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const i = Number(/Integrated loudness:\s+I:\s+(-?[\d.]+)/.exec(log)?.[1])
  const tp = Number(/True peak:\s+Peak:\s+(-?[\d.]+)/.exec(log)?.[1])
  return { i, tp }
}

interface Row { name: string; layout: string; mode: string; i: number; tp: number }

async function run(signal: Signal, channels: 1 | 2): Promise<Row> {
  const slug = `${signal.name.replace(/\s+/g, '-')}-${channels}ch`
  const source = join(WORK, `${slug}.wav`)
  await ffmpeg([
    '-f', 'lavfi', '-i', `aevalsrc='${signal.expr}':s=48000:d=${SECONDS}`,
    '-af', `volume=${signal.gainDb}dB`, '-ac', String(channels), source
  ])
  // The export's master chain, as render.ts builds it (minus the end fade).
  const stats = await measureLoudness(source, 0, SECONDS)
  const chain = `${STEREO},${loudnormFilter(stats)},aresample=48000,${STEREO}`
  const out = join(WORK, `${slug}.m4a`)
  await ffmpeg(['-i', source, '-af', chain, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out])
  const { i, tp } = await measureOutput(out)
  return { name: signal.name, layout: channels === 1 ? 'mono' : 'stereo', mode: normalisationMode(stats), i, tp }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  const rows: Row[] = []
  for (const s of SIGNALS) for (const ch of [1, 2] as const) rows.push(await run(s, ch))

  console.log(`signal       layout  path      loudness   error   true peak   (target ${TARGET_I} LUFS)`)
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(12)} ${r.layout.padEnd(7)} ${r.mode.padEnd(8)} ${r.i.toFixed(1).padStart(6)} LUFS ` +
        `${(r.i - TARGET_I >= 0 ? '+' : '') + (r.i - TARGET_I).toFixed(1)} LU ${r.tp.toFixed(1).padStart(6)} dBTP`
    )
  }
  for (const layout of ['mono', 'stereo']) {
    const set = rows.filter((r) => r.layout === layout)
    const worst = Math.max(...set.map((r) => Math.abs(r.i - TARGET_I)))
    const mean = set.reduce((s, r) => s + Math.abs(r.i - TARGET_I), 0) / set.length
    const peak = Math.max(...set.map((r) => r.tp))
    console.log(`${layout.padEnd(6)}: mean error ${mean.toFixed(2)} LU, worst ${worst.toFixed(1)} LU, highest true peak ${peak.toFixed(1)} dBTP`)
  }

  if (check) {
    const bad = rows.filter((r) => Math.abs(r.i - TARGET_I) > 1.5 || r.tp > -1)
    if (bad.length) {
      console.error(`Off target: ${bad.map((r) => `${r.name} (${r.layout})`).join(', ')}`)
      process.exit(1)
    }
    console.log('Every export is within 1.5 LU of target and under -1 dBTP.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
