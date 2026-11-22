import { throwIfSubscriptionError } from '../subscription'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Clip, FocusKeyframe, Transcript } from '@shared/types'
import { focusAt } from '@shared/focusTrack'
import { bridgeTransitionLayouts } from '@shared/contentType'
import { contentRegionPixels, proposedContentRegion } from '@shared/contentRegion'
import type { ContentRegion } from '@shared/types'
import { chatJSON, type ChatContentPart } from './openai'
import { clipFrameTimes, extractClipFrames, extractFramesAtTimes } from './visualScore'
import { probeImageDimensions, runAnalysisFfmpeg as runFfmpeg } from './ffmpeg'
import { mapLimit } from './concurrency'
import { sourceStretches } from '@shared/clipSegments'
import { refineScreenDetails } from './screenDetail'
import { reviewExistingComposition, reviewPresenterComposition, sourceRectangle } from './presenterComposition'
import type { LayoutMemory } from './layoutMemory'

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['mode', 'reason', 'region', 'screen_detail', 'presenter'],
  properties: {
    mode: { type: 'string', enum: ['crop', 'fit'] },
    reason: { type: 'string' },
    screen_detail: { type: 'boolean', description: 'True only for screen UI, slides or diagrams whose necessary text/controls are too small in full-frame portrait fit and need an enlarged detail with an overview.' },
    presenter: { type: 'object', additionalProperties: false, required: ['left', 'top', 'right', 'bottom'],
      properties: { left: { type: 'integer' }, top: { type: 'integer' }, right: { type: 'integer' }, bottom: { type: 'integer' } } },
    region: { type: 'object', additionalProperties: false, required: ['left', 'top', 'right', 'bottom'],
      properties: { left: { type: 'integer' }, top: { type: 'integer' }, right: { type: 'integer' }, bottom: { type: 'integer' } } }
  }
} as const

