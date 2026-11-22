import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineProgress, Project, SpeechRegion, Transcript } from '@shared/types'
import { AUDIO_CHUNK_SEC, extractAudioChunks } from './ffmpeg'
import { transcriptionChunkSec, transcriptionPlan } from './openai'
import { transcribeChunks } from './transcribe'
import { annotateEnergy } from './energy'
import { detectSpeech, vadAvailable } from './vad'
import { timed } from './timing'
import { analyseSourceAudio, finishAudioAnalysis, type AudioAnalysisRaw, type AudioAnalysisRequest } from './audioAnalysis'
import { speakerModelPath } from './speakerModel'
import { projectDir, updateProject } from '../projects'

/**
 * Whisper transcription for a project, shared by the clip-finding pipeline
 * and "caption whole video".
 *
 * Transcription is the most expensive stage of either flow, so the result is
 * checkpointed to disk the moment it lands and reused by every later run:
 * retries after a failure, regenerating clips with a new prompt, and moving
 * between the two modes never pay for it twice.
 *
 * Two local whole-source analyses ride along and are saved with it: audio
 * reactions (laughter, applause, impacts) and speaker turns. They start once
 * voice activity is known and run alongside Whisper, so usually they are
 * done when it is; older projects get them backfilled like `speech`.
 */

/** Share of the progress span each step of the stage accounts for. */
const AUDIO_SHARE = 0.25
const TRANSCRIBE_SHARE = 0.7
/**
 * Re-running clips on an older project waits this long for the speaker
 * model (a cached copy verifies in ~0.1 s); a first download carries on in
 * the background and is used next time instead of holding up the run.
 */
const BACKFILL_MODEL_WAIT_MS = 10_000
/** Where the audio analyses report while the stage waits on them (after energy). */
const ANALYSIS_FROM = 0.95
const ANALYSIS_MESSAGE = 'Finding speakers and reactions…'

export interface EnsureTranscriptOptions {
  apiKey: string
  model: string
  language: string
  /** Slice of the overall 0..1 pipeline progress this stage reports within. */
  span: { from: number; to: number }
  /** Error raised when the video turns out to have no speech at all. */
  noSpeechError: string
  /** Visual discovery can proceed on an explicitly empty transcript. */
  allowNoSpeech?: boolean
}

