import type { TranscriptWord } from './types'

/**
 * Sound effects and background music: where they go and how loud, shared by
 * the export (ffmpeg synthesises the effects and mixes the music, see
 * render.ts) and the preview (WebAudio plays the same cues and the same
 * ducking envelope, see lib/previewAudio.ts).
 *
 * Nothing here is a recording: the effects are synthesised from the recipes
 * below at render time, and music only ever comes from a folder the user
 * chose.
 */

export type SfxKind = 'whoosh' | 'pop' | 'ding'

export interface SfxSpec {
  /** Length of the sound, seconds. */
  duration: number
  /** How long before its event the sound starts (a whoosh swells into a cut). */
  lead: number
  /** Level relative to the speech, in dB. */
  gainDb: number
}

export const SFX_SPECS: Record<SfxKind, SfxSpec> = {
  whoosh: { duration: 0.55, lead: 0.32, gainDb: -9 },
  pop: { duration: 0.14, lead: 0, gainDb: -8 },
  ding: { duration: 0.9, lead: 0, gainDb: -13 }
}

export interface SfxCue {
  kind: SfxKind
  /** Output second the sound starts. */
  start: number
}

export const MAX_SFX_PER_CLIP = 3
export const MIN_SFX_GAP_SEC = 1.5
/** No effect lands in the clip's last this-many seconds. */
export const SFX_TAIL_FREE_SEC = 0.6

export interface SfxEvents {
  /** Output duration of the clip. */
  duration: number
  /** Where the cold open ends and the clip starts again. */
  coldOpenSeam?: number | null
  /** When the hook title appears. */
  titleAt?: number | null
  /** Where joined moments meet, output seconds. */
  joins?: number[]
}

/**
 * The effects for a clip, by rule: a whoosh at the cold-open seam and at each
 * join of a clip made from separate moments, a pop as the hook title appears.
 * Earlier rules win; at most three, at least 1.5 s apart, none in the last
 * 0.6 s.
 */
export function planSoundEffects(events: SfxEvents): SfxCue[] {
  const candidates: Array<{ kind: SfxKind; at: number }> = []
  if (events.coldOpenSeam != null) candidates.push({ kind: 'whoosh', at: events.coldOpenSeam })
  if (events.titleAt != null) candidates.push({ kind: 'pop', at: events.titleAt })
  for (const join of events.joins ?? []) candidates.push({ kind: 'whoosh', at: join })
  const placed: Array<{ kind: SfxKind; at: number }> = []
  for (const c of candidates) {
    if (placed.length >= MAX_SFX_PER_CLIP) break
    if (!(c.at >= 0) || c.at > events.duration - SFX_TAIL_FREE_SEC) continue
    if (placed.some((p) => Math.abs(p.at - c.at) < MIN_SFX_GAP_SEC)) continue
    placed.push(c)
  }
  return placed
    .map((p) => ({ kind: p.kind, start: Math.max(0, p.at - SFX_SPECS[p.kind].lead) }))
    .sort((a, b) => a.start - b.start)
}

/** Linear amplitude for a level in dB. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * The effect recipes, as one formula each so the export (ffmpeg aevalsrc) and
 * the preview (a JS loop filling an AudioBuffer) produce the same sound. The
 * whoosh is band-limited noise in ffmpeg (anoisesrc + filters) and the closest
 * WebAudio equivalent in the preview: noise differs sample by sample, its
 * envelope and colour do not.
 */
export const SFX_EXPRESSIONS: Record<Exclude<SfxKind, 'whoosh'>, string> = {
  // A short pitch-dropping sine blip with a fast decay.
  pop: '0.9*sin(2*PI*(380+900*exp(-t*38))*t)*exp(-t*26)',
  // Two partials of a soft bell, decaying over most of a second.
  ding: '0.45*(sin(2*PI*1318.5*t)+0.45*sin(2*PI*2637*t))*exp(-t*5.5)'
}

/** Whoosh envelope: swell over the lead, then fall away. Shared by both renderers. */
export function whooshEnvelope(t: number): number {
  const { duration, lead } = SFX_SPECS.whoosh
  if (t < 0 || t > duration) return 0
  if (t < lead) return Math.pow(t / lead, 2)
  return Math.pow(1 - (t - lead) / (duration - lead), 1.6)
}

/** The same envelope as an ffmpeg expression in `t`. */
export const WHOOSH_ENVELOPE_EXPR = (() => {
  const { duration, lead } = SFX_SPECS.whoosh
  return `if(lt(t,${lead}),pow(t/${lead},2),pow(max(0,1-(t-${lead})/${(duration - lead).toFixed(3)}),1.6))`
})()

/** Whoosh noise colour: a band from a low rumble to a soft hiss. */
export const WHOOSH_BAND = { highpassHz: 350, lowpassHz: 3800 }

