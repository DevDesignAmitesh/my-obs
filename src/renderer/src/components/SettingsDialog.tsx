import { useEffect, useState } from 'react'
import { PROVIDERS, providerInfo, TRANSCRIPTION_USD_PER_MIN, type AiSettings, type ImageProviderId, type ProviderId, type ProviderStatus, type TestResult } from '@shared/ai'
import type { SettingsPatch } from '@shared/api'

const LANGUAGES: [string, string][] = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['mr', 'Marathi'], ['ta', 'Tamil'],
  ['te', 'Telugu'], ['gu', 'Gujarati'], ['ur', 'Urdu'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'],
  ['it', 'Italian'], ['ru', 'Russian'], ['ar', 'Arabic'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']
]

/** Settings → AI: keys per provider, which provider does transcription, which does the assistant. */
export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<ProviderStatus[]>([])
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [tests, setTests] = useState<Partial<Record<ProviderId, TestResult | 'running'>>>({})

  const refresh = async (): Promise<void> => {
    const s = await window.studio.ai.status()
    setStatus(s.providers)
    setAi(s.settings)
  }
  useEffect(() => {
    refresh()
  }, [])

  const save = async (patch: NonNullable<SettingsPatch['ai']>): Promise<void> => {
    setAi((await window.studio.settings.set({ ai: patch })).ai)
  }

  const test = async (id: ProviderId): Promise<void> => {
    setTests((t) => ({ ...t, [id]: 'running' }))
    const r = await window.studio.ai.test(id)
    setTests((t) => ({ ...t, [id]: r }))
    // First successful test picks a sensible default assistant model.
    if (r.ok && ai && ai.assistant.provider === id && !ai.assistant.model) {
      const pick = providerInfo(id).preferredChatModels.find((m) => r.models?.includes(m))
      if (pick) await save({ assistant: { model: pick } })
    }
  }

  if (!ai) return null
  const configured = (id: ProviderId): boolean => !!status.find((s) => s.id === id)?.configured
  const assistantTest = tests[ai.assistant.provider]
  const imageTest = tests[ai.image.provider]
  const imageModels = imageTest && imageTest !== 'running' && imageTest.ok ? (imageTest.models ?? []).filter((m) => /image/.test(m)) : []
  const chatModels = assistantTest && assistantTest !== 'running' && assistantTest.ok ? chatModelsOf(ai.assistant.provider, assistantTest.models ?? []) : []

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onPointerDown={onClose}>
      <div className="max-h-[88vh] w-[640px] space-y-6 overflow-auto rounded-lg border border-line bg-panel p-5" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <h2 className="text-lg font-semibold">Settings · AI</h2>
          <button className="ml-auto text-muted hover:text-text" onClick={onClose}>✕</button>
        </div>

        <section className="space-y-3">
          <Title>API keys</Title>
          <p className="text-xs text-muted">Keys are encrypted with Windows and stored only on this computer. Studio sends them only to the provider they belong to.</p>
          {PROVIDERS.map((p) => (
            <KeyRow
              key={p.id}
              name={p.name}
              placeholder={p.keyPlaceholder}
              keyUrl={p.keyUrl}
              status={status.find((s) => s.id === p.id)}
              test={tests[p.id]}
              keyLabel={p.keyLabel}
              uses={[
                p.transcription && 'transcription',
                p.chat && 'AI assistant',
                p.image && 'images & logos',
                p.music === 'search' && 'more free music to search',
                p.music === 'generate' && 'AI-composed music'
              ].filter(Boolean).join(' + ')}
              onSave={async (key) => {
                await window.studio.ai.setKey(p.id, key)
                await refresh()
                if (key) test(p.id)
              }}
              onTest={() => test(p.id)}
            />
          ))}
        </section>

        <section className="space-y-2">
          <Title>Transcription & captions</Title>
          <Row label="Provider">
            <select className={SELECT} value={ai.transcription.provider} onChange={(e) => save({ transcription: { provider: e.target.value as ProviderId, model: providerInfo(e.target.value as ProviderId).transcriptionModels[0] } })}>
              {PROVIDERS.filter((p) => p.transcription).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{configured(p.id) ? '' : ' (no key yet)'}</option>
              ))}
            </select>
          </Row>
          <Row label="Model">
            <select className={SELECT} value={ai.transcription.model} onChange={(e) => save({ transcription: { model: e.target.value } })}>
              {providerInfo(ai.transcription.provider).transcriptionModels.map((m) => (
                <option key={m} value={m}>{m}{m === 'whisper-1' ? ' (per-word timing, best for captions)' : ''}</option>
              ))}
            </select>
          </Row>
          <Row label="Language">
            <select className={SELECT} value={ai.transcription.language} onChange={(e) => save({ transcription: { language: e.target.value } })}>
              {LANGUAGES.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </Row>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ai.transcription.keepFillers} onChange={(e) => save({ transcription: { keepFillers: e.target.checked } })} />
            Keep “um” / “uh” in transcripts (so they can be cut automatically)
          </label>
          <p className="text-xs text-muted">Roughly ${(TRANSCRIPTION_USD_PER_MIN * 60).toFixed(2)} per hour of audio with OpenAI (check OpenAI’s pricing page for current rates).</p>
        </section>

        <section className="space-y-2">
          <Title>AI assistant (used for “ask AI to edit”)</Title>
          <Row label="Provider">
            <select className={SELECT} value={ai.assistant.provider} onChange={(e) => save({ assistant: { provider: e.target.value as ProviderId, model: '' } })}>
              {PROVIDERS.filter((p) => p.chat).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{configured(p.id) ? '' : ' (no key yet)'}</option>
              ))}
            </select>
          </Row>
          <Row label="Model">
            <div className="flex gap-2">
              <input
                className={`${SELECT} flex-1`}
                list="assistant-models"
                placeholder={providerInfo(ai.assistant.provider).preferredChatModels[0]}
                value={ai.assistant.model}
                onChange={(e) => save({ assistant: { model: e.target.value.trim() } })}
              />
              <datalist id="assistant-models">
                {chatModels.map((m) => <option key={m} value={m} />)}
              </datalist>
              <button className={BTN} disabled={!configured(ai.assistant.provider)} onClick={() => test(ai.assistant.provider)}>
                Load models
              </button>
            </div>
          </Row>
          <p className="text-xs text-muted">Type a model name or pick one after “Load models”. You can switch between OpenAI and Claude any time.</p>
        </section>

        <section className="space-y-2">
          <Title>Images & logos (Create tab)</Title>
          <Row label="Provider">
            <select className={SELECT} value={ai.image.provider} onChange={(e) => save({ image: { provider: e.target.value as ImageProviderId, model: '' } })}>
              {PROVIDERS.filter((p) => p.image).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{configured(p.id) ? '' : ' (no key yet)'}</option>
              ))}
            </select>
          </Row>
          <Row label="Model">
            <input
              className={`${SELECT} w-full`}
              list="image-models"
              placeholder={`Automatic (${providerInfo(ai.image.provider).preferredImageModels?.join(', then ')})`}
              value={ai.image.model}
              onChange={(e) => save({ image: { model: e.target.value.trim() } })}
            />
            <datalist id="image-models">
              {imageModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </Row>
          <p className="text-xs text-muted">
            Each image is billed by the provider (roughly $0.01–0.20 depending on quality and size). OpenAI can make transparent backgrounds directly; with Gemini, Studio removes a green background for you.
            SVG art and animations use the AI assistant model above.
          </p>
        </section>

        <details className="space-y-2">
          <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted uppercase">Advanced: custom endpoints</summary>
          <p className="text-xs text-muted">Point a provider at a compatible service or proxy. Leave empty for the official API.</p>
          {PROVIDERS.filter((p) => p.chat).map((p) => (
            <Row key={p.id} label={p.name}>
              <input
                className={`${SELECT} w-full`}
                placeholder={p.id === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
                defaultValue={ai.baseUrls[p.id] ?? ''}
                onBlur={(e) => save({ baseUrls: { ...ai.baseUrls, [p.id]: e.target.value.trim() || undefined } })}
              />
            </Row>
          ))}
        </details>
      </div>
    </div>
  )
}

