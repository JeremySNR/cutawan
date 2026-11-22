/**
 * Measure reaction features on the synthetic sources the tests use, to
 * choose and document the thresholds in src/main/pipeline/reactions.ts.
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/calibrate-reactions.ts
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import { OVER_SPEECH_PERCENTILE, OVER_SPEECH_WINDOW_SEC, burstCount, detectReactions, reactionFeatures, smoothDb as smooth, speechMask, localPercentile, type ReactionFeatures } from '../src/main/pipeline/reactions'
import { syntheticWords, writeSynthetic, type SyntheticLayout } from '../tests/syntheticAudio'

const speech = [{ start: 0.5, end: 10 }, { start: 14, end: 25 }, { start: 32, end: 45 }, { start: 49, end: 59.5 }]
const sources: Record<string, SyntheticLayout> = {
  events: { durationSec: 60, speech, laughter: [10.5, 13], applause: [26, 31], impact: 47, musicDb: -35, roomDb: -60 },
  sting: { durationSec: 60, speech, sting: [26, 29], roomDb: -60 },
  overSpeech: { durationSec: 60, speech, overSpeech: [36, 39], overSpeechDb: 10, roomDb: -60 },
  overSpeechEqual: { durationSec: 60, speech, overSpeech: [36, 39], overSpeechDb: 0, roomDb: -60 },
  loudSpeech: { durationSec: 60, speech, loudSpeech: [32, 45], roomDb: -60 },
  musicOnly: { durationSec: 60, speech, musicDb: -26, roomDb: -60 },
  speechOnly: { durationSec: 60, speech, roomDb: -60 },
  silence: { durationSec: 60, speech: [] }
}

function decode(path: string): Float32Array {
  const out = spawnSync(FFMPEG_PATH, ['-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28 })
  const buf = out.stdout as Buffer
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

function stats(f: ReactionFeatures, a: number, b: number): string {
  const from = Math.round(a / f.hopSec), to = Math.round(b / f.hopSec)
  const pick = (arr: Float32Array): number[] => Array.from(arr.subarray(from, to))
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length
  const lv = pick(f.levelDb)
  const sd = Math.sqrt(mean(lv.map(x => (x - mean(lv)) ** 2)))
  const bursts = burstCount(f.levelDb, from, to, 6) / (b - a)
  return `level ${mean(lv).toFixed(1)} sd ${sd.toFixed(1)} fluxMax ${Math.max(...pick(f.flux), from > 0 ? f.flux[from - 1] : 0).toFixed(1)} ` +
    `flat ${mean(pick(f.flatness)).toFixed(2)} high ${mean(pick(f.highShare)).toFixed(2)} bursts/s ${bursts.toFixed(1)}`
}

const dir = mkdtempSync(join(tmpdir(), 'cutawan-calibrate-'))
try {
  for (const [name, layout] of Object.entries(sources)) {
    const path = join(dir, `${name}.wav`)
    writeSynthetic(layout, path)
    const started = performance.now()
    const features = reactionFeatures(decode(path))
    const ms = performance.now() - started
    console.log(`\n== ${name} (features ${ms.toFixed(0)} ms for ${layout.durationSec}s)`)
    if (layout.speech.length) console.log('  speech      ', stats(features, 15, 24))
    if (layout.laughter) console.log('  laughter    ', stats(features, ...layout.laughter))
    if (layout.applause) console.log('  applause    ', stats(features, ...layout.applause))
    if (layout.impact !== undefined) console.log('  impact      ', stats(features, layout.impact, layout.impact + 0.15))
    if (layout.sting) console.log('  sting       ', stats(features, ...layout.sting))
    if (layout.overSpeech) console.log('  overSpeech  ', stats(features, ...layout.overSpeech))
    console.log('  gap 46-48   ', stats(features, 45.3, 46.8))
    const words = syntheticWords(layout.speech)
    const context = { durationSec: layout.durationSec, speech: layout.speech, words }
    // Gap excess over floor and speech level, and over-speech excess, for documentation.
    const level = smooth(features.levelDb, 1)
    const sustained = smooth(features.levelDb, 3)
    const mask = speechMask(level.length, features.hopSec, context)
    const floor = localPercentile(level, i => !mask[i] && features.levelDb[i] > -70, features.hopSec, 20, 0.2)
    const localSpeech = localPercentile(sustained, i => mask[i] === 1 && features.levelDb[i] > -70, features.hopSec, OVER_SPEECH_WINDOW_SEC, OVER_SPEECH_PERCENTILE)
    const maxIn = (a: number, b: number, fn: (i: number) => number): number => {
      let m = -Infinity
      for (let i = Math.round(a / features.hopSec); i < Math.round(b / features.hopSec); i++) { const v = fn(i); if (!Number.isNaN(v)) m = Math.max(m, v) }
      return m
    }
    const gapExcess = (a: number, b: number): string => { const v = maxIn(a, b, i => mask[i] ? NaN : level[i] - floor[i]); let at = -1; for (let i = Math.round(a / features.hopSec); i < Math.round(b / features.hopSec); i++) if (!mask[i] && level[i] - floor[i] === v) at = i; return `${v.toFixed(1)}@${(at * features.hopSec).toFixed(2)}` }
    const speechExcess = (a: number, b: number): string => maxIn(a, b, i => mask[i] ? sustained[i] - localSpeech[i] : NaN).toFixed(1)
    console.log(`  gap excess over floor: 10-14 ${gapExcess(10, 14)}  25-32 ${gapExcess(25, 32)}  45-49 ${gapExcess(45, 49)}`)
    console.log(`  speech excess over the speaker's loud end: 14-25 ${speechExcess(14, 25)}  32-45 ${speechExcess(32, 45)}`)
    console.log('  reactions', JSON.stringify(detectReactions(features, context)))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
