import { describe, expect, it } from 'vitest'
import {
  loudnormFilter,
  MAX_GAIN_DB,
  MEASURE_FILTER,
  normalisationMode,
  parseLoudnormStats,
  refineLimiterGain
} from '../src/main/pipeline/loudness'

const STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source.mp4':
  Duration: 00:00:30.00, start: 0.000000, bitrate: 2500 kb/s
[Parsed_loudnorm_0 @ 0x55d0] 
{
\t"input_i" : "-27.61",
\t"input_tp" : "-4.47",
\t"input_lra" : "18.06",
\t"input_thresh" : "-39.20",
\t"output_i" : "-22.03",
\t"output_tp" : "-1.50",
\t"output_lra" : "9.50",
\t"output_thresh" : "-32.60",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.47"
}
`

describe('parseLoudnormStats', () => {
  it('reads the measurement block loudnorm prints on stderr', () => {
    expect(parseLoudnormStats(STDERR)).toEqual({
      inputI: -27.61,
      inputTp: -4.47,
      inputLra: 18.06,
      inputThresh: -39.2,
      targetOffset: 0.47
    })
  })

  it('returns null for silent input (loudnorm reports -inf)', () => {
    const silent = STDERR.replace('"-27.61"', '"-inf"')
    expect(parseLoudnormStats(silent)).toBeNull()
  })

  it('returns null when there is no block at all', () => {
    expect(parseLoudnormStats('ffmpeg version 6.1\nno audio here')).toBeNull()
    expect(parseLoudnormStats('{ not json')).toBeNull()
  })
})

describe('loudnormFilter', () => {
  it('runs single-pass when nothing was measured', () => {
    expect(loudnormFilter(null)).toBe('loudnorm=I=-14:TP=-1.5:LRA=11')
  })

  it('feeds the measurements back for linear normalisation when peaks allow', () => {
    // -27.61 -> -14 needs +13.61 dB; TP -4.47 would land at +9.1, over the
    // ceiling, so this source cannot take the loudnorm linear path.
    const stats = parseLoudnormStats(STDERR)!
    expect(normalisationMode(stats)).toBe('limited')
    const quiet = { ...stats, inputTp: -16 }
    expect(normalisationMode(quiet)).toBe('linear')
    // The range target is raised to the measured range (18.06 -> 18.1):
    // loudnorm refuses linear mode when the target is below the source.
    expect(loudnormFilter(quiet)).toBe(
      'loudnorm=I=-14:TP=-1.5:LRA=18.10:measured_I=-27.61:measured_TP=-16.00:measured_LRA=18.06:measured_thresh=-39.20:offset=0.47:linear=true'
    )
  })

  it('keeps the default range target for narrow-range sources', () => {
    const stats = { inputI: -20, inputTp: -10, inputLra: 4.4, inputThresh: -31, targetOffset: 0.1 }
    expect(loudnormFilter(stats)).toContain(':LRA=11.00:')
  })

  it('applies a plain gain into a limiter when the peak would exceed the ceiling', () => {
    const stats = { inputI: -24, inputTp: -6, inputLra: 9, inputThresh: -35, targetOffset: 0.3 }
    expect(normalisationMode(stats)).toBe('limited')
    // +10 dB gain, limiter just under -1.5 dBTP, no auto-levelling.
    expect(loudnormFilter(stats)).toBe('volume=10.00dB,alimiter=limit=0.7943:attack=5:release=50:level=false')
  })

  it('caps the limiter-path gain for broken, near-silent sources', () => {
    const stats = { inputI: -60, inputTp: -20, inputLra: 5, inputThresh: -70, targetOffset: 0 }
    expect(loudnormFilter(stats)).toContain(`volume=${MAX_GAIN_DB.toFixed(2)}dB`)
  })

  it('measures the stereo mix against the same targets it normalises to', () => {
    expect(MEASURE_FILTER).toBe('aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json')
  })
})

describe('refineLimiterGain', () => {
  const limited = { inputI: -24, inputTp: -6, inputLra: 9, inputThresh: -34, targetOffset: 0 }
  /** A limiter that eats a fixed share of every dB pushed into it. */
  const limiter = (lossPerDb: number) => async (chain: string): Promise<number> => {
    const gain = Number(/volume=(-?[\d.]+)dB/.exec(chain)![1])
    return limited.inputI + gain - lossPerDb * gain
  }

  it('raises the gain until the limited clip reaches the target', async () => {
    const refined = await refineLimiterGain(limited, limiter(0.15))
    // Plain estimate is +10 dB, which the limiter leaves 1.5 LU short.
    expect(refined.limiterGainDb).toBeGreaterThan(10)
    const result = await limiter(0.15)(loudnormFilter(refined))
    expect(Math.abs(result - -14)).toBeLessThan(0.3)
    expect(loudnormFilter(refined)).toContain('alimiter=')
  })

  it('keeps the plain gain when the limiter already lands on target', async () => {
    const refined = await refineLimiterGain(limited, limiter(0))
    expect(refined.limiterGainDb).toBe(10)
  })

  it('never exceeds the gain cap and survives a failed measurement', async () => {
    const silent = { ...limited, inputI: -60 }
    expect((await refineLimiterGain(silent, limiter(0.5))).limiterGainDb).toBe(MAX_GAIN_DB)
    expect((await refineLimiterGain(limited, async () => null)).limiterGainDb).toBe(10)
  })
})
