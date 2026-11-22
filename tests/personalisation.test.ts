import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clip, ScoreBreakdown } from '@shared/types'
import { SCORE_PARTS, scoreFromParts } from '@shared/scoreBreakdown'
import {
  applyPersonalisation,
  computeModel,
  emptyStore,
  lengthPenalty,
  MAX_RECORDS,
  migrateStore,
  MIN_POSITIVES,
  personalisedScore,
  recordAction,
  recordClips,
  summarise,
  WEIGHT_CLAMP,
  type PersonalisationStore
} from '@shared/personalisation'

const { userData } = await vi.hoisted(async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  return { userData: path.join(os.tmpdir(), `cutawan-personalisation-${process.pid}-${Date.now()}`) }
})

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const main = await import('../src/main/personalisation')

let n = 0
function clip(parts: ScoreBreakdown | undefined, length = 30, extra: Partial<Clip> = {}): Clip {
  n++
  return {
    id: `c${n}`, title: '', hook: '', summary: '', broll: [], focusTrack: null,
    suggestedStart: 0, suggestedEnd: length, viralityScore: parts ? scoreFromParts(parts) : 50, viralityReason: '',
    visualSummary: null, hashtags: [], thumbnailPath: null, scoreBreakdown: parts,
    edit: {
      aspect: '9:16', framing: 'manual', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
      start: 0, end: length, captionsEnabled: true, tightenCuts: false
    },
    ...extra
  }
}

const hooky = (): ScoreBreakdown => ({ hook: 28, emotion: 10, value: 8, structure: 8, shareability: 4 })
const valuable = (): ScoreBreakdown => ({ hook: 10, emotion: 10, value: 19, structure: 8, shareability: 4 })

/** A history where the user keeps the high-hook clips of about 30 s and ignores the rest. */
function history(kept = MIN_POSITIVES): PersonalisationStore {
  let store = emptyStore()
  const clips = [
    ...Array.from({ length: kept }, (_, i) => clip(hooky(), 28 + (i % 5))),
    ...Array.from({ length: 12 }, () => clip(valuable(), 75))
  ]
  store = recordClips(store, 'p1', clips, 1000)
  for (const c of clips.slice(0, kept)) store = recordAction(store, 'p1', c, 'exported', 2000)
  return store
}

describe('learning weights', () => {
  it('waits for enough kept clips', () => {
    expect(computeModel(history(MIN_POSITIVES - 1))).toBeNull()
    expect(computeModel(history())).not.toBeNull()
    expect(summarise(history(MIN_POSITIVES - 1)).active).toBe(false)
    expect(summarise(history()).active).toBe(true)
  })

  it('weights parts the kept clips have more of, within ±20%, renormalised', () => {
    const model = computeModel(history())!
    expect(model.weights.hook).toBeGreaterThan(1)
    expect(model.weights.value).toBeLessThan(1)
    for (const part of SCORE_PARTS) {
      expect(model.weights[part.key]).toBeGreaterThanOrEqual(1 - WEIGHT_CLAMP - 1e-9)
      expect(model.weights[part.key]).toBeLessThanOrEqual(1 + WEIGHT_CLAMP + 1e-9)
    }
    // A clip at every part's maximum keeps (about) its total.
    const capacity = SCORE_PARTS.reduce((sum, p) => sum + p.max, 0)
    const weighted = SCORE_PARTS.reduce((sum, p) => sum + model.weights[p.key] * p.max, 0)
    expect(Math.abs(weighted - capacity)).toBeLessThan(capacity * 0.05)
  })

  it('learns the lengths the user keeps', () => {
    const model = computeModel(history())!
    expect(model.lengthBand!.min).toBeGreaterThanOrEqual(28)
    expect(model.lengthBand!.max).toBeLessThanOrEqual(32)
    expect(lengthPenalty(30, model.lengthBand)).toBe(0)
    expect(lengthPenalty(75, model.lengthBand)).toBeGreaterThan(0)
    expect(lengthPenalty(75, model.lengthBand)).toBeLessThanOrEqual(4)
  })

  it('is off when disabled', () => {
    expect(computeModel({ ...history(), enabled: false })).toBeNull()
  })
})

describe('re-ranking a new run', () => {
  it('recomputes scores from the parts without changing them', () => {
    const model = computeModel(history())!
    const a = clip(hooky(), 30)
    const b = clip(valuable(), 75)
    const before = { ...a.scoreBreakdown! }
    // Tied before personalisation.
    a.viralityScore = 60
    b.viralityScore = 60
    const ranked = applyPersonalisation([b, a], model)
    expect(ranked[0].id).toBe(a.id)
    expect(a.scoreBreakdown).toEqual(before)
    expect(a.viralityScore).toBeGreaterThan(60)
    expect(b.viralityScore).toBeLessThan(60)
  })

  it('keeps adjustments made after the parts were summed, and moves scores only a little', () => {
    const model = computeModel(history())!
    const c = clip(hooky(), 30)
    c.viralityScore = scoreFromParts(hooky()) - 10 // e.g. an overrun penalty
    const score = personalisedScore(c, model)
    expect(score).toBeLessThan(scoreFromParts(hooky()))
    expect(Math.abs(score - c.viralityScore)).toBeLessThanOrEqual(12)
    expect(personalisedScore(clip(undefined, 30), model)).toBe(50)
  })
})

