import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, Transcript, VideoInfo } from '@shared/types'
import { exportCheckSummary } from '@shared/exportCheck'
import { probeVideo, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { checkExport, judgeExport, midWordCuts, parseAnalysis, protectedOutputRanges, type CheckContext, type ExportAnalysis } from '../src/main/pipeline/exportCheck'
import { clipTimeline } from '@shared/clipTimeline'
import { makeTranscript } from './helpers'
import type { RenderJob } from '../src/main/pipeline/render'

// Real ffmpeg 7 output (trimmed): 1 s of black and silence, a frozen
// stretch, and a silent tail still open at the end of the file.
const LOG = `
[silencedetect @ 0x7fdd68014800] silence_start: 0
[silencedetect @ 0x7fdd68014800] silence_end: 1.000021 | silence_duration: 1.000021
[blackdetect @ 0x7fdd68006500] black_start:0 black_end:1.04 black_duration:1.04
[freezedetect @ 0x7fdd68014480] lavfi.freezedetect.freeze_start: 4.04
[freezedetect @ 0x7fdd68014480] lavfi.freezedetect.freeze_duration: 3
[freezedetect @ 0x7fdd68014480] lavfi.freezedetect.freeze_end: 7.04
[silencedetect @ 0x7fdd68014800] silence_start: 8.000396
[Parsed_ebur128_4 @ 0x7fdd68014a40] Summary:
  Integrated loudness:
    I:         -14.6 LUFS
    Threshold: -24.6 LUFS
  Loudness range:
    LRA:         2.7 LU
  True peak:
    Peak:      -10.3 dBFS
`

const ctx = (extra: Partial<CheckContext> = {}): CheckContext =>
  ({ duration: 10, hasAudio: true, protectedOutput: [], tightenCuts: false, wholeVideo: false, ...extra })
const analysis = (extra: Partial<ExportAnalysis> = {}): ExportAnalysis =>
  ({ black: [], freeze: [], silence: [], integratedLufs: -14, truePeakDb: -3, ...extra })

describe('reading the detectors', () => {
  it('parses black, freeze, silence and loudness, closing open runs at the end', () => {
    const a = parseAnalysis(LOG, 10)
    expect(a.black).toEqual([{ start: 0, end: 1.04 }])
    expect(a.freeze).toEqual([{ start: 4.04, end: 7.04 }])
    expect(a.silence).toEqual([{ start: 0, end: 1.000021 }, { start: 8.000396, end: 10 }])
    expect(a.integratedLufs).toBe(-14.6)
    expect(a.truePeakDb).toBe(-10.3)
    expect(parseAnalysis('', 10)).toEqual({ black: [], freeze: [], silence: [], integratedLufs: null, truePeakDb: null })
  })
})

describe('judging an export', () => {
  it('trims black at the ends only as far as the sound is silent too', () => {
    const silentBlack = judgeExport(analysis({ black: [{ start: 0, end: 0.8 }], silence: [{ start: 0, end: 1 }] }), ctx())
    expect(silentBlack.plan.head).toBeCloseTo(0.8)
    expect(silentBlack.findings.map(f => f.kind)).toEqual(['black'])
    // Speech over the black: the words are worth more than the picture.
    const spoken = judgeExport(analysis({ black: [{ start: 0, end: 0.8 }] }), ctx())
    expect(spoken.plan.head).toBe(0)
    expect(spoken.findings.map(f => f.kind)).toEqual(['black'])
  })

  it('trims dead air at the ends down to a breath when pause removal is on', () => {
    const a = analysis({ silence: [{ start: 0, end: 1.6 }, { start: 7.5, end: 10 }] })
    const on = judgeExport(a, ctx({ tightenCuts: true }))
    expect(on.plan.head).toBeCloseTo(1.3)
    expect(on.plan.tail).toBeCloseTo(1.8)
    expect(on.findings.map(f => f.kind)).toEqual(['silence-start', 'silence-end'])
    // Off, a moving picture over silence may be the point: neither trimmed nor reported at this length.
    expect(judgeExport(a, ctx()).plan).toMatchObject({ head: 0, tail: 0, loudness: false })
    expect(judgeExport(a, ctx()).findings).toEqual([])
    // …but a frozen picture over the silence is dead air whatever the setting.
    expect(judgeExport({ ...a, freeze: [{ start: 7.4, end: 10 }] }, ctx()).plan.tail).toBeCloseTo(1.8)
    // A protected payoff over the silence is kept.
    expect(judgeExport(a, ctx({ tightenCuts: true, protectedOutput: [{ start: 8, end: 9.5 }] })).plan.tail).toBe(0)
    // So is anything in a whole-video edit.
    expect(judgeExport(a, ctx({ tightenCuts: true, wholeVideo: true })).plan).toMatchObject({ head: 0, tail: 0, loudness: false })
  })

  it('never trims away most of the clip', () => {
    const a = analysis({ silence: [{ start: 0, end: 4 }, { start: 6, end: 10 }] })
    expect(judgeExport(a, ctx({ tightenCuts: true })).plan).toMatchObject({ head: 0, tail: 0, loudness: false })
  })

  it('flags level and peak outside the target, but not a silent clip', () => {
    expect(judgeExport(analysis({ integratedLufs: -17.2 }), ctx()).findings.map(f => f.kind)).toEqual(['loudness'])
    expect(judgeExport(analysis({ integratedLufs: -14.5, truePeakDb: -0.4 }), ctx()).findings.map(f => f.kind)).toEqual(['true-peak'])
    expect(judgeExport(analysis({ integratedLufs: -14.5, truePeakDb: -1.2 }), ctx()).findings).toEqual([])
    expect(judgeExport(analysis({ integratedLufs: -60 }), ctx()).plan.loudness).toBe(false)
  })

  it('sends black and freezes inside the clip for comparison with the source', () => {
    const judged = judgeExport(analysis({ black: [{ start: 4, end: 4.7 }, { start: 6, end: 6.2 }], freeze: [{ start: 1, end: 3.5 }, { start: 5, end: 9 }] }), ctx())
    expect(judged.suspects).toEqual([{ kind: 'black', start: 4, end: 4.7 }, { kind: 'freeze', start: 5, end: 9 }])
    expect(judged.findings).toEqual([])
  })
})

describe('cuts inside words', () => {
  const transcript: Transcript = {
    language: 'en', durationSec: 10,
    segments: [{ id: 0, start: 0, end: 10, text: '', words: [
      { text: 'first', start: 1, end: 1.5 }, { text: 'second', start: 2, end: 2.6 }, { text: 'third', start: 5, end: 5.5 }
    ] }]
  }
  const clip = (cuts: Array<{ start: number; end: number }>): Pick<Clip, 'edit' | 'hook'> =>
    ({ hook: '', edit: { start: 0, end: 8, tightenCuts: false, cuts } as unknown as Clip['edit'] })

  it('reports a cut inside a word, in exported time', () => {
    const found = midWordCuts(clip([{ start: 2.3, end: 4 }]), transcript)
    expect(found?.message).toBe('The cut at 0:02 lands inside the word “second”.')
  })

  it('accepts cuts between words, and inside a word voice activity calls silent', () => {
    expect(midWordCuts(clip([{ start: 3, end: 4 }]), transcript)).toBeNull()
    expect(midWordCuts(clip([{ start: 2.3, end: 4 }]), { ...transcript, speech: [{ start: 0.9, end: 2.2 }, { start: 4.9, end: 5.6 }] })).toBeNull()
  })
})

describe('a clip with a cold open', () => {
  const transcript = makeTranscript([
    'Most people start a channel and quit within a month.',
    'They post twice and nobody watches.',
    'Here is what changed for me.',
    'Consistency beats talent every time.'
  ], { wordSec: 0.3, gapSec: 0.08, sentenceGapSec: 0.5 })
  const end = transcript.durationSec + 2
  const coldClip = (): Clip => ({
    id: 'c', title: '', hook: 'Consistency beats talent', summary: '', broll: [], focusTrack: null, suggestedStart: 0, suggestedEnd: end,
    viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: { aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 0, end, captionsEnabled: false, autoZoom: false, tightenCuts: true, coldOpen: true },
    // A silent visual payoff after the last line.
    visualStory: { protectedRanges: [{ start: end - 1.6, end: end - 0.2 }] } as Clip['visualStory']
  })

  it('places protected ranges after the cold open, so the tail trim keeps the payoff', () => {
    const clip = coldClip()
    const timeline = clipTimeline(clip, transcript)
    expect(timeline.coldOpenDuration).toBeGreaterThan(1)
    const protectedOutput = protectedOutputRanges({ clip, transcript })
    // The export ends in 2 s of silence over the payoff.
    const duration = timeline.outputDuration
    const a = analysis({ silence: [{ start: duration - 2, end: duration }] })
    expect(judgeExport(a, ctx({ duration, tightenCuts: true, protectedOutput })).plan.tail).toBe(0)
    expect(protectedOutput).toHaveLength(1)
    expect(protectedOutput[0].start).toBeCloseTo(timeline.outputDuration - 1.6, 3)
  })

  it('reports cuts inside words at their time after the cold open', () => {
    const clip = coldClip()
    const word = transcript.segments[1].words[2]
    clip.edit.cuts = [{ start: (word.start + word.end) / 2, end: transcript.segments[2].start - 0.1 }]
    const timeline = clipTimeline(clip, transcript)
    expect(timeline.hasColdOpen).toBe(true)
    const found = midWordCuts(clip, transcript)
    expect(found?.at).toBeCloseTo(timeline.toOutput((word.start + word.end) / 2), 3)
    expect(found!.at).toBeGreaterThan((word.start + word.end) / 2 + 1)
  })
})

describe('the check on real files', () => {
  let dir: string
  let source: VideoInfo

  const job = (outputPath: string, edit: Partial<Clip['edit']> = {}): RenderJob => ({
    outputPath, transcript: null, source,
    clip: { id: 'c', title: '', hook: '', summary: '', broll: [], focusTrack: null, suggestedStart: 0, suggestedEnd: 8,
      viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
      edit: { aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
        start: 0, end: 8, captionsEnabled: false, autoZoom: false, tightenCuts: false, ...edit } } as Clip
  })
  const render = async (name: string, video: string, audio: string, duration = 8): Promise<string> => {
    const path = join(dir, name)
    await runFfmpeg(['-f', 'lavfi', '-i', `${video}`, '-f', 'lavfi', '-i', `aevalsrc='${audio}':d=${duration}:s=48000:c=stereo`,
      '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', path])
    return path
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cutawan-export-check-'))
    const path = await render('source.mp4', 'testsrc2=s=320x240:r=30:d=8', '0.2*sin(2*PI*220*t)')
    source = await probeVideo(path)
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('passes a clean export untouched', async () => {
    const path = await render('clean.mp4', 'testsrc2=s=320x240:r=30:d=8', '0.21*sin(2*PI*220*t)')
    const report = await checkExport(path, job(path), { outputPath: path, bytes: 0, sizePlan: null })
    expect(report.status).toBe('checked')
    expect(report.findings).toEqual([])
    expect(exportCheckSummary(report)?.label).toBe('Checked')
  }, 60_000)

  it('trims black and silent ends and levels quiet audio, keeping the repair only because it is better', async () => {
    // 1 s of black and silence, then picture and tone at about -24 LUFS, then
    // 2 s of black and silence.
    const path = await render('faulty.mp4',
      "testsrc2=s=320x240:r=30:d=8,drawbox=c=black:t=fill:enable='lt(t,1)+gte(t,6)'",
      '0.06*sin(2*PI*220*t)*between(t,1,6)')
    const before = await probeVideo(path)
    const report = await checkExport(path, job(path, { tightenCuts: true }), { outputPath: path, bytes: 0, sizePlan: null })
    const after = await probeVideo(path)
    expect(report.status).toBe('checked')
    expect(report.findings.filter(f => !f.repaired)).toEqual([])
    const fixes = report.findings.filter(f => f.repaired).map(f => f.message)
    expect(fixes).toHaveLength(3)
    expect(fixes[0]).toBe('Trimmed 1.0 s of black picture and silence from the start.')
    expect(fixes[1]).toBe('Trimmed 2.0 s of black picture and silence from the end.')
    expect(fixes[2]).toMatch(/^Levelled the audio from -2\d\.\d to -14 LUFS\.$/)
    expect(after.durationSec).toBeLessThan(before.durationSec - 2)
    expect(after.durationSec).toBeGreaterThan(4.5)
    expect(Math.abs(report.loudness!.integratedLufs - -14)).toBeLessThan(1)
    expect(exportCheckSummary(report)?.label).toBe('Fixed 3')
  }, 60_000)

  it('reports a freeze the source does not have, and accepts one it does', async () => {
    const frozen = 'testsrc2=s=320x240:r=30:d=8,trim=end_frame=1,loop=loop=239:size=1:start=0,setpts=N/30/TB'
    const path = await render('frozen.mp4', frozen, '0.21*sin(2*PI*220*t)')
    const report = await checkExport(path, job(path), { outputPath: path, bytes: 0, sizePlan: null })
    expect(report.findings.map(f => f.kind)).toEqual(['freeze'])
    expect(exportCheckSummary(report)?.label).toBe('1 issue')

    const stillSource = await probeVideo(await render('still-source.mp4', frozen, '0.2*sin(2*PI*220*t)'))
    const fromStill = { ...job(path), source: stillSource }
    expect((await checkExport(path, fromStill, { outputPath: path, bytes: 0, sizePlan: null })).findings).toEqual([])
  }, 60_000)

  it('never fails the export: a broken file is reported as not checked', async () => {
    const report = await checkExport(join(dir, 'missing.mp4'), job(join(dir, 'missing.mp4')), { outputPath: '', bytes: 0, sizePlan: null })
    expect(report.status).toBe('skipped')
    expect(exportCheckSummary(report)?.label).toBe('Not checked')
  })

  it('stops when the export is cancelled', async () => {
    const path = await render('cancel.mp4', 'testsrc2=s=320x240:r=30:d=8', '0.21*sin(2*PI*220*t)')
    const controller = new AbortController()
    controller.abort()
    await expect(checkExport(path, { ...job(path), signal: controller.signal }, { outputPath: path, bytes: 0, sizePlan: null })).rejects.toThrow()
  })
})
