import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type {
  AnalyzeOptions,
  BatchItem,
  BatchItemSource,
  BatchQueueState,
  ImportProgress,
  PipelineProgress,
  Project
} from '@shared/types'
import { highlightClips } from '@shared/wholeVideo'

/**
 * The batch queue: several files or URLs imported and analysed one after
 * another with the settings snapshot each was added with. Analysis already
 * parallelises internally, so one item at a time keeps the machine and the
 * provider's rate limits sane.
 *
 * The queue is saved to userData after every status change, so it survives
 * a restart. An item that was mid-import or mid-analysis when the app closed
 * goes back to queued (a finished import keeps its project, and a saved
 * transcript is reused), and the queue comes back paused: it never starts
 * spending API calls on launch without being asked.
 */

export const BATCH_QUEUE_VERSION = 1

export interface BatchDeps {
  /** Where the queue is saved. */
  filePath: string
  importFile: (path: string) => Promise<Project>
  importUrl: (url: string, onProgress: (p: ImportProgress) => void, signal: AbortSignal) => Promise<Project>
  analyze: (projectId: string, options: AnalyzeOptions, onProgress: (p: PipelineProgress) => void, signal: AbortSignal) => Promise<Project>
  /** Every state change, for the renderer. */
  emit: (state: BatchQueueState) => void
}

interface SavedQueue {
  version: number
  items: BatchItem[]
}

const ACTIVE = new Set<BatchItem['status']>(['importing', 'analysing'])

export function sourceLabel(source: BatchItemSource): string {
  return source.kind === 'file' ? basename(source.path) : source.url
}

/** A saved queue as it should come back after a restart. */
export function restoreItems(raw: unknown): BatchItem[] {
  const saved = raw as Partial<SavedQueue> | null
  if (!saved || saved.version !== BATCH_QUEUE_VERSION || !Array.isArray(saved.items)) return []
  return saved.items
    .filter((item): item is BatchItem => !!item && typeof item.id === 'string' && !!item.source && !!item.options)
    .map((item) => ACTIVE.has(item.status)
      ? { ...item, status: 'queued' as const, progress: 0, message: 'Interrupted when Cutawan closed. Start the queue to resume.' }
      : item)
}

export class BatchQueue {
  private items: BatchItem[] = []
  private running = false
  private activeId: string | null = null
  private controller: AbortController | null = null
  private saving: Promise<unknown> = Promise.resolve()
  private loaded: Promise<void> | null = null

  constructor(private readonly deps: BatchDeps) {}

  /** Read the saved queue once; later calls share the first read. */
  load(): Promise<void> {
    this.loaded ??= readFile(this.deps.filePath, 'utf8')
      .then((text) => { this.items = restoreItems(JSON.parse(text)) })
      .catch(() => { this.items = [] })
    return this.loaded
  }

  state(): BatchQueueState {
    return { items: this.items.map((item) => ({ ...item })), running: this.running }
  }

  async add(sources: BatchItemSource[], options: AnalyzeOptions): Promise<BatchQueueState> {
    await this.load()
    const now = Date.now()
    for (const source of sources) {
      this.items.push({
        id: randomUUID(),
        source,
        label: sourceLabel(source),
        // A copy: later changes to the form must not reach queued items.
        options: { ...options },
        status: 'queued',
        progress: 0,
        message: 'Waiting',
        addedAt: now
      })
    }
    await this.changed()
    return this.state()
  }

  async start(): Promise<BatchQueueState> {
    await this.load()
    if (!this.running && this.items.some((item) => item.status === 'queued')) {
      this.running = true
      await this.changed()
      void this.pump()
    }
    return this.state()
  }

  /** Stop after the current item; it finishes rather than wasting the work. */
  async pause(): Promise<BatchQueueState> {
    await this.load()
    this.running = false
    await this.changed()
    return this.state()
  }

