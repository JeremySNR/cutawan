import type { SpeakerTurn, SpeechRegion, TranscriptWord } from '@shared/types'
import { createInferenceClient } from '../inference/client'
import type { TensorData } from '../inference/protocol'
import { FBANK_BINS, FBANK_SAMPLE_RATE, computeFbank, fbankFrameCount, subtractMean } from './fbank'
import { alignTurnsToWords, clusterSpeakers, labelTimeline, planWindows, type EmbeddingWindow } from './speakerTurns'

/**
 * Speaker diarization runtime: speaker embeddings for windows over voice
 * activity, computed while the source audio streams past (see
 * audioAnalysis.ts), then clustered into voices and aligned to words.
 */

/** Windows per inference request: CAM++ ran 14 ms/window batched by 8 vs 33 ms alone (2-core CPU). */
const BATCH = 16

export type Runner = (modelPath: string, inputs: Record<string, TensorData>, signal?: AbortSignal) => Promise<Record<string, TensorData>>

let client: ReturnType<typeof createInferenceClient> | undefined
/** Own inference child, so a failure here cannot latch the one automatic framing uses. */
const defaultRunner: Runner = (modelPath, inputs, signal) => {
  client ??= createInferenceClient(undefined, 'Speaker detection')
  return client.run(modelPath, inputs, signal)
}

/**
 * Consumes 16 kHz samples in order and embeds each planned window once the
 * stream has passed its end. Holds only the samples of windows still open
 * (one window plus a hop), whatever the source length.
 */
export class SpeakerEmbedder {
  readonly windows: EmbeddingWindow[]
  readonly embeddings: Array<Float32Array | undefined>
  private next = 0
  private buffer = new Float32Array(FBANK_SAMPLE_RATE * 4)
  private bufferStart = 0 // absolute sample index of buffer[0]
  private bufferLength = 0
  private queue: Array<{ index: number; features: Float32Array; frames: number }> = []

  constructor(speech: SpeechRegion[], private readonly modelPath: string, private readonly run: Runner = defaultRunner,
    private readonly signal?: AbortSignal) {
    this.windows = planWindows(speech)
    this.embeddings = new Array(this.windows.length)
  }

  get windowCount(): number { return this.windows.length }
  /** Samples held right now (for tests: stays near one window). */
  get bufferedSamples(): number { return this.bufferLength }

  /** Feed the next samples of the stream (absolute index `startSample`). */
  async push(samples: Float32Array, startSample: number): Promise<void> {
    if (this.next >= this.windows.length) return
    const end = startSample + samples.length
    // Keep only samples from the earliest open window on.
    const keepFrom = Math.round(this.windows[this.next].start * FBANK_SAMPLE_RATE)
    if (end <= keepFrom) { this.bufferStart = end; this.bufferLength = 0; return }
    const from = Math.max(startSample, keepFrom)
    if (this.bufferLength === 0) this.bufferStart = from
    this.append(samples.subarray(from - startSample))
    while (this.next < this.windows.length) {
      const w = this.windows[this.next]
      const a = Math.round(w.start * FBANK_SAMPLE_RATE), b = Math.round(w.end * FBANK_SAMPLE_RATE)
      if (b > this.bufferStart + this.bufferLength) break
      const slice = this.buffer.subarray(Math.max(0, a - this.bufferStart), b - this.bufferStart)
      const frames = fbankFrameCount(slice.length)
      if (frames > 0) this.queue.push({ index: this.next, features: subtractMean(computeFbank(slice)), frames })
      this.next++
      if (this.queue.length >= BATCH) await this.flush()
    }
    // Drop what no remaining window needs.
    const need = this.next < this.windows.length ? Math.round(this.windows[this.next].start * FBANK_SAMPLE_RATE) : Infinity
    const drop = Math.min(this.bufferLength, Math.max(0, need - this.bufferStart))
    if (drop > 0) {
      this.buffer.copyWithin(0, drop, this.bufferLength)
      this.bufferLength -= drop
      this.bufferStart += drop
    }
  }

  /** Embed whatever is queued; call once the stream ends. */
  async flush(): Promise<void> {
    // Batch windows of equal length (all full windows; short regions go alone).
    const byFrames = new Map<number, typeof this.queue>()
    for (const item of this.queue) { const g = byFrames.get(item.frames) ?? []; g.push(item); byFrames.set(item.frames, g) }
    this.queue = []
    for (const [frames, group] of byFrames) {
      this.signal?.throwIfAborted()
      const data = new Float32Array(group.length * frames * FBANK_BINS)
      group.forEach((item, k) => data.set(item.features, k * frames * FBANK_BINS))
      const out = await this.run(this.modelPath, { x: { data, dims: [group.length, frames, FBANK_BINS] } }, this.signal)
      const embedding = out.embedding ?? Object.values(out)[0]
      const dim = embedding.dims[embedding.dims.length - 1]
      group.forEach((item, k) => { this.embeddings[item.index] = embedding.data.slice(k * dim, (k + 1) * dim) })
    }
  }

  private append(samples: Float32Array): void {
    if (this.bufferLength + samples.length > this.buffer.length) {
      const next = new Float32Array(Math.max(this.buffer.length * 2, this.bufferLength + samples.length))
      next.set(this.buffer.subarray(0, this.bufferLength))
      this.buffer = next
    }
    this.buffer.set(samples, this.bufferLength)
    this.bufferLength += samples.length
  }
}

/** Fewer windows than this (~15 s of speech) is too little to tell voices apart. */
const MIN_WINDOWS = 20

/**
 * Speaker turns from embedded windows, or [] when only one voice is heard
 * (or too little speech to say).
 */
export function speakerTurnsFrom(windows: EmbeddingWindow[], embeddings: Array<Float32Array | undefined>,
  speech: SpeechRegion[], words: TranscriptWord[]): SpeakerTurn[] {
  const usable = windows.map((w, i) => ({ w, e: embeddings[i] })).filter((x): x is { w: EmbeddingWindow; e: Float32Array } => !!x.e)
  if (usable.length < MIN_WINDOWS) return []
  const labels = clusterSpeakers(usable.map(x => x.e))
  if (new Set(labels).size < 2) return []
  const timeline = labelTimeline(usable.map(x => x.w), labels, speech)
  return alignTurnsToWords(timeline, words)
}