/** Check proposed crops within stable shots, including a single static shot. */
export async function refineComposition(
  apiKey: string, model: string, videoPath: string, clip: Clip,
  sceneCuts: number[] | undefined, signal?: AbortSignal, focusTrack?: FocusKeyframe[] | null,
  transitions: Array<{ start: number; end: number }> = [],
  transcript?: Transcript, memory?: LayoutMemory
): Promise<void> {
  const assessment = clip.visualLayout
  if (!assessment?.preserveContext) return
  const candidates = [...(sceneCuts ?? []), ...transitions.flatMap((range) => [range.start, range.end]),
    ...(clip.visualStory?.protectedRanges ?? []).flatMap(range => [range.start, range.end])]
  // Only footage that plays is composed. A joined clip's skipped stretch can
  // hold any number of scene changes; none of them is this clip's business.
  const stretches = sourceStretches(clip.edit)
  const joined = stretches.length > 1
  const played = (t: number): boolean => !joined || stretches.some(r => t >= r.start && t <= r.end)
  if (joined) candidates.push(...stretches.flatMap(r => [r.start, r.end]))
  const bounds = [clip.edit.start, ...new Set(candidates.filter((t) => Number.isFinite(t) && played(t) &&
    t > clip.edit.start + 0.04 && t < clip.edit.end - 0.04))].sort((a, b) => a - b)
  bounds.push(clip.edit.end)
  // Very rapid montages keep the safe whole-clip layout rather than an oversized graph.
  if (bounds.length > 49) {
    clip.visualLayout = { ...assessment, shots: [{ start: clip.edit.start, end: clip.edit.end, mode: 'fit',
      review: { status: 'needs-review', reason: 'Rapid scene changes; full source retained for review.' } }] }
    return
  }
  const shots: NonNullable<NonNullable<Clip['visualLayout']>['shots']> = bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1], mode: 'fit' }))
  const detailPlans = new Map<(typeof shots)[number], typeof shots>()
  await mapLimit(shots, 1, async (shot) => {
    signal?.throwIfAborted()
    if (shot.end - shot.start < 0.25) return
    if (joined && !stretches.some(r => shot.start >= r.start - 0.001 && shot.end <= r.end + 0.001)) return
    if (transitions.some((range) => shot.start < range.end && shot.end > range.start)) return
    let frames: string[] = []
    let retryTimes: number[] = []
    let repairFeedback = ''
    const narration = transcript?.segments.flatMap(s => s.words)
      .filter(w => w.start >= shot.start && w.start < shot.end).map(w => w.text).join(' ').slice(0, 4000) ?? clip.title
    try {
      // The editorial pass already inspected source geometry. Reuse its proposal,
      // but verify the actual output on independent samples before applying it.
      if (assessment.panels && assessment.kind === 'screen' && clip.edit.aspect === '9:16' &&
          assessment.start <= shot.start && assessment.end >= shot.end) {
        const { content, presenter } = assessment.panels
        const checked = await reviewPresenterComposition(apiKey, model, videoPath, shot.start, shot.end, content, presenter, narration, signal)
        Object.assign(shot, { composition: checked.composition, review: checked.review })
        retryTimes = checked.retryTimes ?? []
        if (checked.composition) return
        repairFeedback = JSON.stringify({ rejectedPanels: assessment.panels, reason: checked.review?.reason })
      }
      if (!repairFeedback && !retryTimes.length && assessment.kind === 'screen' && clip.edit.aspect === '9:16') {
        const example = await memory?.propose(shot.start, shot.end, signal)
        if (example) {
          const checked = await reviewExistingComposition(apiKey, model, videoPath,
            shot.start, shot.end, example, narration, signal)
          console.info('[layout-reuse]', JSON.stringify({ start: shot.start, end: shot.end,
            accepted: Boolean(checked.composition), reason: checked.review?.reason }))
          if (checked.composition) { Object.assign(shot, { composition: checked.composition, review: checked.review }); return }
          retryTimes = checked.retryTimes ?? []
          repairFeedback = JSON.stringify({ rejectedComposition: example, reason: checked.review?.reason })
          // A similar screen is not necessarily the same layout. Rejection
          // falls through to the normal proposal path, once per shot.
        }
      }
      const times = [...new Set([...clipFrameTimes(shot.start, shot.end, 3), ...retryTimes])].sort((a, b) => a - b)
      frames = retryTimes.length ? await extractFramesAtTimes(videoPath, times, signal, 1280)
        : await extractClipFrames(videoPath, shot.start, shot.end, 3, signal, 1280)
      const parts: ChatContentPart[] = [{ type: 'text', text:
        `Narration in THIS interval: ${narration}. Judge these images only; other parts of the source may show different content.\nThe first ${times.length} images are original source frames. ${retryTimes.length ? "Extra frames show a detected crop-edge collision: widen the relevant bounds to retain that content." : ""} Comparison pairs (LEFT full source, RIGHT tracked portrait crop) follow only when tracking is available. Face tracking available: ${Boolean(focusTrack?.length)}. All pairs are from ONE camera shot. Choose crop only when tracking is available and the RIGHT images communicate this shot clearly and keep the speaking face comfortably visible. Ordinary explanatory hand gestures, an incidental lectern, set furniture, background monitors used as decoration, or a listener outside the crop do not by themselves require fit. Choose fit when the proposed crop loses a demonstrated object, important hands-on action, essential text/slide/UI, or cuts significantly into the face.\nFor fit, propose a single REGION in normalized 0–1000 coordinates of the FULL SOURCE FRAME (not the pair canvas): left/top/right/bottom. It will be fitted INTACT into the output. Remove empty borders, toolbars, navigation, and unrelated side panels to enlarge the content this narration actually discusses. An activity feed or sidebar is not essential merely because it is visible. Preserve the relevant post, diagram, poll or demonstrated controls; do not preserve the whole application window by default. Keep the whole demonstrated object, moving hands, required labels and meaningful relationships across ALL supplied frames. Leave movement margins. Do not reduce a screen to a tiny control without its context or cut a puzzle/mechanism into fragments. If a stable useful region cannot be established, return the full frame 0,0,1000,1000. For crop also return the full-frame region. This proposal will be checked on additional frames.` }]
      parts.push({ type: 'text', text: 'If this is screen content plus a genuinely separate webcam/presenter inset, return screen_detail=true and presenter=the entire inset rectangle in source 0–1000 coordinates, regardless of its corner. In that case region must contain the relevant graph/slide/UI WITHOUT the webcam; both will be composed independently. Preserve graph labels and relationships. Prefer stable panel boundaries, never a tight face box. If panels move, overlap essential content or cannot be separated consistently across the samples, return presenter=0,0,0,0. For ordinary footage without an inset also return zeros. FIRST: unpadded ORIGINAL SOURCE images. Use these image boundaries for region coordinates. The comparison pairs follow afterward.' })
      parts.push({ type: 'text', text: 'A presenter rectangle must contain ONE contiguous webcam panel. Never combine disconnected webcams or an embedded video and the primary commentator into one bounding box. Choose the primary commentator panel; a second embedded speaker may stay in the content only if relevant to this narration. Locate panel edges from the pixels again when repairing a rejected proposal; do not inherit its incorrect bounds. Focus content on the evidence discussed in this interval, not every visible table row or unrelated sidebar.' })
      for (const path of frames) parts.push({ type: 'image_url', image_url: {
        url: `data:image/jpeg;base64,${(await readFile(path)).toString('base64')}`, detail: 'high'
      } })
      if (focusTrack?.length) {
        parts.push({ type: 'text', text: 'NOW: full-source / proposed face-crop pairs. Their extra canvas padding is only for review, not part of the source.' })
        for (const [i, path] of frames.entries()) {
          const t = times[i]
          const x = focusTrack?.length ? focusAt(focusTrack, t) : 0.5
          const pair = join(dirname(path), `pair-${i}.jpg`)
          await runFfmpeg(['-i', path, '-filter_complex',
            `[0:v]split=2[a][b];[a]scale=320:180:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2[l];` +
            `[b]crop=w='min(iw,floor(ih*0.5625/2)*2)':h='min(ih,floor(iw/0.5625/2)*2)':x='max(0,min(iw-ow,iw*${x.toFixed(5)}-ow/2))':y='(ih-oh)/2',scale=180:320[r];[l][r]hstack[out]`,
            '-map', '[out]', '-frames:v', '1', pair], { signal })
          parts.push({ type: 'image_url', image_url: {
            url: `data:image/jpeg;base64,${(await readFile(pair)).toString('base64')}`, detail: 'low'
          } })
        }
      }
      if (repairFeedback) parts.push({ type: 'text', text: `Repair this rejected proposal. Coordinates below are normalized 0–1; return corrected bounds in 0–1000. ${repairFeedback}` })
      // At most two source proposals. A repaired inset can expose a separate
      // content-size problem; its precise geometric feedback gets one attempt.
      const attempts = 2
      for (let attempt = 0; attempt < attempts; attempt++) {
        const result = await chatJSON<{ mode: string; reason: string; screen_detail?: boolean; region?: { left: number; top: number; right: number; bottom: number }; presenter?: { left: number; top: number; right: number; bottom: number } }>(apiKey, model,
          [{ role: 'user', content: parts }], 'shot_composition', SCHEMA, signal)
        shot.mode = result.mode === 'crop' && focusTrack?.length ? 'crop' : 'fit'
        const presenter = sourceRectangle(result.presenter)
        const content = sourceRectangle(result.region)
        const insetRequested = result.screen_detail && result.presenter && Object.values(result.presenter).some(value => value !== 0)
        if (insetRequested) shot.mode = 'fit'
        if (insetRequested && (!presenter || !content || clip.edit.aspect !== '9:16')) {
          shot.review = { status: 'needs-review', reason: 'Separate source panels could not be composed safely in this format.' }
          // Invalid boxes never reach reviewPresenterComposition; still offer one repair.
          if (clip.edit.aspect === '9:16' && (!presenter || !content) && attempt + 1 < attempts) {
            parts.push({ type: 'text', text: `Repair these rejected source bounds (0–1000): ${JSON.stringify(result)}. Content and presenter bounds overlap or are invalid. Locate the actual webcam rectangle separately from the relevant screen content.` })
            continue
          }
          return
        }
        if (shot.mode === 'fit' && result.screen_detail && presenter && content && clip.edit.aspect === '9:16') {
          const checked = await reviewPresenterComposition(apiKey, model, videoPath, shot.start, shot.end, content, presenter, narration, signal)
          Object.assign(shot, { composition: checked.composition, review: checked.review })
          if (shot.composition) return
          if (checked.repairBounds && attempt + 1 < attempts) {
            parts.push({ type: 'text', text: `Repair these rejected source bounds (0–1000): ${JSON.stringify(result)}. ${checked.review?.reason}` })
            continue
          }
          // A rejected separate-panel proposal cannot safely be reused as a single crop.
          return
        }
        const region = shot.mode === 'fit' ? proposedContentRegion(result.region) : undefined
        if (region && await verifyContentRegion(apiKey, model, videoPath, clip.title, shot.start, shot.end, region, signal)) { shot.region = region; delete shot.review }
        if (shot.mode === 'fit' && !shot.region && result.screen_detail === true && transcript) {
          const details = await refineScreenDetails(apiKey, model, videoPath, clip.title, shot.start, shot.end, transcript, signal)
          if (details) detailPlans.set(shot, details)
        }
        return
      }
    } catch (error) {
      throwIfSubscriptionError(error)
      if (signal?.aborted) throw error
      console.error('Shot composition review failed; preserving the full shot:', error)
      shot.review = { status: 'needs-review', reason: 'Layout analysis failed; full source retained. Retry or choose a layout.' }
    } finally {
      if (frames.length) await rm(dirname(frames[0]), { recursive: true, force: true }).catch(() => undefined)
    }
  })
  bridgeTransitionLayouts(shots, transitions)
  const expanded = shots.flatMap(shot => detailPlans.get(shot) ?? [shot])
  clip.visualLayout = { ...assessment, start: clip.edit.start, end: clip.edit.end, shots: expanded.length <= 48 ? expanded : shots, allowZoom: false }
}

