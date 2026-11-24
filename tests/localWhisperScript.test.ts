import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FFMPEG_PATH } from '../src/main/pipeline/ffmpeg'
import { WHISPER_PACKAGES } from '../src/main/localWhisper'

const SCRIPT = resolve(__dirname, '../resources/local-whisper/transcribe.py')
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0)

/**
 * A stand-in faster-whisper whose own decoder fails the way it does with
 * PyAV 19 (issue #82), and whose model records what it was given.
 */
const STUB = `
import numpy as np
class Info:
    language = "en"
    duration = 0.0
class Segment:
    def __init__(self, n):
        self.id, self.start, self.end = 0, 0.0, n / 16000
        self.text = " samples=%d" % n
        self.avg_logprob = self.no_speech_prob = self.compression_ratio = 0.0
        self.words = []
class WhisperModel:
    def __init__(self, *args, **kwargs): pass
    def transcribe(self, audio, **kwargs):
        assert isinstance(audio, np.ndarray) and audio.dtype == np.float32, type(audio)
        info = Info(); info.duration = len(audio) / 16000
        return iter([Segment(len(audio))]), info
def decode_audio(*args, **kwargs):
    raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
`

describe.skipIf(!python)('local Whisper script', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-whisper-'))
    await mkdir(join(dir, 'stubs', 'faster_whisper'), { recursive: true })
    await writeFile(join(dir, 'stubs', 'faster_whisper', '__init__.py'), STUB)
    await writeFile(join(dir, 'stubs', 'ctranslate2.py'), 'def get_cuda_device_count():\n    return 0\n')
    await mkdir(join(dir, 'model'))
    await writeFile(join(dir, 'model', 'model.bin'), '')
    spawnSync(FFMPEG_PATH, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', '-ar', '16000', '-b:a', '48k', join(dir, 'chunk.mp3')])
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  const runScript = (job: Record<string, unknown>, args: string[] = []): ReturnType<typeof spawnSync> =>
    spawnSync(python!, [SCRIPT, ...args], {
      input: JSON.stringify({ modelPath: join(dir, 'model'), ...job }),
      env: { ...process.env, PYTHONPATH: join(dir, 'stubs') },
      encoding: 'utf8'
    })

  it('decodes with the bundled ffmpeg, so a broken PyAV no longer matters', () => {
    const out = runScript({ path: join(dir, 'chunk.mp3'), ffmpegPath: FFMPEG_PATH })
    expect(out.status, String(out.stderr)).toBe(0)
    const result = JSON.parse(String(out.stdout)) as { duration: number; text: string }
    expect(result.duration).toBeGreaterThan(1.9)
    expect(result.duration).toBeLessThan(2.2)
  })

  it('still fails the old way without an ffmpeg path, proving the stub reproduces issue #82', () => {
    const out = runScript({ path: join(dir, 'chunk.mp3') })
    expect(out.status).not.toBe(0)
    expect(String(out.stderr)).toContain('metadata_errors')
  })

  it('checks decoding at setup', () => {
    expect(runScript({ ffmpegPath: FFMPEG_PATH }, ['--check']).status).toBe(0)
    const broken = runScript({ ffmpegPath: join(dir, 'no-such-ffmpeg') }, ['--check'])
    expect(broken.status).not.toBe(0)
  })
})

describe('local Whisper install', () => {
  it('pins faster-whisper and keeps PyAV below 19', () => {
    expect(WHISPER_PACKAGES).toContain('faster-whisper==1.2.1')
    expect(WHISPER_PACKAGES.some((p) => /^av(>|<|=)/.test(p) && p.includes('<19'))).toBe(true)
  })
})
