import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How the whole-source audio analysis treats its decode stream: a damaged
 * tail keeps the reactions measured before it, and the decode stops early
 * once neither analysis is still listening.
 */

const stream = vi.hoisted(() => ({ frames: 0, delivered: 0, failAfter: Infinity }))

vi.mock('../src/main/pipeline/ffmpeg', () => ({
  streamRawFrames: vi.fn(async (_args: string[], frameBytes: number, onFrame: (frame: Buffer, index: number) => Promise<void>) => {
    const frame = Buffer.alloc(frameBytes)
    for (let i = 0; i < stream.frames; i++) {
      if (i >= stream.failAfter) throw new Error('ffmpeg frame stream exited with code 1')
      for (let j = 0; j < frameBytes; j += 4) frame.writeFloatLE(0.2 * Math.sin((i * frameBytes + j) * 0.01), j)
      await onFrame(frame, i)
      stream.delivered++
    }
    return stream.frames
  })
}))

import { analyseSourceAudio } from '../src/main/pipeline/audioAnalysis'

beforeEach(() => {
  stream.delivered = 0
  stream.failAfter = Infinity
})

describe('audio analysis stream', () => {
  it('keeps the reactions measured before ffmpeg failed on a damaged tail', async () => {
    stream.frames = 600 // 60 s
    stream.failAfter = 400
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const raw = await analyseSourceAudio({ videoPath: 'damaged.mp4', durationSec: 60, reactions: true }, () => {})
    errors.mockRestore()
    expect(raw.reactionFeatures?.levelDb.length).toBeGreaterThan(700) // ~40 s of 50 ms hops
    expect(raw.reactionsFailed).toBeUndefined()
  })

  it('still fails on cancellation', async () => {
    stream.frames = 600
    stream.failAfter = 100
    const controller = new AbortController()
    controller.abort()
    await expect(analyseSourceAudio({ videoPath: 'x.mp4', durationSec: 60, reactions: true }, () => {}, controller.signal))
      .rejects.toThrow('exited with code 1')
  })

  it('stops decoding once neither analysis is listening, and reports diarization as failed', async () => {
    stream.frames = 6000 // 10 minutes
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = vi.fn(() => Promise.reject(new Error('inference process crashed')))
    const raw = await analyseSourceAudio({ videoPath: 'x.mp4', durationSec: 600, reactions: false,
      diarize: { speech: [{ start: 0, end: 600 }], modelPath: 'model.onnx' } }, () => {}, undefined, runner)
    errors.mockRestore()
    expect(runner).toHaveBeenCalled()
    expect(stream.delivered).toBeLessThan(1000)
    expect(raw.embedded).toBeUndefined()
    expect(raw.speakersFailed).toBe(true)
  })
})