/** Evaluate a pop/ding recipe at time t (same maths as SFX_EXPRESSIONS). */
export function sfxSample(kind: Exclude<SfxKind, 'whoosh'>, t: number): number {
  if (kind === 'pop') return 0.9 * Math.sin(2 * Math.PI * (380 + 900 * Math.exp(-t * 38)) * t) * Math.exp(-t * 26)
  return 0.45 * (Math.sin(2 * Math.PI * 1318.5 * t) + 0.45 * Math.sin(2 * Math.PI * 2637 * t)) * Math.exp(-t * 5.5)
}

/** Background music sits this far under the speech's loudness when nobody talks. */
export const MUSIC_BED_LU = -14
/** …and drops by this much more while someone speaks. */
export const MUSIC_DUCK_DB = -10
export const MUSIC_FADE_IN_SEC = 1
export const MUSIC_FADE_OUT_SEC = 1.5
/** Speech closer together than this ducks as one stretch. */
const DUCK_MERGE_GAP_SEC = 0.6
/** The duck comes in and lets go this quickly. */
export const DUCK_ATTACK_SEC = 0.12
export const DUCK_RELEASE_SEC = 0.4

/** Audio files the music picker accepts. */
export const MUSIC_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac']

export function isMusicFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MUSIC_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * The track a clip plays: the one picked for it when it is still in the
 * folder, otherwise one chosen from the clip id (stable, so the preview and
 * every export of the clip agree). `tracks` are file names, any order.
 */
export function pickMusicTrack(tracks: string[], clipId: string, chosen?: string | null): string | null {
  const sorted = [...tracks].filter(isMusicFile).sort((a, b) => a.localeCompare(b))
  if (!sorted.length) return null
  if (chosen && sorted.includes(chosen)) return chosen
  let hash = 0
  for (const ch of clipId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return sorted[hash % sorted.length]
}

/** Stretches of speech on the output timeline, merged across short gaps. */
export function speechSpans(words: Array<Pick<TranscriptWord, 'start' | 'end'>>): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1]
    if (last && w.start - last.end <= DUCK_MERGE_GAP_SEC) last.end = Math.max(last.end, w.end)
    else spans.push({ start: w.start, end: w.end })
  }
  return spans
}

/**
 * Music gain over time, as breakpoints (output seconds, linear gain relative
 * to the bed level): faded in and out at the ends, ducked under each speech
 * span. The preview schedules exactly these; the export ducks with a
 * sidechain compressor keyed on the same speech, which follows the same
 * shape without needing a breakpoint per word.
 */
export function musicGainEnvelope(spans: Array<{ start: number; end: number }>, duration: number): Array<{ t: number; gain: number }> {
  const duck = dbToGain(MUSIC_DUCK_DB)
  const points: Array<{ t: number; gain: number }> = [{ t: 0, gain: 1 }]
  for (const s of spans) {
    const from = Math.max(0, s.start - DUCK_ATTACK_SEC)
    const to = Math.min(duration, s.end + DUCK_RELEASE_SEC)
    if (to <= from) continue
    points.push({ t: from, gain: 1 }, { t: Math.min(to, from + DUCK_ATTACK_SEC), gain: duck }, { t: Math.max(from, s.end), gain: duck }, { t: to, gain: 1 })
  }
  // Overlapping ducks: keep the quieter value at each breakpoint, in time order.
  const sorted = points.sort((a, b) => a.t - b.t)
  const inside = (t: number): boolean => spans.some((s) => t > s.start && t < s.end)
  const shaped = sorted.map((p) => ({ t: p.t, gain: inside(p.t) ? duck : p.gain }))
  const fade = (t: number): number => Math.min(1, t / MUSIC_FADE_IN_SEC, Math.max(0, duration - t) / MUSIC_FADE_OUT_SEC)
  const withFades = [...shaped, { t: MUSIC_FADE_IN_SEC, gain: inside(MUSIC_FADE_IN_SEC) ? duck : 1 },
    { t: Math.max(0, duration - MUSIC_FADE_OUT_SEC), gain: inside(duration - MUSIC_FADE_OUT_SEC) ? duck : 1 }, { t: duration, gain: 0 }]
    .filter((p) => p.t >= 0 && p.t <= duration)
    .sort((a, b) => a.t - b.t)
  return withFades.map((p) => ({ t: p.t, gain: p.gain * fade(p.t) }))
}

/** The envelope's gain at output time `t` (linear between breakpoints). */
export function envelopeGain(points: Array<{ t: number; gain: number }>, t: number): number {
  if (!points.length) return 1
  const i = points.findIndex((p) => p.t > t)
  if (i === 0) return points[0].gain
  if (i === -1) return points[points.length - 1].gain
  const a = points[i - 1], b = points[i]
  return a.gain + (b.gain - a.gain) * ((t - a.t) / Math.max(1e-6, b.t - a.t))
}
