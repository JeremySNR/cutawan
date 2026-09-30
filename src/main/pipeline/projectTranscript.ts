import type { PipelineProgress, Project, Transcript } from '@shared/types'
import { AUDIO_CHUNK_SEC, extractAudioChunks } from './ffmpeg'
import { transcriptionChunkSec } from './openai'
import { transcribeChunks } from './transcribe'
import { annotateEnergy } from './energy'
import { detectSpeech, vadAvailable } from './vad'
import { timed } from './timing'
import { updateProject } from '../projects'

/**
 * Whisper transcription for a project, shared by the clip-finding pipeline
 * and "caption whole video".
 *
 * Transcription is the most expensive stage of either flow, so the result is
 * checkpointed to disk the moment it lands and reused by every later run:
 * retries after a failure, regenerating clips with a new prompt, and moving
 * between the two modes never pay for it twice.
 */

/** Share of the progress span each step of the stage accounts for. */
const AUDIO_SHARE = 0.25
const TRANSCRIBE_SHARE = 0.7

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
    signal
  )
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
  project.transcript = transcript
  await updateProject(project.id, (p) => {
    p.transcript = transcript
  })
  return transcript
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
