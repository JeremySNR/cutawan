import { isAbsolute, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import type { HandoffEvent } from '@shared/types'
import { importHandoffPackage } from './handoff'

/**
 * Agent entry point: `cutawan --import-package "<dir-or-zip>"`. The first
 * launch imports the package itself; a later launch hands its arguments to
 * the running app (single-instance lock) and quits, and the running app
 * imports the package and opens it. See docs/metachlorian-handoff.md.
 */

export const IMPORT_PACKAGE_FLAG = '--import-package'

/** What a launch passes the running app through requestSingleInstanceLock. */
export interface LaunchData {
  importPackage: string | null
}

/**
 * The package path from a command line, resolved against the launching
 * shell's directory. Accepts `--import-package <path>` and
 * `--import-package=<path>`. Pure; exported for tests.
 */
export function importPackageArg(argv: readonly string[], cwd: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    let value: string | undefined
    if (arg === IMPORT_PACKAGE_FLAG) value = argv[i + 1]
    else if (arg.startsWith(`${IMPORT_PACKAGE_FLAG}=`)) value = arg.slice(IMPORT_PACKAGE_FLAG.length + 1)
    if (value === undefined) continue
    const path = value.trim().replace(/^"(.*)"$/, '$1')
    if (!path || path.startsWith('--')) return null
    return isAbsolute(path) ? path : resolve(cwd, path)
  }
  return null
}

/**
 * Events wait here until the renderer has subscribed (it drains the queue
 * once on start-up): an import launched from the command line usually
 * finishes copying before the window has loaded.
 */
const queued: HandoffEvent[] = []
let rendererReady = false
let nextImportId = 1

function emit(event: HandoffEvent): void {
  if (rendererReady) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('handoff:event', event)
    }
    return
  }
  // Only the latest progress of an import is worth replaying.
  for (let i = queued.length - 1; i >= 0; i--) {
    if (queued[i].importId === event.importId && queued[i].state === 'importing') queued.splice(i, 1)
  }
  queued.push(event)
}

export function drainHandoffEvents(): HandoffEvent[] {
  rendererReady = true
  return queued.splice(0)
}

/**
 * Import a package named on the command line and tell the renderer to open
 * it. Prints one JSON line for an agent watching stdout:
 * {"project_id": "..."} or {"error": "..."}.
 */
export async function importPackageFromLaunch(path: string): Promise<void> {
  const importId = nextImportId++
  emit({ importId, state: 'importing', progress: -1, message: 'Importing Metachlorian package…' })
  try {
    const project = await importHandoffPackage(path, {
      onProgress: (p) => emit({ importId, state: 'importing', progress: p.progress, message: p.message })
    })
    emit({ importId, state: 'done', projectId: project.id })
    console.log(JSON.stringify({ project_id: project.id }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit({ importId, state: 'failed', message })
    console.log(JSON.stringify({ error: message }))
  }
}
