import type { AudioReaction, SpeakerTurn, SpeechRegion, Transcript } from '@shared/types'
import { streamRawFrames } from './ffmpeg'
import { REACTION_SAMPLE_RATE, ReactionAnalyzer, detectReactions, type ReactionFeatures } from './reactions'
import { SpeakerEmbedder, speakerTurnsFrom } from './diarize'
import { timed } from './timing'

/**
 * Whole-source audio analyses run once at transcription time: audio
 * reactions (reactions.ts) and speaker turns (diarize.ts). The source is
 * decoded once, as a 16 kHz mono stream both consumers read, so memory stays
 * flat for multi-hour sources: the reaction features cost ~1.2 MB per hour
 * and the embedder holds one window of samples plus 2 KB per embedding.
 *
 * Neither analysis may fail transcription: each consumer is isolated, a
 * failure is logged and leaves its field absent, and only cancellation
 * propagates.
 */

const CHUNK_SAMPLES = 1600 // 100 ms of f32le per stream callback

export interface AudioAnalysisRequest {
  videoPath: string
  durationSec: number
  /** Compute reaction features. */
  reactions: boolean
  /** Voice activity to diarize over, with the speaker model; omit to skip diarization. */
  diarize?: { speech: SpeechRegion[]; modelPath: string }
}

export interface AudioAnalysisRaw {
  reactionFeatures?: ReactionFeatures
  /** Present when diarization ran to the end of the stream. */
  embedded?: Pick<SpeakerEmbedder, 'windows' | 'embeddings'>
  /** Reactions were asked for but could not be measured. */
  reactionsFailed?: boolean
  /** Diarization was asked for but did not produce embeddings. */
  speakersFailed?: boolean
}

/** Stream the source once and feed whichever analyses were asked for. */
export async function analyseSourceAudio(request: AudioAnalysisRequest, onProgress: (fraction: number) => void,
  signal?: AbortSignal, runner?: ConstructorParameters<typeof SpeakerEmbedder>[2]): Promise<AudioAnalysisRaw> {
  let reactions = request.reactions ? new ReactionAnalyzer() : null
  let embedder = request.diarize ? new SpeakerEmbedder(request.diarize.speech, request.diarize.modelPath, runner, signal) : null
  if (embedder && embedder.windowCount === 0) embedder = null
  const diarizing = !!embedder
  if (!reactions && !embedder) return {}
  const totalSamples = Math.max(1, request.durationSec * REACTION_SAMPLE_RATE)
  let position = 0
  let reported = -1
  const isolate = async (name: string, fn: () => void | Promise<void>): Promise<boolean> => {
    try {
      await fn()
      return true
    } catch (error) {
      if (signal?.aborted) throw error
      console.error(`Audio analysis (${name}) failed; continuing without it:`, error)
      return false
    }
  }
  const stopped = new Error('Both audio analyses stopped')
  try {
    await timed('audio-analysis/stream', () => streamRawFrames(
      ['-v', 'error', '-i', request.videoPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(REACTION_SAMPLE_RATE), '-f', 'f32le'],
      CHUNK_SAMPLES * 4,
      async (frame) => {
        // The frame is a view into ffmpeg's output buffer at any byte offset; copy to align.
        const samples = new Float32Array(CHUNK_SAMPLES)
        frame.copy(Buffer.from(samples.buffer))
        const at = position
        position += CHUNK_SAMPLES
        if (reactions && !(await isolate('reactions', () => reactions!.push(samples)))) reactions = null
        if (embedder && !(await isolate('speakers', () => embedder!.push(samples, at)))) embedder = null
        // Nothing left to feed: stop decoding the rest of the source.
        if (!reactions && !embedder) throw stopped
        const fraction = Math.min(1, position / totalSamples)
        if (Math.floor(fraction * 100) !== reported) { reported = Math.floor(fraction * 100); onProgress(fraction) }
      },
      signal
    ), { audioSec: Math.round(request.durationSec), reactions: !!reactions, speakers: embedder?.windowCount ?? 0 })
  } catch (error) {
    if (signal?.aborted) throw error
    if (error !== stopped) {
      // A damaged tail makes ffmpeg exit non-zero after decoding most of the
      // source. The reaction features measured so far still describe what
      // played; diarization needs the whole stream, so it is dropped.
      console.error('Audio analysis stream failed; keeping the reactions measured so far:', error)
      embedder = null
    }
  }
  if (embedder && !(await isolate('speakers', () => embedder!.flush()))) embedder = null
  return {
    reactionFeatures: reactions?.finish(),
    embedded: embedder ? { windows: embedder.windows, embeddings: embedder.embeddings } : undefined,
    ...(request.reactions && !reactions ? { reactionsFailed: true } : {}),
    ...(diarizing && !embedder ? { speakersFailed: true } : {})
  }
}

export interface AudioAnalysisResult {
  reactions?: AudioReaction[]
  /** [] when diarization ran and heard one voice; undefined when it did not run. */
  speakerTurns?: SpeakerTurn[]
}

/** Turn streamed measurements into transcript fields, using the words Whisper found. */
export function finishAudioAnalysis(raw: AudioAnalysisRaw, transcript: Transcript): AudioAnalysisResult {
  const words = transcript.segments.flatMap(s => s.words ?? [])
  const result: AudioAnalysisResult = {}
  try {
    if (raw.reactionFeatures) {
      result.reactions = detectReactions(raw.reactionFeatures, { durationSec: transcript.durationSec, speech: transcript.speech, words })
    }
  } catch (error) {
    console.error('Audio reaction detection failed; continuing without it:', error)
  }
  try {
    if (raw.embedded) {
      result.speakerTurns = speakerTurnsFrom(raw.embedded.windows, raw.embedded.embeddings, transcript.speech ?? [], words)
    }
  } catch (error) {
    console.error('Speaker clustering failed; continuing without it:', error)
  }
  return result
}
