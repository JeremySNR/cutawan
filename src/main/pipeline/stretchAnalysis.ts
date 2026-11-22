import type { FocusKeyframe, TimeRange } from '@shared/types'
import type { ClipFocusAnalysis } from './faces'

/**
 * Combine the framing analyses of a clip's separate stretches into the one
 * analysis the rest of the layout code expects.
 *
 * Everything an analysis reports is in source time, so the parts simply sit
 * side by side. The one thing a join adds is a cut: the picture changes
 * instantly from one moment to another, so the crop must snap to the new
 * framing rather than pan there across a gap that is never shown.
 */
export function mergeStretchAnalyses(parts: ClipFocusAnalysis[], stretches: TimeRange[]): ClipFocusAnalysis {
  if (parts.length === 1) return parts[0]
  const track: FocusKeyframe[] = []
  parts.forEach((part, i) => {
    if (!part.focusTrack?.length) return
    const [first, ...rest] = part.focusTrack
    // The first frame after a join is a new shot, whatever came before it.
    track.push(track.length > 0 || i > 0 ? { ...first, cut: true } : first, ...rest)
  })
  const speaker = parts.some((part) => part.contentType === 'speaker')
  const joins = stretches.slice(1).map((stretch) => stretch.start)
  const all = <T>(pick: (part: ClipFocusAnalysis) => T[] | undefined): T[] => parts.flatMap((part) => pick(part) ?? [])
  return {
    focusTrack: speaker && track.length > 0 ? track : null,
    // One stretch of a person talking is enough to frame the clip for them.
    contentType: speaker ? 'speaker' : 'screencast',
    sceneCuts: [...new Set([...all((part) => part.sceneCuts), ...joins])].sort((a, b) => a - b),
    sceneTransitions: all((part) => part.sceneTransitions),
    lowDetailShots: all((part) => part.lowDetailShots),
    speakerSplits: all((part) => part.speakerSplits),
    faceBands: all((part) => part.faceBands)
  }
}
