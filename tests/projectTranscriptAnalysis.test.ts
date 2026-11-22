import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineProgress, Project, Transcript } from '@shared/types'
import { syntheticWords, writeSynthetic } from './syntheticAudio'

/**
 * Audio reactions and speaker turns inside ensureTranscript: computed with
 * a fresh transcript, backfilled once for older projects, and never able to
 * fail or lose the transcription itself.
 */

const mocks = vi.hoisted(() => ({
  root: '',
  modelPath: null as string | null,
  transcript: null as Transcript | null
}))

vi.mock('electron', () => ({ app: { getPath: () => mocks.root } }))
vi.mock('../src/main/pipeline/vad', () => ({
  vadAvailable: () => true,
  detectSpeech: vi.fn(() => Promise.resolve(speech))
}))
vi.mock('../src/main/pipeline/openai', () => ({ transcriptionChunkSec: (sec: number) => sec, transcriptionPlan: () => undefined }))
vi.mock('../src/main/pipeline/transcribe', () => ({ transcribeChunks: vi.fn(() => Promise.resolve(structuredClone(mocks.transcript))) }))
vi.mock('../src/main/pipeline/energy', () => ({ annotateEnergy: vi.fn(() => Promise.resolve()) }))
vi.mock('../src/main/pipeline/speakerModel', () => ({ speakerModelPath: vi.fn(() => Promise.resolve(mocks.modelPath)) }))
vi.mock('../src/main/pipeline/ffmpeg', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/pipeline/ffmpeg')>()
  return { ...real, extractAudioChunks: vi.fn((path: string) => Promise.resolve([{ path, offsetSec: 0, durationSec: 60 }])) }
})
vi.mock('../src/main/pipeline/audioAnalysis', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/pipeline/audioAnalysis')>()
  return { ...real, analyseSourceAudio: vi.fn(real.analyseSourceAudio) }
})

import { ensureTranscript } from '../src/main/pipeline/projectTranscript'
import { analyseSourceAudio } from '../src/main/pipeline/audioAnalysis'
import { speakerModelPath } from '../src/main/pipeline/speakerModel'
import { detectSpeech } from '../src/main/pipeline/vad'
import { loadProject, projectDir, saveProject } from '../src/main/projects'
import { planWindows } from '../src/main/pipeline/speakerTurns'

const speech = [{ start: 0.5, end: 10 }, { start: 14, end: 25 }, { start: 32, end: 45 }, { start: 49, end: 59.5 }]
const words = syntheticWords(speech)
const segments = speech.map((region, id) => {
  const w = words.filter(x => x.start >= region.start && x.end <= region.end)
  return { id, text: w.map(x => x.text).join(' '), start: w[0].start, end: w[w.length - 1].end, words: w }
})
let wav = ''

beforeAll(async () => {
  mocks.root = await mkdtemp(join(tmpdir(), 'cutawan-transcript-analysis-'))
  wav = join(mocks.root, 'events.wav')
  writeSynthetic({ durationSec: 60, speech, laughter: [10.5, 13], applause: [26, 31], impact: 47, musicDb: -35, roomDb: -60 }, wav)
})
afterAll(async () => { if (mocks.root) await rm(mocks.root, { recursive: true, force: true }) })
beforeEach(() => {
  vi.mocked(analyseSourceAudio).mockClear()
  mocks.modelPath = null
  mocks.transcript = { language: 'en', durationSec: 60, segments: structuredClone(segments) }
})

let counter = 0
async function makeProject(transcript: Transcript | null): Promise<Project> {
  const project: Project = {
    id: `analysis-${++counter}`, createdAt: 0, updatedAt: 0, name: 'Analysis',
    video: { path: wav, fileName: 'events.wav', durationSec: 60, width: 640, height: 360, fps: 25, sizeBytes: 0, hasAudio: true },
    transcript, clips: [], prompt: '', videoType: 'auto'
  }
  await saveProject(project)
  return project
}

const options = { apiKey: 'k', model: 'whisper-1', language: 'en', span: { from: 0, to: 0.5 }, noSpeechError: 'No speech' }

