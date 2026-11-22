import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The shared speaker model download: it belongs to no caller, so cancelling
 * one job abandons only that job's wait, and a failed download is not
 * fetched again on every run of the session.
 */

const mocks = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => mocks.root, getAppPath: () => mocks.root } }))

import { speakerModelPath } from '../src/main/pipeline/speakerModel'

beforeAll(async () => { mocks.root = await mkdtemp(join(tmpdir(), 'cutawan-speaker-shared-')) })
afterAll(async () => {
  vi.unstubAllGlobals()
  await rm(mocks.root, { recursive: true, force: true })
})

describe('shared speaker model download', () => {
  it('outlives a cancelled caller, serves the others, and is not retried after failing', async () => {
    let respond: (res: Response) => void = () => {}
    const fetches: Array<AbortSignal | undefined> = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      fetches.push(init?.signal ?? undefined)
      return new Promise<Response>((resolve) => { respond = resolve })
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const cancelled = new AbortController()
    const first = speakerModelPath(cancelled.signal)
    const second = speakerModelPath()
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    cancelled.abort(new Error('job cancelled'))
    await expect(first).rejects.toThrow('job cancelled')
    expect(fetches[0]?.aborted).toBe(false)

    // The bytes do not match the pinned checksum.
    respond(new Response('not the model'))
    expect(await second).toBeNull()
    expect(await speakerModelPath()).toBeNull()
    expect(fetches).toHaveLength(1)
    warn.mockRestore()
  })
})
