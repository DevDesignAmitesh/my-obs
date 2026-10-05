import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ProviderId, ProviderStatus } from '@shared/ai'
import { PROVIDERS } from '@shared/ai'

/**
 * API keys, encrypted with the OS (Windows DPAPI via Electron safeStorage) in userData.
 * Keys never leave the main process; the UI only sees whether one is set and its last 4 chars.
 */
const file = (): string => join(app.getPath('userData'), 'secrets.json')

async function load(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file(), 'utf8'))
  } catch {
    return {}
  }
}

export async function getKey(id: ProviderId): Promise<string | null> {
  const enc = (await load())[id]
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export async function setKey(id: ProviderId, key: string | null): Promise<void> {
  if (key && !safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer')
  const all = await load()
  if (key?.trim()) all[id] = safeStorage.encryptString(key.trim()).toString('base64')
  else delete all[id]
  await mkdir(dirname(file()), { recursive: true })
  await writeFile(file(), JSON.stringify(all, null, 2))
}

export async function keyStatus(): Promise<ProviderStatus[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const key = await getKey(p.id)
      return { id: p.id, configured: !!key, hint: key ? `…${key.slice(-4)}` : undefined }
    })
  )
}
