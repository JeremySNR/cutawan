import type { Clip, ClipDub, DubLine, Transcript, TranslationLine } from './types'
import type { SubscriptionSettings } from './subscription'
import { translationState } from './captionTranslation'
import { TimeMap, type KeptSegment } from './tighten'

/**
 * AI voice dub planning, shared by the preview (which plays the dub through
 * <audio> elements and ducks the video) and the export (which mixes one dub
 * track under the same envelope), so what you hear is what exports.
 */

/** How far the original audio drops while a dub line plays. */
export const DUB_DUCK_DB = -18
/** Ramp into and out of the duck, either side of a line. */
export const DUB_RAMP_SEC = 0.15
/** Most a line may be sped up after the faster re-request. */
export const DUB_MAX_TEMPO = 1.25
/** Silence kept before the next line's slot. */
export const DUB_LINE_GAP_SEC = 0.05
/** Fade on a line that still has to be cut short. */
export const DUB_TRUNCATE_FADE_SEC = 0.12

export interface DubVoice {
  id: string
  label: string
}

export const DUB_VOICES: DubVoice[] = [
  { id: 'alloy', label: 'Alloy (neutral)' },
  { id: 'coral', label: 'Coral (warm)' },
  { id: 'nova', label: 'Nova (bright)' },
  { id: 'echo', label: 'Echo (calm)' },
  { id: 'onyx', label: 'Onyx (deep)' },
  { id: 'shimmer', label: 'Shimmer (soft)' }
]

export interface DubModel {
  id: string
  label: string
  /** Whether it honours `speed`; the others take a spoken-pace instruction. */
  speed: boolean
  /**
   * Approximate list price in US dollars per million input characters,
   * for the estimate only. gpt-4o-mini-tts is billed per token; OpenAI
   * quotes about $0.015 a minute of speech, which is close to this.
   */
  usdPerMillionChars: number
}

export interface DubSupport {
  available: boolean
  provider?: ClipDub['provider']
  models: DubModel[]
  /** Why dubbing is not offered on this route. */
  reason?: string
}

