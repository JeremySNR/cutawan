import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { captionFrameRate } from '@shared/animatedCaptions'
import { captionFrameInputArgs } from '../src/main/pipeline/animatedCaptions'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import { CaptionRendererError } from '../src/main/pipeline/animatedCaptions'
import { notCaptionFailure } from '../src/main/pipeline/render'

describe('caption frame rate', () => {
  it('gives ffmpeg the exact NTSC rationals that probing rounds away', () => {
    expect(captionFrameRate(29.97)).toEqual({ arg: '30000/1001', value: 30000 / 1001 })
    expect(captionFrameRate(59.94).arg).toBe('60000/1001')
    expect(captionFrameRate(23.98).arg).toBe('24000/1001')
    expect(captionFrameRate(30)).toEqual({ arg: '30', value: 30 })
    expect(captionFrameRate(25).arg).toBe('25')
    expect(captionFrameRate(12.5).arg).toBe('12.500000')
    expect(captionFrameInputArgs(16, 16, 29.97)).toContain('30000/1001')
  })

  /** Overlay frames that each carry their own index over a source at `rate`; return how many show the wrong one. */
  function lateFrames(probedFps: number, rate: string): Promise<{ frames: number; wrong: number }> {
    const W = 16, H = 16, N = 120
    return new Promise((resolve, reject) => {
      const child = spawn(FFMPEG_PATH, ['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${W}x${H}:r=${rate}`,
        ...captionFrameInputArgs(W, H, probedFps),
        '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto,format=gray[v]', '-map', '[v]', '-frames:v', String(N), '-f', 'rawvideo', '-'])
      const out: Buffer[] = []
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.stdin.on('error', () => undefined)
      child.on('error', reject)
      child.on('close', () => {
        const all = Buffer.concat(out)
        let frames = 0, wrong = 0
        for (let k = 0; (k + 1) * W * H <= all.length; k++) { frames++; if (all[k * W * H] !== k) wrong++ }
        resolve({ frames, wrong })
      })
      void (async () => {
        for (let n = 0; n < N + 10; n++) {
          const frame = Buffer.alloc(W * H * 4, n)
          for (let i = 3; i < frame.length; i += 4) frame[i] = 255
          if (!child.stdin.write(frame)) await new Promise((r) => child.stdin.once('drain', r))
        }
        child.stdin.end()
      })()
    })
  }

  it('puts caption frame n on video frame n at NTSC and whole rates', async () => {
    for (const [probed, rate] of [[29.97, '30000/1001'], [59.94, '60000/1001'], [23.98, '24000/1001'], [30, '30'], [25, '25']] as const) {
      const { frames, wrong } = await lateFrames(probed, rate)
      expect(frames, rate).toBe(120)
      expect(wrong, rate).toBe(0)
    }
  }, 60_000)
})

describe('falling back to standard captions', () => {
  it('skips the re-render for failures it would hit again', () => {
    expect(notCaptionFailure(new Error('ffmpeg exited with code 1:\nNo space left on device'))).toBe(true)
    expect(notCaptionFailure(new Error('h264_nvenc: OpenEncodeSessionEx failed'), 'gpu')).toBe(true)
    expect(notCaptionFailure(new Error('h264_nvenc: OpenEncodeSessionEx failed'), 'auto')).toBe(false)
    expect(notCaptionFailure(new Error('ffmpeg exited with code 1: pipe:0: Invalid data'))).toBe(false)
    expect(notCaptionFailure(new CaptionRendererError('No space left on device'))).toBe(false)
  })
})
