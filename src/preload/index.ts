import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { isAbsolute, join } from 'path'
import type { Hotkey, StudioApi } from '@shared/api'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const api: StudioApi = {
  settings: { get: call('settings:get'), set: call('settings:set') },
  dialog: { pickFolder: call('dialog:pickFolder'), pickMediaFiles: call('dialog:pickMediaFiles') },
  projects: {
    list: call('projects:list'),
    create: call('projects:create'),
    open: call('projects:open'),
    save: call('projects:save'),
    reveal: call('projects:reveal')
  },
  media: {
    import: call('media:import'),
    missing: call('media:missing'),
    url: (projectPath, p) =>
      `studio-media://local/${encodeURIComponent(isAbsolute(p) ? p : join(projectPath, p))}`,
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  system: {
    ffmpegInfo: call('system:ffmpegInfo'),
    selftestDone: (result) => ipcRenderer.send('selftest:done', result)
  },
  capture: { sources: call('capture:sources'), prepare: call('capture:prepare') },
  input: { start: call('input:start'), stop: call('input:stop') },
  recording: {
    open: call('rec:open'),
    write: call('rec:write'),
    close: call('rec:close'),
    finish: call('rec:finish')
  },
  files: {
    size: call('file:size'),
    read: call('file:read'),
    exportPath: call('file:exportPath'),
    showInFolder: call('file:showInFolder'),
    saveText: call('file:saveText')
  },
  audio: {
    waveform: call('audio:waveform'),
    enhance: call('audio:enhance'),
    speech: call('audio:speech'),
    normalize: call('audio:normalize')
  },
  ai: {
    status: call('ai:status'),
    setKey: call('ai:setKey'),
    test: call('ai:test'),
    transcribe: call('ai:transcribe'),
    chat: call('ai:chat'),
    assist: call('ai:assist'),
    refine: call('ai:refine'),
    historyLoad: call('ai:historyLoad'),
    historySave: call('ai:historySave'),
    onAssistStatus(cb) {
      const listener = (_e: unknown, text: string): void => cb(text)
      ipcRenderer.on('ai:assistStatus', listener)
      return () => ipcRenderer.removeListener('ai:assistStatus', listener)
    },
    onProgress(cb) {
      const listener = (_e: unknown, p: { mediaId: string; done: number; total: number }): void => cb(p)
      ipcRenderer.on('ai:progress', listener)
      return () => ipcRenderer.removeListener('ai:progress', listener)
    }
  },
  create: {
    image: call('create:image'),
    motion: call('create:motion'),
    musicSearch: call('music:search'),
    musicSuggest: call('music:suggest'),
    musicStreamUrl: call('music:streamUrl'),
    musicDownload: call('music:download'),
    musicGenerate: call('music:generate')
  },
  fonts: { catalog: call('fonts:catalog'), faces: call('fonts:faces'), preview: call('fonts:preview') },
  dev: {
    mode: process.argv.some((a) => a.startsWith('--cli-export=')) ? 'cli-export' : process.env['STUDIO_DEV_MODE'],
    project: process.argv.find((a) => a.startsWith('--cli-export='))?.slice('--cli-export='.length)
  },
  window: {
    hideFromCapture: call('window:hideFromCapture'),
    minimize: call('window:minimize'),
    restore: call('window:restore'),
    onHotkey(cb) {
      const listener = (_e: unknown, key: Hotkey): void => cb(key)
      ipcRenderer.on('hotkey', listener)
      return () => ipcRenderer.removeListener('hotkey', listener)
    }
  }
} as StudioApi

contextBridge.exposeInMainWorld('studio', api)
if (process.argv.some((a) => a.startsWith('--selftest'))) {
  contextBridge.exposeInMainWorld('selftestMakeMedia', (dir: string) => ipcRenderer.invoke('selftest:makeMedia', dir))
}
