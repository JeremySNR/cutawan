import { describe, expect, it } from 'vitest'
import type { Clip, Transcript, TranscriptSegment } from '@shared/types'
import { autoRemovedRanges, editedClipDuration } from '@shared/tighten'
import { pruneRemovedActive, toggleRemovedPause } from '@shared/editOps'

/** Speech 0-3 s, a pause 3-6 s, speech 6-9 s, a pause 9-12 s, speech 12-15 s. */
function transcript(): Transcript {
  const section = (from: number, id: number): TranscriptSegment => {
    const words = Array.from({ length: 6 }, (_, k) => ({ text: `w${id}${k}`, start: from + 0.2 + k * 0.4, end: from + 0.5 + k * 0.4 }))
    return { id, text: '', start: words[0].start, end: words[5].end, words }
  }
  return { language: 'english', durationSec: 15, segments: [section(0, 0), section(6, 1), section(12, 2)],
    speech: [{ start: 0, end: 3 }, { start: 6, end: 9 }, { start: 12, end: 15 }] }
}

function clip(edit: Partial<Clip['edit']>, active: Array<{ start: number; end: number }>): Clip {
  return {
    id: 'c', title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: 15, viralityScore: 0, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null,
    gapActivity: { version: 1, start: 0, end: 15, measured: [{ start: 3, end: 6 }, { start: 9, end: 12 }], active },
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 0, end: 15, captionsEnabled: false, autoZoom: false, tightenCuts: true, ...edit
    }
  }
}

describe('stale removal choices', () => {
  it('acts on what the timeline shows when an old choice no longer names an active pause', () => {
    const t = transcript()
    // Removed while 3-6 s was active; a re-measurement then found nothing there.
    const c = clip({ removedActive: [{ start: 3, end: 6 }] }, [])
    const [pause] = autoRemovedRanges(c, t)
    expect(pause.start).toBeLessThan(6)
    const next = toggleRemovedPause(c.edit, pause, c.gapActivity!.active)
    // The first click restores the pause instead of silently dropping the stale entry.
    expect(next.removedActive).toEqual([])
    expect(next.restored).toEqual([pause])
    expect(editedClipDuration({ ...c, edit: next }, t)).toBeGreaterThan(editedClipDuration(c, t))
  })

  it('still toggles a live removal back to kept automatically', () => {
    const t = transcript()
    const c = clip({ removedActive: [{ start: 3, end: 6 }] }, [{ start: 3, end: 6 }])
    const [pause] = autoRemovedRanges(c, t)
    const next = toggleRemovedPause(c.edit, pause, c.gapActivity!.active)
    expect(next.removedActive).toEqual([])
    expect(next.restored).toBeUndefined()
  })

  it('prunes only the stale entries, keeping identity when nothing is stale', () => {
    const edit = clip({ removedActive: [{ start: 3, end: 6 }, { start: 9, end: 12 }] }, []).edit
    expect(pruneRemovedActive(edit, [{ start: 9.5, end: 11 }]).removedActive).toEqual([{ start: 9, end: 12 }])
    expect(pruneRemovedActive(edit, [{ start: 3, end: 6 }, { start: 9, end: 12 }])).toBe(edit)
    expect(pruneRemovedActive(edit, []).removedActive).toBeUndefined()
  })
})
