import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Clip, Transcript, VideoInfo } from '@shared/types'
import { playedSentences } from '@shared/captionTranslation'
import { makeTranscript } from './helpers'

/** Every .ass the render writes, by content. */
const writtenAss: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (path: unknown, data: unknown, options?: unknown) => {
      if (typeof path === 'string' && path.endsWith('.ass') && typeof data === 'string') writtenAss.push(data)
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, data, options)
    }) as typeof actual.writeFile
  }
})

const { probeVideo, runFfmpeg } = await import('../src/main/pipeline/ffmpeg')
const { renderClip } = await import('../src/main/pipeline/render')

const DURATION = 6
let dir: string
let source: VideoInfo
let transcript: Transcript

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-translated-off-'))
  const path = join(dir, 'source.mp4')
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=gray:size=320x180:rate=25:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${DURATION}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
  ])
  source = await probeVideo(path)
  transcript = makeTranscript(['One two three four.', 'Five six seven eight.'], { startSec: 0.5, wordSec: 0.4, gapSec: 0.1, sentenceGapSec: 1 })
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function translatedClip(captionsEnabled: boolean): Clip {
  const clip: Clip = {
    id: 'translated', title: 'A title', hook: 'Hook text', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: DURATION, viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: 'original', framing: 'manual', reframeMode: 'crop', focusX: 0.5, captionStyleId: 'beast', showTitle: true,
      start: 0, end: DURATION, captionsEnabled, autoZoom: false, tightenCuts: false, captionLanguage: 'translated'
    }
  }
  clip.translation = {
    version: 1, language: 'Spanish', edited: false, accepted: true, createdAt: 0,
    lines: playedSentences(clip, transcript).map((s, i) => ({ start: s.start, end: s.end, source: s.text, text: `línea ${i + 1}` }))
  }
  return clip
}

describe('translated captions follow the captions toggle on export', () => {
  it('burns in no translation when captions are off, even with a hook title', async () => {
    writtenAss.length = 0
    await renderClip({ clip: translatedClip(false), source, transcript, outputPath: join(dir, 'off.mp4'), encoder: 'cpu', quality: 'draft' })
    expect(writtenAss).toHaveLength(1)
    expect(writtenAss[0].toLowerCase()).toContain('hook text')
    expect(writtenAss[0].toLowerCase()).not.toContain('línea')
  }, 120_000)

  it('burns the translation in when captions are on', async () => {
    writtenAss.length = 0
    await renderClip({ clip: translatedClip(true), source, transcript, outputPath: join(dir, 'on.mp4'), encoder: 'cpu', quality: 'draft' })
    expect(writtenAss.join('\n').toLowerCase()).toContain('línea 1')
  }, 120_000)
})
