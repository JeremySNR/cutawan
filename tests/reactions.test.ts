import { describe, expect, it } from 'vitest'
import {
  REACTION_HOP_SEC, REACTION_SAMPLE_RATE, REACTION_SPACING_SEC, ReactionAnalyzer, burstCount, classifyReaction, detectReactions,
  localPercentile, reactionFeatures, smooth, smoothDb, speechMask, type ReactionFeatures
} from '../src/main/pipeline/reactions'

const SR = REACTION_SAMPLE_RATE

/** Deterministic white noise in -1..1 (LCG), so tests never flake. */
function noise(seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  let s = seed
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = amplitude * ((s / 2 ** 32) * 2 - 1)
  }
  return out
}

function tone(seconds: number, amplitude: number, hz = 440): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / SR))
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const mean = (a: Float32Array, from: number, to: number): number => {
  let s = 0
  for (let i = from; i < to; i++) s += a[i]
  return s / (to - from)
}

describe('reaction features', () => {
  it('measures level in dBFS on 50 ms hops, frame k centred on k x 50 ms', () => {
    const f = reactionFeatures(tone(2, 1))
    expect(f.hopSec).toBe(0.05)
    expect(f.levelDb.length).toBe(40)
    expect(mean(f.levelDb, 5, 35)).toBeCloseTo(-3, 0) // a full-scale sine
    // Frame 0 straddles the stream start (half zeros), so it reads ~3 dB lower.
    expect(f.levelDb[0]).toBeLessThan(f.levelDb[10] - 2)
  })

  it('tells noise from a tone by flatness and high-band share', () => {
    const n = reactionFeatures(noise(1, 0.5))
    const t = reactionFeatures(tone(1, 0.5))
    expect(mean(n.flatness, 3, 17)).toBeGreaterThan(0.45)
    expect(mean(t.flatness, 3, 17)).toBeLessThan(0.02)
    expect(mean(n.highShare, 3, 17)).toBeGreaterThan(0.6)
    expect(mean(t.highShare, 3, 17)).toBeLessThan(0.01)
  })

  it('reports spectral flux at an onset, not in a steady sound', () => {
    const f = reactionFeatures(concat(noise(1, 0.001), noise(1, 0.5, 7)))
    const onset = Math.max(...f.flux.subarray(18, 23))
    expect(onset).toBeGreaterThan(20)
    expect(mean(f.flux, 26, 38)).toBeLessThan(6)
  })

  it('streams identically whatever the chunking', () => {
    const audio = concat(noise(0.7, 0.2), tone(0.6, 0.3))
    const whole = reactionFeatures(audio)
    const chunked = new ReactionAnalyzer()
    for (let i = 0; i < audio.length; i += 333) chunked.push(audio.subarray(i, i + 333))
    const f = chunked.finish()
    expect(Array.from(f.levelDb)).toEqual(Array.from(whole.levelDb))
    expect(Array.from(f.flux)).toEqual(Array.from(whole.flux))
  })
})

describe('smoothing and local statistics', () => {
  it('averages over a window that shrinks at the edges', () => {
    expect(Array.from(smooth(Float32Array.from([0, 3, 6, 9]), 1))).toEqual([1.5, 3, 6, 7.5])
  })

  it('smooths decibels in the power domain so a loud frame is not buried', () => {
    const v = smoothDb(Float32Array.from([-60, -10, -60]), 1)
    expect(v[1]).toBeGreaterThan(-15) // dB-domain mean would be -43
  })

  it('finds a local percentile of the selected frames on a one-second grid', () => {
    const values = new Float32Array(1200).fill(-40) // 60 s of 50 ms frames
    for (let i = 600; i < 1200; i++) values[i] = -20
    const p = localPercentile(values, () => true, REACTION_HOP_SEC, 5, 0.5)
    expect(p[100]).toBe(-40)
    expect(p[1100]).toBe(-20)
    const none = localPercentile(values, () => false, REACTION_HOP_SEC, 5, 0.5)
    expect(Number.isNaN(none[0])).toBe(true)
  })

  it('counts bursts of sufficient prominence', () => {
    // 5 bursts per second for 2 s: -10 dB peaks over -30 dB dips.
    const level = Float32Array.from({ length: 40 }, (_, i) => (i % 4 === 1 ? -10 : -30))
    expect(burstCount(level, 0, 40, 6)).toBe(10)
    expect(burstCount(level.map(v => v / 10), 0, 40, 6)).toBe(0) // 2 dB wiggles
  })
})

