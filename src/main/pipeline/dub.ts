import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clip, ClipDub, DubFit, DubLine, Transcript, TranslationLine } from '@shared/types'
import { translationState } from '@shared/captionTranslation'
import {
  DUB_DUCK_DB,
  DUB_LINE_GAP_SEC,
  DUB_MAX_TEMPO,
  DUB_RAMP_SEC,
  dubLineFor,
  duckWindows,
  planDubCues,
  estimateDubCostUsd,
  type DubCue,
  type DubEstimate,
  type DubModel,
  type DuckWindow
} from '@shared/dubPlan'
import { clipKeptSegments, TimeMap, type KeptSegment } from '@shared/tighten'
import { FFMPEG_PATH, FFPROBE_PATH, runBinary, runBinaryFull } from './ffmpeg'
import { loudnormFilter, MEASURE_FILTER, parseLoudnormStats } from './loudness'
import { synthesizeSpeech, type SpeechRequest } from './openai'
import { condenseTarget, type CondenseItem } from './dubScript'

/**
 * AI voice dubbing of a clip's accepted translation: synthesise each line,
 * fit it into its slot, and mix the result over the ducked original on
 * export. Planning (where each line plays, the duck envelope) lives in
 * @shared/dubPlan so the preview plays exactly what this exports.
 */

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export interface SynthResult {
  path: string
  /** Duration of the synthesised audio, seconds. */
  sec: number
}

export interface FitResult {
  audioPath: string
  audioSec: number
  tempo: number
  fit: DubFit
}

/** How much quicker to ask for, given how far over the first take ran. */
export function fasterSpeed(firstSec: number, availableSec: number): number {
  return Math.min(1.6, Math.max(1.1, (firstSec / Math.max(0.1, availableSec)) * 1.05))
}

/**
 * Fit one line into `availableSec`, in order of how natural it sounds:
 *  1. the first take, if it fits;
 *  2. a re-request at a faster speaking rate, if that fits;
 *  3. the faster take time-stretched (atempo) by up to DUB_MAX_TEMPO;
 *  4. failing that, stretched to the limit and cut short with a fade at
 *     playback (`truncated`, flagged in the review panel).
 * `synth` is injected so the decisions are testable without audio.
 */
export async function fitDubLine(
  availableSec: number,
  synth: (variant: { faster: boolean; speed: number }) => Promise<SynthResult>
): Promise<FitResult> {
  const first = await synth({ faster: false, speed: 1 })
  if (first.sec <= availableSec) return { audioPath: first.path, audioSec: first.sec, tempo: 1, fit: 'natural' }
  // A failed or silent faster take falls back to the first.
  const faster = await synth({ faster: true, speed: fasterSpeed(first.sec, availableSec) }).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') throw error
    console.error('Faster dub take failed; keeping the first take:', error)
    return first
  })
  // A model that ignores the pace request can come back no shorter.
  const best = faster.sec < first.sec ? faster : first
  if (best.sec <= availableSec) return { audioPath: best.path, audioSec: best.sec, tempo: 1, fit: 'faster' }
  // Rounded up, so the stretched line never comes out a hair too long.
  const tempo = Math.ceil((best.sec / availableSec) * 1000) / 1000
  if (tempo <= DUB_MAX_TEMPO) return { audioPath: best.path, audioSec: best.sec, tempo, fit: 'stretched' }
  return { audioPath: best.path, audioSec: best.sec, tempo: DUB_MAX_TEMPO, fit: 'truncated' }
}

// ---------------------------------------------------------------------------
// Synthesis with a per-project cache
// ---------------------------------------------------------------------------

export interface DubVoiceChoice {
  provider: ClipDub['provider']
  model: DubModel
  voice: string
}

