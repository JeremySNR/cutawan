import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InferenceRequest, InferenceResponse, TensorData } from './protocol'

/** Serialize native inference across clips and contain a native crash to one child. */
export class InferenceClient {
  private child: ChildProcess | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private nextId = 0
  private failure: Error | null = null
  peakRssBytes = 0
  private idle: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly workerPath: string,
    private readonly execArgv: string[] = [],
    private readonly timeoutMs = 120_000,
    /** What stops when the child fails, for the error the user sees. */
    private readonly feature = 'Automatic framing'
  ) {}

  run(modelPath: string, inputs: Record<string, TensorData>, signal?: AbortSignal,
    vad?: InferenceRequest['vad'], int64Inputs?: InferenceRequest['int64Inputs']): Promise<Record<string, TensorData>> {
    const result = this.queue.then(() => this.execute(modelPath, inputs, signal, vad, int64Inputs))
    this.queue = result.catch(() => undefined)
    return result
  }

  close(): void {
    clearTimeout(this.idle)
    const child = this.child
    this.child = null
    child?.kill('SIGKILL')
  }

  private execute(modelPath: string, inputs: Record<string, TensorData>, signal?: AbortSignal,
    vad?: InferenceRequest['vad'], int64Inputs?: InferenceRequest['int64Inputs']): Promise<Record<string, TensorData>> {
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    clearTimeout(this.idle)
    let child = this.child
    if (!child) {
      child = fork(this.workerPath, [], {
        execArgv: this.execArgv,
        // Use Electron's bundled Node runtime without starting a second GUI app.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      this.child = child
      child.on('error', () => undefined) // Each request installs its own rejection handler.
      child.on('exit', () => { if (this.child === child) this.child = null })
    }
    const active = child
    active.ref()
    active.channel?.ref()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      const finish = (error?: Error, outputs?: Record<string, TensorData>): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        active.removeListener('message', message)
        active.removeListener('exit', exit)
        active.removeListener('error', failed)
        active.stderr?.removeListener('data', log)
        if (this.child === active) {
          active.unref()
          active.channel?.unref()
          this.idle = setTimeout(() => this.close(), 15_000)
          this.idle.unref()
        }
        if (error) reject(error)
        else resolve(outputs!)
      }
      const failed = (error: Error): void => {
        this.failure = new Error(`${this.feature} stopped because the inference process failed. Restart Cutawan to retry. ${error.message}`)
        this.close()
        finish(this.failure)
      }
      const exit = (code: number | null, reason: NodeJS.Signals | null): void =>
        failed(new Error(`Exit ${reason ?? code}. ${stderr.trim()}`))
      const abort = (): void => {
        this.close()
        finish(new Error('Inference cancelled', { cause: signal?.reason }))
      }
      const message = (response: InferenceResponse): void => {
        if (response.id !== id) return
        this.peakRssBytes = Math.max(this.peakRssBytes, response.peakRssBytes ?? 0)
        finish(response.error ? new Error(response.error) : undefined, response.outputs)
      }
      const log = (data: Buffer): void => { stderr = (stderr + data.toString()).slice(-4096) }
      const timeout = setTimeout(() => failed(new Error('Inference timed out.')), this.timeoutMs)
      active.on('message', message)
      active.once('exit', exit)
      active.once('error', failed)
      active.stderr?.on('data', log)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      try {
        active.send({ id, modelPath, inputs, vad, int64Inputs }, error => { if (error && !settled) failed(error) })
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

const compiledWorker = join(__dirname, 'inferenceWorker.js')

/**
 * A separate inference child. Long whole-source analyses use their own so a
 * failure there (which latches a client until restart) cannot take down
 * automatic framing, and so they can run alongside the shared one.
 */
export function createInferenceClient(timeoutMs?: number, feature?: string): InferenceClient {
  const client = new InferenceClient(
    existsSync(compiledWorker) ? compiledWorker : join(__dirname, 'worker.ts'),
    process.versions.electron ? [] : process.execArgv,
    timeoutMs,
    feature
  )
  process.once('exit', () => client.close())
  return client
}

const inference = createInferenceClient()
export const runInference = inference.run.bind(inference)
export const stopInference = inference.close.bind(inference)
export const inferencePeakRssBytes = (): number => inference.peakRssBytes
