import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clip, Project, Transcript } from '@shared/types'
import {
  buildFcpxml,
  buildSrt,
  buildXmeml,
  clipEditSegments,
  escapeXml,
  fcpxTime,
  frameRateFromFps,
  frameRateFromProbe,
  localhostFileUrl,
  sourceFrameCount,
  srtTime,
  timelineSegments,
  toFrame,
  type FrameRate,
  type NleSource
} from '@shared/nleExport'
import { exportClipEdit } from '../src/main/nleExport'
import { probeVideo, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { makeTranscript } from './helpers'
import { child, childText, findAll, parseXml, type XmlElement } from './xml'

const NTSC: FrameRate = { num: 30000, den: 1001 }

function source(overrides: Partial<NleSource> = {}): NleSource {
  return {
    fileUrl: 'file:///Users/me/My%20Videos/talk%20%26%20chat.mp4',
    fileName: 'talk & chat.mp4',
    durationSec: 600,
    width: 1920,
    height: 1080,
    rate: NTSC,
    hasAudio: true,
    audioChannels: 2,
    audioSampleRate: 48000,
    ...overrides
  }
}

function clip(edit: Partial<Clip['edit']> = {}): Clip {
  return {
    id: 'c1', title: 'Why <this> & "that"', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: 60, viralityScore: 70, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 10, end: 40, captionsEnabled: true, tightenCuts: false, ...edit
    }
  }
}

/** Parse an FCPXML rational ("3003/30000s", "2s", "0s") into seconds. */
function fcpxSeconds(value: string): number {
  const m = /^(\d+)(?:\/(\d+))?s$/.exec(value)
  if (!m) throw new Error(`Not an FCPXML time: ${value}`)
  return Number(m[1]) / Number(m[2] ?? 1)
}

/** Seconds as a whole number of frames, failing if it falls between frames. */
function exactFrames(sec: number, rate: FrameRate): number {
  const frames = (sec * rate.num) / rate.den
  expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6)
  return Math.round(frames)
}

describe('frame rates', () => {
  it('uses exact NTSC rationals', () => {
    expect(frameRateFromFps(29.97)).toEqual({ num: 30000, den: 1001 })
    expect(frameRateFromFps(23.98)).toEqual({ num: 24000, den: 1001 })
    expect(frameRateFromFps(59.94)).toEqual({ num: 60000, den: 1001 })
    expect(frameRateFromFps(25)).toEqual({ num: 25, den: 1 })
    expect(frameRateFromFps(29.83)).toEqual({ num: 30, den: 1 })
    expect(frameRateFromProbe('30000/1001', 30)).toEqual({ num: 30000, den: 1001 })
    expect(frameRateFromProbe('2997/100', 29.97)).toEqual({ num: 30000, den: 1001 })
  })

  it('writes FCPXML times as reduced rationals', () => {
    expect(fcpxTime(0, NTSC)).toBe('0s')
    expect(fcpxTime(1, NTSC)).toBe('1001/30000s')
    expect(fcpxTime(30, NTSC)).toBe('1001/1000s')
    expect(fcpxTime(50, { num: 25, den: 1 })).toBe('2s')
  })
})

