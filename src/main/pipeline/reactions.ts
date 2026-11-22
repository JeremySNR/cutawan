import type { AudioReaction, SpeechRegion, TranscriptWord } from '@shared/types'
import { fft } from './mfcc'

/**
 * Audio reactions ("excitement"): stretches of non-speech sound that stand
 * out from the rest of the source — laughter, applause, a crowd, an impact,
 * a music sting. Pure DSP over 16 kHz mono samples, so the maths is testable
 * without ffmpeg; `audioAnalysis.ts` does the decoding.
 *
 * Every 50 ms we measure loudness, spectral flux (how much the spectrum
 * rises frame to frame), spectral flatness (noise-like vs tonal) and the
 * share of energy above 2 kHz. A reaction is sound that is clearly above
 * its own context: in the gaps between words, above the local non-speech
 * floor and near speech level; over speech, well above that speaker's own
 * level around it and spectrally novel. Levels are always compared within
 * the source, so a quiet recording and a loud one behave the same.
 *
 * Thresholds were chosen on synthetic ffmpeg sources (tests/reactions*.test.ts
 * and the measured numbers next to each constant); every one errs towards
 * missing a reaction rather than inventing one.
 */

export const REACTION_SAMPLE_RATE = 16000
/** 50 ms hop, 64 ms Hann frames: fine enough to time an impact, cheap for hours. */
export const REACTION_HOP = 800
export const REACTION_HOP_SEC = REACTION_HOP / REACTION_SAMPLE_RATE
const FRAME = 1024
const BIN_HZ = REACTION_SAMPLE_RATE / FRAME
const SILENCE_DB = -70
const FLUX_BANDS = 20
/** Band levels floor at -80 dB re full-scale white noise, 10 dB under the silence gate. */
const BAND_FLOOR_DB = -80
const HANN_POWER = (3 * FRAME) / 8

export interface ReactionFeatures {
  hopSec: number
  /** Frame loudness, dBFS (a full-scale sine reads -3). */
  levelDb: Float32Array
  /** Mean positive rise of 20 log-spaced band energies vs the previous frame, dB. */
  flux: Float32Array
  /** Spectral flatness 200 Hz–6 kHz: white noise ~0.56, a pure tone ~0. */
  flatness: Float32Array
  /** Share of energy above 2 kHz (speech ~0.05–0.2, applause ~0.6). */
  highShare: Float32Array
}

/** Growable Float32 column, so a multi-hour stream never needs a size up front. */
class Column {
  data = new Float32Array(4096)
  length = 0
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = v
  }
  finish(): Float32Array { return this.data.slice(0, this.length) }
}

/**
 * Streaming feature extractor: push samples as they decode, read features at
 * the end. Holds one frame of audio plus ~16 bytes per 50 ms of source
 * (about 1.2 MB per hour).
 */
