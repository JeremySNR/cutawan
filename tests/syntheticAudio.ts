import { spawnSync } from 'node:child_process'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import type { SpeechRegion, TranscriptWord } from '@shared/types'

/**
 * Synthetic sources for the audio-reaction tests, built from ffmpeg lavfi
 * generators so they need no fixtures: speech-like bursts (pink noise in the
 * voice band with a syllable-rate envelope), a laughter-like burst (breathy
 * noise pulsing at 5 Hz), applause (steady broadband noise), a single impact
 * (a hit decaying over ~200 ms), a quiet music bed and room tone.
 */

export interface SyntheticLayout {
  durationSec: number
  speech: SpeechRegion[]
  laughter?: [number, number]
  applause?: [number, number]
  impact?: number
  /** A tonal sting in a gap: a chord at -16 dBFS, [start, end]. */
  sting?: [number, number]
  /** Laughter-like burst mixed over speech, louder than the speaker by `overSpeechDb`. */
  overSpeech?: [number, number]
  overSpeechDb?: number
  /** A stretch of speech delivered 6 dB louder (emphasis, not a reaction). */
  loudSpeech?: [number, number]
  /** Music bed level in dBFS throughout; omit for none. */
  musicDb?: number
  /** Speech level in dBFS (RMS of the bursts, roughly). */
  speechDb?: number
  /** Room tone level in dBFS; omit for digital silence between sounds. */
  roomDb?: number
}

const between = (spans: SpeechRegion[]): string =>
  spans.length ? spans.map(s => `between(t,${s.start},${s.end})`).join('+') : '0'
const amp = (db: number): number => Math.pow(10, db / 20)
/** lavfi `sine` generates at 1/8 full scale; compensate so levels are true dBFS RMS. */
const SINE_DB = 20 * Math.log10(8) + 3

/** Build the ffmpeg -filter_complex graph and write a 16 kHz mono WAV to `out`. */
export function writeSynthetic(layout: SyntheticLayout, out: string): void {
  const d = layout.durationSec
  const parts: string[] = []
  const labels: string[] = []
  const add = (graph: string): void => { const label = `s${labels.length}`; parts.push(`${graph}[${label}]`); labels.push(`[${label}]`) }
  // Band-limited, enveloped pink noise at amplitude 1 measures -26.4 dBFS.
  const speechGain = amp((layout.speechDb ?? -20) + 26.4)
  add(`anoisesrc=color=pink:amplitude=1:d=${d}:seed=11:r=16000:nb_samples=160,highpass=f=300,lowpass=f=3400,volume=${speechGain.toFixed(4)},` +
    `volume='0.15+0.85*abs(sin(2*PI*3.3*t)*sin(2*PI*1.7*t+1))':eval=frame,volume=0:enable='not(${between(layout.speech)})'` +
    (layout.loudSpeech ? `,volume=2:enable='between(t,${layout.loudSpeech[0]},${layout.loudSpeech[1]})'` : ''))
  if (layout.laughter) {
    const [a, b] = layout.laughter
    add(`anoisesrc=color=white:amplitude=0.5:d=${d}:seed=12:r=16000:nb_samples=160,highpass=f=400,lowpass=f=5000,` +
      `volume='pow(abs(sin(2*PI*2.5*t)),3)':eval=frame,volume=0:enable='not(between(t,${a},${b}))'`)
  }
  if (layout.overSpeech) {
    const [a, b] = layout.overSpeech
    // The pulsing band-limited noise measures 15.5 dB under its amplitude.
    const level = amp((layout.speechDb ?? -20) + (layout.overSpeechDb ?? 10) + 15.5)
    add(`anoisesrc=color=white:amplitude=1:d=${d}:seed=15:r=16000:nb_samples=160,highpass=f=400,lowpass=f=5000,volume=${level.toFixed(4)},` +
      `volume='pow(abs(sin(2*PI*2.5*t)),3)':eval=frame,volume=0:enable='not(between(t,${a},${b}))'`)
  }
  if (layout.applause) {
    const [a, b] = layout.applause
    add(`anoisesrc=color=white:amplitude=0.3:d=${d}:seed=13:r=16000:nb_samples=160,highpass=f=300,volume=0:enable='not(between(t,${a},${b}))'`)
  }
  if (layout.impact !== undefined) {
    const t0 = layout.impact
    add(`anoisesrc=color=white:amplitude=0.95:d=${d}:seed=14:r=16000:nb_samples=160,lowpass=f=3000,` +
      `volume='exp(-abs(t-${t0})*15)':eval=frame,volume=0:enable='not(between(t,${t0},${t0 + 0.25}))'`)
  }
  if (layout.sting) {
    const [a, b] = layout.sting
    for (const f of [196, 247, 294, 392]) {
      add(`sine=f=${f}:d=${d}:r=16000:samples_per_frame=160,volume=${amp(-22 + SINE_DB).toFixed(4)},volume=0:enable='not(between(t,${a},${b}))'`)
    }
  }
  if (layout.musicDb !== undefined) {
    // Four sine partials, each 6 dB below the requested total.
    for (const f of [220, 277.18, 329.63, 440]) add(`sine=f=${f}:d=${d}:r=16000:samples_per_frame=160,volume=${amp(layout.musicDb - 6 + SINE_DB).toFixed(5)}`)
  }
  if (layout.roomDb !== undefined) {
    add(`anoisesrc=color=brown:amplitude=${amp(layout.roomDb + 6).toFixed(5)}:d=${d}:seed=16:r=16000:nb_samples=160`)
  }
  const graph = `${parts.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${d}[out]`
  const result = spawnSync(FFMPEG_PATH, ['-hide_banner', '-y', '-filter_complex', graph, '-map', '[out]', '-ac', '1', '-ar', '16000', out], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(-1500)}`)
}

/** 0.3 s words every 0.4 s across each speech region, as Whisper would time them. */
export function syntheticWords(speech: SpeechRegion[]): TranscriptWord[] {
  const words: TranscriptWord[] = []
  for (const region of speech) {
    for (let t = region.start + 0.05; t + 0.3 <= region.end; t += 0.4) words.push({ text: 'word', start: t, end: t + 0.3 })
  }
  return words
}