/** Keeps the list to chat-capable models (OpenAI lists embeddings, audio, image models too). */
function chatModelsOf(id: ProviderId, models: string[]): string[] {
  if (id === 'openai') return models.filter((m) => /^(gpt-|o\d|chatgpt)/.test(m) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(m))
  return models
}

const SELECT = 'rounded border border-line bg-panel-2 px-2 py-1 outline-none focus:border-accent'
const BTN = 'rounded bg-panel-2 px-3 py-1 hover:bg-line disabled:opacity-40'

function Title({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{children}</h3>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function KeyRow(props: {
  name: string
  placeholder: string
  keyUrl: string
  keyLabel?: string
  uses: string
  status?: ProviderStatus
  test?: TestResult | 'running'
  onSave(key: string | null): void
  onTest(): void
}) {
  const [value, setValue] = useState('')
  const t = props.test
  return (
    <div className="space-y-1.5 rounded border border-line p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{props.name}</span>
        <span className="text-xs text-muted">· {props.uses}</span>
        <span className={`ml-auto text-xs ${props.status?.configured ? 'text-audio' : 'text-muted'}`}>
          {props.status?.configured ? `${props.keyLabel ?? 'Key'} saved ${props.status.hint}` : `No ${(props.keyLabel ?? 'key').toLowerCase()}`}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          className={`${SELECT} flex-1`}
          placeholder={props.status?.configured ? `Paste a new ${(props.keyLabel ?? 'key').toLowerCase()} to replace it` : props.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && (props.onSave(value), setValue(''))}
        />
        <button className={BTN} disabled={!value.trim()} onClick={() => (props.onSave(value), setValue(''))}>Save</button>
        {props.status?.configured && (
          <>
            <button className={BTN} onClick={props.onTest}>Test</button>
            <button className={`${BTN} text-muted hover:text-danger`} onClick={() => props.onSave(null)}>Remove</button>
          </>
        )}
      </div>
      <div className="flex text-xs">
        <a className="text-accent hover:underline" href={props.keyUrl} target="_blank" rel="noreferrer">Get {props.keyLabel ? `a ${props.keyLabel.toLowerCase()}` : 'a key'}</a>
        <span className="ml-auto">
          {t === 'running' && <span className="text-muted">Checking…</span>}
          {t && t !== 'running' && (t.ok ? <span className="text-audio">✓ Works{t.models ? ` (${t.models.length} models available)` : ''}</span> : <span className="text-danger">{t.error}</span>)}
        </span>
      </div>
    </div>
  )
}
