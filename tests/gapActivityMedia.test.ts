import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Clip, TimeRange, Transcript, TranscriptSegment } from '@shared/types'
import { clipKeptSegments } from '@shared/tighten'
import * as ffmpeg from '../src/main/pipeline/ffmpeg'
import { measureGapActivity, refreshGapActivity } from '../src/main/pipeline/gapActivity'
import { setAnalysisCacheRoot } from '../src/main/pipeline/analysisCache'

const { runFfmpeg } = ffmpeg

// Count decodes, so the cache can be seen to spare them.
vi.mock('../src/main/pipeline/ffmpeg', async (original) => {
  const actual = await original<typeof import('../src/main/pipeline/ffmpeg')>()
  return { ...actual, streamRawFrames: vi.fn(actual.streamRawFrames) }
})

/**
 * Gap activity measured on a real, synthetic source: speech-like sections
 * over a still frame, separated by 2.5 s pauses that each hold one kind of
 * "nothing" or "something". Only the moving pause and the loud one count.
 *
 * The still is the test card with sharp, saturated edges — the hardest case
 * for compression noise reading as motion — encoded with x264 at CRF 30.
 */
const SPEECH = 3
const GAP = 2.5
/** Section i's start: speech then gap, repeated. */
const at = (i: number): number => i * (SPEECH + GAP)
const gapOf = (i: number): TimeRange => ({ start: at(i) + SPEECH, end: at(i + 1) })
const SECTIONS = 7
const DURATION = at(SECTIONS - 1) + SPEECH

// What happens in each gap (index = gap after speech section i).
const STILL = 0, GRAIN = 1, MOVING = 2, HARD_CUT = 3, LOUD = 4, BREATH = 5

