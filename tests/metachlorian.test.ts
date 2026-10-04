import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Clip } from '@shared/types'
import { makeTranscript } from './helpers'

const mock = vi.hoisted(() => ({ root: '', chat: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root } }))
vi.mock('../src/main/pipeline/openai', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/pipeline/openai')>()),
  chatJSON: mock.chat
}))
import { checkMetachlorian, searchShots } from '../src/main/pipeline/metachlorian'
import { metachlorianBrollProvider, webBrollProvider, type BrollRequest } from '../src/main/pipeline/brollProviders'
import { attachBroll } from '../src/main/pipeline/broll'

/**
 * Metachlorian as a B-roll source, against a scripted server (fetch is
 * mocked). The request shapes are the real core's: POST /api/search,
 * POST /api/export/clip, GET the returned download path.
 */

const URL = 'http://media.test:8770'
const conn = { url: URL, token: 'tok_secret_123' }
const use = { use: 'marketing', channel: 'organic_social', territory: 'GB' }

interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = []

/** Route requests by method and path; each handler returns a Response. */
function serve(routes: Record<string, (body: unknown, n: number) => Response>): void {
  const counts: Record<string, number> = {}
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new globalThis.URL(input)
    const method = init.method ?? 'GET'
    const key = `${method} ${url.pathname}`
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname + url.search, headers: init.headers as Record<string, string>, body })
    counts[key] = (counts[key] ?? 0) + 1
    const handler = routes[key]
    return handler ? handler(body, counts[key]) : new Response('{"detail":"Not Found"}', { status: 404 })
  }))
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status })
const shot = (uid: string, start: number, end: number): Record<string, unknown> =>
  ({ uid, filename: `${uid}.mp4`, start, end, duration: end - start, caption: null, thumb: '/media/x.jpg' })

beforeAll(async () => { mock.root = await mkdtemp(join(tmpdir(), 'cutawan-metachlorian-')) })
afterAll(async () => { await rm(mock.root, { recursive: true, force: true }) })
afterEach(() => { calls = []; vi.unstubAllGlobals(); mock.chat.mockReset() })

describe('checkMetachlorian', () => {
  it('checks the server identity and that the token can search', async () => {
    serve({
      'GET /api/health': () => json({ name: 'metachlorian', version: '0.1.0' }),
      'POST /api/search': () => json({ results: [], total: 0 })
    })
    await expect(checkMetachlorian(conn)).resolves.toEqual({ message: `Connected to Metachlorian 0.1.0 at ${URL}. Search works.` })
    for (const call of calls) {
      expect(call.headers['X-Metachlorian']).toBe('1')
      expect(call.headers.Authorization).toBe('Bearer tok_secret_123')
    }
  })

  it('sends no Authorization header without a token, but still the X-Metachlorian header', async () => {
    serve({ 'GET /api/health': () => json({ name: 'metachlorian' }), 'POST /api/search': () => json({ results: [] }) })
    await checkMetachlorian({ url: URL, token: '' })
    expect(calls[1].headers).toEqual({ 'X-Metachlorian': '1', 'Content-Type': 'application/json' })
  })

  it('refuses a server that is not Metachlorian', async () => {
    serve({ 'GET /api/health': () => json({ status: 'ok' }) })
    await expect(checkMetachlorian(conn)).rejects.toThrow('is not a Metachlorian server')
  })

  it('explains a rejected token without repeating it', async () => {
    serve({ 'GET /api/health': () => json({ name: 'metachlorian' }), 'POST /api/search': () => json({ detail: 'bad token' }, 401) })
    const error = await checkMetachlorian(conn).catch((e: Error) => e)
    expect(error.message).toMatch(/rejected the access token.*library:read and media:export/)
    expect(error.message).not.toContain('tok_secret_123')
  })

  it('asks for an address before calling anything', async () => {
    serve({})
    await expect(checkMetachlorian({ url: '', token: '' })).rejects.toThrow('Set the Metachlorian address')
    expect(calls).toEqual([])
  })
})

describe('searchShots', () => {
  it('sends the query, B-roll role, minimum length and intended use', async () => {
    serve({ 'POST /api/search': () => json({ results: [shot('s1', 4, 9)], excluded_by_rights: 2 }) })
    const found = await searchShots(conn, 'hands typing close-up', { limit: 3, minDuration: 2, requireBroll: true, intendedUse: use })
    expect(calls[0].body).toEqual({
      q: 'hands typing close-up', limit: 3, require: { shot_role: ['b_roll'] },
      filters: { min_duration: 2 }, intended_use: use
    })
    expect(found).toEqual({ results: [{ uid: 's1', filename: 's1.mp4', start: 4, end: 9, duration: 5, caption: null }], excludedByRights: 2 })
  })

  it('leaves out an empty intended use', async () => {
    serve({ 'POST /api/search': () => json({ results: [] }) })
    await searchShots(conn, 'q', { limit: 3, minDuration: 2, requireBroll: false, intendedUse: { use: '', channel: ' ', territory: '' } })
    expect(calls[0].body).toEqual({ q: 'q', limit: 3, filters: { min_duration: 2 } })
  })
})