export class ReactionAnalyzer {
  private readonly ring = new Float32Array(FRAME)
  private readonly ordered = new Float32Array(FRAME)
  private pos = 0
  // Frame k ends at sample k*HOP + FRAME/2, so it is centred on k*HOP.
  private sinceHop = REACTION_HOP - FRAME / 2
  private readonly window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME))
  private readonly buf = new Float64Array(FRAME * 2)
  private readonly bandEdges: number[]
  private readonly previousBands = new Float64Array(FLUX_BANDS).fill(BAND_FLOOR_DB)
  private readonly bands = new Float64Array(FLUX_BANDS)
  private readonly columns = { level: new Column(), flux: new Column(), flatness: new Column(), high: new Column() }

  constructor() {
    // Log-spaced flux bands, 100 Hz to 7 kHz.
    this.bandEdges = Array.from({ length: FLUX_BANDS + 1 }, (_, b) =>
      Math.round((100 * Math.pow(70, b / FLUX_BANDS)) / BIN_HZ))
  }

  /** Feed mono samples in -1..1. Frame k is centred on k x 50 ms. */
  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.pos] = samples[i]
      this.pos = (this.pos + 1) & (FRAME - 1)
      if (++this.sinceHop === REACTION_HOP) {
        this.sinceHop = 0
        this.frame()
      }
    }
  }

  finish(): ReactionFeatures {
    const c = this.columns
    return { hopSec: REACTION_HOP_SEC, levelDb: c.level.finish(), flux: c.flux.finish(), flatness: c.flatness.finish(), highShare: c.high.finish() }
  }

  private frame(): void {
    // The ring holds the latest FRAME samples, oldest at `pos` (zeros before
    // the stream filled it).
    const x = this.ordered
    for (let i = 0; i < FRAME; i++) x[i] = this.ring[(this.pos + i) & (FRAME - 1)]
    let energy = 0
    for (let i = 0; i < FRAME; i++) energy += x[i] * x[i]
    const levelDb = 10 * Math.log10(energy / FRAME + 1e-12)
    this.columns.level.push(levelDb)
    if (levelDb < SILENCE_DB) {
      this.columns.flatness.push(0)
      this.columns.high.push(0)
      this.bands.fill(BAND_FLOOR_DB)
      this.pushFlux()
      return
    }
    const buf = this.buf
    buf.fill(0)
    for (let i = 0; i < FRAME; i++) buf[2 * i] = x[i] * this.window[i]
    fft(buf)
    const power = (k: number): number => buf[2 * k] * buf[2 * k] + buf[2 * k + 1] * buf[2 * k + 1]
    let logSum = 0, sum = 0, n = 0, high = 0, total = 0
    const flatLo = Math.round(200 / BIN_HZ), flatHi = Math.round(6000 / BIN_HZ)
    const highLo = Math.round(2000 / BIN_HZ), totalLo = Math.round(100 / BIN_HZ)
    for (let k = totalLo; k < FRAME / 2; k++) {
      const p = power(k)
      total += p
      if (k >= highLo) high += p
      if (k >= flatLo && k <= flatHi) { logSum += Math.log(p + 1e-20); sum += p; n++ }
    }
    this.columns.flatness.push(sum > 0 ? Math.exp(logSum / n) / (sum / n) : 0)
    this.columns.high.push(total > 0 ? high / total : 0)
    for (let b = 0; b < FLUX_BANDS; b++) {
      const lo = this.bandEdges[b], hi = Math.max(lo + 1, this.bandEdges[b + 1])
      let e = 0
      for (let k = lo; k < hi; k++) e += power(k)
      // Per-bin power density relative to a full-scale white noise
      // (Hann: sum w^2 = 3N/8), floored so silence and room tone near the
      // gate do not read as huge rises.
      this.bands[b] = Math.max(BAND_FLOOR_DB, 10 * Math.log10(e / ((hi - lo) * HANN_POWER) + 1e-20))
    }
    this.pushFlux()
  }

  private pushFlux(): void {
    let flux = 0
    for (let b = 0; b < FLUX_BANDS; b++) flux += Math.max(0, this.bands[b] - this.previousBands[b])
    this.columns.flux.push(flux / FLUX_BANDS)
    this.previousBands.set(this.bands)
  }
}

