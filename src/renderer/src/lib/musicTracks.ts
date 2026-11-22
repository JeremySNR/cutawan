import { useEffect, useState } from 'react'
import { useStore } from '../store'

export interface MusicTrackEntry {
  name: string
  path: string
}

/**
 * Audio files in the music folder chosen in Settings, refreshed whenever the
 * folder changes. Listing also allows the files through media:// so the
 * preview can play them.
 */
export function useMusicTracks(): MusicTrackEntry[] {
  const folder = useStore((s) => s.settings?.musicFolder ?? null)
  const [listed, setListed] = useState<{ folder: string; tracks: MusicTrackEntry[] } | null>(null)
  useEffect(() => {
    if (!folder) return
    let alive = true
    window.cutawan.listMusicTracks()
      .then((tracks) => { if (alive) setListed({ folder, tracks }) })
      .catch(() => { if (alive) setListed({ folder, tracks: [] }) })
    return () => { alive = false }
  }, [folder])
  return folder && listed?.folder === folder ? listed.tracks : []
}