describe('metachlorianBrollProvider', () => {
  const clipFile = 'clips/office_00000400-00000700_proxy.mp4'
  const exportRoutes = {
    'POST /api/export/clip': () => json({ mode: 'proxy', file: `/srv/exports/${clipFile}`, download: `/api/exports/file?path=${clipFile}` }),
    'GET /api/exports/file': () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200 })
  }

  it('falls back from tagged B-roll to any shot, exports the best fit and downloads it', async () => {
    serve({
      'POST /api/search': (_body, n) => json({ results: n === 1 ? [] : [shot('short', 1, 2.5), shot('long', 4, 10)] }),
      ...exportRoutes
    })
    const provider = metachlorianBrollProvider(conn, use)
    expect(provider.queryStyle).toBe('footage')
    const found = await provider.find({ trigger: 'office', query: 'busy open-plan office', durationSec: 3 }, mock.root, 'clip-1')
    expect((calls[0].body as { require?: unknown }).require).toEqual({ shot_role: ['b_roll'] })
    expect((calls[1].body as { require?: unknown }).require).toBeUndefined()
    // The first shot long enough for the slot, trimmed to the slot.
    expect(calls[2].body).toEqual({ shot_uid: 'long', in: 4, out: 7, mode: 'proxy', intended_use: use })
    expect(calls[3]).toMatchObject({ method: 'GET', path: `/api/exports/file?path=${encodeURIComponent(clipFile).replace(/%2F/g, '/')}` })
    expect(calls[3].headers.Authorization).toBe('Bearer tok_secret_123')
    expect(found).toEqual({
      path: join(mock.root, 'clip-1.mp4'), kind: 'video', mediaIn: 0, maxDurationSec: 3,
      sourceUrl: `${URL}/api/shots/long`
    })
    expect((await readFile(found!.path)).length).toBe(8)
  })

  it('uses the longest shot when none fills the slot', async () => {
    serve({ 'POST /api/search': () => json({ results: [shot('a', 0, 2.2), shot('b', 5, 7.5)] }), ...exportRoutes })
    const found = await metachlorianBrollProvider(conn, null).find({ trigger: 't', query: 'q', durationSec: 4 }, mock.root, 'clip-2')
    expect(calls[1].body).toEqual({ shot_uid: 'b', in: 5, out: 7.5, mode: 'proxy' })
    expect(found?.maxDurationSec).toBe(2.5)
  })

  it('finds nothing when the library has nothing', async () => {
    serve({ 'POST /api/search': () => json({ results: [], excluded_by_rights: 5 }) })
    await expect(metachlorianBrollProvider(conn, use).find({ trigger: 't', query: 'q', durationSec: 3 }, mock.root, 'c')).resolves.toBeNull()
    expect(calls.filter(c => c.path === '/api/export/clip')).toEqual([])
  })

  it('leaves no partial file when the download fails', async () => {
    serve({
      'POST /api/search': () => json({ results: [shot('s', 0, 5)] }),
      'POST /api/export/clip': exportRoutes['POST /api/export/clip'],
      'GET /api/exports/file': () => json({ detail: 'gone' }, 404)
    })
    await expect(metachlorianBrollProvider(conn, null).find({ trigger: 't', query: 'q', durationSec: 3 }, mock.root, 'clip-3'))
      .rejects.toThrow(/HTTP 404/)
    expect(existsSync(join(mock.root, 'clip-3.mp4'))).toBe(false)
  })
})

describe('attachBroll with a footage provider', () => {
  const transcript = makeTranscript(['we spent every night typing in the office until the launch'])
  const clip = (): Clip => ({
    id: 'c1', suggestedStart: 0, suggestedEnd: transcript.durationSec, title: '', hook: '', summary: '',
    viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
    edit: { aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5, captionsEnabled: true,
      captionStyleId: 'beast', showTitle: false, start: 0, end: transcript.durationSec }
  })

  it('asks for footage-style queries and attaches video inserts trimmed to the shot', async () => {
    mock.chat.mockResolvedValue({ items: [{ trigger: 'typing', query: 'hands typing on a laptop at night close-up', start: 1.6, duration: 3, mode: 'fullscreen' }] })
    const find = vi.fn(async (_request: BrollRequest, _dir: string, _base: string) => ({ path: '/p/broll/c1-x.mp4', kind: 'video' as const, mediaIn: 0, maxDurationSec: 2, sourceUrl: `${URL}/api/shots/s` }))
    const target = clip()
    await attachBroll('key', 'model', transcript, 'project', target, undefined, { queryStyle: 'footage', find })
    expect(mock.chat.mock.calls[0][2][0].content).toMatch(/stock-footage library/)
    expect(find.mock.calls[0][0]).toMatchObject({ trigger: 'typing', query: 'hands typing on a laptop at night close-up' })
    expect(find.mock.calls[0][0].durationSec).toBeCloseTo(3)
    expect(target.broll).toHaveLength(1)
    expect(target.broll[0]).toMatchObject({ kind: 'video', mediaIn: 0, start: 1.6, imagePath: '/p/broll/c1-x.mp4' })
    expect(target.broll[0].end).toBeCloseTo(3.6)
  })

  it('keeps the image prompt and image items for the web provider', async () => {
    mock.chat.mockResolvedValue({ items: [] })
    await attachBroll('key', 'model', transcript, 'project', clip(), undefined, webBrollProvider)
    expect(mock.chat.mock.calls[0][2][0].content).toMatch(/Wikipedia/)
  })
})
