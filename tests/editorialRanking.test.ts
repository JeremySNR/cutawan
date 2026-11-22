import { describe, expect, it } from 'vitest'
import type { Clip, Project } from '@shared/types'
import { editorialAssessmentCurrent, editorialReportMatchesClips, editorialScore, editorialSelectionKey, needsEditorialReview, selectEditorialClips } from '@shared/editorialRanking'
import { makeTranscript } from './helpers'

const transcript = makeTranscript(['A useful complete thought.', 'Another useful complete thought.'])
function clip(id: string, start = 0, end = 3, score = 75): Clip {
  const c = { id, viralityScore: 99, edit: { start, end, tightenCuts: false } } as Clip
  c.editorial = { ...needsEditorialReview(c, transcript, 'A complete useful thought'), status: 'reviewed',
    story: 'complete', fidelity: 'supported', score, scores: { hook: 3, clarity: 3, value: 3, payoff: 3, audienceFit: null } }
  return c
}

describe('editorial selection', () => {
  it('does not attach a later failed review report to retained earlier clips', () => {
    const project = { clips: [clip('old')], clipsGenerationId: 'old-run',
      editorialRanking: { generationId: 'new-run', rankedSnapshot: [] } } as unknown as Project
    expect(editorialReportMatchesClips(project)).toBe(false)
    project.editorialRanking!.generationId = 'old-run'
    expect(editorialReportMatchesClips(project)).toBe(true)
    delete project.editorialRanking!.generationId
    expect(editorialReportMatchesClips(project)).toBe(false)
    project.editorialRanking!.rankedSnapshot = [clip('old')]
    expect(editorialReportMatchesClips(project)).toBe(true)
  })
  it('uses one rubric and omits unspecified audience fit from the denominator', () => {
    expect(editorialScore({ hook: 4, clarity: 4, value: 4, payoff: 4, audienceFit: null })).toBe(100)
    expect(editorialScore({ hook: 2, clarity: 2, value: 2, payoff: 2, audienceFit: null })).toBe(50)
    expect(editorialScore({ hook: 4, clarity: 4, value: 4, payoff: 4, audienceFit: 0 })).toBe(90)
  })

  it('rejects known incomplete stories regardless of high legacy score and puts uncertain clips last', () => {
    const bad = clip('bad'); bad.editorial!.status = 'rejected'
    const uncertain = clip('unknown', 10, 13); uncertain.editorial = needsEditorialReview(uncertain, transcript, 'Failed')
    const good = clip('good', 20, 23, 45)
    expect(selectEditorialClips([bad, uncertain, good]).clips.map(c => c.id)).toEqual(['good', 'unknown'])
  })

  it('defers repeated takeaways while retaining complementary ideas and alternatives', () => {
    const a = clip('a', 0, 3, 95), b = clip('b', 10, 13, 94), c = clip('c', 20, 23, 80)
    const selected = selectEditorialClips([b, c, a], [{ first: 'a', second: 'b', reason: 'Both repeat the same lesson.' }])
    expect(selected.clips.map(c => c.id)).toEqual(['a', 'c', 'b'])
    expect(selected.clips[2].editorial?.deferredReason).toContain('same lesson')
    expect(selected.duplicateDeferredCount).toBe(1)
    expect(b.editorial?.deferredReason).toBeUndefined()
  })

  it('removes overlap using final repaired boundaries and best reviewed candidate', () => {
    const a = { ...clip('a', 0, 15, 80), suggestedStart: 0, suggestedEnd: 4 }
    const b = clip('b', 10, 15, 90)
    const result = selectEditorialClips([a, b])
    expect(result.clips.map(c => c.id)).toEqual(['b'])
    expect(result.suppressedOverlapCount).toBe(1)
  })

  it('uses stable input order for tied editorial scores instead of a discovery-route bonus', () => {
    const a = clip('visual', 0, 3), b = clip('speech', 10, 13)
    a.discovery = { origin: 'visual' }; b.discovery = { origin: 'transcript' }
    expect(selectEditorialClips([a, b]).clips.map(c => c.id)).toEqual(['visual', 'speech'])
  })

  it('retains complementary clips when the apparent overlap was cut out of playback', () => {
    const speech = clip('speech', 0, 30, 90)
    speech.edit.cuts = [{ start: 5, end: 25 }]
    const action = clip('action', 10, 25, 85)
    expect(selectEditorialClips([speech, action], [], transcript).clips.map(c => c.id)).toEqual(['speech', 'action'])
  })

  it('marks assessment stale after trims, removed/restored words and caption corrections', () => {
    const c = clip('a', 0, 6)
    expect(editorialAssessmentCurrent(c, transcript)).toBe(true)
    expect(editorialAssessmentCurrent({ ...c, edit: { ...c.edit, end: 2 } }, transcript)).toBe(false)
    expect(editorialAssessmentCurrent({ ...c, edit: { ...c.edit, cuts: [{ start: 0, end: 1 }] } }, transcript)).toBe(false)
    const edited = structuredClone(transcript); edited.segments[0].words[0].text = 'Changed'
    expect(editorialAssessmentCurrent(c, edited)).toBe(false)
    expect(editorialSelectionKey({ ...c, title: 'New title', edit: { ...c.edit, focusX: .7 } }, transcript)).toBe(c.editorial?.selectionKey)
  })
})

describe('editorial selection key and pauses kept for activity', () => {
  it('is not changed by activity measured after the assessment', () => {
    const long = makeTranscript(['One two three four five.', 'Six seven eight nine ten.'], { sentenceGapSec: 3 })
    const assessed = { id: 'a', viralityScore: 70, edit: { start: 0, end: long.durationSec, tightenCuts: true } } as Clip
    const before = editorialSelectionKey(assessed, long)
    const gapStart = long.segments[0].end, gapEnd = long.segments[1].start
    const measured = { ...assessed, gapActivity: { version: 1, start: 0, end: long.durationSec,
      measured: [{ start: gapStart, end: gapEnd }], active: [{ start: gapStart + 0.5, end: gapEnd - 0.5 }] } } as unknown as Clip
    expect(editorialSelectionKey(measured, long)).toBe(before)
    // A real edit still changes it.
    expect(editorialSelectionKey({ ...assessed, edit: { ...assessed.edit, cuts: [{ start: 0.5, end: 1 }] } }, long)).not.toBe(before)
  })
})
