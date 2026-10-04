import { describe, expect, it } from 'vitest'
import { buildFilterGraph, speechSafeFade } from '../src/main/pipeline/render'
import { makeTranscript } from './helpers'
import { DEFAULT_BRAND_COLORS, DEFAULT_CAPTION_STYLE_ID } from '@shared/captionStyles'
import type { BrandingSettings, BrollItem, Clip, VideoInfo } from '@shared/types'
import { resolve } from 'node:path'

function makeClip(start = 0, end = 30): Clip {
  return {
    id: 'c1',
    suggestedStart: start,
    suggestedEnd: end,
    title: 't',
    hook: '',
    summary: '',
    viralityScore: 50,
    viralityReason: '',
    visualSummary: null,
    hashtags: [],
    thumbnailPath: null,
    focusTrack: null,
    broll: [],
    edit: {
      aspect: '9:16',
      reframeMode: 'crop',
      framing: 'manual',
      tightenCuts: false,
      focusX: 0.5,
      captionsEnabled: true,
      captionStyleId: DEFAULT_CAPTION_STYLE_ID,
      showTitle: false,
      start,
      end
    }
  }
}

const source: VideoInfo = {
  path: '/tmp/source.mp4',
  fileName: 'source.mp4',
  durationSec: 300,
  width: 1920,
  height: 1080,
  fps: 30,
  sizeBytes: 1,
  hasAudio: true
}

const branding: BrandingSettings = {
  enabled: true,
  imagePath: '/tmp/logo.png',
  position: 'bottom-right',
  opacity: 0.8,
  scale: 0.16,
  colors: DEFAULT_BRAND_COLORS
}