/** Convenience for tests and short buffers. */
export function reactionFeatures(samples: ArrayLike<number>): ReactionFeatures {
  const analyzer = new ReactionAnalyzer()
  analyzer.push(samples)
  return analyzer.finish()
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Gap sound must clear the local non-speech floor (20th percentile of
 * non-speech frames within ±20 s) by this much. Measured on the synthetic
 * sources (scripts/calibrate-reactions.ts, -20 dBFS speech): over a -35 dBFS
 * music bed the laughter burst peaked +18.1 dB, applause +19.8 dB and the
 * impact +19.6 dB above the floor; with no events, gaps peaked +3.2 dB over
 * -68 dBFS room tone and +0.1 dB over a -26 dBFS music bed. 12 dB sits
 * between the two with ~6–9 dB margin each way.
 */
export const GAP_ABOVE_FLOOR_DB = 12
/**
 * …and come within this much of the source's typical speech level, so a
 * distant door or a chair creak in a quiet room does not count. The events
 * above averaged -15.6 to -22.9 dBFS against -20 dBFS speech; a -35 dBFS
 * music bed is 15 dB under it.
 */
export const GAP_BELOW_SPEECH_DB = 10
/**
 * Over speech, the sustained (±150 ms) level must jump this far above the
 * speaker's own loud end: the OVER_SPEECH_PERCENTILE of their voiced frames
 * within ±OVER_SPEECH_WINDOW_SEC, so the reference follows the speaker. The
 * median was too low a reference for real voices: in the live two-voice
 * check ordinary stressed syllables sat up to 8.5 dB over it, and read as
 * reactions; they sit at most 4.0 dB over the 85th percentile of ±30 s.
 * The wide window keeps a reaction from raising its own reference: a 3 s
 * laugh is 5% of it, and anything up to ~9 s stays above the percentile.
 * Laughter mixed over speech 10 dB louder than the speaker reads +11.1 dB
 * and is caught; at the speaker's own level it is deliberately missed — it
 * cannot be told from emphatic delivery by level alone.
 */
export const OVER_SPEECH_DB = 8
export const OVER_SPEECH_PERCENTILE = 0.85
export const OVER_SPEECH_WINDOW_SEC = 30
/** Over-speech candidates must also be spectrally novel: smoothed flux this many dB above the speaker's median flux. */
export const OVER_SPEECH_FLUX_DB = 1.5
const MERGE_GAP_SEC = 0.4
/** Words closer than this form one run of speech. */
const WORD_RUN_GAP_SEC = 0.3
const WORD_PAD_SEC = 0.1
const EDGE_SNAP_SEC = 0.5
/**
 * Whisper word starts lag the voice, most after a pause: a second voice's
 * first word in the live two-voice check began 0.54 s after its VAD region,
 * and the onset read as a 0.35 s gap sound. Leading edges snap further.
 */
const LEAD_SNAP_SEC = 0.8
const MIN_REACTION_SEC = 0.15
/** Edges extend while the level stays this close to the candidate's own peak region. */
const EDGE_DROP_DB = 6
const SMOOTH_FRAMES = 3
/** At most one reaction per this many seconds of source on average; strongest kept. */
export const REACTION_SPACING_SEC = 20
/**
 * Strength divides by the source's top score, or this many dB if the top is
 * lower: the synthetic gap events scored 12–16 dB, over-speech laughter 4.6.
 */
const STRENGTH_FLOOR_DB = 10

export interface ReactionContext {
  durationSec: number
  /** Voice activity (Silero), when available. */
  speech?: SpeechRegion[]
  /** Word timings from the transcript, when available. */
  words?: TranscriptWord[]
}

/**
 * Per-frame mask of "someone is talking here".
 *
 * Words define speech: laughter often sits inside a Silero speech region
 * with no words in it, so VAD alone would hide it. Whisper word spans are
 * loose, though, and a sentence's last syllable usually decays past the last
 * word's end, so each run of words is stretched to the edge of the voice
 * activity region it sits in when that edge is within EDGE_SNAP_SEC; any
 * longer wordless stretch of a region stays a gap. Without words, VAD is
 * all there is.
 */
export function speechMask(frames: number, hopSec: number, context: ReactionContext): Uint8Array {
  const mask = new Uint8Array(frames)
  const mark = (start: number, end: number): void => {
    const from = Math.max(0, Math.floor(start / hopSec))
    const to = Math.min(frames, Math.ceil(end / hopSec))
    for (let i = from; i < to; i++) mask[i] = 1
  }
  const words = [...(context.words ?? [])].sort((a, b) => a.start - b.start)
  const speech = context.speech ?? []
  if (!words.length) {
    for (const region of speech) mark(region.start, region.end)
    return mask
  }
  const runs: Array<{ start: number; end: number }> = []
  for (const word of words) {
    const last = runs[runs.length - 1]
    if (last && word.start - last.end < WORD_RUN_GAP_SEC) last.end = Math.max(last.end, word.end)
    else runs.push({ start: word.start, end: word.end })
  }
  for (const run of runs) {
    let start = run.start - WORD_PAD_SEC, end = run.end + WORD_PAD_SEC
    for (const region of speech) {
      if (region.end < run.start - LEAD_SNAP_SEC || region.start > run.end + EDGE_SNAP_SEC) continue
      if (region.start < start && run.start - region.start <= LEAD_SNAP_SEC) start = region.start - WORD_PAD_SEC
      if (region.end > end && region.end - run.end <= EDGE_SNAP_SEC) end = region.end + WORD_PAD_SEC
    }
    mark(start, end)
  }
  return mask
}

/** Per-frame VAD mask, or undefined without voice activity. */
function voiceMask(frames: number, hopSec: number, speech?: SpeechRegion[]): Uint8Array | undefined {
  if (!speech?.length) return undefined
  const mask = new Uint8Array(frames)
  for (const region of speech) {
    const to = Math.min(frames, Math.ceil(region.end / hopSec))
    for (let i = Math.max(0, Math.floor(region.start / hopSec)); i < to; i++) mask[i] = 1
  }
  return mask
}

/**
 * Moving average of dB values over ±`radius` frames, taken in the power
 * domain: averaging decibels directly lets two quiet frames bury a loud one
 * (an 80 ms hit lost 15 dB that way, 5 dB in power).
 */
export function smoothDb(values: Float32Array, radius: number): Float32Array {
  const power = values.map(v => Math.pow(10, v / 10))
  return smooth(power, radius).map(v => 10 * Math.log10(v + 1e-12))
}

/** Moving average over ±`radius` frames. */
export function smooth(values: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(values.length)
  let sum = 0, count = 0
  for (let i = 0; i < Math.min(values.length, radius); i++) { sum += values[i]; count++ }
  for (let i = 0; i < values.length; i++) {
    const add = i + radius, drop = i - radius - 1
    if (add < values.length) { sum += values[add]; count++ }
    if (drop >= 0) { sum -= values[drop]; count-- }
    out[i] = sum / count
  }
  return out
}

/**
 * Percentile `p` of the selected frames within ±windowSec of each frame,
 * via 0.5 dB histograms on a one-second grid (exact medians over hours of
 * 50 ms frames would cost seconds; this is milliseconds). NaN where no
 * selected frame is in reach.
 */
export function localPercentile(values: Float32Array, select: (i: number) => boolean, hopSec: number, windowSec: number, p: number,
  lo = -100, hi = 20): Float32Array {
  const binDb = 0.5
  const bins = Math.ceil((hi - lo) / binDb) + 1
  const perBlock = Math.max(1, Math.round(1 / hopSec))
  const blocks = Math.ceil(values.length / perBlock)
  const hist = new Uint32Array(blocks * bins)
  for (let i = 0; i < values.length; i++) {
    if (!select(i)) continue
    const bin = Math.min(bins - 1, Math.max(0, Math.round((values[i] - lo) / binDb)))
    hist[Math.floor(i / perBlock) * bins + bin]++
  }
  const reach = Math.max(0, Math.round(windowSec / (perBlock * hopSec)))
  const acc = new Float64Array(bins)
  let total = 0
  const addBlock = (b: number, sign: number): void => {
    for (let k = 0; k < bins; k++) { const v = hist[b * bins + k]; if (v) { acc[k] += sign * v; total += sign * v } }
  }
  for (let b = 0; b < Math.min(blocks, reach); b++) addBlock(b, 1)
  const perBlockValue = new Float32Array(blocks)
  for (let b = 0; b < blocks; b++) {
    if (b + reach < blocks) addBlock(b + reach, 1)
    if (b - reach - 1 >= 0) addBlock(b - reach - 1, -1)
    if (total <= 0) { perBlockValue[b] = NaN; continue }
    const target = p * total
    let run = 0, k = 0
    for (; k < bins; k++) { run += acc[k]; if (run >= target) break }
    perBlockValue[b] = lo + Math.min(k, bins - 1) * binDb
  }
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = perBlockValue[Math.floor(i / perBlock)]
  return out
}

function percentileOf(values: number[], p: number): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
}