describe('timeline segments', () => {
  it('rounds to whole frames, lays clips end to end and merges pieces that meet', () => {
    const segs = timelineSegments([{ start: 10, end: 12.5 }, { start: 12.5, end: 14 }, { start: 20.02, end: 20.03 }, { start: 30, end: 31 }], NTSC)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ sourceIn: toFrame(10, NTSC), duration: toFrame(14, NTSC) - toFrame(10, NTSC), offset: 0 })
    expect(segs[1].offset).toBe(segs[0].duration)
    expect(segs[1].sourceIn).toBe(toFrame(30, NTSC))
  })

  it('never reaches past the last whole frame of the source', () => {
    // 10.03 s at 29.97 fps is 300.6 frames: the file has 300 whole ones, but
    // the end rounds to 301.
    const frames = sourceFrameCount({ durationSec: 10.03, rate: NTSC })
    expect(frames).toBe(300)
    expect(toFrame(10.03, NTSC)).toBe(301)
    const segs = timelineSegments([{ start: 5, end: 8 }, { start: 9, end: 10.03 }], NTSC, frames)
    expect(segs.every(s => s.sourceIn + s.duration <= frames)).toBe(true)
    expect(segs.at(-1)!.sourceIn + segs.at(-1)!.duration).toBe(frames)
    // A piece wholly past the end is dropped, not given a negative length.
    expect(timelineSegments([{ start: 10.02, end: 10.03 }], NTSC, frames)).toEqual([])
  })

  it('takes the kept segments after pause removal and cuts', () => {
    const transcript = makeTranscript(['one two three four five', 'six seven eight nine ten'], { startSec: 10, sentenceGapSec: 3 })
    const tightened = clip({ start: 10, end: 20, tightenCuts: true, cuts: [{ start: 11, end: 11.5 }] })
    const kept = clipEditSegments(tightened, transcript)
    expect(kept.length).toBeGreaterThan(2)
    expect(kept.every(k => k.end <= 11 || k.start >= 11.5)).toBe(true)
    expect(clipEditSegments(clip(), null)).toEqual([{ start: 10, end: 40 }])
  })
})

function checkFcpxml(xml: string, segs: ReturnType<typeof timelineSegments>, src: NleSource): XmlElement {
  const { doctype, root } = parseXml(xml)
  expect(doctype).toBe('fcpxml')
  expect(root.name).toBe('fcpxml')
  expect(root.attrs.version).toBe('1.9')
  const resources = child(root, 'resources')
  const format = child(resources, 'format')
  expect(format.attrs.frameDuration).toBe(fcpxTime(1, src.rate))
  expect(format.attrs.width).toBe(String(src.width))
  const asset = child(resources, 'asset')
  expect(asset.attrs.format).toBe(format.attrs.id)
  expect(child(asset, 'media-rep').attrs.src).toBe(src.fileUrl)
  const sequence = findAll(root, 'sequence')[0]
  expect(sequence.attrs.format).toBe(format.attrs.id)
  const clips = findAll(sequence, 'asset-clip')
  expect(clips).toHaveLength(segs.length)
  // Consecutive, frame-accurate, and summing to the sequence duration.
  let cursor = 0
  clips.forEach((c, i) => {
    expect(c.attrs.ref).toBe(asset.attrs.id)
    const offset = exactFrames(fcpxSeconds(c.attrs.offset), src.rate)
    const start = exactFrames(fcpxSeconds(c.attrs.start), src.rate)
    const duration = exactFrames(fcpxSeconds(c.attrs.duration), src.rate)
    expect(offset).toBe(cursor)
    expect(start).toBe(segs[i].sourceIn)
    expect(duration).toBe(segs[i].duration)
    cursor += duration
  })
  expect(exactFrames(fcpxSeconds(sequence.attrs.duration), src.rate)).toBe(cursor)
  return root
}

