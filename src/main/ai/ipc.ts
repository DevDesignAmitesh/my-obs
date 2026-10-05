import { ipcMain } from 'electron'
import { readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { AI_HISTORY_FILE, type ChatTurn } from '@shared/assistant'
import { assertInsideProjects } from '../recording'
import type { ProviderId } from '@shared/ai'
import type { MediaItem } from '@shared/project'
import { getSettings } from '../settings'
import { keyStatus, setKey } from '../secrets'
import { chatProvider, testProvider } from './index'
import { transcribeMedia } from './transcribe'
import { runAssistant, type AssistRequest } from './assistant'
import { refineFeedback, type RefineRequest } from './refine'
import type { ChatMessage } from './types'
import type { ImageRequest, MotionRequest } from '@shared/api'
import type { MusicSource, MusicTrack } from '@shared/music'
import type { Project } from '@shared/project'
import { generateImage } from './images'
import { generateMotion } from './motion'
import { downloadMusic, generateMusic, searchMusic, suggestMusic } from '../music'
import { youtubeStreamUrl } from '../youtube'

export function registerAiIpc(): void {
  ipcMain.handle('ai:status', async () => ({ providers: await keyStatus(), settings: (await getSettings()).ai }))
  ipcMain.handle('ai:setKey', (_e, id: ProviderId, key: string | null) => setKey(id, key))
  ipcMain.handle('ai:test', (_e, id: ProviderId) => testProvider(id))
  ipcMain.handle('ai:transcribe', (e, projectPath: string, media: MediaItem) =>
    transcribeMedia(projectPath, media, (done, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:progress', { mediaId: media.id, done, total })
    })
  )
  ipcMain.handle('ai:assist', (e, req: AssistRequest) =>
    runAssistant(req, (text) => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:assistStatus', text)
    })
  )
  // The assistant chat is kept per project in ai-history.json (readable JSON).
  ipcMain.handle('ai:historyLoad', async (_e, projectPath: string): Promise<ChatTurn[]> => {
    try {
      return JSON.parse(await readFile(join(projectPath, AI_HISTORY_FILE), 'utf8')).turns ?? []
    } catch {
      return []
    }
  })
  ipcMain.handle('ai:historySave', async (_e, projectPath: string, turns: ChatTurn[]) => {
    const file = join(projectPath, AI_HISTORY_FILE)
    await assertInsideProjects(file)
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, turns }, null, 2))
    await rename(`${file}.tmp`, file)
  })
  ipcMain.handle('ai:refine', async (_e, req: RefineRequest) => {
    const { intent, instruction, remember } = await refineFeedback(req)
    return { intent, instruction, remember }
  })
  ipcMain.handle('create:image', async (_e, projectPath: string, req: ImageRequest) => {
    await assertInsideProjects(projectPath)
    return generateImage(projectPath, req)
  })
  ipcMain.handle('create:motion', (_e, req: MotionRequest) => generateMotion(req))
  ipcMain.handle('music:search', (_e, query: string, source: MusicSource, safe: boolean) => searchMusic(query, source, safe))
  ipcMain.handle('music:streamUrl', (_e, pageUrl: string) => youtubeStreamUrl(pageUrl))
  ipcMain.handle('music:suggest', (_e, project: Project) => suggestMusic(project))
  ipcMain.handle('music:download', async (_e, projectPath: string, track: MusicTrack) => {
    await assertInsideProjects(projectPath)
    return downloadMusic(projectPath, track)
  })
  ipcMain.handle('music:generate', async (_e, projectPath: string, req: { prompt: string; seconds: number; instrumental: boolean }) => {
    await assertInsideProjects(projectPath)
    return generateMusic(projectPath, req)
  })
  ipcMain.handle('ai:chat', async (_e, system: string, messages: ChatMessage[]) => {
    const { assistant } = (await getSettings()).ai
    if (!assistant.model) throw new Error('Choose an assistant model in Settings → AI.')
    return (await chatProvider(assistant.provider)).chat({ model: assistant.model, system, messages })
  })
}
