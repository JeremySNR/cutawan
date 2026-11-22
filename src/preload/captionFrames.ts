import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload for the hidden caption-frame window (main/captionFrames.ts): the
 * four messages its page exchanges with the main process, nothing else.
 */
contextBridge.exposeInMainWorld('captionFrames', {
  onInit: (cb: (spec: unknown) => void): void => {
    ipcRenderer.on('caption-frames:init', (_e, spec: unknown) => cb(spec))
  },
  onDraw: (cb: (request: unknown) => void): void => {
    ipcRenderer.on('caption-frames:draw', (_e, request: unknown) => cb(request))
  },
  ready: (result: unknown): void => ipcRenderer.send('caption-frames:ready', result),
  drawn: (result: unknown): void => ipcRenderer.send('caption-frames:drawn', result)
})
