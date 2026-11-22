import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyseSourceAudio } from '../src/main/pipeline/audioAnalysis'
import { detectReactions } from '../src/main/pipeline/reactions'
import { syntheticWords, writeSynthetic, type SyntheticLayout } from './syntheticAudio'

/**
 * Reaction detection end to end on synthetic sources: ffmpeg generates the
 * audio, the real streaming decoder measures it, detection finds the events.
 */

const dir = mkdtempSync(join(tmpdir(), 'cutawan-reactions-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const speech = [{ start: 0.5, end: 10 }, { start: 14, end: 25 }, { start: 32, end: 45 }, { start: 49, end: 59.5 }]

async function reactionsFor(name: string, layout: SyntheticLayout): Promise<ReturnType<typeof detectReactions>> {
  const path = join(dir, `${name}.wav`)
  writeSynthetic(layout, path)
  const progress: number[] = []
  const raw = await analyseSourceAudio({ videoPath: path, durationSec: layout.durationSec, reactions: true }, f => progress.push(f))
  expect(raw.reactionFeatures!.levelDb.length).toBeCloseTo(layout.durationSec / 0.05, -1)
  expect(progress[progress.length - 1]).toBeGreaterThan(0.99)
  return detectReactions(raw.reactionFeatures!, { durationSec: layout.durationSec, speech: layout.speech, words: syntheticWords(layout.speech) })
}

describe('audio reactions on synthetic sources', () => {
  it('finds the laughter, the applause and the impact between speech, over a music bed', async () => {
    const reactions = await reactionsFor('events', {
      durationSec: 60, speech, laughter: [10.5, 13], applause: [26, 31], impact: 47, musicDb: -35, roomDb: -60
    })
    expect(reactions.map(r => r.kind)).toEqual(['laughter', 'applause', 'impact'])
    const [laugh, applause, impact] = reactions
    expect(laugh.start).toBeGreaterThan(10.2); expect(laugh.start).toBeLessThan(11)
    expect(laugh.end).toBeGreaterThan(12.5); expect(laugh.end).toBeLessThan(13.5)
    expect(applause.start).toBeCloseTo(26, 0); expect(applause.end).toBeCloseTo(31, 0)
    expect(impact.start).toBeGreaterThan(46.8); expect(impact.end).toBeLessThan(47.5)
    expect(Math.max(...reactions.map(r => r.strength))).toBe(1)
    expect(reactions.every(r => r.strength > 0.3 && r.strength <= 1)).toBe(true)
  }, 30_000)

  it('catches laughter that drowns out the speaker, but not laughter at their level or louder delivery', async () => {
    const loud = await reactionsFor('over', { durationSec: 60, speech, overSpeech: [36, 39], overSpeechDb: 10, roomDb: -60 })
    expect(loud).toHaveLength(1)
    expect(loud[0].start).toBeCloseTo(36, 0)
    expect(loud[0].end).toBeCloseTo(39, 0)
    expect(await reactionsFor('equal', { durationSec: 60, speech, overSpeech: [36, 39], overSpeechDb: 0, roomDb: -60 })).toEqual([])
    expect(await reactionsFor('emphasis', { durationSec: 60, speech, loudSpeech: [32, 45], roomDb: -60 })).toEqual([])
  }, 30_000)

  it('names a tonal sting in a gap as music', async () => {
    const reactions = await reactionsFor('sting', { durationSec: 60, speech, sting: [26, 29], roomDb: -60 })
    expect(reactions).toHaveLength(1)
    expect(reactions[0]).toMatchObject({ kind: 'music' })
    expect(reactions[0].start).toBeCloseTo(26, 0)
  }, 30_000)

  it('invents nothing in speech with room tone, under a music bed, or in silence', async () => {
    expect(await reactionsFor('speech', { durationSec: 60, speech, roomDb: -60 })).toEqual([])
    expect(await reactionsFor('music', { durationSec: 60, speech, musicDb: -26, roomDb: -60 })).toEqual([])
    expect(await reactionsFor('silence', { durationSec: 60, speech: [] })).toEqual([])
  }, 30_000)
})
