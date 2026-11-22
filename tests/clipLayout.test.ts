import { beforeEach, expect, it, vi } from 'vitest'
import type { Clip } from '@shared/types'
import { needsReframe } from '@shared/reframe'
const mocks = vi.hoisted(() => ({ faces: vi.fn(), apply: vi.fn(), compose: vi.fn(), assess: vi.fn(), cuts: vi.fn(), gaps: vi.fn() }))
vi.mock('../src/main/pipeline/faces', () => ({ analyzeClipFocus: mocks.faces, applyFocusAnalysis: mocks.apply }))
vi.mock('../src/main/pipeline/composition', () => ({ refineComposition: mocks.compose }))
vi.mock('../src/main/pipeline/screenCuts', () => ({ screenTransitions: mocks.cuts }))
vi.mock('../src/main/pipeline/visualScore', () => ({ assessClipVisuals: mocks.assess }))
vi.mock('../src/main/pipeline/gapActivity', () => ({ refreshGapActivity: mocks.gaps }))
import { analyzeClipLayout } from '../src/main/pipeline/clipLayout'

const clip = (kind?: 'screen' | 'camera' | 'mixed'): Clip => ({ id: 'clip',
  suggestedStart: 0, suggestedEnd: 30, edit: { start: 5, end: 25, aspect: '9:16' },
  visualLayout: { start: 0, end: 30, kind, preserveContext: true, allowZoom: false, reason: 'Context' }
}) as Clip
beforeEach(() => {
  vi.clearAllMocks()
  mocks.cuts.mockResolvedValue([])
  mocks.faces.mockResolvedValue({ focusTrack: [{ t: 5, x: .5 }], contentType: 'speaker' })
})
it('splits changed screen geometry before spending a whole-clip review', async () => {
  const c = clip('screen')
  c.visualLayout!.panels = { content: { x: .2, y: .3, width: .6, height: .6 },
    presenter: { x: .82, y: .02, width: .16, height: .26 } }
  mocks.cuts.mockResolvedValue([{ start: 12, end: 13 }])
  await analyzeClipLayout('video.mp4', c, 'auto', 'key', 'model')
  expect(mocks.cuts).toHaveBeenCalledOnce()
  expect(mocks.compose).toHaveBeenCalledOnce()
  expect(mocks.compose.mock.calls[0][3].visualLayout.panels).toBeUndefined()
  expect(mocks.compose.mock.calls[0][7]).toEqual([{ start: 12, end: 13 }])
})
it('skips dense speaker inference for screen evidence and still verifies composition', async () => {
  const c = clip('screen')
  await analyzeClipLayout('video.mp4', c, 'auto', 'key', 'model')
  expect(mocks.faces).not.toHaveBeenCalled()
  expect(mocks.compose).toHaveBeenCalledOnce()
  expect(c.reframeStatus).toBe('done')
  expect(needsReframe(c)).toBe(false)
})
it.each(['camera', 'mixed'] as const)('retains speaker tracking for %s footage', async kind => {
  await analyzeClipLayout('video.mp4', clip(kind), 'auto', 'key', 'model')
  expect(mocks.faces.mock.calls[0].slice(1, 3)).toEqual([5, 25])
})
it('respects an explicit talking-head choice even when the visual pass says screen', async () => {
  await analyzeClipLayout('video.mp4', clip('screen'), 'talking-head', 'key', 'model')
  expect(mocks.faces).toHaveBeenCalledOnce()
  expect(mocks.compose).not.toHaveBeenCalled()
})
it('refreshes old screen evidence once, including after a trim extension', async () => {
  const c = clip(), transcript = { language: 'en', durationSec: 50, segments: [] }
  mocks.assess.mockResolvedValue({ visualLayout: clip('screen').visualLayout })
  await analyzeClipLayout('video.mp4', c, 'auto', 'key', 'model', transcript)
  expect(mocks.assess).toHaveBeenCalledOnce()
  expect(mocks.faces).not.toHaveBeenCalled()
  await analyzeClipLayout('video.mp4', c, 'auto', 'key', 'model', transcript)
  expect(mocks.assess).toHaveBeenCalledOnce()
  c.edit.end = 40
  await analyzeClipLayout('video.mp4', c, 'auto', 'key', 'model', transcript)
  expect(mocks.assess).toHaveBeenCalledTimes(2)
})
it('never marks a cancelled composition done', async () => {
  const c = clip('screen'), controller = new AbortController()
  mocks.compose.mockImplementationOnce(async () => controller.abort())
  await expect(analyzeClipLayout('video.mp4', c, 'auto', 'key', 'model', undefined, controller.signal)).rejects.toThrow()
  expect(c.reframeStatus).toBeUndefined()
})
it('migrates old automatic letterboxes once while retaining manual corrections', () => {
  const c = clip()
  Object.assign(c.edit, { reframeMode: 'fit-letterbox', framing: 'manual', focusX: .5, autoZoom: false })
  c.reframeStatus = 'done'
  c.reframeAnalysis = { start: 0, end: 30, version: 1 }
  expect(needsReframe(c)).toBe(true)
  c.visualLayout!.revision = 1
  expect(needsReframe(c)).toBe(false)
  c.visualLayout!.revision = 0
  c.reframeAnalysis.version = 2
  expect(needsReframe(c)).toBe(false)
})
it('measures pause activity on every route, with or without a key, before composition', async () => {
  const transcript = { language: 'en', durationSec: 50, segments: [] }
  const order: string[] = []
  mocks.gaps.mockImplementation(async () => { order.push('gaps') })
  mocks.compose.mockImplementation(async () => { order.push('compose') })
  // Screen route: face analysis skipped.
  const screen = clip('screen')
  await analyzeClipLayout('video.mp4', screen, 'auto', 'key', 'model', transcript)
  expect(mocks.faces).not.toHaveBeenCalled()
  expect(mocks.gaps).toHaveBeenLastCalledWith('video.mp4', screen, transcript, undefined)
  expect(order).toEqual(['gaps', 'compose'])
  // Camera route without an API key, and a talking head.
  await analyzeClipLayout('video.mp4', clip('camera'), 'auto', '', 'model', transcript)
  await analyzeClipLayout('video.mp4', clip('camera'), 'talking-head', '', 'model', transcript)
  expect(mocks.gaps).toHaveBeenCalledTimes(3)
})
