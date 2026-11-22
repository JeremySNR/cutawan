import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnalyzeOptions, BatchQueueState, Project } from '@shared/types'
import { BatchQueue, restoreItems, type BatchDeps } from '../src/main/batchQueue'

const OPTIONS: AnalyzeOptions = { prompt: 'funny bits', clipLength: 'short', broll: false, hookFirst: true, videoType: 'podcast' }

function project(id: string, name = id): Project {
  return {
    id, createdAt: 0, updatedAt: 0, name, transcript: null, prompt: '', videoType: 'auto',
    video: { path: `/v/${id}.mp4`, fileName: `${id}.mp4`, durationSec: 60, width: 1920, height: 1080, fps: 30, sizeBytes: 1, hasAudio: true },
    clips: []
  }
}

interface Harness {
  queue: BatchQueue
  calls: string[]
  states: BatchQueueState[]
  /** Analyses wait on these, by project id, so tests control timing. */
  gates: Map<string, { resolve: () => void; reject: (e: Error) => void }>
  file: string
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-batch-'))
})
afterEach(async () => {
  // A queue's last save can still be writing when a test ends; retry the delete.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function harness(overrides: Partial<BatchDeps> = {}): Harness {
  const calls: string[] = []
  const states: BatchQueueState[] = []
  const gates = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
  const file = join(dir, 'batch-queue.json')
  const queue = new BatchQueue({
    filePath: file,
    importFile: async (path) => {
      calls.push(`import:${path}`)
      return project(path.replace(/\W/g, ''))
    },
    importUrl: async (url, onProgress) => {
      calls.push(`url:${url}`)
      onProgress({ progress: 0.2, message: 'Downloading video…', licence: { url, license: null, reusable: false } })
      return { ...project('u1', 'Downloaded'), importLicence: { url, license: null, reusable: false } }
    },
    analyze: (projectId, options, onProgress, signal) => {
      calls.push(`analyze:${projectId}:${options.prompt}`)
      onProgress({ stage: 'analyze', progress: 0.5, message: 'Finding spoken moments…' })
      return new Promise<Project>((resolve, reject) => {
        const done = (): void => resolve({ ...project(projectId), clips: [] })
        gates.set(projectId, { resolve: done, reject })
        signal.addEventListener('abort', () => reject(new Error('Analysis cancelled')), { once: true })
      })
    },
    emit: (state) => states.push(state),
    ...overrides
  })
  return { queue, calls, states, gates, file }
}

/**
 * Wait for a state the queue reaches asynchronously. The deadline is in
 * time, not polls, and generous: in a full test run the real-export suites
 * load every core, and a one-second budget was not always enough for the
 * queue's next step to be scheduled. A state that never arrives still fails.
 */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('batch queue', { timeout: 30_000 }, () => {
  it('runs items one at a time, in order, with each item\'s settings snapshot', async () => {
    const h = harness()
    await h.queue.add([{ kind: 'file', path: '/a.mp4' }, { kind: 'url', url: 'https://example.com/v' }], OPTIONS)
    await h.queue.add([{ kind: 'file', path: '/b.mp4' }], { ...OPTIONS, prompt: 'later' })
    await h.queue.start()
    await until(() => h.gates.has('amp4'))
    // Only the first item is in flight.
    expect(h.calls).toEqual(['import:/a.mp4', 'analyze:amp4:funny bits'])
    expect(h.queue.state().items.map((i) => i.status)).toEqual(['analysing', 'queued', 'queued'])
    h.gates.get('amp4')!.resolve()
    await until(() => h.gates.has('u1'))
    const second = h.queue.state().items[1]
    expect(second.label).toBe('Downloaded')
    expect(second.licence?.reusable).toBe(false)
    h.gates.get('u1')!.resolve()
    await until(() => h.gates.has('bmp4'))
    expect(h.calls.at(-1)).toBe('analyze:bmp4:later')
    h.gates.get('bmp4')!.resolve()
    await until(() => !h.queue.state().running)
    expect(h.queue.state().items.every((i) => i.status === 'done')).toBe(true)
  })

  it('records failures and retries without importing again', async () => {
    const h = harness()
    await h.queue.add([{ kind: 'file', path: '/a.mp4' }], OPTIONS)
    await h.queue.start()
    await until(() => h.gates.has('amp4'))
    h.gates.get('amp4')!.reject(new Error('No API key configured.'))
    // The failure is saved before the queue sees nothing is left and stops,
    // so wait for the settled state rather than the first sign of failure.
    await until(() => h.queue.state().items[0].status === 'failed' && !h.queue.state().running)
    expect(h.queue.state().items[0].error).toBe('No API key configured.')
    h.gates.clear()
    await h.queue.retry(h.queue.state().items[0].id)
    await h.queue.start()
    await until(() => h.gates.has('amp4'))
    expect(h.calls.filter((c) => c.startsWith('import:'))).toHaveLength(1)
    h.gates.get('amp4')!.resolve()
    await until(() => h.queue.state().items[0].status === 'done')
  })

  it('cancels the running item and moves on; cancels and removes queued ones', async () => {
    const h = harness()
    await h.queue.add([{ kind: 'file', path: '/a.mp4' }, { kind: 'file', path: '/b.mp4' }, { kind: 'file', path: '/c.mp4' }], OPTIONS)
    const [a, b, c] = h.queue.state().items
    await h.queue.cancel(c.id)
    await h.queue.start()
    await until(() => h.gates.has('amp4'))
    await h.queue.cancel(a.id)
    await until(() => h.gates.has('bmp4'))
    expect(h.queue.state().items.find((i) => i.id === a.id)!.status).toBe('cancelled')
    await h.queue.remove(b.id)
    await until(() => !h.queue.state().running)
    expect(h.queue.state().items.map((i) => i.status)).toEqual(['cancelled', 'cancelled'])
    await h.queue.clearFinished()
    expect(h.queue.state().items).toEqual([])
  })

  it('pauses after the current item', async () => {
    const h = harness()
    await h.queue.add([{ kind: 'file', path: '/a.mp4' }, { kind: 'file', path: '/b.mp4' }], OPTIONS)
    await h.queue.start()
    await until(() => h.gates.has('amp4'))
    await h.queue.pause()
    h.gates.get('amp4')!.resolve()
    await until(() => h.queue.state().items[0].status === 'done')
    await h.queue.idle()
    expect(h.queue.state().items[1].status).toBe('queued')
    expect(h.gates.has('bmp4')).toBe(false)
  })

  it('survives a restart: saved after each change, in-flight items requeued, paused', async () => {
    const h = harness()
    await h.queue.add([{ kind: 'file', path: '/a.mp4' }, { kind: 'file', path: '/b.mp4' }], OPTIONS)
    await h.queue.start()
    await until(() => h.gates.has('amp4'))
    let saved = { version: 0, items: [{ status: '', projectId: '' }] }
    for (let i = 0; i < 100 && saved.items[0]?.status !== 'analysing'; i++) {
      await new Promise((r) => setTimeout(r, 10))
      saved = JSON.parse(await readFile(h.file, 'utf8'))
    }
    expect(saved.version).toBe(1)
    expect(saved.items[0].status).toBe('analysing')
    expect(saved.items[0].projectId).toBe('amp4')

    const after = harness()
    await after.queue.load()
    const restored = after.queue.state()
    expect(restored.running).toBe(false)
    expect(restored.items.map((i) => i.status)).toEqual(['queued', 'queued'])
    expect(restored.items[0].options).toEqual(OPTIONS)
    await after.queue.start()
    await until(() => after.gates.has('amp4'))
    // The import had finished before the restart; only the analysis reruns.
    expect(after.calls).toEqual(['analyze:amp4:funny bits'])
    after.gates.get('amp4')!.resolve()
    h.gates.get('amp4')?.resolve()
    await until(() => after.gates.has('bmp4'))
    after.gates.get('bmp4')!.resolve()
    await until(() => !after.queue.state().running)
  })

  it('ignores a corrupt or foreign save', async () => {
    await writeFile(join(dir, 'batch-queue.json'), '{not json', 'utf8')
    const h = harness()
    await h.queue.load()
    expect(h.queue.state().items).toEqual([])
    expect(restoreItems({ version: 2, items: [{}] })).toEqual([])
  })
})
