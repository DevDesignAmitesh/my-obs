import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { open, stat, writeFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import type { Project } from '@shared/project'
import type { SettingsPatch } from '@shared/api'
import { getSettings, setSettings } from './settings'
import { createProjectFolder, importMedia, listProjects, openProject, safeName, saveProject, uniquePath } from './project-store'
import { ffmpegInfo } from './ffmpeg'
import { enhance, normalizeLoudness, speech, waveform } from './audio'
import type { EnhanceLevel, MediaItem } from '@shared/project'
import { fontCatalog, fontFaces, fontPreview } from './fonts'

const MEDIA_FILTERS = [
  { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'mp3', 'mpeg', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
  { name: 'All files', extensions: ['*'] }
]

/** Channel names mirror the StudioApi shape: "<group>:<method>". */
export function registerIpc(): void {
  const win = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? undefined

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => setSettings(patch))

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win()!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:pickMediaFiles', async () => {
    const r = await dialog.showOpenDialog(win()!, { properties: ['openFile', 'multiSelections'], filters: MEDIA_FILTERS })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('fonts:catalog', () => fontCatalog())
  ipcMain.handle('fonts:faces', (_e, family: string) => fontFaces(family))
  ipcMain.handle('fonts:preview', (_e, family: string) => fontPreview(family))

  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', (_e, name: string) => createProjectFolder(name))
  ipcMain.handle('projects:open', (_e, path: string) => openProject(path))
  ipcMain.handle('projects:save', (_e, path: string, project: Project) => saveProject(path, project))
  ipcMain.handle('projects:reveal', (_e, path: string) => shell.openPath(path).then(() => undefined))

  ipcMain.handle('media:import', (_e, projectPath: string, files: string[], link?: boolean) =>
    importMedia(projectPath, files, link ? 'link' : 'copy')
  )

  ipcMain.handle('media:missing', async (_e, projectPath: string, paths: string[]) => {
    const gone = await Promise.all(paths.map((p) => stat(isAbsolute(p) ? p : join(projectPath, p)).then(() => false, () => true)))
    return paths.filter((_, i) => gone[i])
  })

  ipcMain.handle('system:ffmpegInfo', () => ffmpegInfo())

  ipcMain.handle('audio:waveform', (_e, projectPath: string, media: MediaItem) => waveform(projectPath, media))
  ipcMain.handle('audio:enhance', (_e, projectPath: string, media: MediaItem, level: Exclude<EnhanceLevel, 'off'>) =>
    enhance(projectPath, media, level)
  )
  ipcMain.handle('audio:speech', (_e, projectPath: string, media: MediaItem) => speech(projectPath, media))
  ipcMain.handle('audio:normalize', (_e, file: string, target: number) => normalizeLoudness(file, target))

  ipcMain.handle('file:size', async (_e, path: string) => (await stat(path)).size)
  ipcMain.handle('file:read', async (_e, path: string, start: number, end: number) => {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, end - start))
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await fh.close()
    }
  })
  ipcMain.handle('file:exportPath', (_e, projectPath: string, name: string) =>
    uniquePath(join(projectPath, 'exports'), `${safeName(name)}.mp4`)
  )
  ipcMain.handle('file:saveText', async (_e, projectPath: string, fileName: string, text: string) => {
    const path = await uniquePath(join(projectPath, 'exports'), safeName(fileName))
    await writeFile(path, text, 'utf8')
    return path
  })
  ipcMain.handle('file:showInFolder', (_e, path: string) => shell.showItemInFolder(path))
}
