import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, VideoInfo } from '@shared/types'
import { clipKeptSegments, type KeptSegment } from '@shared/tighten'
import { FFPROBE_PATH, probeVideo, runBinary, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { buildFilterGraph, renderClip } from '../src/main/pipeline/render'

/**
 * A steady 440 Hz tone cut in two places, through real ffmpeg. Without fades
 * each cut jumps from one point of the waveform to another — a click; with
 * them the waveform is brought to zero and back, and the export is exactly
 * as long as before.
 */
const RATE = 48000
const AMPLITUDE = 0.5
const FREQ = 440
const DURATION = 10

let dir: string
let source: VideoInfo

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-cut-fades-'))
  const path = join(dir, 'source.mkv')
  // PCM audio, so sample positions are exact (no codec priming delay).
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=gray:size=160x90:rate=30:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `aevalsrc='${AMPLITUDE}*sin(2*PI*${FREQ}*t)':d=${DURATION}:s=${RATE}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', path
  ])
  source = await probeVideo(path)
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A cut point on the millisecond grid (the graph trims to milliseconds)
 * near `t`, where the tone is at its positive or negative extreme, so the
 * unfaded jump across each cut is as large as it gets.
 */
function extreme(t: number, sign: 1 | -1): number {
  let best = t
  for (let ms = -3; ms <= 3; ms++) {
    const candidate = Math.round(t * 1000 + ms) / 1000
    if (sign * Math.sin(2 * Math.PI * FREQ * candidate) > sign * Math.sin(2 * Math.PI * FREQ * best)) best = candidate
  }
  return best
}

function clip(): Clip {
  const cuts = [
    { start: extreme(3, 1), end: extreme(4, -1) },
    { start: extreme(6.5, -1), end: extreme(7.5, 1) }
  ]
  return {
    id: 'fades', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: 9, viralityScore: 0, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 0, end: 9, cuts, captionsEnabled: false, autoZoom: false, tightenCuts: false
    }
  }
}

/**
 * The cut audio alone, before loudness normalisation, as 16-bit PCM — with
 * the per-piece fades, or with them stripped out of the same graph.
 */
async function cutAudio(segments: KeptSegment[], fades: boolean): Promise<Float32Array> {
  const total = segments.reduce((sum, s) => sum + s.end - s.start, 0)
  let graph = buildFilterGraph(clip(), source, null, total, { segments, clipStart: 0 }).filterComplex
    .replace(/\[acat\][^;]*\[aout\]/, '[acat]anull[aout]')
  if (!fades) graph = graph.replace(/,afade=t=(in|out)(:st=[\d.]+)?:d=[\d.]+:curve=hsin/g, '')
  expect(graph.includes('curve=hsin')).toBe(fades)
  const out = join(dir, `audio-${fades}.raw`)
  await runFfmpeg(['-ss', '0', '-t', '9', '-i', source.path, '-filter_complex', graph,
    '-map', '[vout]', '-f', 'null', '-', '-map', '[aout]', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', out])
  const raw = await readFile(out)
  return Float32Array.from({ length: raw.length / 2 }, (_, i) => raw.readInt16LE(i * 2) / 32768)
}

/** Largest sample-to-sample step within 2 ms of `t` (output seconds). */
function largestStep(samples: Float32Array, t: number): number {
  const at = Math.round(t * RATE)
  let largest = 0
  for (let i = Math.max(1, at - 96); i < Math.min(samples.length, at + 96); i++) {
    largest = Math.max(largest, Math.abs(samples[i] - samples[i - 1]))
  }
  return largest
}

describe('audio at internal cuts', () => {
  it('removes the click without changing any duration', async () => {
    const segments = clipKeptSegments(clip(), null)!
    expect(segments).toHaveLength(3)
    const expected = segments.reduce((sum, s) => sum + s.end - s.start, 0)
    const [faded, hard] = await Promise.all([cutAudio(segments, true), cutAudio(segments, false)])

    // Same length to the sample, and the sum of the kept segments.
    expect(faded.length).toBe(hard.length)
    expect(Math.abs(faded.length / RATE - expected)).toBeLessThan(1 / 30)

    // The tone itself never steps by more than A * 2 * pi * f / rate.
    const natural = AMPLITUDE * 2 * Math.PI * FREQ / RATE
    expect(largestStep(hard, 1.5)).toBeLessThan(natural * 1.2)
    const cutTimes = [segments[0].end - segments[0].start,
      segments[0].end - segments[0].start + segments[1].end - segments[1].start]
    for (const t of cutTimes) {
      const click = largestStep(hard, t)
      const smooth = largestStep(faded, t)
      // Hard cut: peak to trough in one sample.
      expect(click).toBeGreaterThan(0.8)
      expect(smooth).toBeLessThan(natural * 1.2)
      expect(smooth).toBeLessThan(click / 20)
    }
    // Away from the cuts the faded audio is untouched.
    const mid = Math.round(1.5 * RATE)
    expect(Array.from(faded.subarray(mid, mid + 480))).toEqual(Array.from(hard.subarray(mid, mid + 480)))
  }, 60_000)

  it('exports at exactly the length of the kept segments', async () => {
    const outputPath = join(dir, 'export.mp4')
    await renderClip({ clip: clip(), source, transcript: null, outputPath, encoder: 'cpu', quality: 'draft' })
    const segments = clipKeptSegments(clip(), null)!
    const expected = segments.reduce((sum, s) => sum + s.end - s.start, 0)
    const streams = JSON.parse(await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type,duration',
      '-of', 'json', outputPath])).streams as Array<{ codec_type: string; duration: string }>
    const length = (type: string): number => Number(streams.find((s) => s.codec_type === type)!.duration)
    console.info(`[cut fades] export video ${length('video')} s, audio ${length('audio')} s, kept segments ${expected.toFixed(4)} s`)
    // The fades live in the audio: it is the sum of the kept segments to
    // within a frame. (Video pieces snap to whole frames, so three cuts off
    // the frame grid can add a frame or so, with or without fades; the
    // export's own check allows two.)
    expect(Math.abs(length('audio') - expected)).toBeLessThan(1 / 30)
    expect(Math.abs(length('video') - expected)).toBeLessThan(2 / 30)
  }, 120_000)
})
