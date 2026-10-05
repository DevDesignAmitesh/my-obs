import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session } from 'electron'
import type { DisplaySource, Hotkey } from '@shared/api'

/**
 * Screen/window capture. The renderer calls `capture:prepare` with the source it wants, then
 * `navigator.mediaDevices.getDisplayMedia()`; our request handler answers with that source
 * (and Windows system-audio loopback when asked) without showing a picker.
 */
let pending: { sourceId?: string; audio: boolean } = { audio: false }

export function registerCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const video = sources.find((s) => s.id === pending.sourceId) ?? sources.find((s) => s.id.startsWith('screen:'))
      if (!video) return callback({})
      callback(pending.audio ? { video, audio: 'loopback' } : { video })
    },
    { useSystemPicker: false }
  )

  ipcMain.handle('capture:sources', async (): Promise<DisplaySource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    })
    // Studio's own window can be recorded too (listed first, clearly named).
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))
    return sources
      .map((s) => ({
        id: s.id,
        name: own.has(s.id) ? 'Studio (this app)' : s.name,
        kind: (s.id.startsWith('screen:') ? 'screen' : 'window') as DisplaySource['kind'],
        thumbnail: s.thumbnail.toDataURL()
      }))
      .sort((a, b) => Number(b.name === 'Studio (this app)') - Number(a.name === 'Studio (this app)'))
  })

  ipcMain.handle('capture:prepare', (_e, sourceId: string | undefined, audio: boolean) => {
    pending = { sourceId, audio }
    // Recording Studio's own window: it must not be hidden from capture, or it would come out black.
    const wins = BrowserWindow.getAllWindows()
    if (sourceId && wins.some((w) => w.getMediaSourceId() === sourceId)) for (const w of wins) w.setContentProtection(false)
  })

  ipcMain.handle('window:hideFromCapture', (e, hide: boolean) => {
    BrowserWindow.fromWebContents(e.sender)?.setContentProtection(hide)
  })
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:restore', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    w?.restore()
    w?.focus()
  })
}

/** System-wide hotkeys, so recording can be controlled while Studio is minimized. */
export const HOTKEYS: Record<string, Hotkey> = {
  'Control+Shift+F9': 'toggle-record',
  'Control+Shift+F10': 'toggle-pause',
  // Scenes 1-8, so the layout can be switched mid-recording while Studio is minimized.
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`Control+Shift+F${i + 1}`, `scene-${i + 1}` as Hotkey]))
}

export function registerHotkeys(win: BrowserWindow): void {
  for (const [accelerator, action] of Object.entries(HOTKEYS)) {
    globalShortcut.register(accelerator, () => win.webContents.send('hotkey', action))
  }
}