function speechRequest(text: string, choice: DubVoiceChoice, variant: { faster: boolean; speed: number }): SpeechRequest {
  const base = { model: choice.model.id, voice: choice.voice, input: text }
  if (!variant.faster) return base
  if (choice.model.speed) return { ...base, speed: Math.round(variant.speed * 20) / 20 }
  const percent = Math.round((variant.speed - 1) * 100)
  return {
    ...base,
    instructions: `Speak briskly, about ${percent}% faster than a normal pace, with short pauses. Keep it clear and natural.`
  }
}

/**
 * Cache file for one synthesis. Keyed by everything that changes the audio,
 * so re-exports, re-opening the project and undoing an edit never pay again.
 */
export function speechCachePath(cacheDir: string, req: SpeechRequest): string {
  const key = createHash('sha256')
    .update(JSON.stringify({ v: 2, model: req.model, voice: req.voice, input: req.input, speed: req.speed ?? 1, instructions: req.instructions ?? '' }))
    .digest('hex')
    .slice(0, 32)
  return join(cacheDir, `${key}.mp3`)
}

export async function probeAudioSeconds(path: string): Promise<number> {
  const out = await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
  const sec = Number(out.trim())
  if (!Number.isFinite(sec) || sec <= 0) throw new Error('Synthesised audio has no duration')
  return sec
}

/**
 * Speech models pad each take with silence: up to 0.58 s before the first
 * word and 0.33 s after the last in the live check, most of a short line's
 * slot. Trimmed to a breath either side when the take is cached.
 */
export const TRIM_SILENCE_FILTER = [
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04',
  'areverse',
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
  'areverse'
].join(',')

/** Shorter than this once trimmed, a take holds no speech. */
const MIN_TAKE_SEC = 0.1

export class SilentTakeError extends Error {
  constructor() { super('The voice model returned silence for this line. Try again, or choose another voice.') }
}

