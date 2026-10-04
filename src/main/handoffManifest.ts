import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { Transcript } from '@shared/types'

/**
 * Checks for a Metachlorian handoff package (format v1), written by hand in
 * the house style rather than with a JSON Schema library. The full schema is
 * Metachlorian's docs/integration/cutawan-package.schema.json; this checks
 * what Cutawan relies on, and every file the manifest points at, before the
 * importer copies a single byte. See docs/metachlorian-handoff.md.
 */

/** The manifest fields Cutawan reads. Everything else is carried but ignored. */
export interface HandoffManifest {
  schema_version: string
  kind: string
  package_id: string
  name: string
  created_at: string
  generator: { name: string; version: string; instance?: string }
  media?: Array<{ file: string; kind: string; duration: number; sha256?: string; bytes?: number }>
  items: HandoffItem[]
  stringout?: {
    sequence_id: string
    file: string
    scope?: 'all' | 'a_roll'
    transcript?: string
    map: Array<{ item_id: string; in: number; out: number }>
  }
  transcripts?: Array<{ file: string; format: string; time_base: string; media_file?: string; language?: string }>
  timelines?: Array<{ file: string }>
  files?: Array<{ path: string; sha256: string; bytes: number }>
  rights: {
    verdict: string
    credits?: string[]
    earliest_expiry?: string
    records: Record<string, { verdict: string; reasons?: Array<{ code: string; detail: string }>; credit?: string }>
    human_readable?: string
  }
  cutawan?: CutawanHints
}

export interface HandoffItem {
  item_id: string
  shot_id: string
  asset_id: string
  role?: string
  source_range: { in: { seconds: number }; out: { seconds: number } }
  media?: { file: string; in: number; out: number }
  thumbnail?: string
  description?: string
  rights_ref: string
  web_url?: string
  safe_crops?: Record<string, { rect: unknown; track?: Array<{ t: number; x: number; cut?: boolean }> }>
}

export type HandoffMode = 'stringout' | 'a_roll_with_inserts' | 'broll_library'

export interface CutawanHints {
  mode: HandoffMode
  project_name?: string
  flow?: 'clips' | 'whole-video'
  video_type?: 'auto' | 'talking-head' | 'podcast' | 'webinar' | 'product-demo'
  aspect?: '9:16' | '1:1' | '16:9' | 'original'
  captions?: boolean
  auto_zoom?: boolean
  follow_speaker?: boolean
  inserts?: Array<{ item_id: string; start: number; end: number; mode?: 'fullscreen' | 'overlay'; trigger?: string }>
  prompt?: string
}

export interface ValidatedPackage {
  /** Real path of the package root (the folder holding manifest.json). */
  root: string
  manifest: HandoffManifest
  /** How the package opens, after falling back from a mode this version does not know. */
  mode: Exclude<HandoffMode, 'broll_library'>
  /** Absolute path of the project video inside the package. */
  videoPath: string
  /** The mapped transcript, or null when the package has none Cutawan can read. */
  transcript: Transcript | null
  /** Absolute path of each inserted item's media file, by item_id. */
  insertMedia: Map<string, string>
  /** Problems that do not stop the import but must stay visible. */
  warnings: string[]
}

export class HandoffPackageError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.length === 1
      ? `This Metachlorian package can't be imported: ${problems[0]}`
      : `This Metachlorian package can't be imported:\n• ${problems.join('\n• ')}`)
  }
}

const MODES: HandoffMode[] = ['stringout', 'a_roll_with_inserts', 'broll_library']
const FLOWS = ['clips', 'whole-video']
const VIDEO_TYPES = ['auto', 'talking-head', 'podcast', 'webinar', 'product-demo']
const ASPECTS = ['9:16', '1:1', '16:9', 'original']
const VERDICTS = ['allowed', 'restricted', 'blocked', 'unknown']
/** More than a page of problems is noise; the first ones say what is wrong. */
const MAX_PROBLEMS = 12

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The schema's relPath rule: relative POSIX path, no '..' segments, no
 * backslashes or characters Windows cannot store. Returns a problem or null.
 */
