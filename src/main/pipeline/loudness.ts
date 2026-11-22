import { FFMPEG_PATH, runBinaryFull } from './ffmpeg'

/**
 * Two-pass loudness normalisation.
 *
 * ffmpeg's loudnorm filter has two modes. Given nothing but a target it runs
 * in "dynamic" mode: a look-ahead gain rider that chases the target through
 * the clip. On speech that is audible as pumping — quiet asides swell, the
 * tail of a loud line ducks. Given the input's measured loudness it can
 * instead apply one linear gain for the whole clip (with true-peak limiting
 * only where needed), which is transparent. That is what every mastering
 * chain does and what this module makes the export do: measure first, then
 * normalise with the measurements.
 *
 * Social platforms normalise to about -14 LUFS, so exports master to match.
 */

export const TARGET_I = -14
export const TARGET_TP = -1.5
export const TARGET_LRA = 11

export interface LoudnessStats {
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetOffset: number
}

const TARGETS = `I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`

/** The measurement filter, for a first pass whose output is discarded. */
export const MEASURE_FILTER = `loudnorm=${TARGETS}:print_format=json`

/**
 * Most gain the limiter path will apply. A source this quiet is broken
 * (a muted mic, a wrong track), and pushing it 40 dB only amplifies noise.
 */
export const MAX_GAIN_DB = 30
/**
 * Ceiling for the limiter path, a little under the true-peak target: the
 * limiter measures sample peaks, and inter-sample peaks after encoding can
 * sit a few tenths of a dB above them.
 */
const LIMITER_CEILING_DB = -2

/**
 * The normalising filter.
 *
 * With measurements, one linear gain brings the clip to the target. Two ways
 * to apply it: loudnorm's own linear mode when it will accept the job, and a
 * plain gain into a true-peak limiter when it will not. loudnorm's linear
 * mode refuses (and silently reverts to the dynamic gain rider this exists to
 * avoid) when the source's loudness range exceeds the target range or the
 * gain would push the true peak over the ceiling — both routine for speech,
 * so the range target is raised to the measured range (it is a ceiling, not a
 * compressor setting) and peak-limited sources go through the limiter path.
 *
 * Without measurements it falls back to single-pass dynamic mode. Pure and
 * exported for tests.
 */
export function loudnormFilter(stats: LoudnessStats | null): string {
  if (!stats) return `loudnorm=${TARGETS}`
  const f = (v: number): string => v.toFixed(2)
  const gainDb = TARGET_I - stats.inputI
  const peakAfterGain = stats.inputTp + gainDb
  if (peakAfterGain <= TARGET_TP) {
    const lra = Math.max(TARGET_LRA, Math.ceil(stats.inputLra * 10) / 10)
    return (
      `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${f(lra)}` +
      `:measured_I=${f(stats.inputI)}:measured_TP=${f(stats.inputTp)}` +
      `:measured_LRA=${f(stats.inputLra)}:measured_thresh=${f(stats.inputThresh)}` +
      `:offset=${f(stats.targetOffset)}:linear=true`
    )
  }
  const gain = Math.min(MAX_GAIN_DB, gainDb)
  const ceiling = Math.pow(10, LIMITER_CEILING_DB / 20)
  return `volume=${f(gain)}dB,alimiter=limit=${ceiling.toFixed(4)}:attack=5:release=50:level=false`
}

/** Which path loudnormFilter takes for a measurement; exported for tests and logs. */
export function normalisationMode(stats: LoudnessStats | null): 'dynamic' | 'linear' | 'limited' {
  if (!stats) return 'dynamic'
  return stats.inputTp + (TARGET_I - stats.inputI) <= TARGET_TP ? 'linear' : 'limited'
}

/**
 * Pull the measurement block out of ffmpeg's stderr. loudnorm prints it as a
 * JSON object of string values after the encode log; the last `{…}` in the
 * output is it. Returns null when the block is missing or any value is not a
 * finite number (silent input reports "-inf"), in which case the caller
 * should fall back to the single-pass filter. Pure and exported for tests.
 */
export function parseLoudnormStats(stderr: string): LoudnessStats | null {
  const close = stderr.lastIndexOf('}')
  if (close === -1) return null
  const open = stderr.lastIndexOf('{', close)
  if (open === -1) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stderr.slice(open, close + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const num = (key: string): number | null => {
    const v = Number(raw[key])
    return Number.isFinite(v) ? v : null
  }
  const inputI = num('input_i')
  const inputTp = num('input_tp')
  const inputLra = num('input_lra')
  const inputThresh = num('input_thresh')
  const targetOffset = num('target_offset')
  if (
    inputI === null ||
    inputTp === null ||
    inputLra === null ||
    inputThresh === null ||
    targetOffset === null
  ) {
    return null
  }
  return { inputI, inputTp, inputLra, inputThresh, targetOffset }
}

/**
 * Measure the loudness of a span of the source's audio. Failures (no audio
 * stream, silent input, an odd ffmpeg build) return null so the render can
 * still proceed with the single-pass filter — measurement improves the
 * export, it must never block it.
 */
export async function measureLoudness(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  signal?: AbortSignal
): Promise<LoudnessStats | null> {
  try {
    const { stderr } = await runBinaryFull(
      FFMPEG_PATH,
      [
        '-hide_banner',
        '-nostats',
        '-ss', startSec.toFixed(3),
        '-t', durationSec.toFixed(3),
        '-i', sourcePath,
        '-vn',
        '-af', MEASURE_FILTER,
        '-f', 'null', '-'
      ],
      { signal }
    )
    return parseLoudnormStats(stderr)
  } catch (err) {
    if (signal?.aborted) throw err
    console.error('Loudness measurement failed; using single-pass normalisation:', err)
    return null
  }
}

/**
 * Measure several stretches of the source as the one programme they will be
 * exported as. A clip joined from distant moments is normalised on what it
 * plays; the minutes between them have no say in its level (and are not
 * decoded to find out).
 */
export async function measureLoudnessOfRanges(
  sourcePath: string,
  ranges: Array<{ start: number; end: number }>,
  signal?: AbortSignal
): Promise<LoudnessStats | null> {
  if (ranges.length === 1) return measureLoudness(sourcePath, ranges[0].start, ranges[0].end - ranges[0].start, signal)
  try {
    const inputs = ranges.flatMap((range) => [
      '-ss', range.start.toFixed(3), '-t', (range.end - range.start).toFixed(3), '-i', sourcePath
    ])
    const joined = `${ranges.map((_, i) => `[${i}:a]`).join('')}concat=n=${ranges.length}:v=0:a=1,${MEASURE_FILTER}`
    const { stderr } = await runBinaryFull(
      FFMPEG_PATH,
      ['-hide_banner', '-nostats', ...inputs, '-filter_complex', joined, '-vn', '-f', 'null', '-'],
      { signal }
    )
    return parseLoudnormStats(stderr)
  } catch (err) {
    if (signal?.aborted) throw err
    console.error('Loudness measurement failed; using single-pass normalisation:', err)
    return null
  }
}
