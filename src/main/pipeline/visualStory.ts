import { throwIfSubscriptionError } from '../subscription'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Clip, Transcript } from '@shared/types'
import { computeKeptSegments } from '@shared/tighten'
import { selectedRanges } from '@shared/clipSegments'
import { padSpeechEnd } from '@shared/sentences'
import { chatJSON, type ChatContentPart } from './openai'
import { extractFramesAtTimes, plannedClipFrameTimes } from './visualScore'
import { runFfmpeg } from './ffmpeg'

interface StoryProposal {
  can_complete: boolean
  intervals: Array<{ start_frame: number; end_frame: number }>
  title: string
  hook: string
  summary: string
  reason: string
}

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['can_complete', 'intervals', 'title', 'hook', 'summary', 'reason'],
  properties: {
    can_complete: { type: 'boolean' },
    intervals: { type: 'array', maxItems: 3, items: {
      type: 'object', additionalProperties: false, required: ['start_frame', 'end_frame'],
      properties: { start_frame: { type: 'integer' }, end_frame: { type: 'integer' } }
    } },
    title: { type: 'string' }, hook: { type: 'string' }, summary: { type: 'string' }, reason: { type: 'string' }
  }
} as const

/** Validate a proposed visual continuation using observed frame times and actual output duration. */
export function applyVisualStoryProposal(
  clip: Clip, transcript: Transcript, times: number[], proposal: StoryProposal,
  maxDuration: number, videoDuration: number
): Clip | null {
  if (!proposal.can_complete || !proposal.intervals?.length || proposal.intervals.length > 3) return null
  const ranges = []
  for (const interval of proposal.intervals) {
    const { start_frame: from, end_frame: to } = interval
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to >= times.length) return null
    const start = times[from], end = times[to]
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < clip.edit.end || end > videoDuration || end <= start) return null
    ranges.push({ start, end })
  }
  ranges.sort((a, b) => a.end - b.end)
  const last = ranges.at(-1)!
  const crossing = transcript.segments.flatMap(s => s.words).find(w => w.start < last.end && w.end > last.end)
  last.end = padSpeechEnd(crossing?.end ?? last.end, transcript, videoDuration, .15)
  const end = last.end
  ranges.sort((a, b) => a.start - b.start)
  const protectedRanges = [...(clip.visualStory?.protectedRanges ?? []), ...ranges]
  const kept = clip.edit.tightenCuts ? computeKeptSegments(transcript, clip.edit.start, end, protectedRanges) : null
  const outputDuration = kept ? kept.reduce((sum, r) => sum + r.end - r.start, 0) : end - clip.edit.start
  if (!Number.isFinite(outputDuration) || outputDuration > maxDuration + .001 || outputDuration < 3) return null
  return {
    ...clip, suggestedEnd: end,
    title: proposal.title.trim() || clip.title, hook: proposal.hook.trim() || clip.hook,
    summary: proposal.summary.trim() || clip.summary,
    viralityReason: proposal.reason,
    edit: { ...clip.edit, end },
    visualStory: { protectedRanges, reason: proposal.reason },
    // The changed interval must receive fresh visual and framing assessment.
    visualLayout: undefined, focusTrack: null, reframeStatus: 'pending', reframeAnalysis: undefined
  }
}

/** Inspect nearby footage only after the candidate review identified a missing demonstration. */
export async function completeVisualStory(
  apiKey: string, model: string, videoPath: string, transcript: Transcript, clip: Clip,
  videoDuration: number, maxDuration: number, signal?: AbortSignal
): Promise<Clip | null> {
  // The repair extends one continuous moment into the footage after it. A
  // clip joined from separate moments has no single "what happens next".
  if (selectedRanges(clip.edit).length > 1) return null
  const from = clip.edit.end + .25
  const until = Math.min(videoDuration - .05, clip.edit.end + 90, clip.edit.start + 120)
  if (until - from < 3) return null
  const times = Array.from({ length: 16 }, (_, i) => from + (until - from) * i / 15)
  const allTimes = [...plannedClipFrameTimes(clip, transcript, 4), ...times]
  let frames: string[] = []
  try {
    frames = await extractFramesAtTimes(videoPath, allTimes, signal)
    const words = transcript.segments.flatMap(s => s.words)
      .filter(w => w.start >= clip.edit.start && w.start <= until)
      .map(w => `[${w.start.toFixed(2)}] ${w.text}`).join(' ').slice(0, 12000)
    const parts: ChatContentPart[] = [{ type: 'text', text:
      `A candidate introduces a visual demonstration but appears to omit its payoff. Topic: ${clip.title}. Current source interval: ${clip.edit.start.toFixed(2)}-${clip.edit.end.toFixed(2)}. The FINAL EDIT must be at most ${maxDuration} seconds.\n` +
      `Keep its spoken setup and select up to THREE chronological visual intervals from the continuation frames that actually demonstrate the promised action/result. Preserve the causal connection (e.g. mechanism and resulting performance), not just a still preview. Waiting time outside these protected intervals may be removed when tightening is enabled (${clip.edit.tightenCuts}). All speech up to the chosen end is retained except ordinary filler/pause trimming. Do not include a different topic, Q&A, thanks or a new unrelated scene.\n` +
      `Return start_frame/end_frame indices from the numbered CONTINUATION frames only. An interval must span at least two frames. End on a visible result or sustained demonstration, without requiring the whole performance. If these samples do not prove a payoff, or no coherent edit fits the duration, set can_complete=false and intervals=[]. Revise title, hook and summary to describe what this edit actually contains. Do not invent sound from still frames.\nTimed speech for context: ${words}` }]
    for (let group = 0; group < 5; group++) {
      signal?.throwIfAborted()
      const paths = frames.slice(group * 4, group * 4 + 4)
      const mosaic = join(dirname(frames[0]), `mosaic-${group}.jpg`)
      const filters = paths.map((_, i) => `[${i}:v]scale=512:288:force_original_aspect_ratio=decrease,pad=512:288:(ow-iw)/2:(oh-ih)/2,setsar=1[p${i}];`).join('') +
        '[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|512_0|0_288|512_288[out]'
      await runFfmpeg([...paths.flatMap(p => ['-i', p]), '-filter_complex', filters, '-map', '[out]', '-frames:v', '1', mosaic], { signal })
      parts.push({ type: 'text', text: group === 0 ? 'CURRENT EDIT: four frames in row-major order.' :
        'CONTINUATION: row-major order: ' + times.slice((group - 1) * 4, group * 4)
          .map((t, i) => `frame ${(group - 1) * 4 + i} = ${t.toFixed(2)}s`).join(', ') })
      parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${(await readFile(mosaic)).toString('base64')}`, detail: 'high' } })
    }
    const proposal = await chatJSON<StoryProposal>(apiKey, model, [{ role: 'user', content: parts }], 'visual_story_completion', SCHEMA, signal)
    return applyVisualStoryProposal(clip, transcript, times, proposal, maxDuration, videoDuration)
  } catch (error) {
    throwIfSubscriptionError(error)
    if (signal?.aborted) throw error
    console.error('Visual story completion failed:', error)
    return null
  } finally {
    if (frames.length) await rm(dirname(frames[0]), { recursive: true, force: true }).catch(() => undefined)
  }
}