let dir: string
let video: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-gap-activity-'))
  setAnalysisCacheRoot(join(dir, 'cache'))
  video = join(dir, 'source.mp4')
  const inGap = (i: number): string => `between(t,${gapOf(i).start},${gapOf(i).end})`
  const speaking = Array.from({ length: SECTIONS }, (_, i) => `between(t,${at(i)},${at(i) + SPEECH})`).join('+')
  // Speech: a 220 Hz tone with a 4 Hz syllable rhythm, about -15 dBFS.
  // Grain gap: room tone at about -57 dBFS. Loud gap: a 500 Hz tone at about
  // -17 dBFS (laughter or a sting at speech level). Breath gap: about -35 dBFS.
  const audio = `(${speaking})*0.25*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*4*t))` +
    `+${inGap(GRAIN)}*0.002*(2*random(0)-1)*1.7` +
    `+${inGap(LOUD)}*0.2*sin(2*PI*500*t)` +
    `+${inGap(BREATH)}*0.025*sin(2*PI*300*t)`
  const cutAt = gapOf(HARD_CUT).start + 1.25
  await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `smptehdbars=size=640x360:rate=30:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `color=c=white:size=120x140:rate=30:duration=${DURATION}`,
    '-f', 'lavfi', '-i', `aevalsrc='${audio}':d=${DURATION}:s=48000`,
    '-filter_complex',
    // A frozen test card throughout; temporal grain only in its gap; a box
    // crossing the frame only in the moving gap; the bars cut in halfway
    // through the hard-cut gap and stay until well into the next speech.
    `[0:v]trim=end_frame=1,loop=-1:1:0,setpts=N/30/TB,trim=duration=${DURATION}[still];` +
    `[still]noise=alls=25:allf=t:enable='${inGap(GRAIN)}'[grain];` +
    `[grain][2:v]overlay=x='40+mod(t*300,440)':y=110:enable='${inGap(MOVING)}'[moving];` +
    `[moving][1:v]overlay=0:0:enable='between(t,${cutAt},${at(HARD_CUT + 1) + 1.5})'[v]`,
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-t', String(DURATION), video
  ])
}, 120_000)

afterAll(async () => {
  setAnalysisCacheRoot(undefined)
  await rm(dir, { recursive: true, force: true })
})

/** Words every 0.4 s through each speech section, with voice activity on the sections. */
function transcript(): Transcript {
  const segments: TranscriptSegment[] = Array.from({ length: SECTIONS }, (_, i) => {
    const words = Array.from({ length: 6 }, (_, k) => ({
      text: `word${i}${k}`, start: at(i) + 0.2 + k * 0.4, end: at(i) + 0.5 + k * 0.4
    }))
    return { id: i, text: words.map(w => w.text).join(' '), start: words[0].start, end: words[5].end, words }
  })
  const speech = Array.from({ length: SECTIONS }, (_, i) => ({ start: at(i), end: at(i) + SPEECH }))
  return { language: 'english', durationSec: DURATION, segments, speech }
}

function clip(edit: Partial<Clip['edit']> = {}): Clip {
  return {
    id: 'gaps', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: DURATION, viralityScore: 0, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 0, end: DURATION, captionsEnabled: false, autoZoom: false, tightenCuts: true, ...edit
    }
  }
}

const overlaps = (ranges: TimeRange[], gap: TimeRange): boolean => ranges.some(r => r.start < gap.end && r.end > gap.start)

describe('measuring activity in pauses', () => {
  it('keeps the moving and the loud pause and nothing else', async () => {
    const started = performance.now()
    const result = await measureGapActivity(video, clip(), transcript())
    const seconds = (performance.now() - started) / 1000
    console.info(`[gap activity] ${DURATION} s clip measured in ${seconds.toFixed(2)} s`)
    expect(result).not.toBeNull()
    // Every pause is measured…
    expect(result!.measured).toHaveLength(SECTIONS - 1)
    for (let i = 0; i < SECTIONS - 1; i++) expect(overlaps(result!.measured, gapOf(i))).toBe(true)
    // …and only these two are active.
    const active = [STILL, GRAIN, MOVING, HARD_CUT, LOUD, BREATH].filter(i => overlaps(result!.active, gapOf(i)))
    expect(active).toEqual([MOVING, LOUD])
    // Active all the way through, so each comes back whole.
    for (const i of [MOVING, LOUD]) {
      const range = result!.active.find(r => overlaps([r], gapOf(i)))!
      expect(range.end - range.start).toBeGreaterThan(GAP - 0.5)
    }

    // Pause removal now keeps them, and still cuts the other four.
    const measured = { ...clip(), gapActivity: result! }
    const kept = clipKeptSegments(measured, transcript())!
    const keptGap = (i: number): boolean => kept.some(k => k.start <= gapOf(i).start + 0.3 && k.end >= gapOf(i).end - 0.3)
    expect([STILL, GRAIN, MOVING, HARD_CUT, LOUD, BREATH].filter(keptGap)).toEqual([MOVING, LOUD])
  }, 60_000)

  it('measures each source once: a re-analysis reads the cache, not the video', async () => {
    const first = await measureGapActivity(video, clip(), transcript())
    // A fresh run of the app: nothing in memory, only what is on disk.
    setAnalysisCacheRoot(join(dir, 'cache'))
    const decodes = vi.mocked(ffmpeg.streamRawFrames)
    decodes.mockClear()
    const started = performance.now()
    const again = await measureGapActivity(video, clip(), transcript())
    console.info(`[gap activity] measured again from the cache in ${((performance.now() - started) / 1000).toFixed(2)} s`)
    expect(again).toEqual(first)
    expect(decodes).not.toHaveBeenCalled()
    // A wider trim decodes only the footage it adds.
    const narrow = clip({ start: 0, end: at(3) })
    setAnalysisCacheRoot(join(dir, 'narrow-cache'))
    await measureGapActivity(video, narrow, transcript())
    decodes.mockClear()
    await measureGapActivity(video, clip(), transcript())
    const decodedSec = decodes.mock.calls.reduce((sum, [args]) => sum + Number(args[args.indexOf('-t') + 1]), 0)
    expect(decodedSec).toBeGreaterThan(0)
    expect(decodedSec).toBeLessThan(2 * (DURATION - at(3)) + 1)
    setAnalysisCacheRoot(join(dir, 'cache'))
  }, 60_000)

  it('never decodes the stretch a joined clip skips', async () => {
    // Joined: the first two sections, then the last two. The cut covers the
    // moving and the loud pause, so nothing between can be measured.
    const joined = clip({ cuts: [{ start: at(2) + 0.1, end: at(5) - 0.1 }] })
    const result = await measureGapActivity(video, joined, transcript())
    expect(result!.measured.some(r => overlaps([r], gapOf(MOVING)) || overlaps([r], gapOf(LOUD)))).toBe(false)
    expect(result!.active).toEqual([])
  }, 60_000)

  it('logs a decode failure and leaves the clip with no protected pauses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const c = { ...clip(), gapActivity: { version: 1, start: 0, end: DURATION, measured: [gapOf(MOVING)], active: [gapOf(MOVING)] } }
    await expect(refreshGapActivity(join(dir, 'missing.mp4'), c, transcript())).resolves.toBeUndefined()
    expect(c.gapActivity).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('stops on abort instead of swallowing it', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(refreshGapActivity(video, clip(), transcript(), controller.signal)).rejects.toThrow()
  })

  it('skips whole-video edits', async () => {
    expect(await measureGapActivity(video, { ...clip(), origin: 'whole-video' }, transcript())).toBeNull()
  })
})