describe('speech mask', () => {
  it('marks word runs, stretched to the voice-activity edge nearby but not across a wordless stretch', () => {
    const words = [{ text: 'a', start: 1, end: 1.3 }, { text: 'b', start: 1.4, end: 1.8 }]
    // VAD hears speech until 2.1 (trailing syllable) and laughter 2.6–4 in the same region.
    const mask = speechMask(100, 0.05, { durationSec: 5, words, speech: [{ start: 0.95, end: 4 }] })
    const at = (t: number): number => mask[Math.round(t / 0.05)]
    expect(at(1.5)).toBe(1)
    expect(at(0.5)).toBe(0)
    expect(at(3)).toBe(0) // laughter inside the VAD region stays a gap
    // Without words, VAD is all there is.
    // A VAD region opening up to 0.8 s before its first word is that word's real start.
    const lateWord = speechMask(100, 0.05, { durationSec: 5, words: [{ text: 'c', start: 1.54, end: 2 }], speech: [{ start: 1, end: 2.1 }] })
    expect(lateWord[Math.round(1.1 / 0.05)]).toBe(1)
    const vadOnly = speechMask(100, 0.05, { durationSec: 5, speech: [{ start: 0.95, end: 4 }] })
    expect(vadOnly[Math.round(3 / 0.05)]).toBe(1)
  })
})

/** Features built directly: a speech/gap pattern with chosen levels. */
function synthetic(seconds: number, fill: (t: number) => { level: number; flatness?: number; high?: number; flux?: number }): ReactionFeatures {
  const n = Math.round(seconds / REACTION_HOP_SEC)
  const f: ReactionFeatures = {
    hopSec: REACTION_HOP_SEC, levelDb: new Float32Array(n), flux: new Float32Array(n), flatness: new Float32Array(n), highShare: new Float32Array(n)
  }
  for (let i = 0; i < n; i++) {
    const v = fill(i * REACTION_HOP_SEC)
    f.levelDb[i] = v.level; f.flux[i] = v.flux ?? 2; f.flatness[i] = v.flatness ?? 0.15; f.highShare[i] = v.high ?? 0.15
  }
  return f
}

