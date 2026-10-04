import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AspectRatio,
  BrollItem,
  Clip,
  FocusKeyframe,
  ImportProgress,
  Project,
  ProjectHandoff
} from '@shared/types'
import { compactFocusTrack } from '@shared/focusTrack'
import { wholeVideoEdit } from '@shared/wholeVideo'
import { extractThumbnail, probeVideo } from './pipeline/ffmpeg'
import { allowMediaPath } from './mediaAccess'
import { projectsRoot } from './projects'
import { extractZip } from './zipExtract'
import {
  HandoffPackageError,
  validateHandoffPackage,
  type HandoffItem,
  type ValidatedPackage
} from './handoffManifest'

/**
 * Import a Metachlorian handoff package (a folder, its manifest.json, or a
 * .zip of the folder) as a ready-to-edit project: the stringout becomes the
 * project video, the package transcript becomes the project transcript (so
 * nothing is transcribed and no API is called), and B-roll inserts become
 * timed video inserts. The contract is Metachlorian's
 * docs/integration/cutawan-contract.md; docs/metachlorian-handoff.md has the
 * Cutawan side.
 *
 * Atomic: the package is validated before anything is written, the project is
 * assembled in a hidden staging folder next to the others, and a single
 * rename publishes it. A failure leaves no half-imported project behind.
 */

export interface ImportPackageOptions {
  onProgress?: (p: ImportProgress) => void
  /** Where projects live; defaults to userData/projects. For tests and offline scripts. */
  projectsRoot?: string
}

/** Inserts may end this far past the probed video, which rounds differently from the writer. */
const DURATION_TOLERANCE_SEC = 0.05

const TITLE_MAX = 80

export async function importHandoffPackage(source: string, opts: ImportPackageOptions = {}): Promise<Project> {
  const progress = (value: number, message: string): void => opts.onProgress?.({ progress: value, message })
  let info
  try {
    info = await stat(source)
  } catch {
    throw new HandoffPackageError([`nothing exists at ${source}.`])
  }

  let unzipDir: string | null = null
  try {
    let packageDir = source
    if (info.isFile()) {
      if (extname(source).toLowerCase() === '.zip') {
        progress(-1, 'Unzipping package…')
        unzipDir = join(tmpdir(), 'cutawan', `package-${randomUUID()}`)
        await extractZip(source, unzipDir)
        packageDir = await locatePackageRoot(unzipDir)
      } else if (basename(source) === 'manifest.json') {
        packageDir = dirname(source)
      } else {
        throw new HandoffPackageError(['choose the package folder, its manifest.json, or a .zip of the folder.'])
      }
    } else {
      packageDir = await locatePackageRoot(source)
    }
    progress(0.05, 'Checking package…')
    const pkg = await validateHandoffPackage(packageDir)
    return await assembleProject(pkg, opts.projectsRoot ?? projectsRoot(), progress)
  } finally {
    if (unzipDir) await rm(unzipDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** A zip of the package folder holds that folder; look one level down for the manifest. */
async function locatePackageRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, 'manifest.json'))) return dir
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX')
  if (folders.length === 1 && existsSync(join(dir, folders[0].name, 'manifest.json'))) {
    return join(dir, folders[0].name)
  }
  return dir
}

