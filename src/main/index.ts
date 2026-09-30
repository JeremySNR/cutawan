import { app, BrowserWindow, nativeTheme, protocol, screen, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrateLegacyCookiesDir } from './cookies'
import { registerIpcHandlers } from './ipc'
import { isMediaPathAllowed, serveMediaFile } from './mediaAccess'
import { initialWindowSize, MIN_WINDOW } from './windowSize'
import { resolveUserDataPath } from './userData'
import { stopInference } from './inference/client'
import { validatePackage } from './packageValidation'

app.setName('Cutawan')
app.setPath('userData', resolveUserDataPath(app.getPath('appData'), process.env.CUTAWAN_USER_DATA))

// Backstop: a stray rejection or throw in a background task (pipeline stages,
// network calls) would otherwise take the whole app down by Node's default.
// Log it and keep running — individual features already surface their own
// errors to the renderer.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})

// Before Chromium touches the profile: older versions kept imported cookie
// files in `userData/cookies`, which collides with Chromium's own `Cookies`
// database on case-insensitive filesystems and breaks the network service (see
// cookies.ts). Must run synchronously at startup, not after app ready.
migrateLegacyCookiesDir()

function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build/icon.png')
}

async function runSmokeCapture(win: BrowserWindow, dir: string): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const shot = async (name: string): Promise<void> => {
    const image = await win.webContents.capturePage()
    await writeFile(join(dir, `${name}.png`), image.toPNG())
  }
  /**
   * Wait for an element, then click it. Waiting beats a fixed sleep: the
   * project list arrives over IPC and the editor mounts a video, so how long a
   * screen takes depends on the machine — and a click that landed early left
   * the walk on the previous screen, shooting it again under the next name.
   */
  const click = async (selector: string): Promise<void> => {
    const query = `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    const deadline = Date.now() + 20000
    while (!(await win.webContents.executeJavaScript(query))) {
      if (Date.now() > deadline) throw new Error(`Smoke capture: no ${selector}`)
      await sleep(250)
    }
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).click()`
    )
    // Let React paint whatever the click navigated to.
    await sleep(900)
  }

  await sleep(2500)
  if (process.env.CUTAWAN_SMOKE_WIZARD) {
    await shot('setup-wizard')
    // OpenRouter route: key entry plus the searchable model pickers.
    const reveal = (selector: string): Promise<void> => win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' })`
    )
    await click('[data-testid="setup-route-openrouter"]')
    await reveal('[data-testid="openrouter-setup"]')
    await shot('setup-openrouter')
    await click('[data-testid="openrouter-model-toggle"]')
    await reveal('[data-testid="openrouter-model"]')
    await shot('setup-openrouter-models')
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[data-testid="openrouter-model-search"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'claude')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(400)
    await shot('setup-openrouter-search')
    await click('[data-testid="openrouter-model-toggle"]')
    await click('[data-testid="openrouter-transcription-toggle"]')
    await reveal('[data-testid="openrouter-transcription"]')
    await shot('setup-openrouter-transcription')
    await click('[data-testid="openrouter-transcription-option-local-whisper"]')
    await reveal('[data-testid="openrouter-transcription"]')
    await shot('setup-openrouter-local')
    app.quit()
    return
  }
  if (process.env.CUTAWAN_SMOKE_UPDATES) {
    await click('[data-testid="update-notification"]')
    const valid = await win.webContents.executeJavaScript(`
      document.body.innerText.includes('Download Mac installer') &&
      !document.body.innerText.includes('Pulls the latest code') &&
      !document.body.innerText.includes('Download and install')
    `)
    if (!valid) throw new Error('Unsigned Mac update route did not offer a manual download')
    await shot('manual-update')
    // Exercise notifications and UI recovery without opening a real installer.
    win.webContents.send('update:state', { status: 'downloading', progress: 0.42, mode: 'manual', version: '99.0.0' })
    await sleep(300)
    if (!await win.webContents.executeJavaScript("document.body.innerText.includes('42%')")) throw new Error('Missing download progress')
    await shot('update-downloading')
    win.webContents.send('update:state', { status: 'error', progress: 0, mode: 'manual', version: '99.0.0', error: 'Test download interruption' })
    await sleep(300)
    if (!await win.webContents.executeJavaScript("document.body.innerText.includes('Retry download')")) throw new Error('Missing download retry')
    await shot('update-retry')
    win.webContents.send('update:state', { status: 'downloaded', progress: 1, mode: 'manual', version: '99.0.0' })
    await sleep(300)
    if (!await win.webContents.executeJavaScript("document.body.innerText.includes('Installer ready') && document.body.innerText.includes('Open installer for v99.0.0')")) throw new Error('Missing installer ready notification')
    await shot('update-ready')
    app.quit()
    return
  }
  // Seeded profiles have projects and no record of seen notes, so the
  // after-update "What's new" dialog opens; capture and dismiss it.
  if (await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="whats-new"]'))`)) {
    await shot('whats-new')
    await click('[data-testid="whats-new-close"]')
  }
  await shot('home')
  await click('[data-testid="project-card"]')
  await shot('clips')
  await click('[data-testid="clip-thumb"]')
  await sleep(800)
  await shot('editor')
  // Timeline editing with real key events: two razor splits, select the
  // middle piece, ripple-delete it, then undo.
  const key = async (keyCode: string, modifiers: Array<'meta' | 'control'> = []): Promise<void> => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(250)
  }
  const hasText = (text: string): Promise<boolean> =>
    win.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(text)})`)
  for (let i = 0; i < 4; i++) await key('L')
  await key('S')
  for (let i = 0; i < 3; i++) await key('L')
  await key('S')
  await win.webContents.executeJavaScript(`(() => {
    const track = document.querySelector('[data-testid="trim-track"]')
    const rect = track.getBoundingClientRect()
    const splits = [...document.querySelectorAll('[data-testid="trim-track"] .bg-amber-300')]
    const x = splits.length >= 2
      ? (splits[0].getBoundingClientRect().left + splits[1].getBoundingClientRect().left) / 2
      : rect.left + rect.width / 2
    track.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, bubbles: true }))
  })()`)
  await sleep(400)
  await key('Delete')
  await sleep(600)
  if (!(await hasText('1 cut'))) throw new Error('Smoke capture: splitting and deleting a piece did not cut it')
  if (!(await hasText('Review edits'))) throw new Error('Smoke capture: a cut did not mark the editorial assessment stale')
  await shot('editor-cut')
  await key('Z', [process.platform === 'darwin' ? 'meta' : 'control'])
  await sleep(600)
  if (await hasText('1 cut')) throw new Error('Smoke capture: undo did not restore the cut piece')
  if (await hasText('Review edits')) throw new Error('Smoke capture: undo did not restore the assessed selection')
  // Out to the setup screen, which is where the two modes are chosen.
  await click('[data-testid="back-button"]')
  await click('[data-testid="regenerate-button"]')
  await shot('setup-clips')
  if (await win.webContents.executeJavaScript(`document.querySelector('[data-testid="editorial-ranking-toggle"]').checked`)) {
    throw new Error('Smoke capture: editorial ranking must be opt-in on a new project')
  }
  await click('[data-testid="editorial-ranking-toggle"]')
  if (!await win.webContents.executeJavaScript(`document.querySelector('[data-testid="editorial-ranking-toggle"]').checked`)) {
    throw new Error('Smoke capture: editorial ranking could not be enabled')
  }
  await click('[data-testid="editorial-ranking-toggle"]')
  await click('[data-testid="visual-discovery-toggle"]')
  if (!await win.webContents.executeJavaScript(`document.querySelector('[data-testid="visual-discovery-toggle"]').checked`)) {
    throw new Error('Smoke capture: visual discovery could not be enabled')
  }
  await shot('setup-visual-discovery')
  await click('[data-testid="visual-discovery-toggle"]')
  await click('[data-testid="mode-whole-video"]')
  await shot('setup-caption-video')
  // Run the mode for real. The seeded demo already has a transcript, so this
  // makes no API calls: it reframes, builds the full-video edit and opens it.
  await click('[data-testid="start-button"]')
  await click('[data-testid="whole-video-badge"]')
  await sleep(1200)
  await shot('editor-caption-video')
  await click('[data-testid="settings-button"]')
  await shot('settings')
  await click('[data-testid="settings-nav-export"]')
  await sleep(400)
  await shot('settings-export')
  app.quit()
}

// Serves local media (source videos, thumbnails) to the sandboxed renderer.
// URL shape: media://file/<encodeURIComponent(absolutePath)>
// `standard` matters: Chromium's media loader aborts its second range request
// on non-standard schemes, which broke <video> playback of files over ~2 MB.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function applyAppIcon(): void {
  const icon = appIconPath()
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }
}

function createWindow(): void {
  // A floating window with margin around it, never edge-to-edge (and never
  // larger than the work area on small laptop displays).
  const { width, height } = process.env.CUTAWAN_SMOKE_WIZARD
    ? { width: 1100, height: 680 }
    : process.env.CUTAWAN_SMOKE
      ? { width: 1600, height: 1000 }
    : initialWindowSize(screen.getPrimaryDisplay().workAreaSize)
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    center: true,
    show: false,
    autoHideMenuBar: true,
    title: 'Cutawan',
    icon: appIconPath(),
    // macOS gets the native frosted-glass treatment: system vibrancy showing
    // through a translucent shell (the renderer lightens its surfaces via the
    // `mac-glass` body class), an inset title bar and our top bar as the drag
    // region. Other platforms keep the solid dark background.
    ...(isMac
      ? {
          backgroundColor: '#00000000',
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 20 }
        }
      : { backgroundColor: '#09090b' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      backgroundThrottling: !process.env.CUTAWAN_SMOKE,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => { if (!process.env.CUTAWAN_SMOKE) win.show() })

  // Headless smoke test hook: CUTAWAN_SMOKE=/dir walks the main screens,
  // capturing a screenshot of each, then quits (see scripts/smoke-test.sh).
  const smokeDir = process.env.CUTAWAN_SMOKE
  if (smokeDir) {
    win.webContents.on('did-finish-load', () => {
      void runSmokeCapture(win, smokeDir).catch((error) => {
        console.error('Screenshot capture failed:', error)
        app.exit(1)
      })
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (process.env.CUTAWAN_PACKAGE_CHECK) {
    void validatePackage(process.env.CUTAWAN_PACKAGE_CHECK).then(() => app.quit()).catch(error => {
      console.error('Packaged validation failed:', error)
      stopInference()
      app.exit(1)
    })
    return
  }
  // The UI is a dark, near-monochrome design and (on macOS) leans on native
  // vibrancy showing through translucent surfaces. Under the system's light
  // appearance that blur turns the window a washed-out grey, so we pin the
  // whole app to dark regardless of the OS setting.
  nativeTheme.themeSource = 'dark'

  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    // Only serve files the app registered (project media), never arbitrary disk paths.
    if (!isMediaPathAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }
    return serveMediaFile(filePath, request.headers.get('range'))
  })

  registerIpcHandlers()
  applyAppIcon()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopInference)