describe('buildFilterGraph', () => {
  // Real files: the graph skips inserts whose media has gone missing.
  const insertVideo = resolve(__dirname, 'fixtures/metachlorian-package/media/it_02.mp4')
  const insertImage = __filename
  const insert = (patch: Partial<BrollItem>): BrollItem => ({
    id: 'b1', trigger: 'tools', query: '', start: 12, end: 15.5, mode: 'fullscreen',
    imagePath: insertImage, sourceUrl: '', enabled: true, ...patch
  })

  it('reads a video insert from mediaIn for its own length and shifts it onto the clip clock', () => {
    const clip = makeClip(10, 40)
    clip.broll = [insert({ kind: 'video', mediaIn: 1.25, imagePath: insertVideo })]
    const graph = buildFilterGraph(clip, source, null, 30, null)
    expect(graph.extraInputs).toEqual(['-ss', '1.250', '-t', '3.500', '-i', insertVideo])
    expect(graph.filterComplex).toContain('[1:v]setpts=PTS-STARTPTS+2.000/TB,scale=1080:1920')
    expect(graph.filterComplex).toContain("enable='between(t,2.000,5.500)'")
    // Insert audio is never used: the A-roll's audio chain is the only one.
    expect(graph.filterComplex).not.toContain('[1:a]')
  })

  it('starts a video insert later in its media when the trim cuts off its head', () => {
    const clip = makeClip(13, 40)
    clip.broll = [insert({ kind: 'video', mediaIn: 1, imagePath: insertVideo })]
    expect(buildFilterGraph(clip, source, null, 27, null).extraInputs.slice(0, 4)).toEqual(['-ss', '2.000', '-t', '2.500'])
  })

  it('keeps image inserts on the looped still path', () => {
    const clip = makeClip(10, 40)
    clip.broll = [insert({}), insert({ id: 'b2', kind: 'image', mode: 'overlay', start: 20, end: 22 })]
    const graph = buildFilterGraph(clip, source, null, 30, null)
    expect(graph.extraInputs).toEqual(['-loop', '1', '-t', '30.000', '-i', insertImage, '-loop', '1', '-t', '30.000', '-i', insertImage])
    expect(graph.filterComplex).not.toContain('setpts=PTS-STARTPTS+')
  })

  it('fits only protected shots in source-relative time and lets manual framing override', () => {
    const clip = makeClip(100, 130)
    clip.edit.framing = 'auto'
    clip.visualLayout = { start: 100, end: 130, preserveContext: true, allowZoom: false, reason: 'puzzle', shots: [
      { start: 100, end: 110, mode: 'fit' }, { start: 110, end: 130, mode: 'crop' }
    ] }
    const graph = buildFilterGraph(clip, source, null, 30, null).filterComplex
    expect(graph).toContain("enable='gte(t,0.000)*lt(t,10.000)'")
    expect(graph).toContain('[layoutCrop][layoutFit0]overlay')
    clip.edit.framing = 'manual'
    expect(buildFilterGraph(clip, source, null, 30, null).filterComplex).not.toContain('layoutFit')
  })
  it('fades only within the available speech-free tail', () => {
    const graph = buildFilterGraph(makeClip(), source, null, 30, null, { audioTailSec: 0.4 })
    expect(graph.filterComplex).toContain('afade=t=out:st=29.600:d=0.4')
    const shortTail = buildFilterGraph(makeClip(), source, null, 30, null, { audioTailSec: 0.075 })
    expect(shortTail.filterComplex).toContain('afade=t=out:st=29.925:d=0.075')
    expect(buildFilterGraph(makeClip(), source, null, 30, null).filterComplex).not.toContain('afade')
  })

  it('fits an object region intact and keeps speaker crop commands away from it', () => {
    const clip = makeClip(0, 100)
    clip.edit.framing = 'auto'
    clip.focusTrack = Array.from({ length: 120 }, (_, i) => ({ t: i * .8, x: .3 + (i % 2) * .4, cut: true }))
    clip.visualLayout = { start: 0, end: 100, preserveContext: true, allowZoom: false, reason: 'mechanism', shots: [
      { start: 0, end: 50, mode: 'crop' }, { start: 50, end: 100, mode: 'fit', region: { x: .25, y: 0, width: .5, height: 1 } }
    ] }
    const graph = buildFilterGraph(clip, source, null, 100, null, { focusCommandsPath: '/tmp/focus.txt' })
    expect(graph.filterComplex).toContain('crop=960:1080:480:0,scale=1080:1920:force_original_aspect_ratio=decrease')
    expect(graph.focusCommands).toBeNull()
    expect(graph.filterComplex).not.toContain('sendcmd')
  })

  it('does not fade a final spoken word or assume unknown audio is silence', () => {
    const transcript = makeTranscript(['It worked out.'])
    const end = transcript.segments[0].end
    expect(speechSafeFade(transcript, 0, end)).toBe(0)
    expect(speechSafeFade(transcript, 0, end + 0.15)).toBeCloseTo(0.1)
    expect(speechSafeFade(transcript, 0, end + 0.6)).toBe(0.4)
    expect(speechSafeFade(null, 0, 30)).toBe(0)
  })

  it('normalises loudness in single-pass mode when the source was not measured', () => {
    const graph = buildFilterGraph(makeClip(), source, null, 30, null)
    expect(graph.filterComplex).toContain('loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000')
    expect(graph.filterComplex).not.toContain('measured_I')
  })

  it('normalises linearly from the measured loudness when available', () => {
    const graph = buildFilterGraph(makeClip(), source, null, 30, null, {
      loudness: { inputI: -23.4, inputTp: -12.1, inputLra: 9.2, inputThresh: -33.7, targetOffset: 0.3 }
    })
    expect(graph.filterComplex).toContain(
      'loudnorm=I=-14:TP=-1.5:LRA=11.00:measured_I=-23.40:measured_TP=-12.10:measured_LRA=9.20:measured_thresh=-33.70:offset=0.30:linear=true,aresample=48000'
    )
    expect(graph.filterComplex).toContain('linear=true,aresample=48000')
  })

  it('gains into a limiter when a linear gain would clip the true peak', () => {
    const graph = buildFilterGraph(makeClip(), source, null, 30, null, {
      loudness: { inputI: -23.4, inputTp: -6.1, inputLra: 9.2, inputThresh: -33.7, targetOffset: 0.3 }
    })
    expect(graph.filterComplex).toContain('volume=9.40dB,alimiter=limit=0.7943:attack=5:release=50:level=false,aresample=48000')
    expect(graph.filterComplex).not.toContain('loudnorm')
  })

  it('skips the fade on very short clips', () => {
    const graph = buildFilterGraph(makeClip(0, 1), source, null, 1, null)
    expect(graph.filterComplex).not.toContain('afade')
  })

  it('overlays the branding watermark under the captions', () => {
    const graph = buildFilterGraph(makeClip(), source, '/tmp/subs.ass', 30, null, { branding })
    expect(graph.extraInputs).toContain('/tmp/logo.png')
    // 16% of 1080 output width, bottom-right with a 3% margin.
    expect(graph.filterComplex).toContain('scale=173:-1')
    expect(graph.filterComplex).toContain('colorchannelmixer=aa=0.800')
    expect(graph.filterComplex).toContain('overlay=W-w-32:H-h-32[wmk]')
    // Captions are burned in after (on top of) the watermark.
    expect(graph.filterComplex.indexOf('overlay=W-w-32')).toBeLessThan(
      graph.filterComplex.indexOf('ass=filename')
    )
  })

  it('positions the watermark per corner', () => {
    const at = (position: BrandingSettings['position']): string =>
      buildFilterGraph(makeClip(), source, null, 30, null, {
        branding: { ...branding, position }
      }).filterComplex
    expect(at('top-left')).toContain('overlay=32:32')
    expect(at('top-right')).toContain('overlay=W-w-32:32')
    expect(at('bottom-left')).toContain('overlay=32:H-h-32')
    expect(at('bottom-right')).toContain('overlay=W-w-32:H-h-32')
  })

  it('omits the watermark when branding is disabled or has no image', () => {
    const disabled = buildFilterGraph(makeClip(), source, null, 30, null, {
      branding: { ...branding, enabled: false }
    })
    expect(disabled.filterComplex).not.toContain('colorchannelmixer')
    const noImage = buildFilterGraph(makeClip(), source, null, 30, null, {
      branding: { ...branding, imagePath: null }
    })
    expect(noImage.filterComplex).not.toContain('colorchannelmixer')
  })

  it('pans the crop for within-shot focus moves and snaps at cuts', () => {
    const clip = makeClip()
    clip.edit.framing = 'auto'
    clip.focusTrack = [
      { t: 0, x: 0.5, cut: true },
      { t: 5, x: 0.62 }, // small within-shot move -> eased pan
      { t: 12, x: 0.2, cut: true } // speaker switch -> hard snap
    ]
    const graph = buildFilterGraph(clip, source, null, 30, null)
    // Auto framing centres the crop on the face centre, not the slider value.
    expect(graph.filterComplex).toContain('max(0,min(iw-ow,iw*(')
    // Eased (smoothstep) pan over the pan window starting at the keyframe.
    expect(graph.filterComplex).toContain('(t-5.000)/0.600')
    expect(graph.filterComplex).toContain('(3-2*')
    // The cut-flagged keyframe stays a hard constant step, gated from its own
    // time to the end of the clip.
    expect(graph.filterComplex).toContain('gte(t,12.000)*(0.2000)')
  })

  /**
   * A whole-video focus track runs to hundreds of keyframes, and ffmpeg's
   * expression parser fails at around a hundred levels of nesting, so the
   * crop expression must not nest per keyframe.
   */
  it('keeps the crop expression flat for long focus tracks', () => {
    const clip = makeClip(0, 600)
    clip.edit.framing = 'auto'
    clip.focusTrack = Array.from({ length: 400 }, (_, i) => ({
      t: i * 1.5,
      x: i % 2 === 0 ? 0.35 : 0.7,
      cut: i % 4 === 0
    }))
    const graph = buildFilterGraph(clip, source, null, 600, null)
    let depth = 0
    let max = 0
    for (const ch of graph.filterComplex) {
      if (ch === '(') max = Math.max(max, ++depth)
      else if (ch === ')') depth--
    }
    expect(max).toBeLessThan(20)
    expect(graph.filterComplex).toContain('gte(t,598.500)')
  })

  it('uses crop-slider math for manual framing', () => {
    const graph = buildFilterGraph(makeClip(), source, null, 30, null)
    expect(graph.filterComplex).toContain("x='(iw-ow)*0.5000'")
    expect(graph.filterComplex).not.toContain('max(0,min(iw-ow,iw*(')
  })

  it('letterboxes wide footage with black bars for screencasts', () => {
    const clip = makeClip()
    clip.edit.reframeMode = 'fit-letterbox'
    const graph = buildFilterGraph(clip, source, null, 30, null)
    expect(graph.filterComplex).toContain('force_original_aspect_ratio=decrease')
    expect(graph.filterComplex).toContain('pad=1080:1920')
    expect(graph.filterComplex).toContain('color=black[reframed]')
    expect(graph.filterComplex).not.toContain('perspective=')
  })

  it('applies auto zoom via the subpixel perspective filter, not zoompan', () => {
    const graph = buildFilterGraph(makeClip(), source, null, 30, null, {
      zoomEvents: [
        { start: 2, end: 2, from: 1, to: 1.12, style: 'cut' },
        { start: 6, end: 14, from: 1, to: 1.08, style: 'creep' }
      ]
    })
    // zoompan pans on whole pixels, which made slow creeps shake.
    expect(graph.filterComplex).not.toContain('zoompan')
    expect(graph.filterComplex).toContain('perspective=')
    expect(graph.filterComplex).toContain('interpolation=cubic:eval=frame[zoomed]')
  })

  it('uses the provided fontsdir for caption burn-in', () => {
    const graph = buildFilterGraph(makeClip(), source, '/tmp/subs.ass', 30, null, {
      fontsDirPath: '/custom/fonts'
    })
    expect(graph.filterComplex).toContain("fontsdir='/custom/fonts'")
  })
})