interface Candidate { from: number; to: number; peak: number; overSpeech: boolean }

/**
 * Find reactions in per-frame features. `context.speech`/`words` separate
 * talking from everything else; without either, every frame is treated as
 * a gap, which only catches sounds near the loudest level of the source.
 */
export function detectReactions(features: ReactionFeatures, context: ReactionContext): AudioReaction[] {
  const { hopSec } = features
  const frames = features.levelDb.length
  if (frames < 10) return []
  // Gap sounds use light smoothing (±1 frame) so an 80 ms impact keeps its
  // level (±3 frames diluted a synthetic hit by 6 dB); over speech, where a
  // plosive can spike a single frame, ±3 frames demand a sustained jump.
  const level = smoothDb(features.levelDb, 1)
  const sustained = smoothDb(features.levelDb, SMOOTH_FRAMES)
  const flux = smooth(features.flux, SMOOTH_FRAMES)
  const audible = (i: number): boolean => features.levelDb[i] > SILENCE_DB
  const mask = speechMask(frames, hopSec, context)

  const speechLevels: number[] = []
  for (let i = 0; i < frames; i += 2) if (mask[i] && audible(i)) speechLevels.push(sustained[i])
  // Typical speech level; with no speech at all, the source's own loud end.
  const allLevels: number[] = []
  for (let i = 0; i < frames; i += 2) if (audible(i)) allLevels.push(level[i])
  if (!allLevels.length) return []
  const speechLevel = speechLevels.length >= 20 ? percentileOf(speechLevels, 0.5) : percentileOf(allLevels, 0.9)

  const gap = (i: number): boolean => !mask[i]
  const floor = localPercentile(level, i => gap(i) && audible(i), hopSec, 20, 0.2)
  // With no silence at all nearby, the floor is the room's quietest stretch overall.
  const globalFloor = percentileOf(allLevels, 0.1)
  // The speaker's reference level comes from frames VAD also hears as voice:
  // the word padding and Whisper's loose word starts put quiet pre-onset
  // frames under the mask, which pulled the median down until an ordinary
  // onset read as a jump over speech.
  const voiced = voiceMask(frames, hopSec, context.speech)
  const reference = (i: number): boolean => mask[i] === 1 && audible(i) && (!voiced || voiced[i] === 1)
  const localSpeech = localPercentile(sustained, reference, hopSec, OVER_SPEECH_WINDOW_SEC, OVER_SPEECH_PERCENTILE)
  const localFlux = localPercentile(flux, reference, hopSec, 10, 0.5, 0, 60)

  // Excess over the relevant reference, in dB; <= 0 means not a candidate.
  const excess = new Float32Array(frames)
  const over = new Uint8Array(frames)
  for (let i = 0; i < frames; i++) {
    if (!audible(i)) continue
    if (gap(i)) {
      const f = Number.isNaN(floor[i]) ? globalFloor : floor[i]
      const aboveFloor = level[i] - f
      if (aboveFloor >= GAP_ABOVE_FLOOR_DB && level[i] >= speechLevel - GAP_BELOW_SPEECH_DB) {
        excess[i] = Math.max(aboveFloor - GAP_ABOVE_FLOOR_DB + 1, level[i] - (speechLevel - GAP_BELOW_SPEECH_DB))
      }
    } else if (!Number.isNaN(localSpeech[i])) {
      const above = sustained[i] - localSpeech[i]
      const novel = flux[i] - (Number.isNaN(localFlux[i]) ? 0 : localFlux[i])
      if (above >= OVER_SPEECH_DB && novel >= OVER_SPEECH_FLUX_DB) { excess[i] = above - OVER_SPEECH_DB + 1; over[i] = 1 }
    }
  }

  // Group candidate frames, bridging short dips.
  const candidates: Candidate[] = []
  const mergeGap = Math.round(MERGE_GAP_SEC / hopSec)
  for (let i = 0; i < frames; i++) {
    if (excess[i] <= 0) continue
    const last = candidates[candidates.length - 1]
    if (last && i - last.to <= mergeGap) {
      last.to = i
      last.peak = Math.max(last.peak, excess[i])
      if (over[i]) last.overSpeech = true
    } else candidates.push({ from: i, to: i, peak: excess[i], overSpeech: over[i] === 1 })
  }

  const reactions: Array<AudioReaction & { score: number }> = []
  for (const candidate of candidates) {
    // Extend edges while the sound holds near the candidate's level, so the
    // span covers the whole burst rather than just its loudest frames.
    let peakLevel = -Infinity
    for (let i = candidate.from; i <= candidate.to; i++) peakLevel = Math.max(peakLevel, level[i])
    const keep = (i: number): boolean => level[i] >= peakLevel - EDGE_DROP_DB && (gap(i) || candidate.overSpeech)
    let from = candidate.from, to = candidate.to
    while (from > 0 && keep(from - 1)) from--
    while (to < frames - 1 && keep(to + 1)) to++
    const start = from * hopSec
    const end = (to + 1) * hopSec
    if (end - start < MIN_REACTION_SEC) continue
    const previous = reactions[reactions.length - 1]
    if (previous && start <= previous.end + MERGE_GAP_SEC) {
      previous.end = Math.max(previous.end, end)
      previous.score = Math.max(previous.score, candidate.peak)
      continue
    }
    reactions.push({ start, end, strength: 0, score: candidate.peak })
  }

  // Classify on the frames each reaction spans.
  for (const reaction of reactions) {
    const from = Math.floor(reaction.start / hopSec)
    const to = Math.min(frames, Math.ceil(reaction.end / hopSec))
    const kind = classifyReaction(features, from, to)
    if (kind) reaction.kind = kind
  }

  // Score: dB of excess over the reference, lengthened reactions a little
  // stronger (a 3 s laugh outweighs a 0.2 s click at the same level).
  for (const reaction of reactions) {
    const lengthBonus = Math.min(1, Math.log2(1 + (reaction.end - reaction.start)) / 2)
    reaction.score *= 0.7 + 0.3 * lengthBonus
  }
  const cap = Math.max(1, Math.floor(context.durationSec / REACTION_SPACING_SEC))
  const kept = reactions.sort((a, b) => b.score - a.score).slice(0, cap)
  // Strength is relative to this source's strongest reaction, but a source
  // whose loudest reaction is itself weak keeps an absolute scale.
  const top = Math.max(...kept.map(r => r.score), STRENGTH_FLOOR_DB)
  return kept
    .map(({ score, ...r }) => ({
      ...r,
      start: Math.round(r.start * 100) / 100,
      end: Math.round(Math.min(context.durationSec || r.end, r.end) * 100) / 100,
      strength: Math.round(Math.min(1, score / top) * 100) / 100
    }))
    .sort((a, b) => a.start - b.start)
}

