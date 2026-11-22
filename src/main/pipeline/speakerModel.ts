import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { app } from 'electron'
import { modelsDir } from './detect'

/**
 * The speaker-embedding model for diarization: 3D-Speaker CAM++ trained on
 * VoxCeleb (iic/speech_campplus_sv_en_voxceleb_16k), as exported to ONNX by
 * the sherpa-onnx project. 512-d embeddings from 80-bin Kaldi fbank,
 * 0.65% EER on VoxCeleb1-O per 3D-Speaker's model card.
 *
 * Licence: Apache-2.0 (3D-Speaker repository and ModelScope model card;
 * sherpa-onnx, which hosts the export, is Apache-2.0 too). Trained on
 * VoxCeleb, whose data is CC BY 4.0. See docs/speaker-diarization.md.
 *
 * At 29.6 MB it would quadruple the bundled models, and only clip finding
 * on multi-speaker sources benefits, so it is downloaded on first use into
 * userData/models and verified by SHA-256 against the value pinned here. A
 * copy in resources/models (a packager's choice) is used as is. Offline,
 * or if the download fails, diarization is simply skipped and the download
 * retried after the app restarts.
 */

export const SPEAKER_MODEL_FILE = 'campplus-voxceleb-en.onnx'
export const SPEAKER_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'
export const SPEAKER_MODEL_SHA256 = '98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5'
export const SPEAKER_MODEL_BYTES = 29596979
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

function cacheDir(): string | null {
  const base = app?.getPath?.('userData')
  return base ? join(base, 'models') : null
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const verified = new Set<string>()

async function isValid(path: string): Promise<boolean> {
  if (verified.has(path)) return existsSync(path)
  try {
    if ((await stat(path)).size !== SPEAKER_MODEL_BYTES) return false
    if ((await sha256File(path)) !== SPEAKER_MODEL_SHA256) return false
    verified.add(path)
    return true
  } catch {
    return false
  }
}

/** Download `url` to `dest`, refusing anything that does not hash to `sha256`. */
export async function downloadVerified(url: string, dest: string, sha256: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const res = await fetch(url, { redirect: 'follow', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!res.ok || !res.body) throw new Error(`Speaker model download failed (HTTP ${res.status}).`)
  const tmp = `${dest}.download`
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length
      if (bytes > maxBytes) { done(new Error('Speaker model download is larger than expected.')); return }
      hash.update(chunk)
      done(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), meter, createWriteStream(tmp))
    const digest = hash.digest('hex')
    if (digest !== sha256) throw new Error(`Speaker model checksum mismatch (${digest}).`)
    await rename(tmp, dest)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

let pending: Promise<string | null> | null = null
/** A failed download is not retried on every run of the same session. */
let downloadFailed = false

/**
 * Path to a verified speaker model, downloading it once if needed; null when
 * it is unavailable (offline, download refused, no userData outside
 * Electron). Never throws except when `signal` aborts.
 *
 * Concurrent callers share one download, which belongs to none of them: it
 * runs under its own timeout, and `signal` only abandons this caller's wait.
 * A download that outlives the run that started it finishes in the
 * background and serves the next one. After a failed download the model is
 * reported unavailable until the app restarts, so a persistent failure does
 * not fetch 30 MB again on every run.
 */
export function speakerModelPath(signal?: AbortSignal): Promise<string | null> {
  const override = process.env.CUTAWAN_SPEAKER_MODEL
  if (override) return Promise.resolve(existsSync(override) ? override : null)
  if (signal?.aborted) return Promise.reject(signal.reason)
  pending ??= resolveModel().finally(() => { pending = null })
  return signal ? abandonable(pending, signal) : pending
}

/** `work`, or a rejection as soon as `signal` aborts; `work` itself carries on. */
function abandonable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function resolveModel(): Promise<string | null> {
  const bundled = join(modelsDir(), SPEAKER_MODEL_FILE)
  if (existsSync(bundled)) return bundled
  const dir = cacheDir()
  if (!dir) return null
  const cached = join(dir, SPEAKER_MODEL_FILE)
  if (await isValid(cached)) return cached
  if (downloadFailed) return null
  try {
    await mkdir(dir, { recursive: true })
    await rm(cached, { force: true })
    await downloadVerified(SPEAKER_MODEL_URL, cached, SPEAKER_MODEL_SHA256, SPEAKER_MODEL_BYTES)
    verified.add(cached)
    return cached
  } catch (error) {
    downloadFailed = true
    console.warn('Speaker model unavailable; diarization skipped until the app restarts:', error instanceof Error ? error.message : error)
    return null
  }
}
