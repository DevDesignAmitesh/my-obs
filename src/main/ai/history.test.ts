import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ChatTurn } from '@shared/assistant'

const tmp = mkdtempSync(join(tmpdir(), 'studio-history-'))
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => join(tmp, 'userData') },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) }
}))

const { setSettings } = await import('../settings')
const { registerAiIpc } = await import('./ipc')

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('assistant chat history', () => {
  it('saves to ai-history.json in the project and loads it back', async () => {
    const root = join(tmp, 'MY-STUDIO')
    const project = join(root, 'test7')
    mkdirSync(project, { recursive: true })
    await setSettings({ projectsRoot: root })
    registerAiIpc()
    const load = handlers.get('ai:historyLoad')!
    const save = handlers.get('ai:historySave')!

    expect(await load({}, project)).toEqual([]) // nothing saved yet

    const turns: ChatTurn[] = [
      { role: 'user', text: 'Remove the ums', time: '2026-09-30T10:00:00Z', scope: null },
      {
        role: 'assistant',
        text: 'Cut 2 filler words.',
        time: '2026-09-30T10:00:05Z',
        provider: 'openai',
        model: 'gpt-5',
        proposal: { summary: 'Remove fillers', edits: [{ op: 'cutRanges', ranges: [[1, 1.3], [4, 4.2]] }] },
        state: 'applied',
        picked: [true]
      }
    ]
    await save({}, project, turns)
    const file = join(project, 'ai-history.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, turns })
    expect(await load({}, project)).toEqual(turns)
  })

  it('refuses to write outside the projects folder', async () => {
    await expect(handlers.get('ai:historySave')!({}, join(tmp, 'elsewhere'), [])).rejects.toThrow(/outside the projects folder/)
  })
})