/*
 * Kinds. Measured on the synthetic sources (mean over each event):
 *   speech-like bursts  flatness 0.17  high share 0.20  level s.d. 3.3  flux peak 14  bursts 3.4/s
 *   laughter burst      flatness 0.43  high share 0.53  level s.d. 5.6  flux peak 27  bursts 5.2/s
 *   applause            flatness 0.56  high share 0.77  level s.d. 2.0  flux peak 39  bursts 0.2/s
 *   impact (~200 ms)    flux peak 46
 *   music sting (chord) flatness 0.00  high share 0.00
 * Real laughter is more voiced (less flat) than the synthetic burst, so the
 * laughter rule leans on the burst rhythm and only asks for some breathiness.
 */
/** Applause/crowd: steady broadband noise; the level s.d. is what separates it from laughter. */
const APPLAUSE_MIN_SEC = 1.5
const APPLAUSE_FLATNESS = 0.4
const APPLAUSE_HIGH_SHARE = 0.45
const APPLAUSE_LEVEL_SD = 3.5
/** Impact: short with a sharp onset, well above speech (14) and laughter (27) onsets. */
const IMPACT_MAX_SEC = 0.6
const IMPACT_FLUX_DB = 32
/** Laughter: 2.5–8 bursts per second of >= 6 dB prominence with some breathiness. */
const LAUGH_MIN_SEC = 0.6
const LAUGH_MAX_SEC = 10
const LAUGH_MIN_RATE = 2.5
const LAUGH_MAX_RATE = 8
const LAUGH_PROMINENCE_DB = 6
const LAUGH_FLATNESS = 0.15
/** Music sting: sustained and tonal (a chord reads 0.00, speech 0.12 and up). */
const MUSIC_MIN_SEC = 1
const MUSIC_FLATNESS = 0.06

