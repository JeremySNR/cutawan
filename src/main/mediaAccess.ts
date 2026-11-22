import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { app } from 'electron'

/**
 * The media:// protocol: an allowlist of files the renderer may read, plus a
 * range-aware file server. Range support matters — Chromium's media pipeline
 * demands 206 responses with Content-Range when seeking <video>, and rejects
 * chunked 200s (PIPELINE_ERROR_READ), so exposing files via net.fetch(file://)
 * is not enough.
 */

const allowedFiles = new Set<string>()

export function allowMediaPath(path: string): void {
  allowedFiles.add(resolve(path))
}

/**
 * userData subdirectories the renderer has a legitimate reason to read:
 * project media (thumbnails, B-roll images, downloaded source videos),
 * custom caption fonts, the branding logo and cached timeline strips.
 * Deliberately NOT the whole of userData — settings.json (the encrypted API
 * key) and cookies/import-cookies.txt (live session cookies) live there too
 * and must never be reachable over media://.
 */
const USER_DATA_MEDIA_DIRS = ['projects', 'fonts', 'branding', 'timeline-cache'] as const

/** Pure core of the allowlist check. Exported for tests. */
export function isMediaPathAllowedIn(
  userData: string,
  allowed: ReadonlySet<string>,
  path: string
): boolean {
  const full = resolve(path)
  if (allowed.has(full)) return true
  return USER_DATA_MEDIA_DIRS.some((dir) => full.startsWith(join(userData, dir) + sep))
}

/**
 * The renderer may only read files the app has a reason to show it: the
 * media subdirectories of userData above, plus user-selected source videos
 * elsewhere on disk, registered explicitly when a project is created or
 * loaded.
 */
export function isMediaPathAllowed(path: string): boolean {
  return isMediaPathAllowedIn(resolve(app.getPath('userData')), allowedFiles, path)
}

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function streamBody(path: string, start?: number, end?: number): WebReadableStream {
  const nodeStream = createReadStream(path, start === undefined ? {} : { start, end })
  return Readable.toWeb(nodeStream)
}

/** Serve an allowed file with HTTP semantics (200 or 206 for Range requests). */
export async function serveMediaFile(path: string, rangeHeader: string | null): Promise<Response> {
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return new Response('Not found', { status: 404 })
    size = info.size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  const baseHeaders = {
    'Content-Type': contentType(path),
    'Accept-Ranges': 'bytes'
  }

  const range = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && (range[1] !== '' || range[2] !== '')) {
    // "bytes=start-", "bytes=start-end" or "bytes=-suffixLength".
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }
    return new Response(streamBody(path, start, end), {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1)
      }
    })
  }

  return new Response(streamBody(path), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) }
  })
}
