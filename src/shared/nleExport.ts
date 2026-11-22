import type { AspectRatio, Clip, Transcript } from './types'
import { clipKeptSegments, remapTranscript, TimeMap, type KeptSegment } from './tighten'
import { selectedRanges } from './clipSegments'
import { captionLayoutBudget, groupDisplayEnd, groupWords, wordsInRange } from './captionLayout'
import { resolveCaptionStyle } from './captionStyles'

/**
 * "Export edit for…": a clip's edit as an editing timeline instead of a
 * rendered file, for finishing in Final Cut Pro, Premiere Pro or DaVinci
 * Resolve. One source asset, one timeline at the source's frame rate, and
 * the kept segments (after pause removal and the user's cuts) laid end to
 * end as clips that reference the source file, audio linked. Captions go in
 * an SRT sidecar.
 *
 * Only the cut list travels: reframing, zoom, B-roll and burned-in caption
 * styling are Cutawan render features with no faithful equivalent in these
 * formats, and the UI says so.
 *
 * Every position is a whole frame of the source rate, so offsets and
 * durations add up exactly in the NLE.
 */

/** Frames per second as an exact rational, num / den (30000/1001 for 29.97). */
export interface FrameRate {
  num: number
  den: number
}

/** Common rates, including the NTSC ones that are not whole numbers. */
const STANDARD_RATES: FrameRate[] = [
  { num: 24000, den: 1001 }, { num: 24, den: 1 }, { num: 25, den: 1 },
  { num: 30000, den: 1001 }, { num: 30, den: 1 }, { num: 48000, den: 1001 }, { num: 48, den: 1 },
  { num: 50, den: 1 }, { num: 60000, den: 1001 }, { num: 60, den: 1 },
  { num: 120000, den: 1001 }, { num: 120, den: 1 }
]

/**
 * The exact rate for a probed (rounded) fps: snapped to a standard rate when
 * within 0.02, to an NTSC rate when fps × 1.001 is near a whole number,
 * otherwise rounded to whole frames (variable-rate phone footage averages
 * a little under its nominal rate).
 */
export function frameRateFromFps(fps: number): FrameRate {
  if (!(fps > 0 && fps < 1000)) return { num: 30, den: 1 }
  const standard = STANDARD_RATES.find((r) => Math.abs(r.num / r.den - fps) < 0.02)
  if (standard) return standard
  const ntsc = fps * 1.001
  if (Math.abs(ntsc - Math.round(ntsc)) < 0.005 && Math.round(ntsc) % 6 === 0) {
    return { num: Math.round(ntsc) * 1000, den: 1001 }
  }
  return { num: Math.max(1, Math.round(fps)), den: 1 }
}

/**
 * An ffprobe rate string ("30000/1001") when it is a clean rational, else
 * the snapped float. Odd rationals (an average over dropped frames) snap.
 */
export function frameRateFromProbe(rate: string | undefined, fallbackFps: number): FrameRate {
  const [num, den] = (rate ?? '').split('/').map(Number)
  if (Number.isInteger(num) && Number.isInteger(den) && num > 0 && (den === 1 || den === 1001) && num / den < 1000) {
    return { num, den }
  }
  return frameRateFromFps(num > 0 && den > 0 ? num / den : fallbackFps)
}

export const isNtsc = (rate: FrameRate): boolean => rate.den === 1001

/** The nearest whole frame to a source time. */
export function toFrame(sec: number, rate: FrameRate): number {
  return Math.round((sec * rate.num) / rate.den + 1e-9)
}

export function framesToSeconds(frames: number, rate: FrameRate): number {
  return (frames * rate.den) / rate.num
}

/** One clip on the timeline, in whole frames. */
export interface TimelineSegment {
  /** First source frame used. */
  sourceIn: number
  /** Frames on the timeline. */
  duration: number
  /** Where it starts on the timeline. */
  offset: number
}

/** What the clip plays, in source seconds: the kept segments, or the selected ranges when nothing is removed. */
export function clipEditSegments(clip: Pick<Clip, 'edit' | 'visualStory' | 'gapActivity'>, transcript: Transcript | null): KeptSegment[] {
  return clipKeptSegments(clip, transcript) ?? selectedRanges(clip.edit)
}

