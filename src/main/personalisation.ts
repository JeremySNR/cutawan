import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Clip, PersonalisationSummary } from '@shared/types'
import {
  applyPersonalisation,
  computeModel,
  emptyStore,
  migrateStore,
  recordAction,
  recordClips,
  summarise,
  type ClipAction,
  type PersonalisationStore
} from '@shared/personalisation'

/**
 * The personalisation file (userData/personalisation.json): versioned JSON,
 * written atomically, with every change queued so concurrent exports and
 * edits never interleave a read-modify-write. See shared/personalisation.ts
 * for what is recorded and how it is used. Nothing here leaves the machine.
 */

function storePath(): string {
  const base = app?.getPath?.('userData') ?? join(process.cwd(), '.tmp', 'userData')
  return join(base, 'personalisation.json')
}

let queue: Promise<unknown> = Promise.resolve()

async function load(): Promise<PersonalisationStore> {
  try {
    return migrateStore(JSON.parse(await readFile(storePath(), 'utf8')))
  } catch {
    return emptyStore()
  }
}

async function save(store: PersonalisationStore): Promise<void> {
  const path = storePath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(store), 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Run `fn` after every earlier change, whether or not they succeeded. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}

async function change(mutate: (store: PersonalisationStore) => PersonalisationStore): Promise<PersonalisationSummary> {
  return serial(async () => {
    const before = await load()
    const after = mutate(before)
    if (after !== before) await save(after)
    return summarise(after)
  })
}

export function getPersonalisationSummary(): Promise<PersonalisationSummary> {
  return serial(async () => summarise(await load()))
}

export function setPersonalisationEnabled(enabled: boolean): Promise<PersonalisationSummary> {
  return change((store) => (store.enabled === enabled ? store : { ...store, enabled }))
}

/** Forget everything learned; the on/off choice stays. */
export function resetPersonalisation(): Promise<PersonalisationSummary> {
  return change((store) => ({ ...emptyStore(), enabled: store.enabled }))
}

export function recordGeneratedClips(projectId: string, clips: Clip[]): Promise<PersonalisationSummary> {
  return change((store) => recordClips(store, projectId, clips))
}

export function recordClipAction(projectId: string, clip: Clip, action: ClipAction): Promise<PersonalisationSummary> {
  return change((store) => recordAction(store, projectId, clip, action))
}

/**
 * Re-rank a fresh run's clips with the learned weights, in place. Returns how
 * many kept clips the weights came from, or null when nothing was applied
 * (off, too little history, or the file could not be read).
 */
export async function personaliseClips(clips: Clip[]): Promise<number | null> {
  try {
    const model = computeModel(await serial(load))
    if (!model) return null
    applyPersonalisation(clips, model)
    return model.positives
  } catch (err) {
    console.error('Personalised ranking skipped:', err)
    return null
  }
}

/** Which edits teach a preference: trim, cuts and captions (not layout or framing). */
export function isLearningEdit(before: Clip, after: Clip): boolean {
  const a = before.edit
  const b = after.edit
  const ranges = (r: Clip['edit']['cuts']): string => JSON.stringify((r ?? []).map((x) => [x.start.toFixed(2), x.end.toFixed(2)]))
  return Math.abs(a.start - b.start) > 0.05 || Math.abs(a.end - b.end) > 0.05 ||
    ranges(a.cuts) !== ranges(b.cuts) || ranges(a.restored) !== ranges(b.restored) ||
    a.tightenCuts !== b.tightenCuts ||
    a.captionsEnabled !== b.captionsEnabled || a.captionStyleId !== b.captionStyleId ||
    (a.captionFontFamily ?? null) !== (b.captionFontFamily ?? null) ||
    a.showTitle !== b.showTitle || before.hook !== after.hook
}