export async function ensureTranscript(
  project: Project,
  workDir: string,
  options: EnsureTranscriptOptions,
  onProgress: (p: PipelineProgress) => void,
  signal?: AbortSignal
): Promise<Transcript> {
  const { from, to } = options.span
  const at = (fraction: number): number => from + (to - from) * fraction

  if (project.transcript) {
    if (!project.transcript.segments.length && !options.allowNoSpeech) throw new Error(options.noSpeechError)
    onProgress({ stage: 'transcribe', progress: at(1), message: 'Using saved transcript…' })
    if (!project.transcript.speech && project.video.hasAudio) {
      // Older projects: add voice activity once so cuts land in silence.
      onProgress({ stage: 'transcribe', progress: at(1), message: 'Detecting speech…' })
      const speech = await speechFor(project.video.path, signal)
      if (speech) {
        project.transcript = { ...project.transcript, speech }
        await updateProject(project.id, (p) => { if (p.transcript) p.transcript.speech = speech })
      }
    }
    if (project.video.hasAudio) {
      // Older projects: add reactions and speaker turns once.
      const saved = project.transcript
      const tried = await analysedBefore(project, saved)
      const want = {
        reactions: !saved.reactions && !tried.reactions,
        speakers: !saved.speakerTurns && !tried.speakers
      }
      if (want.reactions || want.speakers) {
        onProgress({ stage: 'transcribe', progress: at(1), message: ANALYSIS_MESSAGE })
        const raw = await runAudioAnalysis(project, Promise.resolve(saved.speech), want,
          (f) => onProgress({ stage: 'transcribe', progress: at(1), message: analysisMessage(f) }), signal,
          delay(BACKFILL_MODEL_WAIT_MS))
        await saveAudioAnalysis(project, saved, raw)
      }
    }
    return project.transcript
  }

  if (!project.video.hasAudio) {
    if (options.allowNoSpeech) {
      const transcript: Transcript = { language: options.language, durationSec: project.video.durationSec, segments: [], speech: [] }
      project.transcript = transcript
      await updateProject(project.id, (p) => {
        if (p.video.path === project.video.path && (p.sourceRevision ?? 0) === (project.sourceRevision ?? 0)) p.transcript = transcript
      })
      onProgress({ stage: 'transcribe', progress: at(1), message: 'No audio track — looking for visual moments.' })
      return transcript
    }
    throw new Error('This video has no audio track. Speech-based clip selection needs a video with spoken audio.')
  }

  // Voice activity is local and independent of the transcription route, so
  // it runs alongside it rather than adding to the wait.
  const speech = speechFor(project.video.path, signal)
  speech.catch(() => undefined) // awaited below; only cancellation rejects
  // The audio analyses wait only for voice activity. Their own controller
  // stops them if transcription fails, so they never outlive the stage.
  const analysisControl = new AbortController()
  const analysisSignal = signal ? AbortSignal.any([signal, analysisControl.signal]) : analysisControl.signal
  let analysisProgress: ((fraction: number) => void) | undefined
  let transcribed = (): void => {}
  const transcriptReady = new Promise<void>((resolve) => { transcribed = resolve })
  const analysis = runAudioAnalysis(project, speech, { reactions: true, speakers: true },
    (f) => analysisProgress?.(f), analysisSignal, transcriptReady)
  analysis.catch(() => undefined) // awaited below; only cancellation rejects
  try {
    onProgress({ stage: 'audio', progress: at(0), message: 'Extracting audio…' })
    const chunks = await extractAudioChunks(
      project.video.path,
      workDir,
      project.video.durationSec,
      (f) =>
        onProgress({ stage: 'audio', progress: at(f * AUDIO_SHARE), message: 'Extracting audio…' }),
      signal,
      transcriptionChunkSec(AUDIO_CHUNK_SEC)
    )

    onProgress({
      stage: 'transcribe',
      progress: at(AUDIO_SHARE),
      message: 'Transcribing with Whisper…'
    })
    const transcript = await transcribeChunks(
      options.apiKey,
      options.model,
      chunks,
      options.language,
      (f) =>
        onProgress({
          stage: 'transcribe',
          progress: at(AUDIO_SHARE + f * TRANSCRIBE_SHARE),
          message:
            chunks.length > 1
              ? `Transcribing (part ${Math.min(chunks.length, Math.ceil(f * chunks.length))}/${chunks.length})…`
              : 'Transcribing with Whisper…'
        }),
      signal,
      transcriptionPlan()
    )
    transcribed()
    if (transcript.segments.length === 0 && !options.allowNoSpeech) throw new Error(options.noSpeechError)
    transcript.speech = (await speech) ?? undefined

    // Vocal energy feeds the virality analysis (arousal signal) and the auto
    // zoom's emphasis punch-ins, so both flows want it annotated.
    onProgress({
      stage: 'transcribe',
      progress: at(AUDIO_SHARE + TRANSCRIBE_SHARE),
      message: 'Measuring vocal energy…'
    })
    await annotateEnergy(transcript, chunks)

    // Checkpoint. Persist only the field this stage owns — saving the whole
    // local object would revert e.g. a rename that landed since it was loaded.
    // Saved before waiting on the audio analyses, so cancelling during them
    // keeps the transcript (they are backfilled on the next run).
    project.transcript = transcript
    await updateProject(project.id, (p) => {
      p.transcript = transcript
    })

    analysisProgress = (f) => onProgress({ stage: 'transcribe', progress: at(ANALYSIS_FROM + (1 - ANALYSIS_FROM) * f), message: analysisMessage(f) })
    onProgress({ stage: 'transcribe', progress: at(ANALYSIS_FROM), message: ANALYSIS_MESSAGE })
    await saveAudioAnalysis(project, transcript, await analysis)
    return transcript
  } finally {
    transcribed()
    analysisControl.abort()
  }
}

/** Voice activity for the source, or null when unavailable; never fails the stage. */
async function speechFor(videoPath: string, signal?: AbortSignal): Promise<Transcript['speech'] | null> {
  if (!vadAvailable()) return null
  try {
    return await timed('speech', () => detectSpeech(videoPath, signal))
  } catch (error) {
    if (signal?.aborted) throw error
    console.error('Speech detection failed; cuts will use word timing only:', error)
    return null
  }
}

const analysisMessage = (fraction: number): string =>
  fraction > 0 && fraction < 1 ? `Finding speakers and reactions… ${Math.round(fraction * 100)}%` : ANALYSIS_MESSAGE

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })

/**
 * The speaker model if it is ready before `deadline`, else null. A first
 * download is never awaited past the deadline (a slow or hung connection
 * must not hold up the stage); it carries on and serves the next run.
 */
function speakerModelBefore(deadline: Promise<unknown>, signal?: AbortSignal): Promise<string | null> {
  // `signal` abandons only this wait; the shared download carries on. Any
  // other rejection is a missing model, never a failed analysis.
  const model = speakerModelPath(signal).catch((error: unknown) => {
    if (signal?.aborted) throw error
    return null
  })
  return Promise.race([model, deadline.then(() => null)])
}

/**
 * Reactions and/or speaker turns measured over the whole source; null when
 * there was nothing to run, and only failure flags when the analysis
 * failed. Never fails the stage except on cancellation. The speaker model
 * may be downloaded on first use (see speakerModel.ts) and is awaited until
 * `modelDeadline`; without it, or without voice activity, diarization is
 * skipped this time.
 */