describe('recording', () => {
  it('records a run once and marks actions without duplicates', () => {
    const c = clip(hooky())
    let store = recordClips(emptyStore(), 'p', [c])
    store = recordClips(store, 'p', [c])
    expect(store.records).toHaveLength(1)
    store = recordAction(store, 'p', c, 'edited')
    store = recordAction(store, 'p', c, 'edited')
    store = recordAction(store, 'p', { ...c, edit: { ...c.edit, end: 20 } }, 'exported')
    expect(store.records[0].actions).toEqual(['edited', 'exported'])
    expect(store.records[0].lengthSec).toBe(20)
    expect(store.records[0].parts!.hook).toBeCloseTo(28 / 30)
  })

  it('ignores the captioned full video and records kind and origin', () => {
    const whole = clip(undefined, 600, { origin: 'whole-video' })
    expect(recordClips(emptyStore(), 'p', [whole]).records).toHaveLength(0)
    const visual = { ...clip(undefined, 20, { discovery: { origin: 'visual' } }), kind: 'explainer' } as Clip
    const record = recordClips(emptyStore(), 'p', [visual]).records[0]
    expect(record.origin).toBe('visual')
    expect(record.kind).toBe('explainer')
  })

  it('stays bounded, dropping the oldest ignored clips first', () => {
    const kept = clip(hooky())
    let store = recordAction(emptyStore(), 'p', kept, 'exported', 0)
    store = recordClips(store, 'p', Array.from({ length: MAX_RECORDS + 5 }, (_, i) => clip(valuable(), 30 + (i % 3))), 1)
    expect(store.records.length).toBe(MAX_RECORDS)
    expect(store.records.some(r => r.clipId === kept.id)).toBe(true)
  })

  it('migrates unknown versions to an empty store, keeping the toggle', () => {
    expect(migrateStore(null)).toEqual(emptyStore())
    expect(migrateStore({ version: 99, enabled: false, records: [{}] })).toEqual({ ...emptyStore(), enabled: false })
    expect(migrateStore({ version: 1, enabled: true, records: [{ bad: true }] }).records).toEqual([])
  })
})

describe('the personalisation file', () => {
  beforeAll(async () => {
    await rm(userData, { recursive: true, force: true })
  })
  afterAll(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  it('records runs and actions, survives concurrent writes, toggles and resets', async () => {
    const clips = [...Array.from({ length: 10 }, () => clip(hooky(), 30)), ...Array.from({ length: 10 }, () => clip(valuable(), 70))]
    await main.recordGeneratedClips('p', clips)
    await Promise.all(clips.slice(0, 9).map((c, i) => main.recordClipAction('p', c, i % 2 ? 'edited' : 'exported')))
    let summary = await main.getPersonalisationSummary()
    expect(summary).toMatchObject({ positives: 9, recorded: 20, active: true, enabled: true })
    const raw = JSON.parse(await readFile(join(userData, 'personalisation.json'), 'utf8'))
    expect(raw.version).toBe(1)

    const fresh = [clip(valuable(), 70), clip(hooky(), 30)]
    fresh[0].viralityScore = fresh[1].viralityScore = 60
    expect(await main.personaliseClips(fresh)).toBe(9)
    expect(fresh[0].scoreBreakdown).toEqual(hooky())

    summary = await main.setPersonalisationEnabled(false)
    expect(summary.active).toBe(false)
    expect(await main.personaliseClips([clip(hooky())])).toBeNull()
    summary = await main.resetPersonalisation()
    expect(summary).toMatchObject({ positives: 0, recorded: 0, enabled: false })
  })

  it('counts trim, cut and caption edits but not layout changes', () => {
    const c = clip(hooky())
    expect(main.isLearningEdit(c, { ...c, edit: { ...c.edit, end: 25 } })).toBe(true)
    expect(main.isLearningEdit(c, { ...c, edit: { ...c.edit, cuts: [{ start: 1, end: 2 }] } })).toBe(true)
    expect(main.isLearningEdit(c, { ...c, edit: { ...c.edit, captionStyleId: 'classic' } })).toBe(true)
    expect(main.isLearningEdit(c, { ...c, edit: { ...c.edit, focusX: 0.2, aspect: '1:1' } })).toBe(false)
  })
})
