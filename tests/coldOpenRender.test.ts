import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, Transcript, VideoInfo } from '@shared/types'
import { clipTimelineParts } from '@shared/clipTimeline'
import { SFX_SPECS } from '@shared/audioMix'
import { FFPROBE_PATH, probeVideo, runBinary, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { alignSegmentsToFrames, buildFilterGraph, cutFades, renderClip, sfxSource } from '../src/main/pipeline/render'
import { detectBurnedInText } from '../src/main/pipeline/captionSafety'
import { makeTranscript } from './helpers'

/**
 * A clip with a cold open, music and sound effects, exported through real
 * ffmpeg. The source's luma climbs 0..255 every 25 s so a frame says which
 * second it came from; the background is otherwise dark, so bright pixels in
 * the caption and title areas can only be burned-in text.
 */
const DURATION = 24
const FPS = 25
let dir: string
let source: VideoInfo
let musicPath: string
let transcript: Transcript

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-cold-open-'))
  const path = join(dir, 'source.mp4')
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=black:size=640x360:rate=${FPS}:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*3*t))':d=${DURATION}:s=48000`,
    // Luma ramps 16..76 (dark) so captions stand out; it still encodes time.
    '-vf', 'format=yuv420p,geq=lum=\'16+60*mod(T,25)/25\':cb=128:cr=128',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '8', '-g', '25', '-c:a', 'aac', '-shortest', path
  ])
  source = await probeVideo(path)
  musicPath = join(dir, 'music.wav')
  await runFfmpeg(['-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*330*t)+0.3*sin(2*PI*495*t)':d=7:s=44100`, musicPath])
  transcript = makeTranscript([
    'Most creators give up after a few weeks.',
    'They post a handful of videos and wait.',
    'Consistency beats talent every single time.',
    'So keep posting and watch what happens.'
  ], { startSec: 1, wordSec: 0.34, gapSec: 0.08, sentenceGapSec: 0.6 })
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function clip(edit: Partial<Clip['edit']> = {}): Clip {
  return {
    id: 'cold-open', title: 'Consistency', hook: 'Consistency beats talent', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0.5, suggestedEnd: 21, viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [],
    thumbnailPath: null,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: 0.5, captionStyleId: 'beast', showTitle: true,
      start: 0.5, end: 21, captionsEnabled: true, autoZoom: true, tightenCuts: true,
      coldOpen: true, soundEffects: true, music: true, emoji: true, ...edit
    }
  }
}

/** The planned output length: the export aligns every piece to the frame grid first. */
function plannedDuration(c: Clip): { total: number; coldOpen: { start: number; end: number } } {
  const parts = clipTimelineParts(c, transcript)
  const kept = alignSegmentsToFrames(parts.tightened ? parts.main : [{ start: c.edit.start, end: c.edit.end }], FPS, c.edit.start, c.edit.end)!
  const coldOpen = alignSegmentsToFrames([parts.coldOpen!], FPS, c.edit.start, c.edit.end)![0]
  return { total: [coldOpen, ...kept].reduce((sum, s) => sum + s.end - s.start, 0), coldOpen }
}

async function streams(path: string): Promise<Array<{ codec_type: string; duration: string }>> {
  const out = await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', path])
  return JSON.parse(out).streams
}

/** Mean luma of a region of the frame at `t` (x, y, w, h in output pixels). */
async function luma(path: string, t: number, region: [number, number, number, number]): Promise<number> {
  const raw = join(dir, `luma-${t}-${region.join('-')}.gray`)
  const [x, y, w, h] = region
  await runFfmpeg(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', raw])
  const px = await readFile(raw)
  return px.reduce((sum, v) => sum + v, 0) / px.length
}

/** Brightest pixel of a region at `t`. */
async function peak(path: string, t: number, region: [number, number, number, number]): Promise<number> {
  const raw = join(dir, `peak-${t}-${region.join('-')}.gray`)
  const [x, y, w, h] = region
  await runFfmpeg(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', raw])
  return (await readFile(raw)).reduce((max, v) => Math.max(max, v), 0)
}

describe('exporting a clip with a cold open, music and sound effects', () => {
  it('renders exactly the planned length, one audio stream, the cold open first, captions and title present', async () => {
    const c = clip()
    const { total, coldOpen } = plannedDuration(c)
    expect(coldOpen.end - coldOpen.start).toBeGreaterThan(1)
    const outputPath = join(dir, 'cold-open.mp4')
    await renderClip({ clip: c, source, transcript, outputPath, encoder: 'cpu', quality: 'draft', musicPath })

    const info = await streams(outputPath)
    expect(info.filter((s) => s.codec_type === 'audio')).toHaveLength(1)
    const video = info.find((s) => s.codec_type === 'video')!
    const audio = info.find((s) => s.codec_type === 'audio')!
    expect(Math.abs(Number(video.duration) - total)).toBeLessThanOrEqual(1 / FPS + 1e-3)
    // AAC frames are 1024 samples: the audio may end up to one frame later.
    expect(Math.abs(Number(audio.duration) - total)).toBeLessThan(0.05)

    // The first frames are the cold-open line, then the clip from its start.
    // `gray` is full range: undo the limited-range expansion, then the ramp.
    const sourceSecond = (gray: number): number => (gray * 219 / 255) / 60 * 25
    const edge: [number, number, number, number] = [0, 880, 40, 40]
    expect(sourceSecond(await luma(outputPath, 0.2, edge))).toBeCloseTo(coldOpen.start + 0.2, 0)
    expect(sourceSecond(await luma(outputPath, coldOpen.end - coldOpen.start + 0.3, edge))).toBeLessThan(2)

    // A caption is on screen during the cold open and the title right after it.
    expect(await peak(outputPath, 0.8, [100, 1200, 880, 380])).toBeGreaterThan(200)
    expect(await peak(outputPath, coldOpen.end - coldOpen.start + 1, [100, 150, 880, 300])).toBeGreaterThan(200)
  }, 240_000)

  it('mixes effects and music under the speech without changing the graph shape otherwise', () => {
    const c = clip()
    const segments = [{ start: 0.5, end: 10 }, { start: 11, end: 21 }]
    const graph = buildFilterGraph(c, source, null, 21.5, { segments, clipStart: 0.5, coldOpen: { start: 12, end: 14 } }, {
      audioMix: { sfx: [{ kind: 'whoosh', start: 1.7 }, { kind: 'pop', start: 2 }], musicPath, musicGainDb: -18, speechLufs: -22 }
    })
    // The cold open has an input of its own, after the source.
    expect(graph.filterComplex).toContain('[1:v]trim=start=0.000:end=2.000')
    expect(graph.extraInputs.slice(-4)).toEqual(['-stream_loop', '-1', '-i', musicPath])
    expect(graph.filterComplex).toContain('[2:a]atrim=end=21.500')
    expect(graph.filterComplex).toContain('sidechaincompress')
    expect(graph.filterComplex).toContain('amix=inputs=4:duration=first')
    expect(graph.filterComplex).toContain('adelay=delays=1700:all=1')
    expect(graph.filterComplex).toContain(sfxSource('pop'))
    expect(SFX_SPECS.pop.duration).toBeLessThan(0.5)
    // Effects off and no music: the old single master chain.
    const plain = buildFilterGraph(c, source, null, 21.5, { segments, clipStart: 0.5 }, { audioMix: null })
    expect(plain.filterComplex).toMatch(/\[acat\]loudnorm[^;]*\[aout\]/)
    expect(plain.filterComplex).not.toContain('amix')
  })

  it('fades the audio either side of the cold-open seam', () => {
    const segments = [{ start: 12, end: 14 }, { start: 0.5, end: 10 }]
    expect(cutFades(segments, 0, 2)).toContain('afade=t=out')
    expect(cutFades(segments, 1, 9.5)).toContain('afade=t=in')
  })

  it('finds burned-in subtitles in real footage, and none where there are none', async () => {
    const subtitled = join(dir, 'subtitled.mp4')
    const ass = join(dir, 'subs.ass')
    const { writeFile } = await import('node:fs/promises')
    const lines = ['First line of dialogue here', 'And now another line', 'Subtitles change every few seconds', 'Until the end']
    await writeFile(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: S,Poppins,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,22,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.map((l, i) => `Dialogue: 0,0:00:0${i * 2}.00,0:00:0${i * 2 + 2}.00,S,,0,0,0,,${l}`).join('\n')}\n`)
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8', '-vf',
      `ass=${ass}:fontsdir=${join(__dirname, '..', 'resources', 'fonts')}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', subtitled])
    const band = await detectBurnedInText(subtitled, [{ start: 0, end: 8 }])
    expect(band).not.toBeNull()
    expect(band!.top).toBeGreaterThan(0.7)
    expect(await detectBurnedInText(source.path, [{ start: 0, end: 20 }])).toBeNull()
    // Busy test-card footage without subtitles reads as clear too.
    const plain = join(dir, 'plain.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', plain])
    expect(await detectBurnedInText(plain, [{ start: 0, end: 8 }])).toBeNull()
  }, 120_000)
})
