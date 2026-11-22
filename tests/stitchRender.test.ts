import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, VideoInfo } from '@shared/types'
import { FFPROBE_PATH, probeVideo, runBinary, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { measureLoudness, measureLoudnessOfRanges } from '../src/main/pipeline/loudness'
import { buildFilterGraph, renderClip } from '../src/main/pipeline/render'

/**
 * A clip joined from two moments five minutes apart, exported through real
 * ffmpeg from a source whose every frame says what time it was taken at.
 *
 * Luma climbs 0..255 every 25 s (about 0.1 s per level) and the U plane
 * climbs once across the whole eight minutes, so a frame of the export
 * identifies its source second on its own. The soundtrack is quiet during the
 * two moments and loud between them.
 */
const DURATION = 480
const FIRST = { start: 60, end: 70 }
const SECOND = { start: 360, end: 372 }

let dir: string
let source: VideoInfo

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-stitch-render-'))
  const path = join(dir, 'source.mp4')
  const quiet = `between(t,${FIRST.start},${FIRST.end})+between(t,${SECOND.start},${SECOND.end})`
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=black:size=320x180:rate=10:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `aevalsrc='if(${quiet},0.02,0.8)*sin(2*PI*440*t)':d=${DURATION}:s=48000`,
    '-vf', `format=yuv420p,geq=lum='255*mod(T,25)/25':cb='16+224*T/${DURATION}':cr=128`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '10', '-g', '50', '-c:a', 'aac', '-shortest', path
  ])
  source = await probeVideo(path)
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function joinedClip(): Clip {
  return {
    id: 'joined', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: FIRST.start, suggestedEnd: SECOND.end, viralityScore: 0, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    stitch: { segments: [FIRST, SECOND], reason: 'fixture' },
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: FIRST.start, end: SECOND.end, cuts: [{ start: FIRST.end, end: SECOND.start }],
      captionsEnabled: false, autoZoom: false, tightenCuts: false
    }
  }
}

/** The source second a frame of the export was taken at. */
async function sourceTimeAt(output: string, t: number): Promise<number> {
  const raw = join(dir, `frame-${t}.yuv`)
  await runFfmpeg(['-ss', String(t), '-i', output, '-frames:v', '1', '-vf', 'scale=16:16', '-f', 'rawvideo', '-pix_fmt', 'yuv444p', raw])
  const planes = await readFile(raw)
  const mean = (plane: number): number => planes.subarray(plane * 256, plane * 256 + 256).reduce((sum, v) => sum + v, 0) / 256
  const coarse = (mean(1) - 16) / 224 * DURATION
  const fine = mean(0) / 255 * 25
  // The coarse reading picks the 25-second cycle; the fine one places it.
  return Math.round((coarse - fine) / 25) * 25 + fine
}

describe('exporting a clip joined from distant moments', () => {
  it('plays the first moment straight into the second, and nothing between', async () => {
    const outputPath = join(dir, 'joined.mp4')
    await renderClip({ clip: joinedClip(), source, transcript: null, outputPath, encoder: 'cpu', quality: 'draft' })
    const info = await probeVideo(outputPath)
    expect([info.width, info.height]).toEqual([1080, 1920])
    expect(Math.abs(info.durationSec - 22)).toBeLessThan(.15)
    expect(await sourceTimeAt(outputPath, 0.5)).toBeCloseTo(60.5, 0)
    expect(await sourceTimeAt(outputPath, 5)).toBeCloseTo(65, 0)
    // Either side of the join, to within a couple of frames.
    expect(Math.abs(await sourceTimeAt(outputPath, 9.7) - 69.7)).toBeLessThan(.35)
    expect(Math.abs(await sourceTimeAt(outputPath, 10.3) - 360.3)).toBeLessThan(.35)
    expect(await sourceTimeAt(outputPath, 21)).toBeCloseTo(371, 0)
    const streams = JSON.parse(await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', outputPath]))
    expect(streams.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio')).toHaveLength(1)
  }, 120_000)

  it('opens the source once per moment instead of reading through the gap', () => {
    const clip = joinedClip()
    const graph = buildFilterGraph(clip, source, null, 22,
      { segments: [FIRST, SECOND], clipStart: FIRST.start, sources: [FIRST, SECOND] },
      { branding: { enabled: true, imagePath: '/tmp/logo.png', position: 'top-right', scale: .2, opacity: 1 } as never })
    expect(graph.filterComplex).toContain('[0:v]trim=start=0.000:end=10.000')
    expect(graph.filterComplex).toContain('[1:v]trim=start=0.000:end=12.000')
    expect(graph.filterComplex).toContain('[1:a]atrim=start=0.000:end=12.000')
    // The watermark is the input after both source inputs.
    expect(graph.filterComplex).toContain('[2:v]format=rgba')
    // Without separate sources everything is cut from one input, as before.
    const single = buildFilterGraph(clip, source, null, 22, { segments: [FIRST, SECOND], clipStart: FIRST.start })
    expect(single.filterComplex).toContain('[0:v]trim=start=300.000:end=312.000')
  })

  it('sets the level from what plays, not from the loud stretch it skips', async () => {
    const played = await measureLoudnessOfRanges(source.path, [FIRST, SECOND])
    const span = await measureLoudness(source.path, FIRST.start, SECOND.end - FIRST.start)
    expect(played).not.toBeNull()
    expect(span).not.toBeNull()
    // 0.02 against 0.8 amplitude is 32 dB; the span is dominated by the gap.
    expect(span!.inputI - played!.inputI).toBeGreaterThan(25)
    const alone = await measureLoudness(source.path, FIRST.start, FIRST.end - FIRST.start)
    expect(Math.abs(played!.inputI - alone!.inputI)).toBeLessThan(1)
  }, 60_000)

  it('seeks straight to a moment when a long cut sits at the start of the trim', async () => {
    const clip = joinedClip()
    // Trim 60-372 with everything before 360 cut: one stretch, well inside the trim.
    clip.edit = { ...clip.edit, start: FIRST.start, end: SECOND.end, cuts: [{ start: FIRST.start, end: SECOND.start }] }
    clip.stitch = undefined
    const outputPath = join(dir, 'inset.mp4')
    await renderClip({ clip, source, transcript: null, outputPath, encoder: 'cpu', quality: 'draft' })
    const info = await probeVideo(outputPath)
    expect(Math.abs(info.durationSec - 12)).toBeLessThan(.15)
    expect(await sourceTimeAt(outputPath, 0.5)).toBeCloseTo(360.5, 0)
    // Loudness comes from what plays: the quiet moment, not the loud stretch it skips.
    const played = await measureLoudnessOfRanges(source.path, [SECOND])
    expect(played!.inputI).toBeLessThan(-30)
  }, 120_000)
})

