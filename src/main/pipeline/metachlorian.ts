import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { withTimeout } from './openai'

/**
 * Minimal client for a Metachlorian footage library, used as a B-roll source.
 * Every request sends `X-Metachlorian: 1` (a solo-mode core on localhost
 * requires it on writes and accepts token-less requests) and, when a token is
 * set, `Authorization: Bearer`. The token needs the library:read and
 * media:export scopes. It never appears in an error message.
 */

export interface MetachlorianConnection {
  /** Base URL without a trailing slash, e.g. http://127.0.0.1:8770. */
  url: string
  token: string
}

/** Rights intent sent with searches and exports; empty fields are left out. */
export interface MetachlorianIntendedUse {
  use: string
  channel: string
  territory: string
}

export interface MetachlorianShot {
  uid: string
  filename: string
  start: number
  end: number
  duration: number
  caption: string | null
}

export interface MetachlorianSearch {
  results: MetachlorianShot[]
  /** Shots the intended use ruled out on rights grounds. */
  excludedByRights: number
}

const HEALTH_TIMEOUT_MS = 10_000
const SEARCH_TIMEOUT_MS = 30_000
/** An export may render a proxy trim on the core first. */
const EXPORT_TIMEOUT_MS = 180_000
const DOWNLOAD_TIMEOUT_MS = 120_000

export class MetachlorianError extends Error {}

export function normaliseMetachlorianUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function headers(conn: MetachlorianConnection, json: boolean): Record<string, string> {
  return {
    'X-Metachlorian': '1',
    ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {})
  }
}

function intendedUseBody(use: MetachlorianIntendedUse | null | undefined): Record<string, string> | undefined {
  if (!use) return undefined
  const body = Object.fromEntries(Object.entries(use).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
  return Object.keys(body).length ? body : undefined
}

async function request(conn: MetachlorianConnection, path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<Response> {
  if (!conn.url) throw new MetachlorianError('Set the Metachlorian address in Settings → B-roll first.')
  let res: Response
  try {
    res = await fetch(`${conn.url}${path}`, {
      method: init.method,
      headers: headers(conn, init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: withTimeout(init.timeoutMs, init.signal)
    })
  } catch (err) {
    if (init.signal?.aborted) throw err
    throw new MetachlorianError(`Could not reach Metachlorian at ${conn.url} (${err instanceof Error ? err.message : String(err)}).`, { cause: err })
  }
  if (res.status === 401 || res.status === 403) {
    throw new MetachlorianError(conn.token
      ? 'Metachlorian rejected the access token. Create one with the library:read and media:export scopes in Metachlorian Settings → Agents.'
      : 'Metachlorian needs an access token. Create one with the library:read and media:export scopes in Metachlorian Settings → Agents.')
  }
  if (!res.ok) {
    const detail = await res.json().then((body: unknown) => {
      const text = (body as { detail?: unknown } | null)?.detail
      return typeof text === 'string' ? `: ${text}` : ''
    }).catch(() => '')
    throw new MetachlorianError(`Metachlorian ${path.split('?')[0]} failed (HTTP ${res.status})${detail}.`)
  }
  return res
}

/** "Check connection": the server is Metachlorian, and the token may search. */
export async function checkMetachlorian(conn: MetachlorianConnection): Promise<{ message: string }> {
  const health = await (await request(conn, '/api/health', { method: 'GET', timeoutMs: HEALTH_TIMEOUT_MS })).json()
    .catch(() => null) as { name?: unknown; version?: unknown } | null
  if (health?.name !== 'metachlorian') throw new MetachlorianError(`${conn.url} answered, but it is not a Metachlorian server.`)
  // Health is public; a one-result search proves the token can read the library.
  await request(conn, '/api/search', { method: 'POST', body: { q: 'test', limit: 1 }, timeoutMs: SEARCH_TIMEOUT_MS })
  const version = typeof health.version === 'string' ? ` ${health.version}` : ''
  return { message: `Connected to Metachlorian${version} at ${conn.url}. Search works.` }
}

export async function searchShots(
  conn: MetachlorianConnection,
  query: string,
  opts: { limit: number; minDuration: number; requireBroll: boolean; intendedUse?: MetachlorianIntendedUse | null },
  signal?: AbortSignal
): Promise<MetachlorianSearch> {
  const intended = intendedUseBody(opts.intendedUse)
  const body = {
    q: query,
    limit: opts.limit,
    ...(opts.requireBroll ? { require: { shot_role: ['b_roll'] } } : {}),
    filters: { min_duration: opts.minDuration },
    ...(intended ? { intended_use: intended } : {})
  }
  const data = await (await request(conn, '/api/search', { method: 'POST', body, timeoutMs: SEARCH_TIMEOUT_MS, signal })).json() as {
    results?: Array<Partial<MetachlorianShot>>
    excluded_by_rights?: unknown
  }
  const results = (data.results ?? []).filter((r): r is MetachlorianShot =>
    typeof r.uid === 'string' && typeof r.start === 'number' && typeof r.end === 'number' && r.end > r.start)
    .map(r => ({ uid: r.uid, filename: r.filename ?? '', start: r.start, end: r.end, duration: r.end - r.start, caption: r.caption ?? null }))
  return { results, excludedByRights: typeof data.excluded_by_rights === 'number' ? data.excluded_by_rights : 0 }
}

/**
 * Have the core render a proxy trim of one shot, then download it to
 * `destPath`. Works for local and remote cores alike: the file always comes
 * over HTTP, never from the core's own disk path.
 */
export async function exportShot(
  conn: MetachlorianConnection,
  shot: { uid: string; in: number; out: number },
  destPath: string,
  intendedUse?: MetachlorianIntendedUse | null,
  signal?: AbortSignal
): Promise<void> {
  const intended = intendedUseBody(intendedUse)
  const exported = await (await request(conn, '/api/export/clip', {
    method: 'POST',
    body: { shot_uid: shot.uid, in: shot.in, out: shot.out, mode: 'proxy', ...(intended ? { intended_use: intended } : {}) },
    timeoutMs: EXPORT_TIMEOUT_MS,
    signal
  })).json() as { download?: unknown }
  if (typeof exported.download !== 'string' || !exported.download.startsWith('/')) {
    throw new MetachlorianError('Metachlorian exported the clip but did not say where to download it.')
  }
  const res = await request(conn, exported.download, { method: 'GET', timeoutMs: DOWNLOAD_TIMEOUT_MS, signal })
  if (!res.body) throw new MetachlorianError('Metachlorian sent an empty download.')
  await mkdir(dirname(destPath), { recursive: true })
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(destPath))
  } catch (err) {
    await rm(destPath, { force: true }).catch(() => undefined)
    throw err
  }
}
