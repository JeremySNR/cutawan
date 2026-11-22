import type { Clip, Transcript, VideoInfo } from '@shared/types'
import { extractThumbnail, streamRawFrames } from './ffmpeg'
import {
  defaultThumbnailTime,
  pickThumbnail,
  scoreCandidate,
  thumbnailCandidates,
  type GrayFrame,
  type ScoredCandidate
} from './thumbnailScore'

/** Width of the grey frames the candidates are judged on. */
const SAMPLE_WIDTH = 160
/** Each candidate is decoded with a neighbour either side, this far apart. */
const NEIGHBOUR_SEC = 1 / 6
const FRAMES_PER_CANDIDATE = 3

/**
 * Decode every candidate (with its two neighbours) as small grey frames in
 * one ffmpeg call: one fast-seeking input per candidate, concatenated into a
 * single raw stream. A few hundred kilobytes in all.
 */
async function sampleCandidates(
  videoPath: string,
  video: Pick<VideoInfo, 'width' | 'height' | 'durationSec'>,
  times: number[],
  signal?: AbortSignal
): Promise<GrayFrame[][]> {
  const width = SAMPLE_WIDTH
  const aspect = video.width > 0 && video.height > 0 ? video.height / video.width : 9 / 16
  const height = Math.max(2, 2 * Math.round((width * aspect) / 2))
  const frameBytes = width * height
  const inputs: string[] = []
  const chains: string[] = []
  times.forEach((t, i) => {
    const from = Math.max(0, Math.min(t - NEIGHBOUR_SEC, video.durationSec - 1))
    inputs.push('-ss', from.toFixed(3), '-t', '0.75', '-i', videoPath)
    chains.push(
      `[${i}:v]fps=${1 / NEIGHBOUR_SEC},trim=end_frame=${FRAMES_PER_CANDIDATE},` +
        `scale=${width}:${height},format=gray,setsar=1[v${i}]`
    )
  })
  const filter = `${chains.join(';')};${times.map((_, i) => `[v${i}]`).join('')}concat=n=${times.length}:v=1:a=0[out]`
  const frames: GrayFrame[] = []
  await streamRawFrames(
    [...inputs, '-filter_complex', filter, '-map', '[out]', '-an', '-f', 'rawvideo', '-pix_fmt', 'gray'],
    frameBytes,
    (frame) => {
      frames.push({ width, height, data: new Uint8Array(frame) })
    },
    signal
  )
  if (frames.length !== times.length * FRAMES_PER_CANDIDATE) {
    // A short input would shift every later candidate's frames; trust none.
    throw new Error(`Expected ${times.length * FRAMES_PER_CANDIDATE} thumbnail samples, got ${frames.length}`)
  }
  return times.map((_, i) => frames.slice(i * FRAMES_PER_CANDIDATE, (i + 1) * FRAMES_PER_CANDIDATE))
}

/**
 * The source time of the best thumbnail frame for a clip, or the plain
 * 1.5 s frame when sampling fails or nothing scores well.
 */
export async function pickThumbnailTime(
  videoPath: string,
  video: Pick<VideoInfo, 'width' | 'height' | 'durationSec'>,
  clip: Pick<Clip, 'edit' | 'suggestedStart' | 'suggestedEnd' | 'focusTrack'>,
  transcript: Transcript | null,
  signal?: AbortSignal
): Promise<number> {
  const fallback = defaultThumbnailTime(clip)
  const candidates = thumbnailCandidates(clip, transcript)
  if (candidates.length < 2) return fallback
  try {
    const samples = await sampleCandidates(videoPath, video, candidates.map((c) => c.time), signal)
    const scored: ScoredCandidate[] = candidates.map((c, i) => {
      const [before, frame, after] = samples[i]
      return { ...c, score: scoreCandidate(c, frame, [before, after]) }
    })
    // The middle sample sits NEIGHBOUR_SEC after the seek point, i.e. at the candidate.
    return pickThumbnail(scored)?.time ?? fallback
  } catch (err) {
    if (signal?.aborted) throw err
    return fallback
  }
}

/** Pick and write a clip's thumbnail; falls back to the plain frame on any failure. */
export async function writeClipThumbnail(
  videoPath: string,
  video: Pick<VideoInfo, 'width' | 'height' | 'durationSec'>,
  clip: Pick<Clip, 'edit' | 'suggestedStart' | 'suggestedEnd' | 'focusTrack'>,
  transcript: Transcript | null,
  outPath: string,
  signal?: AbortSignal
): Promise<string> {
  const at = await pickThumbnailTime(videoPath, video, clip, transcript, signal)
  try {
    return await extractThumbnail(videoPath, at, outPath)
  } catch (err) {
    const fallback = defaultThumbnailTime(clip)
    if (signal?.aborted || Math.abs(fallback - at) < 1e-3) throw err
    return extractThumbnail(videoPath, fallback, outPath)
  }
}