function checkXmeml(xml: string, segs: ReturnType<typeof timelineSegments>, src: NleSource): XmlElement {
  const { doctype, root } = parseXml(xml)
  expect(doctype).toBe('xmeml')
  expect(root.attrs.version).toBe('4')
  const sequence = child(root, 'sequence')
  const rate = child(sequence, 'rate')
  expect(childText(rate, 'timebase')).toBe(String(Math.round(src.rate.num / src.rate.den)))
  expect(childText(rate, 'ntsc')).toBe(src.rate.den === 1001 ? 'TRUE' : 'FALSE')
  const media = child(sequence, 'media')
  const videoTracks = findAll(child(media, 'video'), 'track')
  expect(videoTracks).toHaveLength(1)
  const videoItems = videoTracks[0].children.filter(c => c.name === 'clipitem')
  expect(videoItems).toHaveLength(segs.length)
  let cursor = 0
  videoItems.forEach((item, i) => {
    const start = Number(childText(item, 'start'))
    const end = Number(childText(item, 'end'))
    const inPoint = Number(childText(item, 'in'))
    const outPoint = Number(childText(item, 'out'))
    expect(start).toBe(cursor)
    expect(end - start).toBe(outPoint - inPoint)
    expect(inPoint).toBe(segs[i].sourceIn)
    expect(outPoint - inPoint).toBe(segs[i].duration)
    cursor = end
  })
  expect(Number(childText(sequence, 'duration'))).toBe(cursor)
  // The first item defines the file; the rest reference it.
  const file = child(videoItems[0], 'file')
  expect(file.attrs.id).toBe('file-1')
  expect(childText(file, 'pathurl')).toBe(localhostFileUrl(src.fileUrl))
  for (const item of videoItems.slice(1)) expect(child(item, 'file').children).toHaveLength(0)
  const audioTracks = child(media, 'audio').children.filter(c => c.name === 'track')
  expect(audioTracks).toHaveLength(src.hasAudio ? Math.min(2, src.audioChannels) : 0)
  // Audio items mirror the video timing and every item links its group.
  const ids = new Set(findAll(root, 'clipitem').map(c => c.attrs.id))
  audioTracks.forEach((track, ch) => {
    const items = track.children.filter(c => c.name === 'clipitem')
    expect(items).toHaveLength(segs.length)
    items.forEach((item, i) => {
      expect(childText(item, 'in')).toBe(childText(videoItems[i], 'in'))
      expect(childText(item, 'start')).toBe(childText(videoItems[i], 'start'))
      expect(childText(child(item, 'sourcetrack'), 'trackindex')).toBe(String(ch + 1))
    })
  })
  for (const item of findAll(root, 'clipitem')) {
    const links = findAll(item, 'link')
    expect(links).toHaveLength(1 + audioTracks.length)
    for (const link of links) expect(ids.has(childText(link, 'linkclipref'))).toBe(true)
  }
  return root
}

describe('FCPXML', () => {
  it('is well formed with frame-accurate, consecutive clips at NTSC rates', () => {
    const src = source()
    const segs = timelineSegments([{ start: 10.01, end: 13.37 }, { start: 15.5, end: 21.123 }, { start: 40, end: 44.4 }], src.rate)
    const root = checkFcpxml(buildFcpxml({ name: clip().title, source: src, segments: segs }), segs, src)
    expect(findAll(root, 'project')[0].attrs.name).toBe('Why <this> & "that"')
    expect(child(child(root, 'resources'), 'asset').attrs.audioChannels).toBe('2')
  })

  it('handles integer rates and silent sources', () => {
    const src = source({ rate: { num: 25, den: 1 }, hasAudio: false })
    const segs = timelineSegments([{ start: 0, end: 2 }, { start: 3, end: 4.04 }], src.rate)
    const root = checkFcpxml(buildFcpxml({ name: 'x', source: src, segments: segs }), segs, src)
    expect(child(child(root, 'resources'), 'asset').attrs.hasAudio).toBe('0')
  })
})

describe('FCP7 XML (xmeml)', () => {
  it('is well formed with linked audio and frame-accurate items', () => {
    const src = source()
    const segs = timelineSegments([{ start: 10.01, end: 13.37 }, { start: 15.5, end: 21.123 }, { start: 40, end: 44.4 }], src.rate)
    checkXmeml(buildXmeml({ name: clip().title, source: src, segments: segs }), segs, src)
  })

  it('writes mono and silent sources', () => {
    for (const src of [source({ audioChannels: 1 }), source({ hasAudio: false, rate: { num: 24, den: 1 } })]) {
      const segs = timelineSegments([{ start: 1, end: 3 }], src.rate)
      checkXmeml(buildXmeml({ name: 'mono', source: src, segments: segs }), segs, src)
    }
  })

  it('escapes text for XML', () => {
    expect(escapeXml('a<b>&"c\'\u0001')).toBe('a&lt;b&gt;&amp;&quot;c&apos;')
  })
})

