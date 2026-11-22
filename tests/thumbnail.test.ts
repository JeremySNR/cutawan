import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clip, Transcript } from '@shared/types'
import {
  defaultThumbnailTime,
  frameDifference,
  frameMetrics,
  frameQuality,
  pickThumbnail,
  scoreCandidate,
  steadiness,
  thumbnailCandidates,
  type GrayFrame
} from '../src/main/pipeline/thumbnailScore'
import { pickThumbnailTime, writeClipThumbnail } from '../src/main/pipeline/thumbnail'
import { runFfmpeg } from '../src/main/pipeline/ffmpeg'

const W = 160
const H = 90

function frame(fn: (x: number, y: number) => number): GrayFrame {
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))))
  return { width: W, height: H, data }
}

/** A detailed mid-tone scene: checker texture over a gradient. */
const sharp = (): GrayFrame => frame((x, y) => 70 + x * 0.5 + (((x >> 2) + (y >> 2)) % 2 ? 50 : 0))
/** The same scene through a heavy box blur. */
function blurred(source: GrayFrame, radius = 3): GrayFrame {
  return frame((x, y) => {
    let sum = 0
    let n = 0
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = Math.max(0, Math.min(W - 1, x + dx))
        const yy = Math.max(0, Math.min(H - 1, y + dy))
        sum += source.data[yy * W + xx]
        n++
      }
    }
    return sum / n
  })
}
const flat = (v: number): GrayFrame => frame(() => v)

describe('frame scoring', () => {
  it('measures sharpness as Laplacian variance', () => {
    const crisp = frameMetrics(sharp())
    const soft = frameMetrics(blurred(sharp()))
    expect(crisp.laplacianVariance).toBeGreaterThan(soft.laplacianVariance * 10)
    expect(frameMetrics(flat(128)).laplacianVariance).toBe(0)
  })

  it('prefers a sharp frame to the same frame blurred', () => {
    expect(frameQuality(frameMetrics(sharp()))).toBeGreaterThan(frameQuality(frameMetrics(blurred(sharp()))))
  })

  it('rejects dark and blown-out frames', () => {
    const good = frameQuality(frameMetrics(sharp()))
    const dark = frame((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 12 : 4))
    const blown = frame((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 255 : 250))
    expect(frameQuality(frameMetrics(dark))).toBeLessThan(good * 0.3)
    expect(frameQuality(frameMetrics(blown))).toBeLessThan(good * 0.3)
    expect(frameQuality(frameMetrics(flat(0)))).toBe(0)
  })

  it('rewards contrast and detail', () => {
    const lowContrast = frame((x, y) => 120 + (((x >> 2) + (y >> 2)) % 2 ? 6 : 0))
    expect(frameQuality(frameMetrics(sharp()))).toBeGreaterThan(frameQuality(frameMetrics(lowContrast)))
    const m = frameMetrics(sharp())
    expect(m.entropy).toBeGreaterThan(frameMetrics(lowContrast).entropy)
  })

  it('marks a frame that differs sharply from its neighbours as a transition', () => {
    const a = sharp()
    expect(frameDifference(a, a)).toBe(0)
    expect(steadiness([frameDifference(a, a)])).toBe(1)
    const other = frame((x, y) => 200 - x * 0.5 + (((x >> 3) + (y >> 3)) % 2 ? 40 : 0))
    expect(frameDifference(a, other)).toBeGreaterThan(0.16)
    expect(steadiness([0, frameDifference(a, other)])).toBe(0)
  })

  it('scores steady, sharp frames above transitions and blur, and context breaks ties', () => {
    const scene = sharp()
    const steady = scoreCandidate({ time: 1, prior: 0.4 }, scene, [scene, scene])
    const cut = scoreCandidate({ time: 2, prior: 0.4 }, scene, [scene, flat(20)])
    const soft = scoreCandidate({ time: 3, prior: 0.4 }, blurred(scene), [blurred(scene), blurred(scene)])
    const afterHook = scoreCandidate({ time: 4, prior: 0.9 }, scene, [scene, scene])
    const noFace = scoreCandidate({ time: 5, prior: 0.4, face: false }, scene, [scene, scene])
    expect(steady).toBeGreaterThan(cut)
    expect(steady).toBeGreaterThan(soft)
    expect(afterHook).toBeGreaterThan(steady)
    expect(noFace).toBeLessThan(steady)
    const best = pickThumbnail([
      { time: 1, prior: 0.4, score: steady },
      { time: 2, prior: 0.4, score: cut },
      { time: 4, prior: 0.9, score: afterHook }
    ])
    expect(best?.time).toBe(4)
    expect(pickThumbnail([{ time: 1, prior: 1, score: 0.01 }])).toBeNull()
  })
})

