import { existsSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Clip, NleExportResult, NleFormat, Project } from '@shared/types'
import {
  buildFcpxml,
  buildSrt,
  buildXmeml,
  clipEditSegments,
  frameRateFromProbe,
  sourceFrameCount,
  timelineSegments,
  type NleSource
} from '@shared/nleExport'
import { FFPROBE_PATH, runBinary } from './pipeline/ffmpeg'
import { sanitizeFileName } from './exportPath'

interface ProbedStreams {
  streams?: Array<{
    codec_type?: string
    r_frame_rate?: string
    avg_frame_rate?: string
    channels?: number
    sample_rate?: string
  }>
}

/**
 * The details an NLE needs that the project does not store: the exact
 * frame-rate rational and the audio layout. Falls back to the project's
 * probe (and 48 kHz stereo) when ffprobe cannot say.
 */
async function nleSource(project: Project): Promise<NleSource> {
  const video = project.video
  let rate = frameRateFromProbe(undefined, video.fps)
  let channels = 2
  let sampleRate = 48000
  try {
    const out = await runBinary(FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_streams', video.path])
    const data = JSON.parse(out) as ProbedStreams
    const v = data.streams?.find((s) => s.codec_type === 'video')
    const a = data.streams?.find((s) => s.codec_type === 'audio')
    // r_frame_rate is the stream's base rate (30000/1001); avg is a measurement.
    rate = frameRateFromProbe(v?.r_frame_rate, video.fps)
    if (rate.den !== 1 && rate.den !== 1001) rate = frameRateFromProbe(v?.avg_frame_rate, video.fps)
    if (a?.channels) channels = a.channels
    if (a?.sample_rate && Number(a.sample_rate) > 0) sampleRate = Number(a.sample_rate)
  } catch {
    /* the stored probe is close enough */
  }
  return {
    fileUrl: pathToFileURL(video.path).href,
    fileName: video.fileName,
    durationSec: video.durationSec,
    width: video.width,
    height: video.height,
    rate,
    hasAudio: video.hasAudio,
    audioChannels: channels,
    audioSampleRate: sampleRate
  }
}

/** A base name under which neither the timeline nor its SRT exists yet. */
function uniqueBase(dir: string, base: string, extensions: string[]): string {
  const free = (name: string): boolean => extensions.every((ext) => !existsSync(join(dir, `${name}${ext}`)))
  if (free(base)) return base
  for (let n = 2; ; n++) if (free(`${base} (${n})`)) return `${base} (${n})`
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.partial-${randomUUID()}`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Write a clip's edit as an editing timeline (plus SRT captions) into `outputDir`. */
export async function exportClipEdit(
  project: Project,
  clip: Clip,
  format: NleFormat,
  outputDir: string
): Promise<NleExportResult> {
  const source = await nleSource(project)
  const segments = timelineSegments(clipEditSegments(clip, project.transcript), source.rate, sourceFrameCount(source))
  if (segments.length === 0) {
    throw new Error('Nothing is left to export: every part of this clip has been cut. Undo a cut or widen the trim.')
  }
  const timeline = { name: clip.title.trim() || project.name, source, segments }
  const xml = format === 'fcpxml' ? buildFcpxml(timeline) : buildXmeml(timeline)
  const srt = buildSrt(clip, project.transcript, segments, source)
  const ext = format === 'fcpxml' ? '.fcpxml' : '.xml'
  const base = uniqueBase(outputDir, sanitizeFileName(clip.title), [ext, '.srt'])
  const outputPath = join(outputDir, `${base}${ext}`)
  await writeAtomic(outputPath, xml)
  let srtPath: string | null = null
  if (srt) {
    srtPath = join(outputDir, `${base}.srt`)
    await writeAtomic(srtPath, srt)
  }
  return { clipId: clip.id, format, outputPath, srtPath, segments: segments.length }
}