async function assembleProject(
  pkg: ValidatedPackage,
  root: string,
  progress: (value: number, message: string) => void
): Promise<Project> {
  const { manifest } = pkg
  const hints = manifest.cutawan
  const id = randomUUID()
  const finalDir = join(root, id)
  const staging = join(root, `.import-${id}`)
  // Paths inside the project are stored final; files are written to staging.
  const staged = (path: string): string => join(staging, path.slice(finalDir.length + 1))

  await mkdir(staging, { recursive: true })
  try {
    progress(0.15, 'Copying video…')
    const videoPath = join(finalDir, 'source.mp4')
    await copyFile(pkg.videoPath, staged(videoPath), constants.COPYFILE_FICLONE)
    progress(0.6, 'Reading video…')
    const video = { ...(await probeVideo(staged(videoPath))), path: videoPath }

    const problems: string[] = []
    const inserts = pkg.mode === 'a_roll_with_inserts' ? hints?.inserts ?? [] : []
    inserts.forEach((insert, i) => {
      if (insert.end > video.durationSec + DURATION_TOLERANCE_SEC) {
        problems.push(`cutawan.inserts[${i}] ends at ${insert.end}s, after the ${video.durationSec.toFixed(2)}s video.`)
      }
    })
    if (problems.length) throw new HandoffPackageError(problems)

    // B-roll media: one copy per file (several inserts may share one), kept by
    // its package basename, which Metachlorian guarantees is unique.
    progress(0.7, 'Copying B-roll…')
    const items = new Map(manifest.items.map(item => [item.item_id, item]))
    const brollDir = join(finalDir, 'broll')
    if (inserts.length) await mkdir(staged(brollDir), { recursive: true })
    const copied = new Map<string, string>()
    const broll: BrollItem[] = []
    for (const [n, insert] of inserts.entries()) {
      const from = pkg.insertMedia.get(insert.item_id)!
      let target = copied.get(from)
      if (!target) {
        target = join(brollDir, basename(from))
        await copyFile(from, staged(target), constants.COPYFILE_FICLONE)
        try {
          await probeVideo(staged(target))
        } catch {
          throw new HandoffPackageError([`the B-roll file for item "${insert.item_id}" (${basename(from)}) is not a video Cutawan can read.`])
        }
        copied.set(from, target)
      }
      const item = items.get(insert.item_id)!
      broll.push({
        id: randomUUID(),
        trigger: insert.trigger || shortTitle(item.description) || `B-roll ${n + 1}`,
        query: item.description ?? '',
        start: insert.start,
        end: insert.end,
        mode: insert.mode ?? 'fullscreen',
        kind: 'video',
        mediaIn: item.media?.in ?? 0,
        imagePath: target,
        sourceUrl: item.web_url ?? '',
        enabled: true
      })
    }

    progress(0.85, 'Building the edit…')
    const aspect: AspectRatio = hints?.aspect ?? targetAspect(manifest)
    const track = seededFocusTrack(pkg, aspect)
    const flow = hints?.flow ?? 'whole-video'
    const thumbsDir = join(finalDir, 'thumbs')
    await mkdir(staged(thumbsDir), { recursive: true })
    const thumbnail = async (clipId: string, at: number): Promise<string | null> => {
      const path = join(thumbsDir, `${clipId}.jpg`)
      try {
        await extractThumbnail(staged(videoPath), at, staged(path))
        return path
      } catch {
        return null
      }
    }

    const ranges = flow === 'clips'
      ? (manifest.stringout?.map ?? []).filter(m => m.in < video.durationSec)
        .map(m => ({ start: m.in, end: Math.min(m.out, video.durationSec), item: items.get(m.item_id) }))
      : [{ start: 0, end: video.durationSec, item: undefined }]
    const clips: Clip[] = []
    for (const [n, range] of ranges.entries()) {
      const clipId = randomUUID()
      const focusTrack = track?.filter(k => k.t >= range.start && k.t <= range.end) ?? null
      const seeded = focusTrack && focusTrack.length ? focusTrack : null
      const edit = wholeVideoEdit({
        aspect,
        autoZoom: hints?.auto_zoom ?? false,
        durationSec: video.durationSec,
        focusTrack: seeded,
        contentType: 'speaker'
      })
      edit.start = range.start
      edit.end = range.end
      edit.captionsEnabled = hints?.captions ?? true
      const wholeVideo = flow !== 'clips'
      // A whole-video edit, or a clip whose framing the package already
      // tracked, is ready as it is. Other clips get on-device framing
      // analysis when first opened, like any clip the pipeline left pending.
      const ready = wholeVideo || seeded !== null
      clips.push({
        id: clipId,
        origin: wholeVideo ? 'whole-video' : 'package',
        suggestedStart: range.start,
        suggestedEnd: range.end,
        title: wholeVideo ? projectName(pkg) : shortTitle(range.item?.description) || `Shot ${n + 1}`,
        hook: '',
        summary: range.item?.description ?? '',
        viralityScore: 0,
        viralityReason: '',
        visualSummary: null,
        hashtags: [],
        thumbnailPath: await thumbnail(clipId, range.start + Math.min(1.5, (range.end - range.start) / 2)),
        focusTrack: seeded,
        reframeStatus: ready ? 'done' : 'pending',
        ...(ready ? { reframeAnalysis: { start: range.start, end: range.end, version: 2 } } : {}),
        contentType: ready ? 'speaker' : null,
        // Each insert belongs to the clip it starts in.
        broll: broll.filter(b => b.start >= range.start && b.start < range.end),
        edit
      })
    }

    const now = Date.now()
    const project: Project = {
      id,
      createdAt: now,
      updatedAt: now,
      name: projectName(pkg),
      video,
      transcript: pkg.transcript,
      clips,
      prompt: hints?.prompt ?? '',
      videoType: hints?.video_type ?? 'auto',
      mode: flow,
      handoff: handoffRecord(pkg, now)
    }
    await writeFile(join(staging, 'project.json'), JSON.stringify(project), 'utf8')
    await rename(staging, finalDir)
    allowMediaPath(video.path)
    progress(1, 'Done')
    return project
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

function projectName(pkg: ValidatedPackage): string {
  return pkg.manifest.cutawan?.project_name?.trim() || pkg.manifest.name
}

function shortTitle(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= TITLE_MAX) return clean
  return `${clean.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…`
}

/** The package's target aspect when the Cutawan block does not name one. */
function targetAspect(manifest: ValidatedPackage['manifest']): AspectRatio {
  const target = (manifest as unknown as { target?: { aspect?: string } }).target?.aspect
  return target === '9:16' || target === '1:1' || target === '16:9' ? target : '9:16'
}

/**
 * Metachlorian's subject track for the stringout's A-roll, moved from each
 * item's asset clock onto the stringout clock. It has the shape of a
 * FocusKeyframe, so the editor can follow the subject without running
 * speaker detection on device. Null when the package carries none.
 */
function seededFocusTrack(pkg: ValidatedPackage, aspect: AspectRatio): FocusKeyframe[] | null {
  const items = new Map<string, HandoffItem>(pkg.manifest.items.map(item => [item.item_id, item]))
  const keyframes: FocusKeyframe[] = []
  for (const entry of pkg.manifest.stringout?.map ?? []) {
    const item = items.get(entry.item_id)
    const crops = item?.safe_crops
    const crop = crops?.[aspect] ?? crops?.['9:16']
    if (!item || !crop?.track?.length) continue
    const assetIn = item.source_range.in.seconds
    const length = entry.out - entry.in
    let first = true
    for (const k of crop.track) {
      const offset = k.t - assetIn
      if (offset < 0 || offset > length) continue
      // The first keyframe of each item is a cut: the shot changes there.
      keyframes.push({ t: entry.in + offset, x: k.x, ...(k.cut || first ? { cut: true } : {}) })
      first = false
    }
  }
  return keyframes.length ? compactFocusTrack(keyframes) : null
}

function handoffRecord(pkg: ValidatedPackage, now: number): ProjectHandoff {
  const { manifest } = pkg
  const reasons = Object.values(manifest.rights.records ?? {})
    .flatMap(record => record.reasons ?? [])
    .map(reason => reason.detail || reason.code)
  const credits = manifest.rights.credits ?? []
  const notes = pkg.warnings.filter(w => !w.startsWith('Rights verdict'))
  return {
    packageId: manifest.package_id,
    schemaVersion: manifest.schema_version,
    ...(manifest.generator.instance ? { instance: manifest.generator.instance } : {}),
    packageName: manifest.name,
    importedAt: now,
    rights: {
      verdict: manifest.rights.verdict,
      credits,
      ...(manifest.rights.earliest_expiry ? { earliestExpiry: manifest.rights.earliest_expiry } : {}),
      ...(reasons.length ? { reasons: [...new Set(reasons)] } : {})
    },
    ...(notes.length ? { notes } : {})
  }
}