function clip(start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    id: 'c', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: start, suggestedEnd: end, viralityScore: 50, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start, end, captionsEnabled: true, tightenCuts: false
    },
    ...extra
  }
}

describe('thumbnail candidates', () => {
  it('stay inside what the clip plays, including today\'s frame', () => {
    const c = clip(10, 70)
    c.edit.cuts = [{ start: 20, end: 60 }]
    const candidates = thumbnailCandidates(c, null)
    expect(candidates.length).toBeGreaterThan(3)
    for (const cand of candidates) expect(cand.time < 20 || cand.time > 60).toBe(true)
    expect(candidates.some(cand => Math.abs(cand.time - defaultThumbnailTime(c)) < 0.5)).toBe(true)
  })

  it('favour the end of the hook line and the most energetic delivery', () => {
    const words = [
      { text: 'Nobody', start: 10.2, end: 10.6 }, { text: 'tells', start: 10.7, end: 11 },
      { text: 'you', start: 11.1, end: 11.3 }, { text: 'this.', start: 11.4, end: 11.9 },
      { text: 'Then', start: 14, end: 14.3 }, { text: 'boom!', start: 25, end: 25.5 }
    ]
    const transcript: Transcript = { language: 'en', durationSec: 60, segments: [
      { id: 0, text: '', start: 10.2, end: 11.9, words: words.slice(0, 4), energy: 0.2 },
      { id: 1, text: '', start: 14, end: 14.3, words: words.slice(4, 5), energy: 0.4 },
      { id: 2, text: '', start: 24, end: 26, words: words.slice(5), energy: 1 }
    ] }
    const candidates = thumbnailCandidates(clip(10, 40), transcript)
    const top = [...candidates].sort((a, b) => b.prior - a.prior)
    expect(top[0].time).toBeCloseTo(25, 0)
    expect(top[1].time).toBeCloseTo(12.2, 1)
  })

  it('note face presence only when face tracking exists', () => {
    expect(thumbnailCandidates(clip(0, 30), null).every(c => c.face === undefined)).toBe(true)
    const tracked = thumbnailCandidates(clip(0, 30, { focusTrack: [{ t: 10, x: .5 }, { t: 20, x: .5 }] }), null)
    expect(tracked.some(c => c.face === true)).toBe(true)
    expect(tracked.some(c => c.face === false)).toBe(true)
  })
})

describe('picking from real footage', () => {
  let dir: string
  let video: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-thumb-'))
    video = join(dir, 'source.mp4')
    // Two seconds of black (where today's 1.5 s frame lands), then a test pattern.
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=2',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=6',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', video
    ])
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('avoids the black opening and writes the chosen frame', async () => {
    const c = clip(0, 8)
    const info = { width: 320, height: 180, durationSec: 8 }
    expect(defaultThumbnailTime(c)).toBeLessThan(2)
    const at = await pickThumbnailTime(video, info, c, null)
    expect(at).toBeGreaterThan(2)
    const out = join(dir, 'thumb.jpg')
    await writeClipThumbnail(video, info, c, null, out)
    expect((await stat(out)).size).toBeGreaterThan(1000)
  }, 60_000)

  it('falls back to the plain frame when sampling fails', async () => {
    const c = clip(0, 8)
    expect(await pickThumbnailTime(join(dir, 'missing.mp4'), { width: 320, height: 180, durationSec: 8 }, c, null))
      .toBe(defaultThumbnailTime(c))
  }, 30_000)
})