const OPENAI_MODELS: DubModel[] = [
  { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', speed: false, usdPerMillionChars: 15 },
  { id: 'tts-1', label: 'TTS-1', speed: true, usdPerMillionChars: 15 },
  { id: 'tts-1-hd', label: 'TTS-1 HD', speed: true, usdPerMillionChars: 30 }
]

/**
 * OpenRouter's speech endpoint is OpenAI-compatible. Its OpenAI voice model
 * is listed under a dated slug (the undated one is not routed).
 */
const OPENROUTER_MODELS: DubModel[] = [
  { id: 'openai/gpt-4o-mini-tts-2025-12-15', label: 'GPT-4o mini TTS (via OpenRouter)', speed: false, usdPerMillionChars: 15 }
]

/** Which AI route can dub, and with which models. */
export function dubSupport(provider: SubscriptionSettings['provider']): DubSupport {
  if (provider === 'chatgpt') {
    return {
      available: false,
      models: [],
      reason: 'AI voice dubbing needs a paid speech API, which ChatGPT sign-in does not include. Add an OpenAI API key or an OpenRouter key in Settings to dub.'
    }
  }
  if (provider === 'openrouter') return { available: true, provider: 'openrouter', models: OPENROUTER_MODELS }
  return { available: true, provider: 'openai', models: OPENAI_MODELS }
}

/** Approximate cost of synthesising `characters`, in US dollars. */
export function estimateDubCostUsd(characters: number, model: DubModel): number {
  return (characters * model.usdPerMillionChars) / 1_000_000
}

/** The dub line that voices a translation line as it reads now, if any. */
export function dubLineFor(dub: ClipDub | undefined, line: TranslationLine): DubLine | undefined {
  return dub?.lines.find((d) => Math.abs(d.start - line.start) < 0.01 && Math.abs(d.end - line.end) < 0.01 && d.text === line.text)
}

export interface DubCue {
  /** Output seconds where the line starts. */
  start: number
  /** Output seconds it plays for (after tempo, cut short if it must be). */
  duration: number
  tempo: number
  /** Cut short to stay inside its slot: fades out over `fadeOutSec`. */
  truncated: boolean
  fadeOutSec: number
  audioPath: string
  text: string
}

/**
 * Where each dub line plays in the output. Only translation lines that play
 * in full are voiced (the same lines the captions show), at their sentence's
 * slot mapped through the clip's time map. A line may use the pause after its
 * sentence but never the next sentence's slot or the time past the clip end;
 * one that still does not fit is cut short with a fade. Lines whose text was
 * edited after dubbing are silent until dubbed again.
 */
export function planDubCues(
  clip: Pick<Clip, 'edit' | 'visualStory' | 'gapActivity' | 'translation' | 'dub'>,
  transcript: Transcript | null,
  segments: KeptSegment[] | null,
  outputDuration?: number,
  /** Output seconds before the clip proper starts (a cold open); lines shift by it. */
  outputOffset = 0
): DubCue[] {
  const { translation, dub } = clip
  if (!translation?.accepted || !dub?.enabled || !dub.lines.length) return []
  const map = new TimeMap(segments?.length ? segments : [{ start: clip.edit.start, end: clip.edit.end }])
  const total = outputDuration ?? outputOffset + map.outputDuration
  const lines = translationState(clip, translation, transcript).playable
  const cues: DubCue[] = []
  lines.forEach((line, i) => {
    const voiced = dubLineFor(dub, line)
    if (!voiced) return
    const start = outputOffset + map.toOutput(line.start)
    const slotEnd = Math.min(total, i + 1 < lines.length ? outputOffset + map.toOutput(lines[i + 1].start) : total)
    const available = slotEnd - start - DUB_LINE_GAP_SEC
    if (available <= 0.05) return
    const tempo = Math.min(DUB_MAX_TEMPO, Math.max(1, voiced.tempo || 1))
    const natural = voiced.audioSec / tempo
    const truncated = natural > available + 1e-3
    const duration = Math.min(natural, available)
    cues.push({
      start,
      duration,
      tempo,
      truncated,
      fadeOutSec: truncated ? Math.min(DUB_TRUNCATE_FADE_SEC, duration / 2) : 0,
      audioPath: voiced.audioPath,
      text: voiced.text
    })
  })
  return cues
}

export interface DuckWindow {
  /** Output seconds the original is fully ducked between. */
  start: number
  end: number
}

/** Ducked spans, merged where two lines' ramps would meet. */
export function duckWindows(cues: DubCue[], rampSec = DUB_RAMP_SEC): DuckWindow[] {
  const out: DuckWindow[] = []
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    const window = { start: cue.start, end: cue.start + cue.duration }
    const last = out[out.length - 1]
    if (last && window.start - last.end <= rampSec * 2) last.end = Math.max(last.end, window.end)
    else out.push(window)
  }
  return out
}

/** Linear gain of the original audio at output time `t`. */
export function duckGainAt(windows: DuckWindow[], t: number, duckDb = DUB_DUCK_DB, rampSec = DUB_RAMP_SEC): number {
  const floor = 10 ** (duckDb / 20)
  let depth = 0
  for (const w of windows) {
    const ramp = Math.max(1e-3, rampSec)
    const into = Math.min((t - (w.start - ramp)) / ramp, ((w.end + ramp) - t) / ramp)
    depth = Math.max(depth, Math.min(1, Math.max(0, into)))
  }
  return 1 - (1 - floor) * depth
}

export interface DubEstimate {
  lines: number
  characters: number
  /** Characters not already in the cache: what a run would bill. */
  uncachedCharacters: number
  /** Approximate cost of one take per uncached line. */
  usd: number
  /** If every uncached line also needed the faster re-request. */
  usdMax: number
}
