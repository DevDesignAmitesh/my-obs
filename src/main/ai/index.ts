import type { ProviderId, TestResult } from '@shared/ai'
import { providerInfo } from '@shared/ai'
import { getKey } from '../secrets'
import { getSettings } from '../settings'
import { AnthropicProvider } from './anthropic'
import { OpenAIProvider } from './openai'
import { geminiImageModels } from './images'
import { checkElevenLabs, searchJamendo } from '../music'
import { AiError, type ChatProvider, type TranscriptionProvider } from './types'

/** Provider registry: the only place that knows which adapter serves which provider id. */
async function create(id: ProviderId): Promise<ChatProvider & Partial<TranscriptionProvider>> {
  const key = await getKey(id)
  if (!key) throw new AiError(`No ${providerInfo(id).name} API key yet. Add one in Settings → AI.`)
  const baseUrl = (await getSettings()).ai.baseUrls[id]
  switch (id) {
    case 'openai':
      return new OpenAIProvider(key, baseUrl)
    case 'anthropic':
      return new AnthropicProvider(key, baseUrl)
    default:
      throw new AiError(`${providerInfo(id).name} can't be used as the AI assistant.`)
  }
}

export async function chatProvider(id: ProviderId): Promise<ChatProvider> {
  return create(id)
}

export async function transcriptionProvider(id: ProviderId): Promise<TranscriptionProvider> {
  const p = await create(id)
  if (!providerInfo(id).transcription || !p.transcribe) {
    throw new AiError(`${providerInfo(id).name} cannot transcribe audio. Choose another provider in Settings → AI.`)
  }
  return p as TranscriptionProvider
}

export async function testProvider(id: ProviderId): Promise<TestResult> {
  try {
    const key = await getKey(id)
    if (!key) throw new AiError(`No ${providerInfo(id).name} API key yet. Add one in Settings → AI.`)
    if (id === 'google') return { ok: true, models: await geminiImageModels(key) }
    if (id === 'elevenlabs') return (await checkElevenLabs(key), { ok: true })
    if (id === 'jamendo') return (await searchJamendo(key, 'piano', false), { ok: true })
    const models = await (await create(id)).listModels()
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
