import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join, parse } from 'path'
import type { AppSettings, SettingsPatch } from '@shared/api'
import { DEFAULT_AI } from '@shared/ai'

/** Projects live on F: by default; falls back to Documents if that drive isn't present. */
const PREFERRED_ROOT = 'F:\\MY-STUDIO'

function defaultSettings(): AppSettings {
  const drive = parse(PREFERRED_ROOT).root
  const projectsRoot = existsSync(drive) ? PREFERRED_ROOT : join(app.getPath('documents'), 'MY-STUDIO')
  return {
    projectsRoot,
    recorder: {
      micEnabled: true,
      micAutoGain: true,
      systemAudio: true,
      fps: 30,
      recordProgram: true,
      hideStudio: false,
      minimizeOnRecord: true,
      countdownSeconds: 3,
      autoZoom: true,
      autoZoomScale: 1.8
    },
    ai: DEFAULT_AI
  }
}

function mergeAi(base: AppSettings['ai'], patch?: SettingsPatch['ai']): AppSettings['ai'] {
  return {
    transcription: { ...base.transcription, ...patch?.transcription },
    assistant: { ...base.assistant, ...patch?.assistant },
    image: { ...base.image, ...patch?.image },
    baseUrls: { ...base.baseUrls, ...patch?.baseUrls }
  }
}

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

let cache: AppSettings | null = null

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  let stored: Partial<AppSettings> = {}
  try {
    stored = JSON.parse(await readFile(settingsFile(), 'utf8'))
  } catch {
    // first run or unreadable file: use defaults
  }
  const defaults = defaultSettings()
  cache = { ...defaults, ...stored, recorder: { ...defaults.recorder, ...stored.recorder }, ai: mergeAi(defaults.ai, stored.ai) }
  await mkdir(cache.projectsRoot, { recursive: true })
  return cache
}

export async function setSettings(patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings()
  const next = { ...current, ...patch, recorder: { ...current.recorder, ...patch.recorder }, ai: mergeAi(current.ai, patch.ai) }
  await mkdir(next.projectsRoot, { recursive: true })
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(next, null, 2))
  cache = next
  return next
}
