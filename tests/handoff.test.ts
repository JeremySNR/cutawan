import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32, deflateRawSync } from 'node:zlib'

const mock = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root } }))
import { importHandoffPackage } from '../src/main/handoff'
import { HandoffPackageError, relPathProblem, validateHandoffPackage } from '../src/main/handoffManifest'
import { importPackageArg } from '../src/main/handoffLaunch'
import { extractZip, zipEntryTarget, ZipError } from '../src/main/zipExtract'
import { loadProject, projectsRoot } from '../src/main/projects'
import { isWholeVideoClip } from '@shared/wholeVideo'

/**
 * Metachlorian handoff import. The fixture (tests/fixtures/metachlorian-package)
 * is a complete a_roll_with_inserts package whose manifest validates against
 * Metachlorian's JSON Schema: a 6 s A-roll stringout (testsrc2 + 440 Hz tone),
 * one B-roll insert file that is blue for 1 s then red, a word-timed
 * transcript and a rights record with a credit line.
 */

const FIXTURE = resolve(__dirname, 'fixtures/metachlorian-package')
let work = ''

beforeAll(async () => {
  mock.root = await mkdtemp(join(tmpdir(), 'cutawan-handoff-userdata-'))
  work = await mkdtemp(join(tmpdir(), 'cutawan-handoff-work-'))
})
afterAll(async () => {
  await rm(mock.root, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

let copies = 0
/** A private copy of the fixture, with the manifest edited by `edit`. */
async function fixtureCopy(edit?: (manifest: Record<string, any>) => void): Promise<string> { // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form JSON edits
  const dir = join(work, `package-${copies++}`)
  await cp(FIXTURE, dir, { recursive: true })
  if (edit) {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    edit(manifest)
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

async function problemsOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(HandoffPackageError)
    return (err as HandoffPackageError).problems
  }
  throw new Error('expected the package to be rejected')
}

async function projectFolders(): Promise<string[]> {
  return existsSync(projectsRoot()) ? readdir(projectsRoot()) : []
}

describe('importHandoffPackage', () => {
  it('imports a valid package as an offline, ready-to-edit project', async () => {
    const project = await importHandoffPackage(await fixtureCopy())
    expect(project.name).toBe('Remote work explainer')
    expect(project.mode).toBe('whole-video')
    expect(project.videoType).toBe('talking-head')
    expect(project.video.path).toBe(join(projectsRoot(), project.id, 'source.mp4'))
    expect(project.video.durationSec).toBeGreaterThan(5.9)
    expect(project.video.hasAudio).toBe(true)
    // The package transcript is the project transcript: nothing to transcribe.
    expect(project.transcript?.language).toBe('en-GB')
    expect(project.transcript?.segments[0].words[0]).toEqual({ text: 'Remote', start: 0.3, end: 0.52 })

    expect(project.clips).toHaveLength(1)
    const clip = project.clips[0]
    expect(isWholeVideoClip(clip)).toBe(true)
    expect(clip.edit).toMatchObject({ aspect: '9:16', captionsEnabled: true, autoZoom: true, start: 0 })
    expect(clip.reframeStatus).toBe('done')
    // Metachlorian's subject track, moved from the asset clock to the stringout clock.
    expect(clip.focusTrack?.[0]).toMatchObject({ t: 0, x: 0.5 })
    expect(clip.broll).toHaveLength(1)
    const insert = clip.broll[0]
    expect(insert).toMatchObject({
      kind: 'video', mediaIn: 1, start: 2, end: 3.5, mode: 'fullscreen', trigger: 'tools',
      enabled: true, sourceUrl: 'https://media.example.org/shots/s_9001'
    })
    expect(insert.imagePath).toBe(join(projectsRoot(), project.id, 'broll', 'it_02.mp4'))
    expect(existsSync(insert.imagePath!)).toBe(true)

    expect(project.handoff).toMatchObject({
      packageId: '01JA7Z3K8V5R2Q9W4M6T1X0B3C',
      schemaVersion: '1.0.0',
      instance: 'https://media.example.org',
      rights: { verdict: 'allowed', credits: ['Footage: Example Stock Ltd'], earliestExpiry: '2027-12-31' }
    })
    // Saved where the rest of the app looks for it, with no staging left over.
    const reopened = await loadProject(project.id)
    expect(reopened.handoff?.packageId).toBe(project.handoff?.packageId)
    expect(reopened.sourceMissing).toBe(false)
    expect((await projectFolders()).filter(name => name.startsWith('.'))).toEqual([])
  })

  it('makes one package clip per stringout item for the clips flow', async () => {
    const project = await importHandoffPackage(await fixtureCopy(m => { m.cutawan.flow = 'clips' }))
    expect(project.mode).toBe('clips')
    expect(project.clips).toHaveLength(1)
    expect(project.clips[0]).toMatchObject({
      origin: 'package', title: 'Founder, MCU, says remote work is about trust not tools.', viralityScore: 0
    })
    expect(project.clips[0].broll[0].kind).toBe('video')
  })

  it('imports a zip of the package folder', async () => {
    const dir = await fixtureCopy()
    const zipPath = join(work, 'package.zip')
    await writeZip(zipPath, dir, 'remote-work-01JA7Z3K8V5R2Q9W4M6T1X0B3C')
    const project = await importHandoffPackage(zipPath)
    expect(project.clips[0].broll).toHaveLength(1)
    expect(existsSync(project.video.path)).toBe(true)
  })

  it('keeps a blocked verdict, its reasons and credits on the project', async () => {
    const project = await importHandoffPackage(await fixtureCopy(m => {
      m.rights.verdict = 'blocked'
      m.rights.counts = { allowed: 1, restricted: 0, blocked: 1, unknown: 0 }
      m.rights.records.r_it_02 = {
        verdict: 'blocked',
        reasons: [{ code: 'territory_not_permitted', detail: 'Licence excludes GB.' }],
        credit: 'Footage: Example Stock Ltd'
      }
    }))
    expect(project.handoff?.rights).toEqual({
      verdict: 'blocked',
      credits: ['Footage: Example Stock Ltd'],
      earliestExpiry: '2027-12-31',
      reasons: ['Licence excludes GB.']
    })
  })

  it('rejects path traversal before writing anything', async () => {
    const before = await projectFolders()
    const problems = await problemsOf(importHandoffPackage(await fixtureCopy(m => {
      m.items[1].media.file = '../../outside.mp4'
    })))
    expect(problems.join(' ')).toMatch(/items\[1\]\.media\.file must stay inside the package/)
    expect(await projectFolders()).toEqual(before)
  })

  it('rejects absolute paths', async () => {
    const problems = await problemsOf(validateHandoffPackage(await fixtureCopy(m => {
      m.stringout.file = '/etc/passwd'
    })))
    expect(problems.join(' ')).toMatch(/stringout\.file must be relative/)
  })

  it('rejects a symlink that escapes the package', async () => {
    const outside = join(work, 'outside.mp4')
    await cp(join(FIXTURE, 'media/it_02.mp4'), outside)
    const dir = await fixtureCopy(m => {
      m.items[1].media.file = 'media/escape.mp4'
      m.media[1].file = 'media/escape.mp4'
    })
    await symlink(outside, join(dir, 'media/escape.mp4'))
    const problems = await problemsOf(validateHandoffPackage(dir))
    expect(problems.join(' ')).toMatch(/points outside the package/)
  })

  it('names a missing file and the field that refers to it', async () => {
    const dir = await fixtureCopy()
    await rm(join(dir, 'media/it_02.mp4'))
    const problems = await problemsOf(importHandoffPackage(dir))
    expect(problems.join(' ')).toMatch(/items\[1\]\.media\.file names media\/it_02\.mp4, which is missing/)
  })

  it('refuses an unknown major version', async () => {
    const problems = await problemsOf(validateHandoffPackage(await fixtureCopy(m => { m.schema_version = '2.0.0' })))
    expect(problems[0]).toMatch(/package format 2\.0\.0.*reads format 1 only/)
  })

  it('accepts a newer minor version', async () => {
    const pkg = await validateHandoffPackage(await fixtureCopy(m => { m.schema_version = '1.4.0' }))
    expect(pkg.mode).toBe('a_roll_with_inserts')
  })

  it('detects a file that does not match its sha256', async () => {
    const dir = await fixtureCopy(m => { delete m.media[1].bytes })
    await writeFile(join(dir, 'media/it_02.mp4'), 'not the original file')
    const problems = await problemsOf(validateHandoffPackage(dir))
    expect(problems.join(' ')).toMatch(/media\/it_02\.mp4 does not match the sha256/)
  })

  it('checks inserts against items and the video length', async () => {
    let problems = await problemsOf(validateHandoffPackage(await fixtureCopy(m => {
      m.cutawan.inserts.push({ item_id: 'it_99', start: 1, end: 2 }, { item_id: 'it_02', start: 3, end: 3 })
    })))
    expect(problems.join(' ')).toMatch(/inserts\[1\] refers to item "it_99"/)
    expect(problems.join(' ')).toMatch(/inserts\[2\] must start before it ends/)
    problems = await problemsOf(importHandoffPackage(await fixtureCopy(m => { m.cutawan.inserts[0].end = 9 })))
    expect(problems.join(' ')).toMatch(/inserts\[0\] ends at 9s, after the 6\.\d\ds video/)
  })

  it('falls back to the stringout for a mode it does not know', async () => {
    const pkg = await validateHandoffPackage(await fixtureCopy(m => { m.cutawan.mode = 'storyboard' }))
    expect(pkg.mode).toBe('stringout')
    expect(pkg.warnings.join(' ')).toMatch(/does not know the "storyboard" mode/)
  })

  it('leaves a wordless transcript for Cutawan to redo, and says so', async () => {
    const dir = await fixtureCopy()
    await writeFile(join(dir, 'transcripts/stringout_a_roll.json'), JSON.stringify({ language: 'und', durationSec: 6, segments: [] }))
    const project = await importHandoffPackage(dir)
    expect(project.transcript).toBeNull()
    expect(project.handoff?.notes?.join(' ')).toMatch(/no words yet/)
  })

  it('warns about any verdict but allowed', async () => {
    const pkg = await validateHandoffPackage(await fixtureCopy(m => { m.rights.verdict = 'restricted' }))
    expect(pkg.warnings.join(' ')).toMatch(/Rights verdict is "restricted"/)
  })
})

describe('relPathProblem', () => {
  it('accepts plain relative paths and rejects the rest', () => {
    expect(relPathProblem('media/it_02.mp4')).toBeNull()
    expect(relPathProblem('media/../x.mp4')).toMatch(/inside the package/)
    expect(relPathProblem('C:/x.mp4')).toMatch(/relative/)
    expect(relPathProblem('media\\x.mp4')).toMatch(/characters/)
    expect(relPathProblem('')).toMatch(/relative path/)
  })
})

describe('importPackageArg', () => {
  it('reads the flag in both spellings and resolves relative paths', () => {
    expect(importPackageArg(['/app/cutawan', '--import-package', '/pkgs/a'], '/home')).toBe('/pkgs/a')
    expect(importPackageArg(['electron', '.', '--import-package=pkgs/b.zip'], '/home/me')).toBe('/home/me/pkgs/b.zip')
    expect(importPackageArg(['cutawan', '--import-package'], '/')).toBeNull()
    expect(importPackageArg(['cutawan', '--import-package', '--no-sandbox'], '/')).toBeNull()
    expect(importPackageArg(['cutawan'], '/')).toBeNull()
  })
})

describe('extractZip', () => {
  it('refuses entries that would land outside the target', () => {
    expect(() => zipEntryTarget('/tmp/x', '../evil')).toThrow(ZipError)
    expect(() => zipEntryTarget('/tmp/x', '/etc/passwd')).toThrow(ZipError)
    expect(() => zipEntryTarget('/tmp/x', 'C:\\evil')).toThrow(ZipError)
    expect(zipEntryTarget('/tmp/x', 'a/b.txt')).toBe('/tmp/x/a/b.txt')
  })

  it('rejects a damaged entry', async () => {
    const zipPath = join(work, 'damaged.zip')
    await writeZipEntries(zipPath, [{ name: 'a.txt', data: Buffer.from('hello world'), corruptCrc: true }])
    await expect(extractZip(zipPath, join(work, 'damaged'))).rejects.toThrow(/integrity check/)
  })
})

/** Smallest useful zip writer (deflate), so the test needs no zip tool. */
async function writeZip(zipPath: string, dir: string, prefix: string): Promise<void> {
  const entries: Array<{ name: string; data: Buffer }> = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path)
      else entries.push({ name: `${prefix}/${path}`, data: await readFile(join(dir, path)) })
    }
  }
  await walk('')
  await writeZipEntries(zipPath, entries)
}

async function writeZipEntries(zipPath: string, entries: Array<{ name: string; data: Buffer; corruptCrc?: boolean }>): Promise<void> {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const packed = deflateRawSync(entry.data)
    const crc = (crc32(entry.data) ^ (entry.corruptCrc ? 1 : 0)) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  await writeFile(zipPath, Buffer.concat([...locals, directory, end]))
}
