import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { app } from 'electron'
import type { BrowserCookieSource, ImportProgress } from '@shared/types'
import { CHROMIUM_BROWSERS } from '@shared/cookies'
import { FFMPEG_PATH } from './ffmpeg'

/**
 * yt-dlp integration for URL imports. The standalone binary (~30 MB per
 * platform) is downloaded from the official GitHub releases into userData on
 * first use rather than bundled with the app.
 */

type ProgressFn = (p: ImportProgress) => void

/** Failure of the yt-dlp process itself (as opposed to our own validation). */
export class YtDlpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YtDlpError'
  }
}

function binaryName(): string {
  switch (process.platform) {
    case 'win32':
      return 'yt-dlp.exe'
    case 'darwin':
      return 'yt-dlp_macos'
    default:
      return 'yt-dlp_linux'
  }
}

function binaryDir(): string {
  const base = app?.getPath?.('userData') ?? join(process.cwd(), '.tmp', 'userData')
  return join(base, 'bin')
}

export function ytDlpPath(): string {
  return join(binaryDir(), binaryName())
}

/** Directory passed to --plugin-dirs (contains yt_dlp_plugins/). */
export function ytDlpPluginDir(): string {
  if (app?.isPackaged) return join(process.resourcesPath, 'yt-dlp-plugins')
  return join(process.cwd(), 'resources', 'yt-dlp-plugins')
}

