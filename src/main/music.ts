import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clip } from '@shared/types'
import { isMusicFile, pickMusicTrack } from '@shared/audioMix'
import { allowMediaPath } from './mediaAccess'

/**
 * Background music comes only from a folder the user chose in Settings; the
 * app bundles none. Listing a folder also allows its tracks through the
 * media:// protocol, so the preview can play the same file the export mixes.
 */

export interface MusicTrack {
  name: string
  path: string
}

/** Audio files directly inside `folder`, by name. An unreadable folder lists nothing. */
export async function listMusicTracks(folder: string | null): Promise<MusicTrack[]> {
  if (!folder) return []
  let entries: Array<{ name: string; isFile: () => boolean }>
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const tracks = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && isMusicFile(entry.name))
    .map((entry) => ({ name: entry.name, path: join(folder, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const track of tracks) allowMediaPath(track.path)
  return tracks
}

/** The file a clip's music toggle plays, or null when music is off or the folder is empty. */
export async function clipMusicPath(clip: Clip, folder: string | null): Promise<string | null> {
  if (!clip.edit.music || !folder) return null
  const tracks = await listMusicTracks(folder)
  const name = pickMusicTrack(tracks.map((t) => t.name), clip.id, clip.edit.musicTrack)
  return tracks.find((t) => t.name === name)?.path ?? null
}
