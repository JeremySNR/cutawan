/**
 * MFCC feature extraction for the LR-ASD active speaker model.
 *
 * The model was trained on features from python_speech_features.mfcc with its
 * default settings (13 cepstra, 26 mel filters, 512-point FFT, 0.97
 * pre-emphasis, rectangular window, ceplifter 22, log energy replacing c0),
 * so this implementation reproduces that library bit-for-bit — any drift in
 * framing or filterbank construction shifts the features the model sees.
 * Verified against a generated fixture in tests/mfcc.test.ts.
 */

export const MFCC_COEFFS = 13

const NFFT = 512
const NFILT = 26
const PREEMPH = 0.97
const CEPLIFTER = 22

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1)
}

/** Triangular mel filterbank, NFILT x (NFFT/2 + 1), matching get_filterbanks. */
function buildFilterbank(sampleRate: number): Float64Array[] {
  const lowMel = hzToMel(0)
  const highMel = hzToMel(sampleRate / 2)
  const melPoints = Array.from(
    { length: NFILT + 2 },
    (_, i) => lowMel + ((highMel - lowMel) * i) / (NFILT + 1)
  )
  const bin = melPoints.map((m) => Math.floor(((NFFT + 1) * melToHz(m)) / sampleRate))
  const bank = Array.from({ length: NFILT }, () => new Float64Array(NFFT / 2 + 1))
  for (let j = 0; j < NFILT; j++) {
    for (let i = bin[j]; i < bin[j + 1]; i++) {
      bank[j][i] = (i - bin[j]) / (bin[j + 1] - bin[j])
    }
    for (let i = bin[j + 1]; i < bin[j + 2]; i++) {
      bank[j][i] = (bin[j + 2] - i) / (bin[j + 2] - bin[j + 1])
    }
  }
  return bank
}

/** DCT-II with orthonormal scaling, first MFCC_COEFFS rows of an NFILT DCT. */
function buildDctMatrix(): Float64Array[] {
  const rows: Float64Array[] = []
  for (let k = 0; k < MFCC_COEFFS; k++) {
    const row = new Float64Array(NFILT)
    const scale = k === 0 ? Math.sqrt(1 / (4 * NFILT)) : Math.sqrt(1 / (2 * NFILT))
    for (let n = 0; n < NFILT; n++) {
      row[n] = 2 * scale * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * NFILT))
    }
    rows.push(row)
  }
  return rows
}

/** In-place iterative radix-2 FFT over interleaved [re, im] pairs. */
export function fft(buf: Float64Array): void {
  const n = buf.length / 2
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const ti = buf[2 * i]
      const tq = buf[2 * i + 1]
      buf[2 * i] = buf[2 * j]
      buf[2 * i + 1] = buf[2 * j + 1]
      buf[2 * j] = ti
      buf[2 * j + 1] = tq
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const a = 2 * (i + k)
        const b = 2 * (i + k + len / 2)
        const bRe = buf[b] * curRe - buf[b + 1] * curIm
        const bIm = buf[b] * curIm + buf[b + 1] * curRe
        buf[b] = buf[a] - bRe
        buf[b + 1] = buf[a + 1] - bIm
        buf[a] += bRe
        buf[a + 1] += bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

export interface MfccResult {
  /** Row-major [frames x MFCC_COEFFS] features. */
  features: Float32Array
  frames: number
}

/**
 * Compute MFCC features from 16-bit mono PCM. `winlen`/`winstep` are in
 * seconds; the LR-ASD pipeline uses 0.025/0.010 at 25 fps video so that four
 * audio feature frames line up with each video frame.
 */
export function computeMfcc(
  pcm: Int16Array,
  sampleRate: number,
  winlen = 0.025,
  winstep = 0.01
): MfccResult {
  const frameLen = Math.round(winlen * sampleRate)
  const frameStep = Math.round(winstep * sampleRate)
  const epsF = Number.EPSILON // numpy float64 eps, used for log(0) guards

  // Pre-emphasis.
  const signal = new Float64Array(pcm.length)
  if (pcm.length > 0) signal[0] = pcm[0]
  for (let i = 1; i < pcm.length; i++) signal[i] = pcm[i] - PREEMPH * pcm[i - 1]

  const slen = signal.length
  const frames =
    slen <= frameLen ? 1 : 1 + Math.ceil((slen - frameLen) / frameStep)

  const filterbank = buildFilterbank(sampleRate)
  const dct = buildDctMatrix()
  const lifter = Array.from(
    { length: MFCC_COEFFS },
    (_, i) => 1 + (CEPLIFTER / 2) * Math.sin((Math.PI * i) / CEPLIFTER)
  )

  const features = new Float32Array(frames * MFCC_COEFFS)
  const fftBuf = new Float64Array(NFFT * 2)
  const pspec = new Float64Array(NFFT / 2 + 1)
  const fbankLog = new Float64Array(NFILT)

  for (let f = 0; f < frames; f++) {
    const start = f * frameStep
    fftBuf.fill(0)
    const copyLen = Math.min(frameLen, Math.max(0, slen - start))
    for (let i = 0; i < copyLen; i++) fftBuf[2 * i] = signal[start + i]

    fft(fftBuf)

    let energy = 0
    for (let i = 0; i <= NFFT / 2; i++) {
      const re = fftBuf[2 * i]
      const im = fftBuf[2 * i + 1]
      pspec[i] = (re * re + im * im) / NFFT
      energy += pspec[i]
    }
    if (energy === 0) energy = epsF

    for (let j = 0; j < NFILT; j++) {
      const fb = filterbank[j]
      let sum = 0
      for (let i = 0; i <= NFFT / 2; i++) sum += pspec[i] * fb[i]
      fbankLog[j] = Math.log(sum === 0 ? epsF : sum)
    }

    const out = features.subarray(f * MFCC_COEFFS, (f + 1) * MFCC_COEFFS)
    for (let k = 0; k < MFCC_COEFFS; k++) {
      const row = dct[k]
      let sum = 0
      for (let n = 0; n < NFILT; n++) sum += fbankLog[n] * row[n]
      out[k] = sum * lifter[k]
    }
    out[0] = Math.log(energy)
  }

  return { features, frames }
}
