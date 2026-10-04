import { join } from 'node:path'
import type { BrollKind } from '@shared/types'
import { downloadImage, searchImage } from './imagesearch'
import {
  exportShot,
  searchShots,
  type MetachlorianConnection,
  type MetachlorianIntendedUse
} from './metachlorian'

/**
 * Where B-roll inserts come from. The web provider (the default) finds and
 * downloads still images; the Metachlorian provider finds footage in the
 * user's own library and downloads a proxy trim of the best shot.
 */

export interface BrollRequest {
  /** Spoken word the insert illustrates. */
  trigger: string
  /** Search query the LLM wrote for it. */
  query: string
  /** How long the insert should run, in seconds. */
  durationSec: number
}

export interface BrollFound {
  path: string
  kind: BrollKind
  /** Seconds into the file where the insert starts (video only). */
  mediaIn?: number
  /** How long the found media can run; an insert is shortened to fit. */
  maxDurationSec?: number
  sourceUrl: string
}

export interface BrollProvider {
  /** What the LLM is asked for: named things to picture, or footage to cut away to. */
  queryStyle: 'image' | 'footage'
  find(request: BrollRequest, destDir: string, fileBase: string, signal?: AbortSignal): Promise<BrollFound | null>
}

export const webBrollProvider: BrollProvider = {
  queryStyle: 'image',
  async find(request, destDir, fileBase, signal) {
    const found = await searchImage(request.query, request.trigger, signal)
    if (!found) return null
    const path = await downloadImage(found.imageUrl, destDir, fileBase, signal)
    return path ? { path, kind: 'image', sourceUrl: found.sourceUrl } : null
  }
}

/** Shots shorter than this are not worth cutting to. */
const MIN_SHOT_SEC = 2
const RESULTS = 3

export function metachlorianBrollProvider(
  conn: MetachlorianConnection,
  intendedUse: MetachlorianIntendedUse | null
): BrollProvider {
  return {
    queryStyle: 'footage',
    async find(request, destDir, fileBase, signal) {
      const search = (requireBroll: boolean): ReturnType<typeof searchShots> => searchShots(conn, request.query, {
        limit: RESULTS, minDuration: MIN_SHOT_SEC, requireBroll, intendedUse
      }, signal)
      // Shots tagged as B-roll first; many libraries are not tagged yet, so
      // fall back to any shot. Never retry around a rights exclusion: those
      // shots were ruled out for this use on purpose.
      let found = await search(true)
      if (found.results.length === 0) found = await search(false)
      if (found.results.length === 0) return null
      // The best-ranked shot that is long enough, else the longest one.
      const shot = found.results.find(r => r.duration >= request.durationSec) ??
        [...found.results].sort((a, b) => b.duration - a.duration)[0]
      const length = Math.min(shot.duration, request.durationSec)
      const path = join(destDir, `${fileBase}.mp4`)
      await exportShot(conn, { uid: shot.uid, in: shot.start, out: shot.start + length }, path, intendedUse, signal)
      return { path, kind: 'video', mediaIn: 0, maxDurationSec: length, sourceUrl: `${conn.url}/api/shots/${encodeURIComponent(shot.uid)}` }
    }
  }
}
