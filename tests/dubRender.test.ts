import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, Transcript, VideoInfo } from '@shared/types'
import { playedSentences } from '@shared/captionTranslation'
import { planDubCues, DUB_DUCK_DB } from '@shared/dubPlan'
import { clipKeptSegments } from '@shared/tighten'
import { clipTimeline } from '@shared/clipTimeline'
import { FFMPEG_PATH, FFPROBE_PATH, probeVideo, runBinary, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { alignSegmentsToFrames, renderClip } from '../src/main/pipeline/render'
import { makeTranscript } from './helpers'
import { spawn } from 'node:child_process'

/**
 * The AI dub through real ffmpeg, with tones standing in for speech: the
 * source "voice" is a 220 Hz tone, each dub line a one-second 1 kHz tone.
 * Measuring the two frequencies separately shows where the dub plays and
 * how far the original drops under it.
 */
const FPS = 25
const DURATION = 12
const RATE = 16000

let dir: string
let source: VideoInfo
let transcript: Transcript
let lineAudio: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-dub-render-'))
  const path = join(dir, 'source.mp4')
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=gray:size=320x180:rate=${FPS}:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${DURATION}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', path
  ])
  source = await probeVideo(path)
  lineAudio = join(dir, 'line.mp3')
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=24000:duration=1', '-c:a', 'libmp3lame', '-b:a', '64k', lineAudio])
  // Three sentences: 0.5-2.4 s, 4.4-6.3 s, 8.3-10.2 s.
  transcript = makeTranscript(['One two three four.', 'Five six seven eight.', 'Nine ten eleven twelve.'],
    { startSec: 0.5, wordSec: 0.4, gapSec: 0.1, sentenceGapSec: 2 })
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function dubbedClip(): Clip {
  const clip: Clip = {
    id: 'dubbed', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: DURATION, viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: 'original', framing: 'manual', reframeMode: 'crop', focusX: 0.5, captionStyleId: 'beast', showTitle: false,
      start: 0, end: DURATION, captionsEnabled: false, autoZoom: false, tightenCuts: false, captionLanguage: 'translated'
    }
  }
  const sentences = playedSentences(clip, transcript)
  clip.translation = {
    version: 1, language: 'Spanish', edited: false, accepted: true, createdAt: 0,
    lines: sentences.map((s, i) => ({ start: s.start, end: s.end, source: s.text, text: `línea ${i + 1}` }))
  }
  clip.dub = {
    version: 1, provider: 'openai', model: 'tts-1', voice: 'alloy', enabled: true, createdAt: 0,
    lines: clip.translation.lines.map((l) => ({ start: l.start, end: l.end, text: l.text, audioPath: lineAudio, audioSec: 1, tempo: 1, fit: 'natural' as const }))
  }
  // Cut the middle sentence out entirely.
  const middle = clip.translation.lines[1]
  clip.edit.cuts = [{ start: middle.start - 0.6, end: middle.end + 0.6 }]
  return clip
}

