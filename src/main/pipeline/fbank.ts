import { fft } from './mfcc'

/**
 * Kaldi-compatible log mel filterbank features, the input the speaker
 * embedding model was trained on (3D-Speaker computes them with
 * torchaudio.compliance.kaldi.fbank; sherpa-onnx with kaldi-native-fbank).
 *
 * Defaults match both at inference: 16 kHz, 25 ms frames every 10 ms with
 * snip_edges, DC removal, 0.97 pre-emphasis, Povey window, 512-point FFT,
 * power spectrum, 80 mel bins between 20 Hz and Nyquist, natural log floored
 * at FLT_EPSILON, no dither. The model's metadata asks for samples in -1..1
 * (`normalize_samples=1`) and per-utterance mean subtraction
 * (`feature_normalize_type=global-mean`), which `subtractMean` does.
 * Verified against kaldi-native-fbank 1.x in tests/fbank.test.ts.
 */

export const FBANK_BINS = 80
export const FBANK_SAMPLE_RATE = 16000
export const FBANK_FRAME = 400 // 25 ms
export const FBANK_SHIFT = 160 // 10 ms
const NFFT = 512
const PREEMPH = 0.97
const LOW_HZ = 20
const FLT_EPSILON = 1.1920928955078125e-7

const melScale = (hz: number): number => 1127 * Math.log(1 + hz / 700)

/** Kaldi's MelBanks: triangles in mel space over the first NFFT/2 bins. */
function melBanks(): Float64Array[] {
  const fftBins = NFFT / 2
  const nyquist = FBANK_SAMPLE_RATE / 2
  const melLow = melScale(LOW_HZ)
  const melHigh = melScale(nyquist)
  const delta = (melHigh - melLow) / (FBANK_BINS + 1)
  const banks: Float64Array[] = []
  for (let b = 0; b < FBANK_BINS; b++) {
    const left = melLow + b * delta
    const center = left + delta
    const right = center + delta
    const weights = new Float64Array(fftBins)
    for (let i = 0; i < fftBins; i++) {
      const mel = melScale((FBANK_SAMPLE_RATE / NFFT) * i)
      if (mel > left && mel < right) {
        weights[i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center)
      }
    }
    banks.push(weights)
  }
  return banks
}

let cachedBanks: Float64Array[] | undefined
let cachedWindow: Float64Array | undefined

function povey(): Float64Array {
  const w = new Float64Array(FBANK_FRAME)
  for (let i = 0; i < FBANK_FRAME; i++) {
    w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME - 1)), 0.85)
  }
  return w
}

/**
 * Computes one fbank frame at a time so a caller streaming hours of audio
 * only ever holds the frames it still needs.
 */
export class FbankComputer {
  private readonly banks = (cachedBanks ??= melBanks())
  private readonly window = (cachedWindow ??= povey())
  private readonly frame = new Float64Array(FBANK_FRAME)
  private readonly buf = new Float64Array(NFFT * 2)
  private readonly power = new Float64Array(NFFT / 2)

  /** Write the FBANK_BINS features of the frame starting at `offset` into `out`. */
  compute(samples: ArrayLike<number>, offset: number, out: Float32Array, outOffset = 0): void {
    const frame = this.frame
    let mean = 0
    for (let i = 0; i < FBANK_FRAME; i++) { frame[i] = samples[offset + i]; mean += frame[i] }
    mean /= FBANK_FRAME
    for (let i = 0; i < FBANK_FRAME; i++) frame[i] -= mean
    for (let i = FBANK_FRAME - 1; i > 0; i--) frame[i] -= PREEMPH * frame[i - 1]
    frame[0] -= PREEMPH * frame[0]
    const buf = this.buf
    buf.fill(0)
    for (let i = 0; i < FBANK_FRAME; i++) buf[2 * i] = frame[i] * this.window[i]
    fft(buf)
    const power = this.power
    for (let i = 0; i < NFFT / 2; i++) power[i] = buf[2 * i] * buf[2 * i] + buf[2 * i + 1] * buf[2 * i + 1]
    for (let b = 0; b < FBANK_BINS; b++) {
      const weights = this.banks[b]
      let sum = 0
      for (let i = 0; i < weights.length; i++) if (weights[i] !== 0) sum += weights[i] * power[i]
      out[outOffset + b] = Math.log(Math.max(sum, FLT_EPSILON))
    }
  }
}

/** Frames Kaldi produces for `sampleCount` samples with snip_edges. */
export function fbankFrameCount(sampleCount: number): number {
  return sampleCount < FBANK_FRAME ? 0 : 1 + Math.floor((sampleCount - FBANK_FRAME) / FBANK_SHIFT)
}

/** Row-major [frames x FBANK_BINS] features for a whole buffer of -1..1 samples. */
export function computeFbank(samples: ArrayLike<number>): Float32Array {
  const frames = fbankFrameCount(samples.length)
  const out = new Float32Array(frames * FBANK_BINS)
  const computer = new FbankComputer()
  for (let f = 0; f < frames; f++) computer.compute(samples, f * FBANK_SHIFT, out, f * FBANK_BINS)
  return out
}

/** Per-utterance mean normalisation (`global-mean`), in place. */
export function subtractMean(features: Float32Array, bins = FBANK_BINS): Float32Array {
  const frames = features.length / bins
  if (!frames) return features
  for (let b = 0; b < bins; b++) {
    let sum = 0
    for (let f = 0; f < frames; f++) sum += features[f * bins + b]
    const mean = sum / frames
    for (let f = 0; f < frames; f++) features[f * bins + b] -= mean
  }
  return features
}
