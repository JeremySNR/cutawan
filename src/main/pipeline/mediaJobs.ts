import { availableParallelism, freemem, totalmem } from 'node:os'

/** Shared admission across projects: do not multiply per-stage concurrency. */
export class MediaQueue {
  private active = 0
  private waiting: Array<{ start: () => void; priority: number }> = []

  constructor(private readonly capacity: () => number, private readonly ceiling = 2) {}

  run<T>(work: () => Promise<T>, signal?: AbortSignal, priority = 0): Promise<T> {
    signal?.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        this.waiting = this.waiting.filter(item => item !== job)
        reject(signal?.reason ?? new Error('Cancelled'))
      }
      const job = { priority, start: (): void => {
        signal?.removeEventListener('abort', abort)
        this.active++
        void Promise.resolve().then(() => { signal?.throwIfAborted(); return work() }).then(resolve, reject)
          .finally(() => { this.active--; this.drain() })
      } }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiting.push(job)
      this.waiting.sort((a, b) => b.priority - a.priority)
      this.drain()
    })
  }

  private drain(): void {
    const limit = Math.max(1, Math.min(this.ceiling, this.capacity()))
    while (this.active < limit && this.waiting.length) this.waiting.shift()!.start()
  }
}

const GiB = 1024 ** 3
/** Network waits never occupy the local decoder/inference budget. Share this
 * ceiling across providers, including a settings change while work is active. */
export const analysisRequests = new MediaQueue(() => totalmem() >= 8 * GiB ? 2 : 1)
/**
 * Requests to a hosted analysis API. These are waits on someone else's
 * machine, not work on this one, so they are bounded by what a provider's
 * rate limit comfortably takes rather than by local memory. (ChatGPT sign-in
 * runs a local Codex process per request and stays on `analysisRequests`.)
 */
export const apiRequests = new MediaQueue(() => 4, 4)
export const mediaJobs = new MediaQueue(() =>
  totalmem() >= 12 * GiB && freemem() >= 4 * GiB && availableParallelism() >= 8 ? 2 : 1)

/** Leave CPU capacity for playback; two admitted tasks share at most eight threads. */
export const mediaThreads = (): number => Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