describe('detectReactions', () => {
  const speech = [{ start: 0, end: 20 }, { start: 25, end: 60 }]
  const words = speech.flatMap(r => Array.from({ length: Math.floor((r.end - r.start) / 0.4) }, (_, k) =>
    ({ text: 'w', start: r.start + k * 0.4, end: r.start + k * 0.4 + 0.3 })))
  const inSpeech = (t: number): boolean => speech.some(r => t >= r.start && t < r.end)

  it('finds loud sound in a gap and leaves ordinary speech and room tone alone', () => {
    const f = synthetic(60, t => t >= 21 && t < 23.5 ? { level: -18, flatness: 0.55, high: 0.7 } : inSpeech(t) ? { level: -20 } : { level: -60 })
    const reactions = detectReactions(f, { durationSec: 60, speech, words })
    expect(reactions).toHaveLength(1)
    expect(reactions[0].start).toBeCloseTo(21, 0)
    expect(reactions[0].end).toBeCloseTo(23.5, 0)
    expect(reactions[0].kind).toBe('applause')
    expect(reactions[0].strength).toBeGreaterThan(0)
    expect(reactions[0].strength).toBeLessThanOrEqual(1)
  })

  it('ignores gap sound far below speech level', () => {
    const f = synthetic(60, t => t >= 21 && t < 23.5 ? { level: -40 } : inSpeech(t) ? { level: -20 } : { level: -60 })
    expect(detectReactions(f, { durationSec: 60, speech, words })).toEqual([])
  })

  it('catches a crowd well above the speaker, but not emphasis', () => {
    const crowd = synthetic(60, t => t >= 40 && t < 43 ? { level: -9, flux: 8, flatness: 0.4 } : inSpeech(t) ? { level: -20 } : { level: -60 })
    const found = detectReactions(crowd, { durationSec: 60, speech, words })
    expect(found).toHaveLength(1)
    expect(found[0].start).toBeCloseTo(40, 0)
    const emphasis = synthetic(60, t => t >= 40 && t < 43 ? { level: -15, flux: 3 } : inSpeech(t) ? { level: -20 } : { level: -60 })
    expect(detectReactions(emphasis, { durationSec: 60, speech, words })).toEqual([])
  })

  it('leaves a real voice alone: stressed syllables and a word Whisper starts late', () => {
    // Measured shape of a real (TTS) voice: syllables peak ~8 dB over the
    // median with dips between them, and the second voice's first word is
    // timed 0.54 s after its voice activity starts.
    const late = words.map(w => w.start < 25 || w.start >= 26 ? w : { ...w, start: w.start + 0.54, end: Math.min(w.end + 0.54, w.start + 0.94) })
      .filter(w => w.start < 20 || w.start >= 25.54)
    const voice = (t: number): { level: number; flux?: number } => {
      const phase = (t % 0.4) / 0.4
      return phase < 0.15 ? { level: -12, flux: 9 } : phase < 0.6 ? { level: -22, flux: 6 } : { level: -34, flux: 4 }
    }
    const f = synthetic(60, t => inSpeech(t) ? voice(t) : { level: -120 })
    expect(detectReactions(f, { durationSec: 60, speech, words: late })).toEqual([])
    // A crowd over the same voice, 10 dB above its peaks, is still heard.
    const crowd = synthetic(60, t => t >= 40 && t < 43 ? { level: -2, flux: 12, flatness: 0.4 } : inSpeech(t) ? voice(t) : { level: -120 })
    const found = detectReactions(crowd, { durationSec: 60, speech, words: late })
    expect(found).toHaveLength(1)
    expect(found[0].start).toBeCloseTo(40, 0)
  })

  it('keeps at most one reaction per 20 s on average, the strongest', () => {
    // Ten gap bursts in 60 s of otherwise quiet source, rising in level.
    const bursts = Array.from({ length: 10 }, (_, k) => ({ start: 2 + k * 6, end: 3 + k * 6, level: -30 + k * 2 }))
    const f = synthetic(60, t => {
      const b = bursts.find(x => t >= x.start && t < x.end)
      return b ? { level: b.level } : { level: -60 }
    })
    const reactions = detectReactions(f, { durationSec: 60 })
    expect(reactions).toHaveLength(60 / REACTION_SPACING_SEC)
    expect(reactions.map(r => Math.round(r.start))).toEqual([44, 50, 56])
    expect(reactions[2].strength).toBe(1)
    expect(reactions.every((r, i) => i === 0 || r.start > reactions[i - 1].start)).toBe(true)
  })

  it('returns nothing for silence', () => {
    expect(detectReactions(synthetic(30, () => ({ level: -120 })), { durationSec: 30 })).toEqual([])
  })
})

describe('classifyReaction', () => {
  it('names a kind only on clear evidence', () => {
    const impact = synthetic(1, t => ({ level: -15, flux: t < 0.1 ? 40 : 2 }))
    expect(classifyReaction(impact, 1, 5)).toBe('impact')
    const laugh = synthetic(3, t => ({ level: Math.floor(t / 0.05) % 4 === 1 ? -15 : -30, flatness: 0.35, high: 0.5 }))
    expect(classifyReaction(laugh, 0, 60)).toBe('laughter')
    const sting = synthetic(3, () => ({ level: -15, flatness: 0.01, high: 0.01 }))
    expect(classifyReaction(sting, 0, 60)).toBe('music')
    const vague = synthetic(3, () => ({ level: -15, flatness: 0.2, high: 0.2 }))
    expect(classifyReaction(vague, 0, 60)).toBe('other')
  })
})