async function synthesiseCached(
  apiKey: string,
  cacheDir: string,
  req: SpeechRequest,
  signal?: AbortSignal
): Promise<SynthResult> {
  const path = speechCachePath(cacheDir, req)
  if (!existsSync(path)) {
    const bytes = await synthesizeSpeech(apiKey, req, signal)
    await mkdir(cacheDir, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    const trimmed = `${path}.${randomUUID()}.trim.mp3`
    try {
      await writeFile(temporary, bytes)
      // Keep the untrimmed take if ffmpeg cannot trim it: a little air beats no line.
      const trim = await runBinaryFull(FFMPEG_PATH, ['-v', 'error', '-y', '-i', temporary, '-af', TRIM_SILENCE_FILTER,
        '-c:a', 'libmp3lame', '-b:a', '128k', trimmed], { signal }).then(() => true, () => false)
      signal?.throwIfAborted()
      // Nothing left once trimmed: the model returned silence (seen on a
      // two-word line asked to speak briskly). Never cache it.
      if (trim && !(await probeAudioSeconds(trimmed).then((sec) => sec >= MIN_TAKE_SEC, () => false))) {
        throw new SilentTakeError()
      }
      await rename(trim ? trimmed : temporary, path)
    } finally {
      await rm(temporary, { force: true })
      await rm(trimmed, { force: true })
    }
  }
  return { path, sec: await probeAudioSeconds(path) }
}

// ---------------------------------------------------------------------------
// Whole-clip dub
// ---------------------------------------------------------------------------

interface LineSlot {
  line: TranslationLine
  /** Output seconds available before the next sentence or the clip end. */
  available: number
}

/** Each playable line with the time it may use, under the current edit. */
export function dubSlots(clip: Clip, transcript: Transcript | null): LineSlot[] {
  if (!clip.translation) return []
  const lines = translationState(clip, clip.translation, transcript).playable
  const map = new TimeMap(clipKeptSegments(clip, transcript) ?? [{ start: clip.edit.start, end: clip.edit.end }])
  return lines.map((line, i) => {
    const start = map.toOutput(line.start)
    const end = i + 1 < lines.length ? map.toOutput(lines[i + 1].start) : map.outputDuration
    return { line, available: Math.max(0, end - start - DUB_LINE_GAP_SEC) }
  }).filter((slot) => slot.available > 0.05 && slot.line.text.trim().length > 0)
}

export function estimateDub(clip: Clip, transcript: Transcript | null, cacheDir: string, choice: DubVoiceChoice): DubEstimate {
  const slots = dubSlots(clip, transcript)
  const characters = slots.reduce((sum, s) => sum + s.line.text.length, 0)
  const uncached = slots.filter((s) => !existsSync(speechCachePath(cacheDir, speechRequest(s.line.text, choice, { faster: false, speed: 1 }))))
  const uncachedCharacters = uncached.reduce((sum, s) => sum + s.line.text.length, 0)
  const usd = estimateDubCostUsd(uncachedCharacters, choice.model)
  return { lines: slots.length, characters, uncachedCharacters, usd, usdMax: usd * 2 }
}

export async function dubClip(
  apiKey: string,
  clip: Clip,
  transcript: Transcript | null,
  cacheDir: string,
  choice: DubVoiceChoice,
  opts: {
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
    /** Shorter wordings for overrunning lines (dubScript.ts); omitted, lines are only sped up. */
    condense?: (items: CondenseItem[]) => Promise<Map<number, string>>
  } = {}
): Promise<ClipDub> {
  if (!clip.translation?.accepted) throw new Error('Accept the translation before dubbing it.')
  const slots = dubSlots(clip, transcript)
  if (!slots.length) throw new Error('No translated line plays in this clip, so there is nothing to dub.')
  let done = 0
  const fit = (slot: LineSlot, text: string): Promise<FitResult> => fitDubLine(slot.available, (variant) =>
    synthesiseCached(apiKey, cacheDir, speechRequest(text, choice, variant), opts.signal))
  // A few lines at a time: the API queue bounds concurrency across the app.
  const results: Array<{ slot: LineSlot; fitted: FitResult; spoken?: string }> = await Promise.all(slots.map(async (slot) => {
    const fitted = await fit(slot, slot.line.text)
    opts.onProgress?.(++done, slots.length)
    return { slot, fitted }
  }))
  // Lines still too long at the fastest tempo get a shorter wording, voiced again.
  const over = results.map((r, i) => ({ r, n: i + 1 })).filter(({ r }) => r.fitted.fit === 'truncated')
  if (opts.condense && over.length) {
    let shorter = new Map<number, string>()
    try {
      shorter = await opts.condense(over.map(({ r, n }) => ({
        n, text: r.slot.line.text, maxChars: condenseTarget(r.slot.line.text, r.slot.available, r.fitted.audioSec, DUB_MAX_TEMPO)
      })))
    } catch (error) {
      if (opts.signal?.aborted) throw error
      console.error('Shortening overrunning dub lines failed; keeping them as they are:', error)
    }
    await Promise.all(over.map(async ({ r, n }) => {
      const text = shorter.get(n)
      if (!text) return
      const again = await fit(r.slot, text)
      // Keep whichever overruns less; a shorter wording that now fits always wins.
      if (again.fit !== 'truncated' || again.audioSec < r.fitted.audioSec) { r.fitted = again; r.spoken = text }
    }))
  }
  const lines: DubLine[] = results.map(({ slot, fitted, spoken }) => ({
    start: slot.line.start,
    end: slot.line.end,
    text: slot.line.text,
    ...(spoken ? { spoken } : {}),
    audioPath: fitted.audioPath,
    audioSec: fitted.audioSec,
    tempo: fitted.tempo,
    fit: fitted.fit
  }))
  return {
    version: 1,
    provider: choice.provider,
    model: choice.model.id,
    voice: choice.voice,
    enabled: true,
    lines,
    createdAt: Date.now()
  }
}

/** Lines of the accepted translation that have no up-to-date dub. */
export function staleDubLines(clip: Clip, transcript: Transcript | null): number {
  if (!clip.translation || !clip.dub) return 0
  return dubSlots(clip, transcript).filter((s) => !dubLineFor(clip.dub, s.line)).length
}

// ---------------------------------------------------------------------------
// Export: one dub track, then a mix over the ducked original
// ---------------------------------------------------------------------------

const DUB_FORMAT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'

/** atempo takes 0.5-2 per instance; dub tempos stay within 1-1.25. */
function tempoFilter(tempo: number): string {
  return Math.abs(tempo - 1) < 1e-3 ? '' : `,atempo=${tempo.toFixed(4)}`
}

/**
 * Filter graph placing each cue at its output time, exactly
 * `outputDuration` long. Exported for tests.
 */
export function dubTrackGraph(cues: DubCue[], outputDuration: number): string {
  const parts = cues.map((cue, i) => {
    const fade = cue.truncated && cue.fadeOutSec > 0
      ? `,afade=t=out:st=${Math.max(0, cue.duration - cue.fadeOutSec).toFixed(4)}:d=${cue.fadeOutSec.toFixed(4)}`
      : ''
    const delayMs = Math.max(0, Math.round(cue.start * 1000))
    return `[${i}:a]${DUB_FORMAT}${tempoFilter(cue.tempo)},atrim=end=${cue.duration.toFixed(4)},asetpts=PTS-STARTPTS${fade},adelay=delays=${delayMs}:all=1[d${i}]`
  })
  const total = outputDuration.toFixed(4)
  const labels = cues.map((_, i) => `[d${i}]`).join('')
  const join = cues.length > 1 ? `${labels}amix=inputs=${cues.length}:duration=longest:dropout_transition=0:normalize=0,` : labels
  parts.push(`${join}apad=whole_dur=${total},atrim=end=${total}[dub]`)
  return parts.join(';')
}

/**
 * Render the cues into one track, loudness-matched to the export's master
 * (-14 LUFS, so the voice sits where the original speech sat), at exactly
 * `outputDuration`. One file keeps the export graph to a single extra input.
 */
export async function renderDubTrack(cues: DubCue[], outputDuration: number, outPath: string, signal?: AbortSignal): Promise<void> {
  if (!cues.length) throw new Error('No dub lines to render')
  const raw = `${outPath}.raw-${randomUUID()}.wav`
  const script = `${outPath}.graph-${randomUUID()}.txt`
  try {
    await writeFile(script, dubTrackGraph(cues, outputDuration), 'utf8')
    await runBinary(FFMPEG_PATH, ['-hide_banner', '-nostats', '-y', ...cues.flatMap((cue) => ['-i', cue.audioPath]),
      '-filter_complex_script', script, '-map', '[dub]', '-c:a', 'pcm_s16le', raw], { signal })
    const { stderr } = await runBinaryFull(FFMPEG_PATH, ['-hide_banner', '-nostats', '-i', raw, '-af', MEASURE_FILTER, '-f', 'null', '-'], { signal })
    const stats = parseLoudnormStats(stderr)
    const total = outputDuration.toFixed(4)
    await runBinary(FFMPEG_PATH, ['-hide_banner', '-nostats', '-y', '-i', raw,
      '-af', `${loudnormFilter(stats)},${DUB_FORMAT},apad=whole_dur=${total},atrim=end=${total}`,
      '-c:a', 'pcm_s16le', outPath], { signal })
  } finally {
    await rm(raw, { force: true }).catch(() => undefined)
    await rm(script, { force: true }).catch(() => undefined)
  }
}

/** Windows per volume filter: keeps each expression well under ffmpeg's parser limit. */
const WINDOWS_PER_FILTER = 12

/**
 * The duck as chained `volume` filters, each covering a batch of windows.
 * Windows are merged (no two ramps overlap), so outside its own windows each
 * filter is exactly unity and the chain's product equals the shared
 * duckGainAt envelope the preview applies.
 */
export function duckFilters(windows: DuckWindow[], duckDb = DUB_DUCK_DB, rampSec = DUB_RAMP_SEC): string[] {
  const depth = (1 - 10 ** (duckDb / 20)).toFixed(5)
  const r = Math.max(1e-3, rampSec)
  const filters: string[] = []
  for (let i = 0; i < windows.length; i += WINDOWS_PER_FILTER) {
    const terms = windows.slice(i, i + WINDOWS_PER_FILTER).map((w) =>
      `clip(min((t-${(w.start - r).toFixed(4)})/${r},(${(w.end + r).toFixed(4)}-t)/${r}),0,1)`)
    const envelope = terms.reduce((acc, term) => (acc ? `max(${acc},${term})` : term), '')
    filters.push(`volume=volume='1-${depth}*${envelope}':eval=frame`)
  }
  return filters
}

/**
 * --- Dub mix hook for render.ts ---------------------------------------
 * Takes the label of the export's finished voice chain and returns the label
 * of the mixed stream: the original ducked under each dub line, plus the dub
 * track (input `dubInput`). The voice chain's length decides the output
 * length (`duration=first`), so the export stays exactly the sum of the kept
 * segments. A source with no audio gets the dub alone.
 */
export function dubMixGraph(
  voiceLabel: string | null,
  dubInput: number,
  windows: DuckWindow[]
): { filter: string; label: string } {
  if (!voiceLabel) return { filter: `[${dubInput}:a]${DUB_FORMAT}[adub]`, label: 'adub' }
  // Timestamps are rebuilt from the sample count: loudnorm emits its first
  // seconds late and stamped as one block, which shifted the envelope off
  // the dub. Small frames give the envelope ~5 ms steps instead of ~21 ms.
  const duck = ['asetpts=N/SR/TB', 'asetnsamples=n=256:p=0', ...duckFilters(windows)].join(',')
  return {
    filter: `[${voiceLabel}]${duck}[aducked];[${dubInput}:a]${DUB_FORMAT}[dubin];` +
      `[aducked][dubin]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[adub]`,
    label: 'adub'
  }
}

export interface PreparedDub {
  trackPath: string
  windows: DuckWindow[]
}

/**
 * Plan the clip's dub against the export's own segments and render its
 * track, or null when the clip has no enabled dub that plays.
 */
export async function prepareDubTrack(
  clip: Clip,
  transcript: Transcript | null,
  segments: KeptSegment[] | null,
  outputDuration: number,
  tempDir: string,
  signal?: AbortSignal,
  outputOffset = 0
): Promise<PreparedDub | null> {
  const cues = planDubCues(clip, transcript, segments, outputDuration, outputOffset).filter((cue) => existsSync(cue.audioPath))
  if (!cues.length) return null
  const trackPath = join(tempDir, `dub-${randomUUID()}.wav`)
  await renderDubTrack(cues, outputDuration, trackPath, signal)
  return { trackPath, windows: duckWindows(cues) }
}

interface AudioGraph {
  filterComplex: string
  extraInputs: string[]
  audioLabel: string | null
}

/**
 * Add the dub track to an export filter graph as one more input, mixed in
 * by dubMixGraph. `sourceInputs` is how many `-i` the export puts before the
 * graph's own extra inputs.
 */
export function withDubMix<G extends AudioGraph>(graph: G, dub: PreparedDub | null, sourceInputs: number): G {
  if (!dub) return graph
  const input = sourceInputs + graph.extraInputs.filter((arg) => arg === '-i').length
  const mix = dubMixGraph(graph.audioLabel, input, dub.windows)
  return {
    ...graph,
    filterComplex: `${graph.filterComplex};${mix.filter}`,
    extraInputs: [...graph.extraInputs, '-i', dub.trackPath],
    audioLabel: mix.label
  }
}