  async cancel(id: string): Promise<BatchQueueState> {
    await this.load()
    const item = this.items.find((i) => i.id === id)
    if (item?.status === 'queued') {
      this.update(item, { status: 'cancelled', message: 'Cancelled', progress: 0 })
      await this.changed()
    } else if (item && this.activeId === id) {
      this.controller?.abort()
    }
    return this.state()
  }

  async remove(id: string): Promise<BatchQueueState> {
    await this.load()
    if (this.activeId === id) this.controller?.abort()
    this.items = this.items.filter((i) => i.id !== id)
    await this.changed()
    return this.state()
  }

  async retry(id: string): Promise<BatchQueueState> {
    await this.load()
    const item = this.items.find((i) => i.id === id)
    if (item && (item.status === 'failed' || item.status === 'cancelled')) {
      this.update(item, { status: 'queued', progress: 0, message: 'Waiting', error: undefined })
      await this.changed()
      if (this.running) void this.pump()
    }
    return this.state()
  }

  async clearFinished(): Promise<BatchQueueState> {
    await this.load()
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'cancelled')
    await this.changed()
    return this.state()
  }

  /** Resolves once the queue is idle (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.activeId) await new Promise((resolve) => setTimeout(resolve, 10))
    await this.saving
  }

  private update(item: BatchItem, patch: Partial<BatchItem>): void {
    Object.assign(item, patch)
    if (patch.error === undefined && 'error' in patch) delete item.error
  }

  /** Save and tell the renderer. Saves are queued so they land in order. */
  private changed(): Promise<void> {
    const snapshot: SavedQueue = { version: BATCH_QUEUE_VERSION, items: this.items.map((item) => ({ ...item })) }
    this.deps.emit(this.state())
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.deps.filePath), { recursive: true })
      const temporary = `${this.deps.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(snapshot), 'utf8')
        await rename(temporary, this.deps.filePath)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    const run = this.saving.then(write, write)
    this.saving = run.catch((err) => console.error('Could not save the batch queue:', err))
    return this.saving as Promise<void>
  }

  /** Progress is shown live but not saved: only status changes are worth a write. */
  private progress(item: BatchItem, progress: number, message: string): void {
    this.update(item, { progress, message })
    this.deps.emit(this.state())
  }

  private async pump(): Promise<void> {
    if (this.activeId || !this.running) return
    const item = this.items.find((i) => i.status === 'queued')
    if (!item) {
      this.running = false
      await this.changed()
      return
    }
    const controller = new AbortController()
    this.activeId = item.id
    this.controller = controller
    try {
      if (!item.projectId) {
        this.update(item, { status: 'importing', progress: item.source.kind === 'url' ? -1 : 0, message: 'Importing…' })
        await this.changed()
        const project = item.source.kind === 'file'
          ? await this.deps.importFile(item.source.path)
          : await this.deps.importUrl(item.source.url, (p) => {
            if (p.licence) this.update(item, { licence: p.licence })
            this.progress(item, p.progress, p.message)
          }, controller.signal)
        controller.signal.throwIfAborted()
        this.update(item, {
          projectId: project.id,
          label: project.name,
          ...(project.importLicence ? { licence: project.importLicence } : {})
        })
      }
      this.update(item, { status: 'analysing', progress: 0, message: 'Starting…' })
      await this.changed()
      const analysed = await this.deps.analyze(item.projectId!, item.options, (p) => {
        this.progress(item, p.progress, p.message)
      }, controller.signal)
      this.update(item, { status: 'done', progress: 1, message: 'Done', clipCount: highlightClips(analysed).length })
    } catch (err) {
      if (controller.signal.aborted) {
        this.update(item, { status: 'cancelled', progress: 0, message: 'Cancelled' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.update(item, { status: 'failed', progress: 0, message: 'Failed', error: message })
      }
    } finally {
      this.activeId = null
      this.controller = null
    }
    await this.changed()
    void this.pump()
  }
}
