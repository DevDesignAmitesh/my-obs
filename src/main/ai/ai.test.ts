import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MediaItem } from '@shared/project'

const tmp = mkdtempSync(join(tmpdir(), 'studio-ai-'))
// Electron stand-ins: userData in a temp folder, "encryption" that just tags the text.
vi.mock('electron', () => ({
  app: { getPath: () => join(tmp, 'userData') },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  }
}))

const { setSettings } = await import('../settings')
const { getKey, keyStatus, setKey } = await import('../secrets')
const { testProvider } = await import('./index')
const { planChunks, transcribeMedia } = await import('./transcribe')
const { wordsFromVerbose } = await import('./openai')
const { ffmpegPath } = await import('../ffmpeg')

/** A tiny stand-in for the OpenAI and Anthropic APIs, recording what it receives. */
let server: Server
let baseUrl = ''
const received: { path: string; auth?: string; body: Buffer }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({ path: req.url!, auth: req.headers.authorization ?? (req.headers['x-api-key'] as string), body: Buffer.concat(chunks) })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models' && req.headers['x-api-key']) {
        res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }))
      } else if (req.url === '/v1/models') {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'whisper-1', object: 'model', created: 0, owned_by: 'openai' }, { id: 'gpt-5', object: 'model', created: 0, owned_by: 'openai' }] }))
      } else if (req.url === '/v1/audio/transcriptions') {
        res.end(JSON.stringify({ language: 'english', duration: 3, text: 'hello there world', words: [{ word: 'hello', start: 0.1, end: 0.5 }, { word: 'there', start: 0.6, end: 0.9 }, { word: 'world', start: 1.0, end: 1.4 }] }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: { message: 'not found' } }))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  await setSettings({ projectsRoot: join(tmp, 'projects'), ai: { baseUrls: { openai: baseUrl, anthropic: baseUrl.replace(/\/v1$/, '') } } })
})

afterAll(() => {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('keys', () => {
  it('stores keys encrypted and only exposes a hint', async () => {
    expect((await keyStatus()).every((s) => !s.configured)).toBe(true)
    await setKey('openai', ' sk-test-1234 ')
    expect(await getKey('openai')).toBe('sk-test-1234')
    expect((await keyStatus()).find((s) => s.id === 'openai')).toEqual({ id: 'openai', configured: true, hint: '…1234' })
    await setKey('anthropic', 'sk-ant-xyz9')
    expect(await getKey('anthropic')).toBe('sk-ant-xyz9')
  })

  it('reports a clear error when a key is missing', async () => {
    await setKey('anthropic', null)
    expect((await testProvider('anthropic')).error).toMatch(/No Anthropic \(Claude\) API key/)
    await setKey('anthropic', 'sk-ant-xyz9')
  })
})

describe('providers (against a local mock API)', () => {
  it('lists OpenAI models with the key as a bearer token', async () => {
    const r = await testProvider('openai')
    expect(r).toEqual({ ok: true, models: ['gpt-5', 'whisper-1'] })
    expect(received.at(-1)!.auth).toBe('Bearer sk-test-1234')
  })

  it('lists Claude models with the key in x-api-key', async () => {
    const r = await testProvider('anthropic')
    expect(r).toEqual({ ok: true, models: ['claude-opus-5-5'] })
    expect(received.at(-1)!.auth).toBe('sk-ant-xyz9')
  })

  it('transcribes a media file end to end', async () => {
    const wav = join(tmp, 'voice.wav')
    execFileSync(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=3', wav])
    const media = MediaItem.parse({ id: 'voice', kind: 'audio', name: 'voice.wav', path: wav, duration: 3, hasAudio: true })
    const progress: string[] = []
    const t = await transcribeMedia(join(tmp, 'proj'), media, (d, n) => progress.push(`${d}/${n}`))

    expect(t.words.map((w) => w.text)).toEqual(['hello', 'there', 'world'])
    expect(t.words[2]).toMatchObject({ start: 1.0, end: 1.4 })
    expect(t).toMatchObject({ provider: 'openai', model: 'whisper-1', language: 'english' })
    expect(progress).toEqual(['0/1', '1/1'])

    // The upload: compressed Ogg/Opus audio plus the options that give word timings.
    const req = received.find((r) => r.path === '/v1/audio/transcriptions')!
    const body = req.body.toString('latin1')
    expect(body).toContain('OggS')
    expect(body).toContain('whisper-1')
    expect(body).toContain('verbose_json')
    expect(body).toMatch(/timestamp_granularities/)
    expect(body).toContain('Umm, let me think') // keeps filler words by default
    expect(req.body.length).toBeLessThan(40_000)
  })
})

describe('helpers', () => {
  it('cuts long recordings into chunks at pauses near every 10 minutes', () => {
    // Speech everywhere except pauses at 590–592 s and 1195–1200 s.
    const speech: [number, number][] = [[0, 590], [592, 1195], [1200, 2000]]
    const chunks = planChunks(2000, speech)
    expect(chunks.map(([a, b]) => [Math.round(a), Math.round(b)])).toEqual([[0, 591], [591, 1198], [1198, 2000]])
    expect(planChunks(300, [])).toEqual([[0, 300]])
  })

  it('spreads words over segments when a model returns no word timings', () => {
    const w = wordsFromVerbose({ segments: [{ text: ' ab cdef', start: 1, end: 4 }] })
    expect(w).toEqual([{ text: 'ab', start: 1, end: 2 }, { text: 'cdef', start: 2, end: 4 }])
  })
})