/** Two voices alternating by speech region, as the embedder would report them. */
function twoVoiceRaw(): Awaited<ReturnType<typeof analyseSourceAudio>> {
  const windows = planWindows(speech)
  const voice = (k: number): Float32Array => Float32Array.from({ length: 8 }, (_, i) => (i === k ? 1 : 0.02))
  return { embedded: { windows, embeddings: windows.map(w => voice(w.start >= 14 && w.start < 32 ? 1 : 0)) } }
}

describe('fresh transcription', () => {
  it('adds audio reactions alongside the transcript and reports progress', async () => {
    const project = await makeProject(null)
    const progress: PipelineProgress[] = []
    const transcript = await ensureTranscript(project, mocks.root, options, p => progress.push(p))
    expect(transcript.reactions?.map(r => r.kind)).toEqual(['laughter', 'applause', 'impact'])
    expect(transcript.speakerTurns).toBeUndefined() // no speaker model available
    expect(progress.some(p => p.message.startsWith('Finding speakers and reactions'))).toBe(true)
    expect(progress.every((p, i) => i === 0 || p.progress >= progress[i - 1].progress)).toBe(true)
    const saved = (await loadProject(project.id)).transcript!
    expect(saved.reactions).toEqual(transcript.reactions)
    expect(saved.segments).toHaveLength(4)
  }, 30_000)

  it('saves speaker turns when more than one voice is heard', async () => {
    mocks.modelPath = 'model.onnx'
    vi.mocked(analyseSourceAudio).mockResolvedValueOnce(twoVoiceRaw())
    const project = await makeProject(null)
    const transcript = await ensureTranscript(project, mocks.root, options, () => {})
    expect(vi.mocked(analyseSourceAudio).mock.calls[0][0].diarize).toEqual({ speech, modelPath: 'model.onnx' })
    expect(transcript.speakerTurns?.map(t => t.speaker)).toEqual([0, 1, 0, 0]) // the last two split by a 4 s pause
    expect(transcript.speakerTurns?.[1].start).toBe(words.find(w => w.start >= 14)!.start)
    expect((await loadProject(project.id)).transcript?.speakerTurns).toEqual(transcript.speakerTurns)
  })

  it('does not wait for a speaker model download past the end of transcription', async () => {
    vi.mocked(speakerModelPath).mockReturnValueOnce(new Promise(() => {})) // a hung connection
    const project = await makeProject(null)
    const transcript = await ensureTranscript(project, mocks.root, options, () => {})
    expect(transcript.reactions).toHaveLength(3)
    expect(transcript.speakerTurns).toBeUndefined()
    expect(vi.mocked(analyseSourceAudio).mock.calls[0][0].diarize).toBeUndefined()
  }, 30_000)

  it('keeps the reactions when waiting for the speaker model fails', async () => {
    vi.mocked(speakerModelPath).mockImplementationOnce(() => Promise.reject(new Error('download cancelled elsewhere')))
    const project = await makeProject(null)
    const transcript = await ensureTranscript(project, mocks.root, options, () => {})
    expect(transcript.reactions).toHaveLength(3)
    expect(transcript.speakerTurns).toBeUndefined()
  }, 30_000)

  it('does not fetch the speaker model for a source without speech', async () => {
    vi.mocked(speakerModelPath).mockClear()
    vi.mocked(detectSpeech).mockResolvedValueOnce([])
    const project = await makeProject(null)
    await ensureTranscript(project, mocks.root, options, () => {})
    expect(speakerModelPath).not.toHaveBeenCalled()
  }, 30_000)

  it('keeps the transcript when the audio analysis fails', async () => {
    mocks.modelPath = 'model.onnx'
    vi.mocked(analyseSourceAudio).mockRejectedValueOnce(new Error('inference process crashed'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const project = await makeProject(null)
    const transcript = await ensureTranscript(project, mocks.root, options, () => {})
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    expect(transcript.segments).toHaveLength(4)
    expect(transcript.speech).toEqual(speech)
    expect(transcript.reactions).toBeUndefined()
    expect(transcript.speakerTurns).toBeUndefined()
    expect((await loadProject(project.id)).transcript?.segments).toHaveLength(4)
  })

  it('stops on cancellation during the analysis, with the transcript already saved', async () => {
    const controller = new AbortController()
    vi.mocked(analyseSourceAudio).mockImplementationOnce((_request, _progress, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
    const project = await makeProject(null)
    const run = ensureTranscript(project, mocks.root, options, p => {
      if (p.message.startsWith('Finding speakers')) controller.abort()
    }, controller.signal)
    await expect(run).rejects.toThrow('cancelled')
    const saved = (await loadProject(project.id)).transcript
    expect(saved?.segments).toHaveLength(4)
    expect(saved?.reactions).toBeUndefined()
  })
})

describe('backfill for older projects', () => {
  const older = (): Transcript => ({ language: 'en', durationSec: 60, segments: structuredClone(segments), speech })

  it('adds reactions once, then reuses them', async () => {
    const project = await makeProject(older())
    const first = await ensureTranscript(project, mocks.root, options, () => {})
    expect(first.reactions).toHaveLength(3)
    expect((await loadProject(project.id)).transcript?.reactions).toEqual(first.reactions)
    expect(analyseSourceAudio).toHaveBeenCalledTimes(1)
    // Reopened later: nothing to recompute (and no speaker model to try).
    const again = await ensureTranscript(await loadProject(project.id), mocks.root, options, () => {})
    expect(again.reactions).toEqual(first.reactions)
    expect(analyseSourceAudio).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('records a single-voice result so diarization does not re-run on every regeneration', async () => {
    mocks.modelPath = 'model.onnx'
    const windows = planWindows(speech)
    vi.mocked(analyseSourceAudio).mockResolvedValueOnce({ embedded: { windows, embeddings: windows.map(() => Float32Array.from([1, 0, 0])) } })
    const project = await makeProject({ ...older(), reactions: [] })
    const first = await ensureTranscript(project, mocks.root, options, () => {})
    expect(first.speakerTurns).toBeUndefined()
    expect(vi.mocked(analyseSourceAudio).mock.calls[0][0]).toMatchObject({ reactions: false })
    expect(existsSync(join(projectDir(project.id), 'audio-analysis.json'))).toBe(true)
    await ensureTranscript(await loadProject(project.id), mocks.root, options, () => {})
    expect(analyseSourceAudio).toHaveBeenCalledTimes(1)
  })

  it('backfills speaker turns, and retries diarization later when the model was unavailable', async () => {
    const project = await makeProject({ ...older(), reactions: [] })
    await ensureTranscript(project, mocks.root, options, () => {})
    expect(analyseSourceAudio).not.toHaveBeenCalled() // nothing it could do without the model
    mocks.modelPath = 'model.onnx'
    vi.mocked(analyseSourceAudio).mockResolvedValueOnce(twoVoiceRaw())
    const later = await ensureTranscript(await loadProject(project.id), mocks.root, options, () => {})
    expect(later.speakerTurns?.map(t => t.speaker)).toEqual([0, 1, 0, 0]) // the last two split by a 4 s pause
    expect((await loadProject(project.id)).transcript?.speakerTurns).toEqual(later.speakerTurns)
  })

  it('does not decode the source again after the analysis failed for it', async () => {
    mocks.modelPath = 'model.onnx'
    vi.mocked(analyseSourceAudio).mockRejectedValueOnce(new Error('inference process crashed'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const project = await makeProject(older())
    await ensureTranscript(project, mocks.root, options, () => {})
    errors.mockRestore()
    expect(analyseSourceAudio).toHaveBeenCalledTimes(1)
    await ensureTranscript(await loadProject(project.id), mocks.root, options, () => {})
    expect(analyseSourceAudio).toHaveBeenCalledTimes(1)
  })

  it('leaves a project without audio alone', async () => {
    const project = await makeProject(older())
    project.video.hasAudio = false
    await ensureTranscript(project, mocks.root, options, () => {})
    expect(analyseSourceAudio).not.toHaveBeenCalled()
  })
})