describe('SRT sidecar', () => {
  const transcript: Transcript = makeTranscript([
    'This is the first line of the clip.',
    'Some words get cut out here.',
    'And this is how it ends.'
  ], { startSec: 10, sentenceGapSec: 0.6 })

  it('times caption groups on the output timeline, skipping cut words', () => {
    const c = clip({ start: 10, end: 20 })
    const words = transcript.segments.flatMap(s => s.words)
    const cut = { start: transcript.segments[1].start - 0.05, end: transcript.segments[1].end + 0.05 }
    c.edit.cuts = [cut]
    const segs = timelineSegments(clipEditSegments(c, transcript), NTSC)
    const srt = buildSrt(c, transcript, segs, { rate: NTSC, width: 1920, height: 1080 })!
    expect(srt).toBeTruthy()
    const cues = srt.trim().split(/\n\n/)
    expect(cues.length).toBeGreaterThan(2)
    expect(srt).not.toMatch(/Some|cut out/)
    expect(srt).toMatch(/first/)
    let last = -1
    for (const [i, cue] of cues.entries()) {
      const [index, timing] = cue.split('\n')
      expect(index).toBe(String(i + 1))
      const m = /^(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})$/.exec(timing)!
      expect(m).toBeTruthy()
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
      const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
      expect(start).toBeGreaterThanOrEqual(last - 1e-9)
      expect(end).toBeGreaterThan(start)
      last = end
    }
    // The last word after the cut lands earlier by the cut's length.
    const lastWord = words.at(-1)!
    const total = segs.reduce((sum, s) => sum + s.duration, 0) * NTSC.den / NTSC.num
    expect(last).toBeLessThanOrEqual(total + 1e-3)
    expect(last).toBeLessThan(lastWord.end - 10)
  })

  it('formats timestamps and returns null without words', () => {
    expect(srtTime(3723.4567)).toBe('01:02:03,457')
    expect(buildSrt(clip(), null, [], { rate: NTSC, width: 1, height: 1 })).toBeNull()
  })
})

describe('writing the files', () => {
  let dir: string
  let project: Project

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-nle-'))
    const path = join(dir, 'source video.mp4')
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30000/1001:d=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=12',
      '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
    ])
    project = {
      id: 'p', createdAt: 0, updatedAt: 0, name: 'Project', video: await probeVideo(path),
      transcript: makeTranscript(['Hello there everyone.', 'This is a test.'], { startSec: 1 }),
      clips: [], prompt: '', videoType: 'auto'
    }
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes both formats with the exact source rate, audio layout and an SRT', async () => {
    const c = clip({ start: 1, end: 9, cuts: [{ start: 3, end: 4 }] })
    const fcp = await exportClipEdit(project, c, 'fcpxml', dir)
    expect(fcp.outputPath.endsWith('.fcpxml')).toBe(true)
    expect(fcp.segments).toBe(2)
    const fcpXml = await readFile(fcp.outputPath, 'utf8')
    const root = parseXml(fcpXml).root
    expect(child(child(root, 'resources'), 'format').attrs.frameDuration).toBe('1001/30000s')
    expect(child(child(root, 'resources'), 'asset').attrs.audioRate).toBe('44100')
    expect(child(child(child(root, 'resources'), 'asset'), 'media-rep').attrs.src).toMatch(/^file:\/\/\/.*source%20video\.mp4$/)
    expect(fcp.srtPath && (await readFile(fcp.srtPath, 'utf8'))).toMatch(/Hello/)

    const premiere = await exportClipEdit(project, c, 'xmeml', dir)
    expect(premiere.outputPath.endsWith('.xml')).toBe(true)
    const xmeml = parseXml(await readFile(premiere.outputPath, 'utf8')).root
    expect(childText(child(child(xmeml, 'sequence'), 'rate'), 'ntsc')).toBe('TRUE')
    // A second export of the same clip never overwrites the first.
    const again = await exportClipEdit(project, c, 'fcpxml', dir)
    expect(again.outputPath).not.toBe(fcp.outputPath)
    expect(again.srtPath).not.toBe(fcp.srtPath)
  }, 30_000)

  it('clamps the last segment to the frames the source has', async () => {
    const short = { ...project, video: { ...project.video, durationSec: 10.03 } }
    const frames = sourceFrameCount({ durationSec: 10.03, rate: NTSC })
    const result = await exportClipEdit(short, clip({ start: 9, end: 10.03 }), 'xmeml', dir)
    const xmeml = parseXml(await readFile(result.outputPath, 'utf8')).root
    const items = findAll(xmeml, 'clipitem')
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(Number(childText(item, 'out'))).toBeLessThanOrEqual(frames)
  }, 30_000)
})
