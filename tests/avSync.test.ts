import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, VideoInfo } from '@shared/types'
import { FFPROBE_PATH, probeVideo, runBinary, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { alignSegmentsToFrames, renderClip } from '../src/main/pipeline/render'

describe('alignSegmentsToFrames', () => {
  const fps = 30

  it('makes every piece a whole number of frames, edges a quarter frame before a frame', () => {
    const out = alignSegmentsToFrames([{ start: 1.017, end: 2.049 }, { start: 3.51, end: 4.98 }], fps, 0, 10)!
    for (const piece of out) {
      const frames = (piece.end - piece.start) * fps
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-9)
      expect(Math.abs(piece.start * fps + 0.25 - Math.round(piece.start * fps + 0.25))).toBeLessThan(1e-9)
    }
    // Each edge moves by under a frame.
    expect(Math.abs(out[0].start - 1.017)).toBeLessThan(1 / fps)
    expect(Math.abs(out[1].end - 4.98)).toBeLessThan(1 / fps)
  })

  it('drops pieces under a frame, merges pieces that now meet, and stays inside the trim', () => {
    expect(alignSegmentsToFrames([{ start: 1.0, end: 1.01 }], fps, 0, 10)).toEqual([])
    expect(alignSegmentsToFrames([{ start: 1, end: 2.004 }, { start: 2.006, end: 3 }], fps, 0, 10)).toHaveLength(1)
    const clamped = alignSegmentsToFrames([{ start: 0.001, end: 9.999 }], fps, 0, 9.99)!
    expect(clamped[0].start).toBeGreaterThanOrEqual(0)
    expect(clamped[0].end).toBeLessThanOrEqual(9.99)
  })

  it('gives each piece exactly as many frames as its audio lasts, wherever the source frames sit', () => {
    // What ffmpeg's trim keeps: the frames whose timestamp is inside [start, end).
    const framesIn = (start: number, end: number, offset: number): number => {
      let n = 0
      for (let k = 0; k < 2000; k++) { const t = k / fps + offset; if (t >= start && t < end) n++ }
      return n
    }
    const pieces = Array.from({ length: 30 }, (_, i) => ({ start: 1.017 + i * 1.31 + 0.13 * (i % 3), end: 1.017 + i * 1.31 + 0.83 }))
    for (const offset of [0, 0.004, 0.021, 0.03]) {
      // Unaligned: the offset between picture and sound wanders as pieces are joined.
      let drift = 0, worst = 0
      for (const p of pieces) { drift += framesIn(p.start, p.end, offset) / fps - (p.end - p.start); worst = Math.max(worst, Math.abs(drift)) }
      expect(worst).toBeGreaterThan(0.5 / fps)
      // Aligned: no piece's picture differs from its sound by any frame at all.
      for (const p of alignSegmentsToFrames(pieces, fps, 0, 60)!) {
        expect(framesIn(p.start, p.end, offset)).toBe(Math.round((p.end - p.start) * fps))
      }
    }
  })

  it('leaves clips without cuts, and unusable frame rates, alone', () => {
    expect(alignSegmentsToFrames(null, fps, 0, 10)).toBeNull()
    const segments = [{ start: 1.017, end: 2.049 }]
    expect(alignSegmentsToFrames(segments, 0, 0, 10)).toBe(segments)
  })
})

/**
 * Many cuts at times between frames, exported through real ffmpeg: a guard
 * that the aligned pieces still render to the right length with the streams
 * ending together. (The errors alignment removes are per piece and largely
 * cancel by the end, so the test above, not this one, is what proves it.)
 */
describe('audio and video stay in step across many cuts', () => {
  let dir: string
  let source: VideoInfo
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-avsync-'))
    const path = join(dir, 'source.mkv')
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=gray:size=160x90:rate=30:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', path
    ])
    source = await probeVideo(path)
  }, 60_000)
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('ends the video and audio streams within a frame of each other', async () => {
    // Twenty half-second cuts, each starting 0.47 s into a 1.3 s stride: none on a frame.
    const cuts = Array.from({ length: 20 }, (_, i) => ({ start: 1.017 + i * 1.3 + 0.47, end: 1.017 + i * 1.3 + 0.97 }))
    const clip: Clip = {
      id: 'sync', title: '', hook: '', summary: '', broll: [], focusTrack: null,
      suggestedStart: 0.5, suggestedEnd: 30, viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
      edit: { aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
        start: 0.5, end: 30, cuts, captionsEnabled: false, autoZoom: false, tightenCuts: false }
    }
    const outputPath = join(dir, 'out.mp4')
    await renderClip({ clip, source, transcript: null, outputPath, encoder: 'cpu', quality: 'draft' })
    const probe = JSON.parse(await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', outputPath])) as
      { streams: Array<{ codec_type: string; duration: string }> }
    const video = Number(probe.streams.find((s) => s.codec_type === 'video')!.duration)
    const audio = Number(probe.streams.find((s) => s.codec_type === 'audio')!.duration)
    // AAC frames are 1024 samples (21 ms); a 30 fps frame is 33 ms.
    expect(Math.abs(video - audio)).toBeLessThan(1 / 30 + 0.022)
    expect(Math.abs(video - (29.5 - 20 * 0.5))).toBeLessThan(0.1)
  }, 120_000)
})