/**
 * Frame-aligned timeline segments laid end to end. Pieces shorter than a
 * frame vanish, and pieces that meet in source after rounding are merged so
 * the NLE does not get a pointless through-edit. With `sourceFrames` (see
 * sourceFrameCount), no segment reaches past the source's last whole frame:
 * an end rounded up would point the NLE at a frame the file does not have.
 */
export function timelineSegments(segments: KeptSegment[], rate: FrameRate, sourceFrames = Infinity): TimelineSegment[] {
  const out: TimelineSegment[] = []
  let offset = 0
  for (const seg of segments) {
    const from = Math.min(toFrame(seg.start, rate), sourceFrames)
    const to = Math.min(toFrame(seg.end, rate), sourceFrames)
    if (to <= from) continue
    const last = out[out.length - 1]
    if (last && last.sourceIn + last.duration === from) {
      last.duration += to - from
    } else {
      out.push({ sourceIn: from, duration: to - from, offset })
    }
    offset += to - from
  }
  return out
}

export interface NleSource {
  /** Absolute file URL (file:///…). */
  fileUrl: string
  fileName: string
  durationSec: number
  width: number
  height: number
  rate: FrameRate
  hasAudio: boolean
  audioChannels: number
  audioSampleRate: number
}

export interface NleTimeline {
  /** Sequence/project name, usually the clip title. */
  name: string
  source: NleSource
  segments: TimelineSegment[]
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these characters outright
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** Whole frames in the source (never past its end). */
export function sourceFrameCount(source: Pick<NleSource, 'durationSec' | 'rate'>): number {
  return Math.max(1, Math.floor((source.durationSec * source.rate.num) / source.rate.den + 1e-6))
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** FCPXML rational time: "3003/30000s", "2s" or "0s". */
export function fcpxTime(frames: number, rate: FrameRate): string {
  if (frames === 0) return '0s'
  const numerator = frames * rate.den
  const divisor = gcd(numerator, rate.num)
  const n = numerator / divisor
  const d = rate.num / divisor
  return d === 1 ? `${n}s` : `${n}/${d}s`
}

function totalFrames(segments: TimelineSegment[]): number {
  const last = segments[segments.length - 1]
  return last ? last.offset + last.duration : 0
}

const fcpxAudioRate = (hz: number): string => (Math.abs(hz - 44100) < 1 ? '44.1k' : hz >= 96000 ? '96k' : '48k')

/**
 * FCPXML 1.9: Final Cut Pro 10.4.1+ and DaVinci Resolve import it. The
 * source is one asset with an original-media `media-rep`; the spine holds
 * one `asset-clip` per kept segment, which carries the linked audio.
 */
export function buildFcpxml(timeline: NleTimeline): string {
  const { source, segments } = timeline
  const rate = source.rate
  const duration = totalFrames(segments)
  const audio = source.hasAudio
  const name = escapeXml(timeline.name)
  const assetName = escapeXml(source.fileName.replace(/\.[^.]+$/, ''))
  const clips = segments
    .map((seg) =>
      `            <asset-clip ref="r2" name="${assetName}" offset="${fcpxTime(seg.offset, rate)}" ` +
      `start="${fcpxTime(seg.sourceIn, rate)}" duration="${fcpxTime(seg.duration, rate)}" tcFormat="NDF"${audio ? ' audioRole="dialogue"' : ''}/>`)
    .join('\n')
  const audioAttrs = audio
    ? ` hasAudio="1" audioSources="1" audioChannels="${Math.max(1, source.audioChannels)}" audioRate="${Math.round(source.audioSampleRate)}"`
    : ' hasAudio="0"'
  const sequenceAudio = audio ? ` audioLayout="${source.audioChannels === 1 ? 'mono' : 'stereo'}" audioRate="${fcpxAudioRate(source.audioSampleRate)}"` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="${fcpxTime(1, rate)}" width="${source.width}" height="${source.height}"/>
    <asset id="r2" name="${assetName}" start="0s" duration="${fcpxTime(sourceFrameCount(source), rate)}" hasVideo="1" format="r1"${audioAttrs}>
      <media-rep kind="original-media" src="${escapeXml(source.fileUrl)}"/>
    </asset>
  </resources>
  <library>
    <event name="Cutawan">
      <project name="${name}">
        <sequence format="r1" duration="${fcpxTime(duration, rate)}" tcStart="0s" tcFormat="NDF"${sequenceAudio}>
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`
}

/** Premiere and FCP 7 want file://localhost/… rather than file:///… */
export function localhostFileUrl(fileUrl: string): string {
  return fileUrl.replace(/^file:\/\/\//, 'file://localhost/')
}

function xmemlRate(rate: FrameRate, indent: string): string {
  return `${indent}<rate>\n${indent}  <timebase>${Math.round(rate.num / rate.den)}</timebase>\n${indent}  <ntsc>${isNtsc(rate) ? 'TRUE' : 'FALSE'}</ntsc>\n${indent}</rate>`
}

/**
 * Final Cut Pro 7 XML (xmeml version 4), which Premiere Pro and DaVinci
 * Resolve import. In this format an NTSC rate is a whole timebase (30) with
 * the ntsc flag, and positions count real frames, so the same frame numbers
 * serve both formats. Stereo audio is two mono channel tracks, as Premiere
 * itself writes it; every segment's video and audio items are linked.
 */
export function buildXmeml(timeline: NleTimeline): string {
  const { source, segments } = timeline
  const rate = source.rate
  const channels = source.hasAudio ? Math.min(2, Math.max(1, source.audioChannels)) : 0
  const frames = sourceFrameCount(source)
  const duration = totalFrames(segments)
  const name = escapeXml(timeline.name)
  const fileName = escapeXml(source.fileName)
  const videoId = (k: number): string => `clipitem-v${k + 1}`
  const audioId = (ch: number, k: number): string => `clipitem-a${ch + 1}-${k + 1}`

  const links = (k: number, indent: string): string => {
    const items = [
      `${indent}<link>\n${indent}  <linkclipref>${videoId(k)}</linkclipref>\n${indent}  <mediatype>video</mediatype>\n${indent}  <trackindex>1</trackindex>\n${indent}  <clipindex>${k + 1}</clipindex>\n${indent}</link>`
    ]
    for (let ch = 0; ch < channels; ch++) {
      items.push(`${indent}<link>\n${indent}  <linkclipref>${audioId(ch, k)}</linkclipref>\n${indent}  <mediatype>audio</mediatype>\n${indent}  <trackindex>${ch + 1}</trackindex>\n${indent}  <clipindex>${k + 1}</clipindex>\n${indent}  <groupindex>1</groupindex>\n${indent}</link>`)
    }
    return items.join('\n')
  }

  const fileFull = (indent: string): string => `${indent}<file id="file-1">
${indent}  <name>${fileName}</name>
${indent}  <pathurl>${escapeXml(localhostFileUrl(source.fileUrl))}</pathurl>
${xmemlRate(rate, `${indent}  `)}
${indent}  <duration>${frames}</duration>
${indent}  <timecode>
${xmemlRate(rate, `${indent}    `)}
${indent}    <string>00:00:00:00</string>
${indent}    <frame>0</frame>
${indent}    <displayformat>NDF</displayformat>
${indent}  </timecode>
${indent}  <media>
${indent}    <video>
${indent}      <samplecharacteristics>
${xmemlRate(rate, `${indent}        `)}
${indent}        <width>${source.width}</width>
${indent}        <height>${source.height}</height>
${indent}        <pixelaspectratio>square</pixelaspectratio>
${indent}      </samplecharacteristics>
${indent}    </video>${channels ? `
${indent}    <audio>
${indent}      <samplecharacteristics>
${indent}        <depth>16</depth>
${indent}        <samplerate>${Math.round(source.audioSampleRate)}</samplerate>
${indent}      </samplecharacteristics>
${indent}      <channelcount>${channels}</channelcount>
${indent}    </audio>` : ''}
${indent}  </media>
${indent}</file>`

  const clipitem = (id: string, seg: TimelineSegment, k: number, indent: string, body: string): string => `${indent}<clipitem id="${id}">
${indent}  <masterclipid>masterclip-1</masterclipid>
${indent}  <name>${fileName}</name>
${indent}  <enabled>TRUE</enabled>
${indent}  <duration>${frames}</duration>
${xmemlRate(rate, `${indent}  `)}
${indent}  <start>${seg.offset}</start>
${indent}  <end>${seg.offset + seg.duration}</end>
${indent}  <in>${seg.sourceIn}</in>
${indent}  <out>${seg.sourceIn + seg.duration}</out>
${body}
${links(k, `${indent}  `)}
${indent}</clipitem>`

  const ind = '          '
  const videoItems = segments
    .map((seg, k) => clipitem(videoId(k), seg, k, ind, k === 0 ? fileFull(`${ind}  `) : `${ind}  <file id="file-1"/>`))
    .join('\n')
  const audioTracks = Array.from({ length: channels }, (_, ch) => {
    const items = segments
      .map((seg, k) => clipitem(audioId(ch, k), seg, k, ind,
        `${ind}  <file id="file-1"/>\n${ind}  <sourcetrack>\n${ind}    <mediatype>audio</mediatype>\n${ind}    <trackindex>${ch + 1}</trackindex>\n${ind}  </sourcetrack>`))
      .join('\n')
    return `        <track>\n${items}\n        </track>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${name}</name>
    <duration>${duration}</duration>
${xmemlRate(rate, '    ')}
    <timecode>
${xmemlRate(rate, '      ')}
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
${xmemlRate(rate, '            ')}
            <width>${source.width}</width>
            <height>${source.height}</height>
            <pixelaspectratio>square</pixelaspectratio>
          </samplecharacteristics>
        </format>
        <track>
${videoItems}
        </track>
      </video>
      <audio>${channels ? `
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>${Math.round(source.audioSampleRate)}</samplerate>
          </samplecharacteristics>
        </format>
${audioTracks}` : ''}
      </audio>
    </media>
  </sequence>
</xmeml>
`
}

/** SRT timestamp: 00:01:02,345 */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`
}

/** Output width / height of a clip's aspect, as the caption layout sees it. */
function outputAspect(aspect: AspectRatio, source: { width: number; height: number }): number {
  if (aspect === '9:16') return 9 / 16
  if (aspect === '1:1') return 1
  if (aspect === '16:9') return 16 / 9
  return source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9
}

/**
 * Captions for the exported timeline as SRT: the same word groups the
 * burned-in captions use (groupWords with the clip's style at its output
 * shape), timed on the output timeline through the same frame-aligned
 * segments as the XML. Null when there are no words to caption.
 */
export function buildSrt(
  clip: Pick<Clip, 'edit'>,
  transcript: Transcript | null,
  segments: TimelineSegment[],
  source: Pick<NleSource, 'rate' | 'width' | 'height'>
): string | null {
  if (!transcript || segments.length === 0) return null
  const kept = segments.map((seg) => ({
    start: framesToSeconds(seg.sourceIn, source.rate),
    end: framesToSeconds(seg.sourceIn + seg.duration, source.rate)
  }))
  const map = new TimeMap(kept)
  const remapped = remapTranscript(transcript, map, kept[0].start, kept[kept.length - 1].end)
  const total = map.outputDuration
  const words = wordsInRange(remapped, 0, total)
  if (words.length === 0) return null
  const style = resolveCaptionStyle(clip.edit.captionStyleId, null, clip.edit.captionFontFamily ?? undefined)
  const groups = groupWords(words, captionLayoutBudget(style, outputAspect(clip.edit.aspect, source)))
  const cues: string[] = []
  groups.forEach((group, i) => {
    const start = group.start
    const end = groupDisplayEnd(groups, i, total)
    if (end - start < 0.04) return
    const text = group.lines.map((line) => line.map((w) => w.text).join(' ')).join('\n')
    cues.push(`${cues.length + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`)
  })
  return cues.length ? cues.join('\n') : null
}