export function relPathProblem(path: unknown): string | null {
  if (!isString(path) || path.length === 0) return 'must be a relative path'
  if (path.length > 512) return 'is longer than 512 characters'
  if (path.startsWith('/') || isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return `must be relative to the package (got "${path}")`
  if (path.split('/').includes('..')) return `must stay inside the package (got "${path}")`
  if (/[\\:*?"<>|]/.test(path)) return `contains characters a package path may not use (got "${path}")`
  return null
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Validate the package at `dir` (the folder with manifest.json in it). Throws
 * a HandoffPackageError naming every field that is wrong; reads but never
 * writes.
 */
export async function validateHandoffPackage(dir: string): Promise<ValidatedPackage> {
  const problems: string[] = []
  const warnings: string[] = []
  const fail = (): never => { throw new HandoffPackageError(problems.slice(0, MAX_PROBLEMS)) }

  let root: string
  try {
    root = await realpath(dir)
  } catch {
    throw new HandoffPackageError([`the folder ${dir} does not exist.`])
  }
  let raw: string
  try {
    raw = await readFile(join(root, 'manifest.json'), 'utf8')
  } catch {
    throw new HandoffPackageError(['there is no manifest.json in it. Packages are complete only once Metachlorian has written their manifest.'])
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new HandoffPackageError([`manifest.json is not valid JSON (${err instanceof Error ? err.message : String(err)}).`])
  }
  if (!isObject(parsed)) throw new HandoffPackageError(['manifest.json must hold a JSON object.'])
  const m = parsed

  // Identity first: an unknown major means every other field may have changed meaning.
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(isString(m.schema_version) ? m.schema_version : '')
  if (!version) {
    throw new HandoffPackageError(['schema_version must be a version like "1.0.0".'])
  }
  if (version[1] !== '1') {
    throw new HandoffPackageError([`it uses package format ${m.schema_version as string}, and this version of Cutawan reads format 1 only. Update Cutawan, or ask Metachlorian for a format 1 package.`])
  }
  if (m.kind !== 'metachlorian.package') problems.push('kind must be "metachlorian.package".')
  for (const field of ['package_id', 'name', 'created_at'] as const) {
    if (!isString(m[field]) || !(m[field] as string).length) problems.push(`${field} is missing.`)
  }
  if (!isObject(m.generator) || !isString(m.generator.name) || !isString(m.generator.version)) {
    problems.push('generator must name the tool and its version.')
  }
  if (!isObject(m.vocab_versions)) problems.push('vocab_versions is missing.')
  if (!Array.isArray(m.assets)) problems.push('assets must be a list.')
  if (!Array.isArray(m.items) || m.items.length === 0) problems.push('items must list at least one shot.')

  // Rights: required, and never second-guessed. Anything but "allowed" imports with a warning.
  const rights = m.rights
  if (!isObject(rights)) {
    problems.push('rights is missing. Metachlorian records a rights verdict in every package.')
  } else {
    if (!VERDICTS.includes(rights.verdict as string)) problems.push(`rights.verdict must be one of ${VERDICTS.join(', ')}.`)
    if (!isString(rights.checked_at)) problems.push('rights.checked_at is missing.')
    if (!isObject(rights.records)) problems.push('rights.records is missing.')
    if (rights.credits !== undefined && (!Array.isArray(rights.credits) || !rights.credits.every(isString))) {
      problems.push('rights.credits must be a list of credit lines.')
    }
  }

  const items = Array.isArray(m.items) ? m.items : []
  const itemsById = new Map<string, Json>()
  items.forEach((item, i) => {
    const at = `items[${i}]`
    if (!isObject(item)) { problems.push(`${at} must be an object.`); return }
    for (const field of ['item_id', 'shot_id', 'asset_id', 'rights_ref'] as const) {
      if (!isString(item[field])) problems.push(`${at}.${field} is missing.`)
    }
    if (isString(item.item_id)) {
      if (itemsById.has(item.item_id)) problems.push(`${at}.item_id "${item.item_id}" is used twice.`)
      itemsById.set(item.item_id, item)
    }
    const range = item.source_range
    if (!isObject(range) || !isObject(range.in) || !isObject(range.out) || !isNumber(range.in.seconds) || !isNumber(range.out.seconds)) {
      problems.push(`${at}.source_range needs in and out times in seconds.`)
    }
    if (item.media !== undefined) {
      const media = item.media
      if (!isObject(media) || !isNumber(media.in) || !isNumber(media.out) || media.in < 0 || media.out < media.in) {
        problems.push(`${at}.media needs a file and in ≤ out times.`)
      }
    }
  })

  // How to open it. An unknown mode from a newer Metachlorian falls back to the stringout.
  const hints = isObject(m.cutawan) ? m.cutawan : undefined
  if (m.cutawan !== undefined && !hints) problems.push('cutawan must be an object.')
  let mode: HandoffMode = 'stringout'
  if (hints) {
    if (MODES.includes(hints.mode as HandoffMode)) mode = hints.mode as HandoffMode
    else if (isObject(m.stringout)) warnings.push(`This version of Cutawan does not know the "${String(hints.mode)}" mode, so it opened the package's stringout instead.`)
    else problems.push(`cutawan.mode "${String(hints.mode)}" is not one this version of Cutawan can open.`)
    if (hints.flow !== undefined && !FLOWS.includes(hints.flow as string)) problems.push(`cutawan.flow must be ${FLOWS.join(' or ')}.`)
    if (hints.video_type !== undefined && !VIDEO_TYPES.includes(hints.video_type as string)) problems.push(`cutawan.video_type must be one of ${VIDEO_TYPES.join(', ')}.`)
    if (hints.aspect !== undefined && !ASPECTS.includes(hints.aspect as string)) problems.push(`cutawan.aspect must be one of ${ASPECTS.join(', ')}.`)
    for (const flag of ['captions', 'auto_zoom', 'follow_speaker'] as const) {
      if (hints[flag] !== undefined && typeof hints[flag] !== 'boolean') problems.push(`cutawan.${flag} must be true or false.`)
    }
  }
  if (mode === 'broll_library') {
    problems.push('it is a B-roll library (no project video). This version of Cutawan imports stringout and A-roll-with-inserts packages only.')
  }

  const stringout = isObject(m.stringout) ? m.stringout : undefined
  if (m.stringout !== undefined && !stringout) problems.push('stringout must be an object.')
  if (!stringout && mode !== 'broll_library') {
    problems.push('it has no stringout, so there is no video for the project. Ask Metachlorian for a package with media "stringout".')
  }
  if (stringout) {
    if (!Array.isArray(stringout.map)) problems.push('stringout.map must be a list.')
    else stringout.map.forEach((entry, i) => {
      if (!isObject(entry) || !isString(entry.item_id) || !isNumber(entry.in) || !isNumber(entry.out) || entry.out <= entry.in) {
        problems.push(`stringout.map[${i}] needs an item_id and in < out.`)
      } else if (!itemsById.has(entry.item_id)) {
        problems.push(`stringout.map[${i}] refers to item "${entry.item_id}", which is not in items.`)
      }
    })
    if (mode === 'a_roll_with_inserts' && stringout.scope === 'all') {
      warnings.push('The stringout already has the B-roll cut in, so the inserts will cover it a second time.')
    }
  }

  // Inserts must point at items whose media shipped, and run forwards.
  const inserts = hints && Array.isArray(hints.inserts) ? hints.inserts : []
  if (hints && hints.inserts !== undefined && !Array.isArray(hints.inserts)) problems.push('cutawan.inserts must be a list.')
  const insertMediaRel = new Map<string, string>()
  if (mode === 'a_roll_with_inserts') {
    inserts.forEach((insert, i) => {
      const at = `cutawan.inserts[${i}]`
      if (!isObject(insert) || !isString(insert.item_id) || !isNumber(insert.start) || !isNumber(insert.end)) {
        problems.push(`${at} needs an item_id, start and end.`)
        return
      }
      if (insert.start < 0 || insert.start >= insert.end) problems.push(`${at} must start before it ends (start ${insert.start}, end ${insert.end}).`)
      if (insert.mode !== undefined && insert.mode !== 'fullscreen' && insert.mode !== 'overlay') problems.push(`${at}.mode must be fullscreen or overlay.`)
      const item = itemsById.get(insert.item_id)
      if (!item) problems.push(`${at} refers to item "${insert.item_id}", which is not in items.`)
      else if (!isObject(item.media) || !isString(item.media.file)) problems.push(`${at} refers to item "${insert.item_id}", which has no media in the package.`)
      else insertMediaRel.set(insert.item_id, item.media.file)
    })
  }

  // Every path the manifest names: well-formed, present, and really inside the package.
  const refs: Array<{ path: unknown; field: string }> = []
  const ref = (path: unknown, field: string): void => { refs.push({ path, field }) }
  if (stringout) {
    ref(stringout.file, 'stringout.file')
    if (stringout.transcript !== undefined) ref(stringout.transcript, 'stringout.transcript')
  }
  const mediaList = Array.isArray(m.media) ? m.media : []
  mediaList.forEach((entry, i) => { if (isObject(entry)) ref(entry.file, `media[${i}].file`) })
  items.forEach((item, i) => {
    if (!isObject(item)) return
    if (isObject(item.media)) ref(item.media.file, `items[${i}].media.file`)
    if (item.thumbnail !== undefined) ref(item.thumbnail, `items[${i}].thumbnail`)
  })
  const transcriptList = Array.isArray(m.transcripts) ? m.transcripts : []
  transcriptList.forEach((entry, i) => {
    if (!isObject(entry)) return
    ref(entry.file, `transcripts[${i}].file`)
    if (entry.media_file !== undefined) ref(entry.media_file, `transcripts[${i}].media_file`)
  })
  const timelineList = Array.isArray(m.timelines) ? m.timelines : []
  timelineList.forEach((entry, i) => { if (isObject(entry)) ref(entry.file, `timelines[${i}].file`) })
  const fileList = Array.isArray(m.files) ? m.files : []
  fileList.forEach((entry, i) => { if (isObject(entry)) ref(entry.path, `files[${i}].path`) })
  if (isObject(rights) && rights.human_readable !== undefined) ref(rights.human_readable, 'rights.human_readable')

  const resolved = new Map<string, string>()
  for (const { path, field } of refs) {
    const problem = relPathProblem(path)
    if (problem) { problems.push(`${field} ${problem}.`); continue }
    const rel = path as string
    if (resolved.has(rel)) continue
    let real: string
    try {
      real = await realpath(join(root, rel))
    } catch {
      problems.push(`${field} names ${rel}, which is missing from the package.`)
      continue
    }
    // realpath follows symlinks, so this also catches a link pointing outside.
    if (!real.startsWith(root + sep)) {
      problems.push(`${field} (${rel}) points outside the package.`)
      continue
    }
    if (!(await stat(real)).isFile()) {
      problems.push(`${field} (${rel}) is not a file.`)
      continue
    }
    resolved.set(rel, real)
  }
  if (problems.length) fail()

  // Integrity: sha256 and size where the manifest records them.
  const expected = new Map<string, { sha256?: string; bytes?: number; field: string }>()
  mediaList.forEach((entry, i) => {
    if (isObject(entry) && isString(entry.file) && (isString(entry.sha256) || isNumber(entry.bytes))) {
      expected.set(entry.file, { sha256: entry.sha256 as string | undefined, bytes: entry.bytes as number | undefined, field: `media[${i}]` })
    }
  })
  fileList.forEach((entry, i) => {
    if (isObject(entry) && isString(entry.path)) {
      expected.set(entry.path, { sha256: entry.sha256 as string | undefined, bytes: entry.bytes as number | undefined, field: `files[${i}]` })
    }
  })
  for (const [rel, want] of expected) {
    const real = resolved.get(rel)
    if (!real) continue
    if (isNumber(want.bytes) && (await stat(real)).size !== want.bytes) {
      problems.push(`${rel} is not the size ${want.field} records; the package is incomplete or was changed.`)
    } else if (isString(want.sha256) && (await sha256(real)) !== want.sha256.toLowerCase()) {
      problems.push(`${rel} does not match the sha256 in ${want.field}; the package is damaged or was changed.`)
    }
  }
  if (problems.length) fail()

  // The transcript, in Cutawan's own shape, on the stringout clock.
  let transcript: Transcript | null = null
  if (stringout && isString(stringout.transcript)) {
    const entry = transcriptList.find(t => isObject(t) && t.file === stringout.transcript)
    const format = isObject(entry) ? entry.format : 'cutawan.transcript/1'
    if (format !== 'cutawan.transcript/1') {
      warnings.push(`The transcript is ${String(format)}, which Cutawan cannot use for captions, so it will transcribe the video itself.`)
    } else if (isObject(entry) && entry.time_base === 'asset') {
      problems.push('The stringout transcript must use the stringout\'s own clock (time_base "media").')
    } else {
      transcript = await readTranscript(resolved.get(stringout.transcript)!, problems)
      // Metachlorian writes an empty transcript when it has not transcribed the
      // footage yet. Leaving the project without one lets Cutawan transcribe it.
      if (transcript && transcript.segments.every(s => s.words.length === 0)) {
        transcript = null
        warnings.push('The package transcript has no words yet, so Cutawan will transcribe the video before captioning.')
      }
    }
  } else if (stringout) {
    warnings.push('The package has no transcript, so Cutawan will transcribe the video before captioning.')
  }
  if (problems.length) fail()

  const insertMedia = new Map<string, string>()
  for (const [itemId, rel] of insertMediaRel) insertMedia.set(itemId, resolved.get(rel)!)

  // Rights verdict other than allowed: import, but say so (the importer keeps it on the project).
  if (isObject(rights) && rights.verdict !== 'allowed') {
    warnings.push(`Rights verdict is "${String(rights.verdict)}". Check the package's RIGHTS.md before publishing.`)
  }

  return {
    root,
    manifest: m as unknown as HandoffManifest,
    mode: mode as Exclude<HandoffMode, 'broll_library'>,
    videoPath: resolved.get(stringout!.file as string)!,
    transcript,
    insertMedia,
    warnings
  }
}

/** Parse and check a cutawan.transcript/1 file; word timings are required. */
async function readTranscript(path: string, problems: string[]): Promise<Transcript | null> {
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    problems.push('The stringout transcript is not valid JSON.')
    return null
  }
  if (!isObject(data) || !Array.isArray(data.segments)) {
    problems.push('The stringout transcript must have a segments list.')
    return null
  }
  const segments: Transcript['segments'] = []
  for (const [i, seg] of data.segments.entries()) {
    if (!isObject(seg) || !isNumber(seg.start) || !isNumber(seg.end) || !Array.isArray(seg.words)) {
      problems.push(`Transcript segment ${i} needs start, end and words.`)
      return null
    }
    const words = []
    for (const w of seg.words) {
      if (!isObject(w) || !isString(w.text) || !isNumber(w.start) || !isNumber(w.end) || w.end < w.start) {
        problems.push(`Transcript segment ${i} has a word without text, start and end.`)
        return null
      }
      words.push({ text: w.text, start: w.start, end: w.end })
    }
    segments.push({
      id: isNumber(seg.id) ? seg.id : i,
      text: isString(seg.text) ? seg.text : words.map(w => w.text).join(' '),
      start: seg.start,
      end: seg.end,
      words
    })
  }
  const speech = Array.isArray(data.speech)
    ? data.speech.filter((r): r is { start: number; end: number } => isObject(r) && isNumber(r.start) && isNumber(r.end) && r.end > r.start)
      .map(r => ({ start: r.start, end: r.end }))
    : undefined
  return {
    language: isString(data.language) ? data.language : 'und',
    durationSec: isNumber(data.durationSec) ? data.durationSec : (segments.at(-1)?.end ?? 0),
    segments,
    ...(speech ? { speech } : {})
  }
}
