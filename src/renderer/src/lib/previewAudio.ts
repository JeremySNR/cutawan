import {
  MUSIC_BED_LU,
  SFX_SPECS,
  WHOOSH_BAND,
  dbToGain,
  envelopeGain,
  sfxSample,
  whooshEnvelope,
  type SfxCue,
  type SfxKind
} from '@shared/audioMix'

/**
 * Sound effects and background music in the live preview, from the same
 * cues and ducking envelope the export uses (shared/audioMix.ts). WebAudio
 * plays them against the preview's output clock; levels are an estimate
 * (the export measures the speech and the track and mixes exactly).
 */

/** Speech level the preview assumes for the source (the export measures it). */
const PREVIEW_SPEECH_LUFS = -20
/** Typical loudness of a mastered music track (the export measures the real one). */
const PREVIEW_MUSIC_LUFS = -12
const SFX_REFERENCE_LUFS = -10

let context: AudioContext | null = null
const buffers = new Map<SfxKind, AudioBuffer>()

function audio(): AudioContext {
  if (!context) context = new AudioContext()
  if (context.state === 'suspended') void context.resume()
  return context
}

/** One-pole filters, enough to colour the whoosh noise like the export's highpass/lowpass. */
function onePole(samples: Float32Array, rate: number, cutoff: number, high: boolean): void {
  const a = Math.exp((-2 * Math.PI * cutoff) / rate)
  let low = 0
  for (let i = 0; i < samples.length; i++) {
    low = (1 - a) * samples[i] + a * low
    samples[i] = high ? samples[i] - low : low
  }
}

function sfxBuffer(kind: SfxKind): AudioBuffer {
  const cached = buffers.get(kind)
  if (cached) return cached
  const ctx = audio()
  const rate = ctx.sampleRate
  const length = Math.ceil(SFX_SPECS[kind].duration * rate)
  const data = new Float32Array(length)
  if (kind === 'whoosh') {
    // Pink-ish noise (Paul Kellet's economy filter), band-limited, enveloped.
    let b0 = 0, b1 = 0, b2 = 0
    let seed = 7
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const white = seed / 2 ** 31 - 1
      b0 = 0.99765 * b0 + white * 0.099046
      b1 = 0.963 * b1 + white * 0.2965164
      b2 = 0.57 * b2 + white * 1.0526913
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2
    }
    onePole(data, rate, WHOOSH_BAND.highpassHz, true)
    onePole(data, rate, WHOOSH_BAND.lowpassHz, false)
    for (let i = 0; i < length; i++) data[i] *= 0.8 * whooshEnvelope(i / rate)
  } else {
    for (let i = 0; i < length; i++) data[i] = sfxSample(kind, i / rate)
  }
  const buffer = ctx.createBuffer(1, length, rate)
  buffer.copyToChannel(data, 0)
  buffers.set(kind, buffer)
  return buffer
}

function sameCues(a: SfxCue[], b: SfxCue[]): boolean {
  return a.length === b.length && a.every((cue, i) => cue.kind === b[i].kind && cue.start === b[i].start)
}

export interface PreviewMix {
  cues: SfxCue[]
  /** media:// URL of the music track, or null. */
  musicUrl: string | null
  /** Music gain breakpoints relative to the bed level (musicGainEnvelope). */
  envelope: Array<{ t: number; gain: number }>
}

/**
 * Plays a PreviewMix in step with the preview. `sync(out)` (re)starts it at
 * output time `out`; `stop()` silences it; `tick(out)` keeps the music's
 * ducking on the envelope. Call sync again after any jump (seek, loop) —
 * continuous playback needs nothing more, the clocks run together. A mix
 * that changes what plays (music or effects toggled, cues moved by a trim)
 * while playing takes effect at once, from the last ticked time.
 *
 * Music plays through a plain audio element with its volume driven from the
 * shared envelope: routing a media:// file through WebAudio would be
 * cross-origin, and Chromium silences that.
 */
