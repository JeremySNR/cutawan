import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpeakerTurn } from '@shared/types'
import { SpeakerEmbedder, speakerTurnsFrom, type Runner } from '../src/main/pipeline/diarize'
import { analyseSourceAudio } from '../src/main/pipeline/audioAnalysis'
import { FBANK_BINS, computeFbank, subtractMean } from '../src/main/pipeline/fbank'
import { planWindows } from '../src/main/pipeline/speakerTurns'

const SR = 16000

function audio(seconds: number): Float32Array {
  return Float32Array.from({ length: seconds * SR }, (_, i) => 0.3 * Math.sin(i * 0.05) + 0.1 * Math.sin(i * 0.37 + Math.sin(i * 0.001)))
}

describe('SpeakerEmbedder', () => {
  const speech = [{ start: 0.2, end: 4.1 }, { start: 5, end: 5.9 }, { start: 8, end: 11.5 }]

  it('embeds every planned window from the exact samples, in batches, whatever the chunking', async () => {
    const samples = audio(12)
    const calls: number[][] = []
    const seen = new Map<string, Float32Array>()
    const runner: Runner = (_model, inputs) => {
      const { data, dims } = inputs.x
      calls.push([...dims])
      const [batch, frames] = dims
      for (let b = 0; b < batch; b++) seen.set(`${frames}:${seen.size}`, data.slice(b * frames * FBANK_BINS, (b + 1) * frames * FBANK_BINS))
      return Promise.resolve({ embedding: { data: Float32Array.from({ length: batch * 4 }, (_, k) => Math.floor(k / 4) + 1), dims: [batch, 4] } })
    }
    const embedder = new SpeakerEmbedder(speech, 'model.onnx', runner)
    let maxBuffered = 0
    for (let at = 0, step = 517; at < samples.length; at += step, step = step === 517 ? 3001 : 517) {
      await embedder.push(samples.subarray(at, Math.min(samples.length, at + step)), at)
      maxBuffered = Math.max(maxBuffered, embedder.bufferedSamples)
    }
    await embedder.flush()
    const windows = planWindows(speech)
    expect(embedder.windows).toEqual(windows)
    expect(embedder.embeddings.every(e => e?.length === 4)).toBe(true)
    // Full windows go in batches; the 0.9 s region goes alone with fewer frames.
    expect(calls.some(([b, f]) => b > 1 && f === 148)).toBe(true)
    expect(calls).toContainEqual([1, 88, FBANK_BINS])
    // The first window's features are the fbank of exactly its samples, mean-normalised.
    const first = subtractMean(computeFbank(samples.subarray(Math.round(0.2 * SR), Math.round(1.7 * SR))))
    const sent = seen.get('148:0')!
    expect(sent.length).toBe(first.length)
    expect(Math.max(...sent.map((v, i) => Math.abs(v - first[i])))).toBeLessThan(1e-5)
    // Memory stays at about one window plus a stream chunk, not the source.
    expect(maxBuffered).toBeLessThan(2 * SR)
  })

  it('needs no samples outside speech and does nothing without windows', async () => {
    const embedder = new SpeakerEmbedder([{ start: 0, end: 0.3 }], 'model.onnx', () => Promise.reject(new Error('never called')))
    expect(embedder.windowCount).toBe(0)
    await embedder.push(audio(2), 0)
    await embedder.flush()
  })
})

describe('speakerTurnsFrom', () => {
  const speech = [{ start: 0, end: 10 }, { start: 10.5, end: 20 }, { start: 20.5, end: 30 }]
  const windows = planWindows(speech)
  const voice = (k: number): Float32Array => Float32Array.from({ length: 16 }, (_, i) => (i === k ? 1 : 0.05 * Math.sin(i * 7 + k)))

  it('labels alternating voices and aligns turns to the regions', () => {
    const embeddings = windows.map(w => voice(w.start >= 10.5 && w.start < 20.5 ? 1 : 0))
    expect(speakerTurnsFrom(windows, embeddings, speech, [])).toEqual([
      { start: 0, end: 10, speaker: 0 }, { start: 10.5, end: 20, speaker: 1 }, { start: 20.5, end: 30, speaker: 0 }
    ])
  })

  it('reports nothing for one voice or too little speech', () => {
    expect(speakerTurnsFrom(windows, windows.map(() => voice(0)), speech, [])).toEqual([])
    const few = windows.slice(0, 10)
    expect(speakerTurnsFrom(few, few.map((_, i) => voice(i % 2)), speech, [])).toEqual([])
  })
})

/**
 * The real CAM++ model on a fixture of two synthesized voices (espeak-ng,
 * 55 s, Opus). The model is downloaded on demand in the app, not shipped,
 * so this runs only when CUTAWAN_SPEAKER_MODEL points at it. Voice activity
 * comes from the fixture's own labels, so the test needs only the model.
 */
const modelPath = process.env.CUTAWAN_SPEAKER_MODEL
describe.skipIf(!modelPath || !existsSync(modelPath))('diarization with the CAM++ model', () => {
  const truth: SpeakerTurn[] = ([[0.5, 5.722, 0], [6.004, 10.635, 0], [11.476, 16.798, 1], [17.107, 22.374, 0], [23.24, 27.083, 1],
    [27.891, 38.08, 0], [38.861, 43.707, 1], [43.998, 49.395, 0], [50.15, 55.014, 1]] as const).map(([start, end, speaker]) => ({ start, end, speaker }))

  it('finds the two voices and when each speaks', async () => {
    const ort = await import('onnxruntime-node')
    const session = await ort.InferenceSession.create(modelPath!)
    const runner: Runner = async (_model, inputs) => {
      const out = await session.run({ x: new ort.Tensor('float32', inputs.x.data, inputs.x.dims) })
      const e = out.embedding
      return { embedding: { data: new Float32Array(e.data as Float32Array), dims: e.dims } }
    }
    const speech = truth.map(({ start, end }) => ({ start, end }))
    const raw = await analyseSourceAudio({ videoPath: join(__dirname, 'fixtures', 'two-voices.opus'), durationSec: 55.4, reactions: false,
      diarize: { speech, modelPath: modelPath! } }, () => {}, undefined, runner)
    const turns = speakerTurnsFrom(raw.embedded!.windows, raw.embedded!.embeddings, speech, [])
    expect(new Set(turns.map(t => t.speaker))).toEqual(new Set([0, 1]))
    let agree = 0, total = 0
    for (let t = 0.5; t < 55; t += 0.1) {
      const expected = truth.find(x => t >= x.start && t < x.end)?.speaker
      if (expected === undefined) continue
      total++
      if (turns.find(x => t >= x.start && t < x.end)?.speaker === expected) agree++
    }
    expect(agree / total).toBeGreaterThan(0.95)
  }, 60_000)
})