export async function runAudioAnalysis(
  project: Project,
  speech: Promise<SpeechRegion[] | null | undefined>,
  want: { reactions: boolean; speakers: boolean },
  onFraction: (fraction: number) => void,
  signal?: AbortSignal,
  modelDeadline: Promise<unknown> = Promise.resolve()
): Promise<AudioAnalysisRaw | null> {
  let diarize: AudioAnalysisRequest['diarize']
  try {
    const regions = await speech
    // Only a source with speech needs the model: a silent or music-only one
    // never starts the download.
    const modelPath = want.speakers && regions?.length ? await speakerModelBefore(modelDeadline, signal) : null
    diarize = modelPath && regions?.length ? { speech: regions, modelPath } : undefined
    if (!want.reactions && !diarize) return null
    return await timed('audio-analysis', () => analyseSourceAudio({
      videoPath: project.video.path,
      durationSec: project.video.durationSec,
      reactions: want.reactions,
      diarize
    }, onFraction, signal))
  } catch (error) {
    if (signal?.aborted) throw error
    console.error('Audio analysis failed; the transcript is kept without it:', error)
    // Recorded so the backfill does not decode the whole source again on
    // every regeneration.
    return { ...(want.reactions ? { reactionsFailed: true } : {}), ...(diarize ? { speakersFailed: true } : {}) }
  }
}

/** Attach the analyses to the transcript and persist just those fields. */
async function saveAudioAnalysis(project: Project, transcript: Transcript, raw: AudioAnalysisRaw | null): Promise<void> {
  if (!raw) return
  const result = finishAudioAnalysis(raw, transcript)
  const turns = result.speakerTurns?.length ? result.speakerTurns : undefined
  if (result.reactions || turns) {
    if (result.reactions) transcript.reactions = result.reactions
    if (turns) transcript.speakerTurns = turns
    await updateProject(project.id, (p) => {
      // A source replaced meanwhile has a transcript of its own.
      if (!p.transcript || p.video.path !== project.video.path || (p.sourceRevision ?? 0) !== (project.sourceRevision ?? 0)) return
      if (result.reactions) p.transcript.reactions = result.reactions
      if (turns) p.transcript.speakerTurns = turns
    })
  }
  // A failed analysis is recorded as tried, like a single voice, so the
  // backfill does not decode the whole source again on every regeneration.
  const speakers = !!result.speakerTurns || !!raw.speakersFailed
  const reactions = !result.reactions && (!!raw.reactionsFailed || !!raw.reactionFeatures)
  if (speakers || reactions) await markAnalysed(project, transcript, { speakers, reactions })
}

/**
 * A single voice leaves `speakerTurns` absent, which alone cannot tell
 * "diarized, one speaker" from "never diarized"; a failed analysis leaves
 * its field absent too. A small marker beside project.json records both,
 * keyed to the source, so the backfill does not re-run the model or decode
 * the source on every regeneration of a talking-head video or a damaged
 * file. Bump the version when the analyses improve enough to be worth
 * re-running.
 */
const ANALYSIS_MARKER = 'audio-analysis.json'
const ANALYSIS_VERSION = 1

interface AnalysisMarker {
  version?: number
  /** Source key diarization ran on (or failed on). */
  diarized?: string
  /** Source key reaction detection failed on. */
  reactionsTried?: string
}

function sourceKey(project: Project, transcript: Transcript): string {
  return JSON.stringify([project.video.path, project.sourceRevision ?? 0, transcript.durationSec, transcript.segments.length])
}

async function readMarker(project: Project): Promise<AnalysisMarker> {
  try {
    const marker = JSON.parse(await readFile(join(projectDir(project.id), ANALYSIS_MARKER), 'utf8')) as AnalysisMarker
    return marker.version === ANALYSIS_VERSION ? marker : {}
  } catch {
    return {}
  }
}

async function analysedBefore(project: Project, transcript: Transcript): Promise<{ speakers: boolean; reactions: boolean }> {
  const marker = await readMarker(project)
  const key = sourceKey(project, transcript)
  return { speakers: marker.diarized === key, reactions: marker.reactionsTried === key }
}

async function markAnalysed(project: Project, transcript: Transcript, done: { speakers: boolean; reactions: boolean }): Promise<void> {
  const key = sourceKey(project, transcript)
  const marker = await readMarker(project)
  try {
    await writeFile(join(projectDir(project.id), ANALYSIS_MARKER), JSON.stringify({
      version: ANALYSIS_VERSION,
      ...(done.speakers ? { diarized: key } : marker.diarized ? { diarized: marker.diarized } : {}),
      ...(done.reactions ? { reactionsTried: key } : marker.reactionsTried ? { reactionsTried: marker.reactionsTried } : {})
    }))
  } catch (error) {
    console.warn('Could not record the audio analysis for this project:', error)
  }
}
