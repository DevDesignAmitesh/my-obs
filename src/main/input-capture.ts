import { desktopCapturer, ipcMain, screen, type Rectangle } from 'electron'
import type { InputEvent } from '@shared/api'

/**
 * Clicks and typing during a recording, for auto zoom. Uses a system-wide input hook (uiohook)
 * that runs only while recording. Only WHEN and WHERE is kept, never which keys were pressed.
 * Positions come from Electron (DPI-aware) and are made relative to each recorded screen.
 */

type Hook = typeof import('uiohook-napi').uIOhook

let hook: Hook | null = null
let screens: { label: string; bounds: Rectangle }[] = []
let events: { at: number; kind: 'click' | 'key'; x: number; y: number }[] = []
/** Typing zooms to where you last clicked (the text box), if that was recent. */
let lastClick: { at: number; x: number; y: number } | null = null
const CLICK_FOCUS_MS = 20_000

function loadHook(): Hook | null {
  try {
    // Loaded lazily: a missing/blocked native module must never break recording.
    return (require('uiohook-napi') as typeof import('uiohook-napi')).uIOhook
  } catch (e) {
    console.warn('Input hook unavailable, auto zoom is off:', e)
    return null
  }
}

function record(kind: 'click' | 'key'): void {
  const now = Date.now()
  let p = screen.getCursorScreenPoint()
  if (kind === 'click') lastClick = { at: now, ...p }
  else if (lastClick && now - lastClick.at < CLICK_FOCUS_MS) p = lastClick
  events.push({ at: now, kind, x: p.x, y: p.y })
}

export function registerInputCapture(): void {
  ipcMain.handle('input:start', async (_e, sources: { label: string; sourceId?: string }[]): Promise<boolean> => {
    stop()
    // Which monitor each recorded screen is (windows can't be mapped, so they get no zooms).
    const caps = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const displays = screen.getAllDisplays()
    screens = sources.flatMap(({ label, sourceId }) => {
      const cap = sourceId ? caps.find((c) => c.id === sourceId) : caps[0]
      if (!cap) return []
      const d = displays.find((x) => String(x.id) === cap.display_id) ?? (caps.length === 1 ? screen.getPrimaryDisplay() : undefined)
      return d ? [{ label, bounds: d.bounds }] : []
    })
    if (!screens.length) return false
    hook ??= loadHook()
    if (!hook) return false
    events = []
    lastClick = null
    hook.removeAllListeners()
    hook.on('mousedown', () => record('click'))
    // Typing only: shortcuts (Ctrl/Alt/Win + key), modifier keys, Esc and F-keys don't zoom.
    const { UiohookKey: K } = require('uiohook-napi') as typeof import('uiohook-napi')
    const fKeys = Array.from({ length: 24 }, (_, i) => K[`F${i + 1}` as keyof typeof K] as number)
    const notTyping = new Set<number>([K.Shift, K.ShiftRight, K.Ctrl, K.CtrlRight, K.Alt, K.AltRight, K.Meta, K.MetaRight, K.CapsLock, K.Escape, ...fKeys])
    hook.on('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey || notTyping.has(e.keycode)) return
      record('key')
    })
    try {
      hook.start()
      return true
    } catch (e) {
      console.warn('Input hook failed to start:', e)
      return false
    }
  })

  ipcMain.handle('input:stop', (): Record<string, InputEvent[]> => {
    stop()
    const out: Record<string, InputEvent[]> = {}
    for (const { label, bounds: b } of screens) {
      out[label] = events
        .filter((e) => e.x >= b.x && e.x < b.x + b.width && e.y >= b.y && e.y < b.y + b.height)
        .map((e) => ({ at: e.at, kind: e.kind, x: (e.x - b.x) / b.width, y: (e.y - b.y) / b.height }))
    }
    events = []
    return out
  })
}

function stop(): void {
  try {
    hook?.stop()
  } catch {
    // already stopped
  }
}