/** A proposed rectangle is accepted only after checking actual crops on seven frames. */
async function verifyContentRegion(
  apiKey: string, model: string, videoPath: string, title: string,
  start: number, end: number, region: ContentRegion, signal?: AbortSignal
): Promise<boolean> {
  let frames: string[] = []
  try {
    frames = await extractClipFrames(videoPath, start, end, 7, signal)
    const parts: ChatContentPart[] = [{ type: 'text', text:
      `Review a proposed content-region layout for "${title}". Each image has THREE panels: LEFT is a larger original-source reference for checking containment; MIDDLE is the current full-frame fit into portrait; RIGHT is the proposed region fit into an IDENTICAL-SIZED portrait canvas. Compare MIDDLE versus RIGHT for enlargement, never compare size to the left reference. Seven chronological frames sample one shot, including frames not used for the proposal. Accept only if the right view is meaningfully larger than the middle AND retains all essential demonstrated objects, hands throughout their movement, faces when relevant, text and context in EVERY frame. Reject clipping, missing causal relationships, unreadable isolated UI without context, or uncertain boundaries. Empty source borders may be discarded. Return accept=false if unsure. This verifies containment and usefulness, not popularity.` }]
    for (const [i, path] of frames.entries()) {
      const info = await probeImageDimensions(path)
      const pixels = contentRegionPixels(region, info.width, info.height)
      const pair = join(dirname(path), `region-${i}.jpg`)
      await runFfmpeg(['-i', path, '-filter_complex',
        `[0:v]split=3[a][b][c];[a]scale=480:270:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2[l];` +
        `[c]scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2[m];` +
        `[b]crop=${pixels.width}:${pixels.height}:${pixels.x}:${pixels.y},scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2[r];[l][m][r]hstack=inputs=3[out]`,
        '-map', '[out]', '-frames:v', '1', pair], { signal })
      parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${(await readFile(pair)).toString('base64')}`, detail: 'high' } })
    }
    const result = await chatJSON<{ accept: boolean; reason: string }>(apiKey, model, [{ role: 'user', content: parts }],
      'content_region_verification', { type: 'object', additionalProperties: false, required: ['accept', 'reason'],
        properties: { accept: { type: 'boolean' }, reason: { type: 'string' } } }, signal)
    return result.accept === true
  } finally {
    if (frames.length) await rm(dirname(frames[0]), { recursive: true, force: true }).catch(() => undefined)
  }
}
