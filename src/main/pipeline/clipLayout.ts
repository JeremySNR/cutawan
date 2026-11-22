import type { Clip, Transcript, VideoType } from '@shared/types'
import { shouldAnalyzeFaces } from '@shared/videoType'
import { markReframeComplete } from '@shared/reframe'
import { sourceStretches } from '@shared/clipSegments'
import { mergeStretchAnalyses } from './stretchAnalysis'
import { analyzeClipFocus, applyFocusAnalysis, type ClipFocusAnalysis } from './faces'
import { refineComposition } from './composition'
import { assessClipVisuals } from './visualScore'
import { screenTransitions } from './screenCuts'
import { refreshGapActivity } from './gapActivity'
import { captionSafety, detectBurnedInText } from './captionSafety'
import type { LayoutMemory } from './layoutMemory'

async function inOrder<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (const item of items) out.push(await run(item))
  return out
}

/** One route for initial analysis and on-demand/legacy projects. */
export async function analyzeClipLayout(
  videoPath: string, clip: Clip, videoType: VideoType,
  apiKey: string, model: string, transcript?: Transcript, signal?: AbortSignal, memory?: LayoutMemory
): Promise<void> {
  const started = performance.now()
  // Old saved assessments lack layout evidence. Refresh it once, rather than
  // making every screen clip run dense active-speaker tracking first.
  if (apiKey && transcript && videoType !== 'talking-head' &&
      (!clip.visualLayout?.kind || clip.visualLayout.start > clip.edit.start || clip.visualLayout.end < clip.edit.end)) {
    const visual = await assessClipVisuals(apiKey, model, videoPath, transcript, clip, signal)
    if (visual) clip.visualLayout = visual.visualLayout
    if (visual?.emphasis && !clip.emphasis) clip.emphasis = visual.emphasis
  }
  const screen = clip.visualLayout?.kind === 'screen' && videoType !== 'talking-head' &&
    clip.visualLayout.start <= clip.edit.start && clip.visualLayout.end >= clip.edit.end
  // A clip joined from distant moments is read stretch by stretch: tracking
  // faces through the minutes it skips would cost far more than the clip.
  const stretches = sourceStretches(clip.edit)
  const analysis: ClipFocusAnalysis = !screen && shouldAnalyzeFaces(videoType)
    ? mergeStretchAnalyses(await inOrder(stretches, (stretch) =>
        analyzeClipFocus(videoPath, stretch.start, stretch.end, signal)), stretches)
    : { focusTrack: null, contentType: 'screencast' }
  if (screen) {
    analysis.sceneTransitions = (await inOrder(stretches, (stretch) =>
      screenTransitions(videoPath, stretch.start, stretch.end, signal))).flat()
    if (analysis.sceneTransitions.length && clip.visualLayout) {
      clip.visualLayout = { ...clip.visualLayout, panels: undefined }
    }
  }
  // Which silent pauses have something happening in them. Local decoding
  // only, so it runs for every video type, with or without an API key or
  // face analysis, and before composition so the AI sees the same edit.
  await refreshGapActivity(videoPath, clip, transcript, signal)
  // Where faces and burned-in text sit, so captions can step around them.
  // Local and cheap (keyframes only), so it runs for every clip.
  clip.captionSafety = captionSafety({ start: clip.edit.start, end: clip.edit.end }, analysis?.faceBands ?? [],
    await detectBurnedInText(videoPath, stretches, signal))
  if (apiKey && videoType !== 'talking-head') {
    await refineComposition(apiKey, model, videoPath, clip, analysis.sceneCuts, signal,
      analysis.focusTrack, analysis.sceneTransitions, transcript, memory)
  }
  signal?.throwIfAborted()
  applyFocusAnalysis(clip, analysis, videoType)
  markReframeComplete(clip)
  memory?.remember(clip)
  console.info('[layout]', JSON.stringify({ clipId: clip.id, route: screen ? 'screen' : 'camera',
    seconds: Math.round((performance.now() - started) / 100) / 10,
    composed: clip.visualLayout?.shots?.filter(s => s.composition).length ?? 0,
    review: clip.visualLayout?.shots?.filter(s => s.review?.status === 'needs-review').map(s => s.review?.reason) ?? [] }))
}
