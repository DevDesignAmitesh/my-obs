/** Pluggable AI providers. Adding one = an adapter in src/main/ai/ + an entry here. */

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'elevenlabs' | 'jamendo'
/** Services that can make images from a prompt. */
export type ImageProviderId = 'openai' | 'google'

export interface ProviderInfo {
  id: ProviderId
  name: string
  /** Where to get a key. */
  keyUrl: string
  keyPlaceholder: string
  /** What this provider can do in Studio. */
  chat: boolean
  transcription: boolean
  /** Makes images and logos from a prompt. */
  image: boolean
  /** Searches free music (Jamendo) or composes music from a prompt (ElevenLabs). */
  music?: 'search' | 'generate'
  /** Word used in the UI for the secret ("API key", "Client ID"). */
  keyLabel?: string
  /** Image models, best first; the first one that works is used when none is chosen. */
  preferredImageModels?: string[]
  /** Preferred chat models, best first; the first one the key can access becomes the default. */
  preferredChatModels: string[]
  transcriptionModels: string[]
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    chat: true,
    transcription: true,
    image: true,
    preferredImageModels: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'],
    preferredChatModels: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
    // whisper-1 gives per-word timings, which captions need; the others fall back to per-sentence timing.
    transcriptionModels: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-transcribe']
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    chat: true,
    // Claude has no speech-to-text API.
    transcription: false,
    image: false,
    preferredChatModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    transcriptionModels: []
  },
  {
    id: 'google',
    name: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    chat: false,
    transcription: false,
    image: true,
    preferredImageModels: ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'],
    preferredChatModels: [],
    transcriptionModels: []
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs (optional)',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    keyPlaceholder: 'sk_…',
    chat: false,
    transcription: false,
    image: false,
    music: 'generate',
    preferredChatModels: [],
    transcriptionModels: []
  },
  {
    id: 'jamendo',
    name: 'Jamendo (optional, free)',
    keyUrl: 'https://devportal.jamendo.com/',
    keyPlaceholder: 'Client ID, e.g. 1a2b3c4d',
    keyLabel: 'Client ID',
    chat: false,
    transcription: false,
    image: false,
    music: 'search',
    preferredChatModels: [],
    transcriptionModels: []
  }
]

export const providerInfo = (id: ProviderId): ProviderInfo => PROVIDERS.find((p) => p.id === id)!

export interface AiSettings {
  transcription: {
    provider: ProviderId
    model: string
    /** ISO-639-1 code, or 'auto' to detect. */
    language: string
    /** Ask the model to keep "um"/"uh" so they can be cut. */
    keepFillers: boolean
  }
  assistant: { provider: ProviderId; model: string }
  /** Images and logos; an empty model means "the best one the key can use". */
  image: { provider: ImageProviderId; model: string }
  /** Optional custom endpoint per provider (e.g. an OpenAI-compatible service). */
  baseUrls: Partial<Record<ProviderId, string>>
}

export const DEFAULT_AI: AiSettings = {
  transcription: { provider: 'openai', model: 'whisper-1', language: 'auto', keepFillers: true },
  assistant: { provider: 'openai', model: '' },
  image: { provider: 'openai', model: '' },
  baseUrls: {}
}

/** What the UI may know about a stored key (never the key itself). */
export interface ProviderStatus {
  id: ProviderId
  configured: boolean
  /** e.g. "…a1b2" */
  hint?: string
}

export interface TestResult {
  ok: boolean
  models?: string[]
  error?: string
}

/** Approximate OpenAI transcription price, USD per audio minute (shown as an estimate only). */
export const TRANSCRIPTION_USD_PER_MIN = 0.006