/** Decode an export's audio to mono float samples. */
function decodeAudio(path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'])
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`))
      const buf = Buffer.concat(chunks)
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)))
    })
  })
}

/** Amplitude of one frequency over [from, to) seconds (Goertzel). */
function toneLevel(samples: Float32Array, freq: number, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from * RATE))
  const end = Math.min(samples.length, Math.floor(to * RATE))
  const n = end - start
  const k = 2 * Math.cos((2 * Math.PI * freq) / RATE)
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end; i++) {
    const s0 = samples[i] + k * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = s1 * s1 + s2 * s2 - k * s1 * s2
  return (2 * Math.sqrt(Math.max(0, power))) / Math.max(1, n)
}

const db = (ratio: number): number => 20 * Math.log10(ratio)

describe('exporting a dubbed clip', () => {
  it('keeps the exact duration and one audio stream, ducks the original under each line, and drops lines in removed spans', async () => {
    const clip = dubbedClip()
    const outputPath = join(dir, 'dubbed.mp4')
    await renderClip({ clip, source, transcript, outputPath, encoder: 'cpu', quality: 'draft' })

    const segments = alignSegmentsToFrames(clipKeptSegments(clip, transcript), FPS, clip.edit.start, clip.edit.end)!
    const expected = segments.reduce((sum, s) => sum + s.end - s.start, 0)
    const streams = async (path: string): Promise<Array<[string, number]>> =>
      (await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', path]))
        .trim().split('\n').map((line) => { const [type, sec] = line.split(','); return [type, Number(sec)] })
    const dubbed = await streams(outputPath)
    expect(dubbed.filter(([type]) => type === 'audio')).toHaveLength(1)
    const video = dubbed.find(([type]) => type === 'video')![1]
    expect(Math.abs(video - expected)).toBeLessThan(1.5 / FPS)
    // The audio is the sum of the kept segments too, to within one AAC frame.
    const audioSec = dubbed.find(([type]) => type === 'audio')![1]
    expect(Math.abs(audioSec - expected)).toBeLessThan(1024 / 48000 + 1e-3)

    const cues = planDubCues(clip, transcript, segments, expected)
    expect(cues.map((c) => c.text)).toEqual(['línea 1', 'línea 3'])

    const audio = await decodeAudio(outputPath)
    // The original, alone, between the first line and the cut.
    const firstEnd = cues[0].start + cues[0].duration
    const reference = toneLevel(audio, 220, firstEnd + 0.4, firstEnd + 0.9)
    expect(reference).toBeGreaterThan(0.05)
    for (const cue of cues) {
      const from = cue.start + 0.25
      const to = cue.start + cue.duration - 0.25
      const ducked = toneLevel(audio, 220, from, to)
      // -18 dB, give or take the encoder and the ramps' edges.
      expect(db(ducked / reference)).toBeGreaterThan(DUB_DUCK_DB - 3)
      expect(db(ducked / reference)).toBeLessThan(DUB_DUCK_DB + 3)
      expect(toneLevel(audio, 1000, from, to)).toBeGreaterThan(reference)
    }

    // The dub is heard only inside its cues: scan the whole export.
    const window = 0.1
    for (let t = 0; t + window <= expected; t += window) {
      const inside = cues.some((c) => t + window > c.start - 0.05 && t < c.start + c.duration + 0.05)
      if (!inside) expect(toneLevel(audio, 1000, t, t + window)).toBeLessThan(reference * 0.05)
    }
  }, 120_000)
})

describe('a dubbed clip that opens with a cold open', () => {
  it('voices each line after the cold open, at its shifted place, and mixes the right input', async () => {
    const clip = dubbedClip()
    // Uncut, so the last sentence sits more than 8 s in and can be the cold open.
    clip.edit.cuts = []
    clip.edit.coldOpen = true
    const timeline = clipTimeline(clip, transcript)
    // The replayed line is the last sentence, at least 8 s into the clip.
    expect(timeline.coldOpenDuration).toBeGreaterThan(1)
    const outputPath = join(dir, 'dubbed-cold-open.mp4')
    await renderClip({ clip, source, transcript, outputPath, encoder: 'cpu', quality: 'draft' })
    const info = await probeVideo(outputPath)
    expect(info.hasAudio).toBe(true)
    expect(Math.abs(info.durationSec - timeline.outputDuration)).toBeLessThan(0.15)

    const cues = planDubCues(clip, transcript, timeline.pieces.filter((p) => !p.coldOpen), timeline.outputDuration, timeline.coldOpenDuration)
    expect(cues.map((c) => c.text)).toEqual(['línea 1', 'línea 2', 'línea 3'])
    expect(cues[0].start).toBeGreaterThanOrEqual(timeline.coldOpenDuration)
    const audio = await decodeAudio(outputPath)
    // The dub plays where it was planned (the input index counts the cold
    // open's own input, or this would mix the wrong file)…
    for (const cue of cues) {
      expect(toneLevel(audio, 1000, cue.start + 0.25, cue.start + cue.duration - 0.25)).toBeGreaterThan(0.05)
    }
    // …and not during the cold open, which replays the original voice.
    expect(toneLevel(audio, 1000, 0.1, timeline.coldOpenDuration - 0.15)).toBeLessThan(0.01)
    expect(toneLevel(audio, 220, 0.1, timeline.coldOpenDuration - 0.15)).toBeGreaterThan(0.05)
  }, 120_000)
})

describe('dubbing a source with no soundtrack', () => {
  it('exports the dub as the only audio stream', async () => {
    const silentPath = join(dir, 'silent.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', `color=gray:size=320x180:rate=${FPS}:duration=${DURATION}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silentPath])
    const silent = await probeVideo(silentPath)
    expect(silent.hasAudio).toBe(false)
    const outputPath = join(dir, 'silent-dubbed.mp4')
    await renderClip({ clip: dubbedClip(), source: silent, transcript, outputPath, encoder: 'cpu', quality: 'draft' })
    expect((await probeVideo(outputPath)).hasAudio).toBe(true)
    const audio = await decodeAudio(outputPath)
    expect(toneLevel(audio, 1000, 0.75, 1.25)).toBeGreaterThan(0.05)
  }, 120_000)
})