export async function ensureYtDlp(onProgress: ProgressFn): Promise<string> {
  const binPath = ytDlpPath()
  if (existsSync(binPath)) return binPath

  onProgress({ progress: -1, message: 'Downloading yt-dlp (one-time setup)…' })
  await mkdir(binaryDir(), { recursive: true })
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName()}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Could not download yt-dlp (HTTP ${res.status}). Check your connection.`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  const tmpPath = `${binPath}.download`
  let seen = 0
  async function* withProgress(source: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
    for await (const chunk of source) {
      seen += chunk.length
      if (total > 0) {
        onProgress({
          progress: Math.min(1, seen / total) * 0.15,
          message: 'Downloading yt-dlp (one-time setup)…'
        })
      }
      yield chunk
    }
  }
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream),
    withProgress,
    createWriteStream(tmpPath)
  )
  await chmod(tmpPath, 0o755)
  await rename(tmpPath, binPath)
  return binPath
}

export interface UrlVideoMeta {
  id: string
  title: string
  durationSec: number
  webpageUrl: string
  /**
   * The licence the site reports, e.g. YouTube's "Creative Commons
   * Attribution license (reuse allowed)". Null when the site reports none,
   * which on YouTube means the standard licence.
   */
  license: string | null
}

export interface CookieAuthOptions {
  cookiesFromBrowser?: BrowserCookieSource
  /** Netscape-format cookies.txt path. Takes priority over browser extraction. */
  cookiesFile?: string | null
}

/**
 * Args that let yt-dlp reuse the login session from the user's browser, or a
 * saved cookies.txt export. Private/unlisted videos and enterprise Vimeo
 * behind SSO work this way without any server-side integration.
 */
export function cookieArgs(opts: CookieAuthOptions): string[] {
  if (opts.cookiesFile && existsSync(opts.cookiesFile)) {
    return ['--cookies', opts.cookiesFile]
  }
  if (opts.cookiesFromBrowser) {
    return ['--cookies-from-browser', opts.cookiesFromBrowser]
  }
  return []
}

/** Load the cookie-unlock plugin so Chromium DBs can be read while open. */
export function pluginArgs(opts: CookieAuthOptions): string[] {
  const dir = ytDlpPluginDir()
  if (!existsSync(dir)) return []
  const usesChromiumCookies =
    (opts.cookiesFromBrowser && CHROMIUM_BROWSERS.has(opts.cookiesFromBrowser)) ||
    Boolean(opts.cookiesFile)
  return usesChromiumCookies || opts.cookiesFromBrowser ? ['--plugin-dirs', dir] : []
}

/** Surface a clear next step when a site refuses the anonymous request. */
export function isAuthError(message: string): boolean {
  return /log ?in|sign ?in|password|private|members only|purchase|cookies|401|403|authoriz/i.test(
    message
  )
}

/** yt-dlp could not read a Chromium cookie database (browser open / locked). */
export function isCookieCopyError(message: string): boolean {
  return /could not copy chrome cookie database|permission denied.*cookies/i.test(message)
}

/** Windows Chromium v20+ app-bound encryption; yt-dlp cannot decrypt outside the browser. */
export function isDpapiDecryptError(message: string): boolean {
  return /failed to decrypt with dpapi|cannot decrypt v\d+ cookies|no key found/i.test(message)
}

export function cookieDpapiErrorHint(hasCookiesFile: boolean): string {
  if (hasCookiesFile) {
    return 'Your cookies file is set but the import still failed. Open the Vimeo video in your browser while signed in, re-export cookies with the Get cookies.txt LOCALLY extension, import the new file, and retry.'
  }
  return [
    'Windows encrypts Chrome/Edge cookies so other apps cannot read them (this is a Chromium security change, not a Cutawan bug).',
    'Use Import cookies file below: sign in to Vimeo in your browser, export with the Get cookies.txt LOCALLY extension, then import the .txt file.',
    'Or pick Firefox in the browser list. Firefox cookies still work with browser login on Windows.'
  ].join(' ')
}

/** Chromium on Windows uses DPAPI app-bound encryption; fail fast with a clear fix. */
export function assertCookieAuthSupported(opts: CookieAuthOptions): void {
  const hasFile = Boolean(opts.cookiesFile && existsSync(opts.cookiesFile))
  if (
    process.platform === 'win32' &&
    opts.cookiesFromBrowser &&
    CHROMIUM_BROWSERS.has(opts.cookiesFromBrowser) &&
    !hasFile
  ) {
    throw new YtDlpError(cookieDpapiErrorHint(false))
  }
}

export function cookieCopyErrorHint(browser: BrowserCookieSource, hasCookiesFile: boolean): string {
  if (hasCookiesFile) {
    return 'Your cookies file is set but the import still failed. Re-export it from the browser while signed in to the site (use the Get cookies.txt LOCALLY extension), then import the new file and retry.'
  }
  const parts = [
    'Chrome and other Chromium browsers lock their cookie store while they are open, so Cutawan could not borrow the login.'
  ]
  if (browser && CHROMIUM_BROWSERS.has(browser)) {
    parts.push(
      'Try Firefox in the browser picker (it usually works while open), fully quit Chrome and retry, or import a cookies.txt file instead.'
    )
  } else if (browser) {
    parts.push(
      'Make sure you are signed in to the site in that browser, or import a cookies.txt file instead.'
    )
  }
  parts.push(
    'To import a cookies file: sign in to the site in your browser, use the "Get cookies.txt LOCALLY" extension to export, then click Import cookies file below.'
  )
  return parts.join(' ')
}

function runYtDlp(
  binPath: string,
  args: string[],
  onLine?: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      stdout += text
      if (onLine) {
        lineBuf += text
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 65536) stderr = stderr.slice(-32768)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new YtDlpError(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
    })
  })
}

let selfUpdatedThisRun = false

/**
 * Sites change their players constantly and an out-of-date yt-dlp is the most
 * common cause of extractor failures. When a yt-dlp invocation fails, run the
 * binary's built-in self-updater once per app session and retry.
 */
export async function withSelfUpdateRetry<T>(
  binPath: string,
  onProgress: ProgressFn,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof YtDlpError) || selfUpdatedThisRun) throw err
    selfUpdatedThisRun = true
    onProgress({ progress: -1, message: 'Updating yt-dlp…' })
    try {
      await runYtDlp(binPath, ['-U'])
    } catch {
      throw err // updater itself failed; surface the original error
    }
    return fn()
  }
}

function cleanYtDlpError(stderr: string): string {
  const line = stderr
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('ERROR:'))
  return line ? line.replace(/^ERROR:\s*(\[[^\]]+\]\s*[^\s:]*:?\s*)?/, '').trim() : ''
}

interface YtDlpJson {
  _type?: string
  id?: string
  title?: string
  duration?: number
  webpage_url?: string
  url?: string
  license?: string | null
  entries?: YtDlpJson[]
}

function baseArgs(cookieOpts: CookieAuthOptions): string[] {
  return [...pluginArgs(cookieOpts), ...cookieArgs(cookieOpts)]
}

export async function fetchUrlMeta(
  binPath: string,
  url: string,
  cookieOpts: CookieAuthOptions = {},
  signal?: AbortSignal
): Promise<UrlVideoMeta> {
  const out = await runYtDlp(binPath, [
    '-J',
    '--no-playlist',
    '--no-warnings',
    ...baseArgs(cookieOpts),
    url
  ], undefined, signal)
  let data = JSON.parse(out) as YtDlpJson

  // Some sites (e.g. archive.org items with several files) resolve to a
  // playlist. Pick the longest entry — almost always the main video.
  if (data._type === 'playlist') {
    const entries = (data.entries ?? []).filter((e) => (e.duration ?? 0) > 0)
    if (entries.length === 0) {
      throw new Error('This URL does not contain a downloadable video.')
    }
    const main = entries.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a))
    // Prefer the entry's direct media URL: the entry webpage_url often points
    // back at the playlist page, which would re-resolve to all files.
    data = { ...main, title: main.title ?? data.title, license: main.license ?? data.license,
      webpage_url: main.url ?? main.webpage_url }
  }

  if (!data.duration || data.duration <= 0) {
    throw new Error('This URL does not point to a downloadable video.')
  }
  return {
    id: data.id ?? 'video',
    title: data.title ?? 'Imported video',
    durationSec: data.duration,
    webpageUrl: data.webpage_url ?? data.url ?? url,
    license: typeof data.license === 'string' && data.license.trim() ? data.license.trim() : null
  }
}

const DOWNLOAD_FORMAT = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b'

export async function downloadUrlVideo(
  binPath: string,
  url: string,
  outPath: string,
  onProgress: ProgressFn,
  cookieOpts: CookieAuthOptions = {},
  signal?: AbortSignal
): Promise<void> {
  await runYtDlp(
    binPath,
    [
      '-f', DOWNLOAD_FORMAT,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG_PATH,
      '--no-playlist',
      '--no-warnings',
      '--newline',
      ...baseArgs(cookieOpts),
      '-o', outPath,
      url
    ],
    (line) => {
      const match = line.match(/\[download\]\s+([\d.]+)%/)
      if (match) {
        // Map download to 0.15..0.95 of the import (after binary setup).
        const fraction = Number(match[1]) / 100
        onProgress({ progress: 0.15 + fraction * 0.8, message: 'Downloading video…' })
      } else if (line.includes('[Merger]')) {
        onProgress({ progress: 0.96, message: 'Merging streams…' })
      }
    },
    signal
  )
}
