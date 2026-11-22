import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FBANK_BINS, computeFbank, fbankFrameCount, subtractMean } from '../src/main/pipeline/fbank'

interface Fixture { frames: number[][] }
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'fbank-reference.json'), 'utf8')) as Fixture

/** The signal described in the fixture (generated with kaldi-native-fbank, dither 0, 80 bins). */
function signal(): Float64Array {
  const n = 1600
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / 16000
    x[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 1234.5 * t + 0.3)
      + 0.1 * Math.sin(2 * Math.PI * (100 + (1500 * i) / n) * t)
  }
  return x
}

describe('Kaldi fbank', () => {
  it('matches kaldi-native-fbank frame for frame', () => {
    const features = computeFbank(signal())
    expect(features.length / FBANK_BINS).toBe(fixture.frames.length)
    let worst = 0
    fixture.frames.forEach((frame, f) => frame.forEach((value, b) => {
      worst = Math.max(worst, Math.abs(features[f * FBANK_BINS + b] - value))
    }))
    // Float32 output vs a 4-decimal fixture; measured worst error ~1e-4.
    expect(worst).toBeLessThan(2e-3)
  })

  it('counts frames like snip_edges', () => {
    expect(fbankFrameCount(399)).toBe(0)
    expect(fbankFrameCount(400)).toBe(1)
    expect(fbankFrameCount(24000)).toBe(148) // a 1.5 s embedding window
  })

  it('removes the per-utterance mean', () => {
    const features = subtractMean(computeFbank(signal()))
    for (let b = 0; b < FBANK_BINS; b++) {
      let sum = 0
      for (let f = 0; f < features.length / FBANK_BINS; f++) sum += features[f * FBANK_BINS + b]
      expect(Math.abs(sum)).toBeLessThan(1e-3)
    }
  })
})
