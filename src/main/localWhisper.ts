import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportProgress } from '@shared/types'

export type LocalWhisperModel = 'small' | 'large-v3'
export interface LocalWhisperInstallResult { pythonPath: string; modelPath: string }

let currentInstall: AbortController | null = null

export function localWhisperPaths(root: string, platform = process.platform): {
  environment: string; python: string; models: string
} {
  const environment = join(root, 'local-whisper', 'venv')
  return {
    environment,
    python: join(environment, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python'),
    models: join(root, 'local-whisper', 'models')
  }
}

function installScript(): string {
  return app.isPackaged ? join(process.resourcesPath, 'local-whisper', 'install.py')
    : join(app.getAppPath(), 'resources', 'local-whisper', 'install.py')
}

function run(command: string, args: string[], signal: AbortSignal, progress: (message: string) => void): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32' })
    let tail = ''
    let finished = false
    const stop = (): void => {
      if (!child.pid) { child.kill(); return }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true })
        killer.on('error', () => child.kill())
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
      }
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', stop)
      app.removeListener('before-quit', stop)
    }
    const done = (error?: Error): void => {
      if (finished) return
      finished = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
    app.once('before-quit', stop)
    if (signal.aborted) stop()
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      const chunk = String(data)
      tail = (tail + chunk).slice(-3000)
      const line = chunk.trim().split('\n').at(-1)?.trim()
      if (line) progress(line.slice(0, 180))
    })
    child.on('error', error => done(new Error(`Could not run ${command}: ${error.message}`)))
    child.on('close', code => done(signal.aborted
      ? new Error('Whisper installation cancelled. You can retry to resume the download.')
      : code === 0 ? undefined : new Error(`Whisper installation failed (${code}). ${tail.trim()}`)))
  })
}

/**
 * Pinned, so an install made today matches one tested here. Unpinned,
 * faster-whisper 1.2.1 pulled PyAV 19, which removed an argument it passes
 * (issue #82). Transcription now decodes with Cutawan's ffmpeg anyway, but
 * the pins keep the rest of the stack known-good. Bump them deliberately.
 */
export const WHISPER_PACKAGES = ['faster-whisper==1.2.1', 'av>=11,<19', 'huggingface-hub']

export function cancelLocalWhisperInstall(): void { currentInstall?.abort() }

export async function installLocalWhisper(
  model: LocalWhisperModel,
  requestedPython: string,
  onProgress: (progress: ImportProgress) => void
): Promise<LocalWhisperInstallResult> {
  if (model !== 'small' && model !== 'large-v3') throw new Error('Unsupported Whisper model.')
  if (currentInstall) throw new Error('Whisper installation is already running.')
  const controller = new AbortController()
  currentInstall = controller
  const paths = localWhisperPaths(app.getPath('userData'))
  const modelPath = join(paths.models, model)
  const announce = (progress: number, message: string): void => onProgress({ progress, message })
  try {
    await mkdir(paths.models, { recursive: true })
    if (!existsSync(paths.python)) {
      announce(0.05, 'Creating a private Python environment…')
      const chosen = requestedPython.trim() || 'python'
      try {
        await run(chosen, ['-m', 'venv', paths.environment], controller.signal, message => announce(0.1, message))
      } catch (error) {
        if (chosen !== 'python' || process.platform === 'win32' || !(error instanceof Error) || !error.message.includes('Could not run')) throw error
        await run('python3', ['-m', 'venv', paths.environment], controller.signal, message => announce(0.1, message))
      }
    }
    announce(0.2, 'Installing faster-whisper in the private environment…')
    await run(paths.python, ['-m', 'pip', 'install', '--disable-pip-version-check', ...WHISPER_PACKAGES],
      controller.signal, message => announce(0.3, message))
    // Apple Silicon also gets the MLX build, which transcribes on the GPU.
    // Optional: the CPU path still works if it cannot be installed.
    let gpu = false
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      announce(0.35, 'Installing Apple Silicon acceleration…')
      try {
        await run(paths.python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'mlx-whisper'],
          controller.signal, message => announce(0.4, message))
        gpu = true
      } catch (error) {
        controller.signal.throwIfAborted()
        console.warn('Apple Silicon Whisper acceleration unavailable; using the CPU:', error)
      }
    }
    announce(0.45, `Downloading the ${model} speech model…`)
    const download = (withGpu: boolean): Promise<void> =>
      run(paths.python, ['-u', installScript(), model, modelPath, ...(withGpu ? ['--mlx'] : [])],
        controller.signal, message => announce(-1, message))
    try {
      await download(gpu)
    } catch (error) {
      // MLX weights are optional; a failed GPU download must not block the CPU model.
      controller.signal.throwIfAborted()
      if (!gpu) throw error
      console.warn('Apple Silicon Whisper model unavailable; using the CPU:', error)
      await download(false)
    }
    announce(0.95, 'Checking the local transcription setup…')
    await run(paths.python, ['-c', 'import ctranslate2, faster_whisper; print("ready")'], controller.signal, () => {})
    announce(1, 'Local Whisper is ready.')
    return { pythonPath: paths.python, modelPath }
  } finally {
    currentInstall = null
  }
}
