import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  CaptionVideoOptions,
  Clip,
  ClipContentType,
  FocusKeyframe,
  PipelineProgress,
  Project
} from '@shared/types'
import { compactFocusTrack } from '@shared/focusTrack'
import { findWholeVideoClip, wholeVideoEdit } from '@shared/wholeVideo'
import { extractThumbnail } from './ffmpeg'
import { analyzeClipFocus } from './faces'
import { ensureTranscript } from './projectTranscript'
import { getAnalysisCredential, getModelPreferences } from '../settings'
import { usesLocalTranscription } from '../subscription'
import { projectDir, updateProject } from '../projects'

/**
 * "Caption whole video": transcribe the video, optionally track the speaker,
 * and leave behind one full-length clip the editor can style and export. No
 * highlight detection, no virality scoring, no LLM calls beyond Whisper.
 *
 * The result is a normal clip (see shared/wholeVideo.ts), so trimming,
 * reframing, caption styling, auto zoom and export all work on it unchanged.
 */

/**
 * Length of each speaker-tracking window. Active speaker detection samples at
 * 25 fps and works on a window's frames at once, so a whole video is analysed
 * in slices whose focus tracks are stitched together in source time. This
 * keeps memory flat regardless of how long the video is.
 */
const FOCUS_WINDOW_SEC = 120

export async function captionWholeVideo(
  project: Project,
  options: CaptionVideoOptions,
  onProgress: (p: PipelineProgress) => void,
  signal?: AbortSignal
): Promise<Project> {
  // The key only pays for transcription. With a transcript already saved this
  // run makes no API calls at all, so redoing the crop or the speaker track
  // offline is allowed.
  const apiKey = getAnalysisCredential()
  if (!apiKey && !project.transcript && !usesLocalTranscription()) {
    throw new Error('No transcription connection configured. Add an API key or set up local Whisper in Settings.')
  }
  const settings = getModelPreferences()
  const workDir = join(tmpdir(), 'cutawan', `caption-${project.id}`)
  await mkdir(workDir, { recursive: true })

  try {
    await ensureTranscript(
      project,
      workDir,
      {
        apiKey: apiKey ?? '',
        model: settings.transcriptionModel,
        language: settings.transcriptionLanguage,
        span: { from: 0.02, to: 0.7 },
        noSpeechError:
          'No speech was detected in this video, so there is nothing to caption.'
      },
      onProgress,
      signal
    )

    let focusTrack: FocusKeyframe[] | null = null
    // Without tracking the crop is a fixed window the focus slider moves, and
    // a talking head is the assumption — the user can letterbox in the editor.
    let contentType: ClipContentType = 'speaker'
    if (options.followSpeaker) {
      const tracked = await trackSpeakerAcrossVideo(
        project.video.path,
        project.video.durationSec,
        (done, total) =>
          onProgress({
            stage: 'reframe',
            progress: 0.7 + (done / total) * 0.22,
            message:
              total > 1
                ? `Following the speaker (part ${done}/${total})…`
                : 'Following the speaker…'
          }),
        signal
      )
      focusTrack = tracked.focusTrack
      contentType = tracked.contentType
    }

    onProgress({ stage: 'thumbnails', progress: 0.94, message: 'Finishing up…' })
    const existing = findWholeVideoClip(project)
    // Reuse the clip id across re-runs so export progress, the open editor and
    // anything else keyed by clip id keep pointing at the same edit.
    const clipId = existing?.id ?? randomUUID()
    const thumbsDir = join(projectDir(project.id), 'thumbs')
    await mkdir(thumbsDir, { recursive: true })
    let thumbnailPath: string | null = null
    try {
      thumbnailPath = await extractThumbnail(
        project.video.path,
        Math.min(1.5, project.video.durationSec / 2),
        join(thumbsDir, `${clipId}.jpg`)
      )
    } catch {
      thumbnailPath = null
    }

    const clip: Clip = {
      id: clipId,
      origin: 'whole-video',
      suggestedStart: 0,
      suggestedEnd: project.video.durationSec,
      title: project.name,
      hook: '',
      summary: '',
      viralityScore: 0,
      viralityReason: '',
      visualSummary: null,
      hashtags: [],
      thumbnailPath,
      focusTrack,
      reframeStatus: 'done',
      reframeAnalysis: { start: 0, end: project.video.durationSec, version: 1 },
      contentType,
      // Inserts an imported package placed stay put across re-runs.
      broll: existing?.broll ?? [],
      edit: wholeVideoEdit({
        aspect: options.aspect,
        autoZoom: options.autoZoom,
        durationSec: project.video.durationSec,
        focusTrack,
        contentType,
        // A re-run applies the new options but keeps the caption look, which
        // is a pure styling choice and annoying to lose.
        captionStyleId: existing?.edit.captionStyleId,
        captionFontFamily: existing?.edit.captionFontFamily
      })
    }

    const persisted = await updateProject(project.id, (p) => {
      const idx = p.clips.findIndex((c) => c.origin === 'whole-video')
      // A re-run replaces the full-video edit and leaves AI clips alone.
      if (idx === -1) p.clips.unshift(clip)
      else p.clips[idx] = clip
      p.mode = 'whole-video'
    })
    onProgress({ stage: 'done', progress: 1, message: 'Done' })
    return persisted
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface WholeVideoFocus {
  focusTrack: FocusKeyframe[] | null
  contentType: ClipContentType
}

/**
 * Speaker tracking across a whole video, one window at a time.
 *
 * Windows with no usable faces (a screen share, a slide interlude) contribute
 * no keyframes: the crop simply holds the last tracked position through them,
 * which is what the renderer and the preview already do between keyframes.
 */
async function trackSpeakerAcrossVideo(
  videoPath: string,
  durationSec: number,
  onWindowDone: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<WholeVideoFocus> {
  const windows: Array<[number, number]> = []
  for (let start = 0; start < durationSec; start += FOCUS_WINDOW_SEC) {
    const end = Math.min(durationSec, start + FOCUS_WINDOW_SEC)
    // Include the tail: analysis provenance must cover the range we claim.
    windows.push([start, end])
  }

  const keyframes: FocusKeyframe[] = []
  let speakerWindows = 0
  for (let i = 0; i < windows.length; i++) {
    signal?.throwIfAborted()
    const [start, end] = windows[i]
    const analysis = await analyzeClipFocus(videoPath, start, end, signal)
    if (analysis.focusTrack) keyframes.push(...analysis.focusTrack)
    if (analysis.contentType === 'speaker') speakerWindows++
    onWindowDone(i + 1, windows.length)
  }

  if (keyframes.length === 0) return { focusTrack: null, contentType: 'screencast' }
  return {
    focusTrack: compactFocusTrack(keyframes),
    // Only letterbox when most of the video has no speaker to follow: one
    // slide interlude must not decide the layout for the whole thing.
    contentType: speakerWindows * 2 >= windows.length ? 'speaker' : 'screencast'
  }
}