/** A kind only when the features clearly say so; otherwise 'other'. */
export function classifyReaction(features: ReactionFeatures, from: number, to: number): AudioReaction['kind'] {
  const duration = (to - from) * features.hopSec
  // Statistics over the interior: edge frames straddle the onset and decay.
  if (to - from > 6) { from++; to-- }
  const n = to - from
  if (n <= 0) return 'other'
  let flat = 0, high = 0, mean = 0, maxFlux = 0
  for (let i = from; i < to; i++) {
    flat += features.flatness[i]; high += features.highShare[i]; mean += features.levelDb[i]
    maxFlux = Math.max(maxFlux, features.flux[i])
  }
  flat /= n; high /= n; mean /= n
  // Include the onset frame just before the span (the rise is measured there).
  if (from > 0) maxFlux = Math.max(maxFlux, features.flux[from - 1])
  let variance = 0
  for (let i = from; i < to; i++) variance += (features.levelDb[i] - mean) ** 2
  const sd = Math.sqrt(variance / n)

  if (duration <= IMPACT_MAX_SEC && maxFlux >= IMPACT_FLUX_DB) return 'impact'
  if (duration >= APPLAUSE_MIN_SEC && flat >= APPLAUSE_FLATNESS && high >= APPLAUSE_HIGH_SHARE && sd <= APPLAUSE_LEVEL_SD) return 'applause'
  if (duration >= LAUGH_MIN_SEC && duration <= LAUGH_MAX_SEC && flat >= LAUGH_FLATNESS) {
    const rate = burstCount(features.levelDb, from, to, LAUGH_PROMINENCE_DB) / duration
    if (rate >= LAUGH_MIN_RATE && rate <= LAUGH_MAX_RATE) return 'laughter'
  }
  if (duration >= MUSIC_MIN_SEC && flat <= MUSIC_FLATNESS) return 'music'
  return 'other'
}

/** Local level maxima rising at least `prominence` dB above the dip before them. */
export function burstCount(level: Float32Array, from: number, to: number, prominence: number): number {
  let count = 0
  let dip = Infinity
  let rising = false
  for (let i = from; i < to; i++) {
    const v = level[i]
    dip = Math.min(dip, v)
    if (!rising && v - dip >= prominence) rising = true
    if (rising) {
      const next = i + 1 < to ? level[i + 1] : -Infinity
      if (v >= next) { count++; rising = false; dip = v }
    }
    if (!rising && v < dip) dip = v
  }
  return count
}