export class PreviewAudio {
  private sources: AudioBufferSourceNode[] = []
  private music: HTMLAudioElement | null = null
  private musicUrl: string | null = null
  /** Output time last synced or ticked while playing; null when stopped. */
  private playingAt: number | null = null
  /** Bumped by stop(), so a pending music start from an older sync is dropped. */
  private generation = 0
  /** Removes the loadedmetadata listener of a music start still waiting. */
  private pendingMetadata: (() => void) | null = null

  constructor(private mix: PreviewMix) {}

  update(mix: PreviewMix): void {
    const previous = this.mix
    this.mix = mix
    const changed = previous.musicUrl !== mix.musicUrl || !sameCues(previous.cues, mix.cues)
    if (changed && this.playingAt !== null) this.sync(this.playingAt)
  }

  get active(): boolean {
    return this.mix.cues.length > 0 || this.mix.musicUrl !== null
  }

  sync(out: number): void {
    this.stop()
    this.playingAt = out
    if (!this.active) return
    if (this.mix.cues.length) {
      const ctx = audio()
      const now = ctx.currentTime + 0.02
      for (const cue of this.mix.cues) {
        if (cue.start + SFX_SPECS[cue.kind].duration <= out) continue
        const node = ctx.createBufferSource()
        node.buffer = sfxBuffer(cue.kind)
        const gain = ctx.createGain()
        gain.gain.value = dbToGain(Math.min(0, PREVIEW_SPEECH_LUFS + SFX_SPECS[cue.kind].gainDb - SFX_REFERENCE_LUFS))
        node.connect(gain).connect(ctx.destination)
        node.start(now + Math.max(0, cue.start - out), Math.max(0, out - cue.start))
        this.sources.push(node)
      }
    }
    if (this.mix.musicUrl) this.startMusic(out)
  }

  /** Follow the ducking envelope; call on every preview frame while playing. */
  tick(out: number): void {
    if (this.playingAt !== null) this.playingAt = out
    if (this.music && !this.music.paused) {
      const bed = dbToGain(PREVIEW_SPEECH_LUFS + MUSIC_BED_LU - PREVIEW_MUSIC_LUFS)
      this.music.volume = Math.max(0, Math.min(1, bed * envelopeGain(this.mix.envelope, out)))
    }
  }

  private startMusic(out: number): void {
    if (!this.music || this.musicUrl !== this.mix.musicUrl) {
      this.music?.pause()
      const element = new Audio()
      element.src = this.mix.musicUrl!
      element.loop = true
      element.preload = 'auto'
      this.music = element
      this.musicUrl = this.mix.musicUrl
    }
    const element = this.music
    const generation = this.generation
    const seek = (): void => {
      // Stopped, resynced or switched track since: this start is stale.
      if (generation !== this.generation || element !== this.music) return
      if (Number.isFinite(element.duration) && element.duration > 0) element.currentTime = out % element.duration
      element.volume = 0
      void element.play().then(() => this.tick(out)).catch(() => undefined)
    }
    if (element.readyState >= 1) seek()
    else {
      const onMetadata = (): void => {
        element.removeEventListener('loadedmetadata', onMetadata)
        seek()
      }
      element.addEventListener('loadedmetadata', onMetadata)
      // stop() drops the listener when this start goes stale, so repeated
      // syncs before the metadata arrives do not stack up.
      this.pendingMetadata = () => element.removeEventListener('loadedmetadata', onMetadata)
    }
  }

  stop(): void {
    this.generation++
    this.playingAt = null
    this.pendingMetadata?.()
    this.pendingMetadata = null
    for (const node of this.sources) {
      try { node.stop() } catch { /* already ended */ }
    }
    this.sources = []
    this.music?.pause()
  }

  dispose(): void {
    this.stop()
    this.music = null
    this.musicUrl = null
  }
}
