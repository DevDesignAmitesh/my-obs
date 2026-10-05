import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyOps } from '@shared/ops'
import { createProject, MediaItem, type Project } from '@shared/project'

const tmp = mkdtempSync(join(tmpdir(), 'studio-assist-'))
vi.mock('electron', () => ({
  app: { getPath: () => join(tmp, 'userData') },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

const { setSettings } = await import('../settings')
const { setKey } = await import('../secrets')
const { runAssistant } = await import('./assistant')
const { refineFeedback } = await import('./refine')

function project(): Project {
  const p = createProject('p')
  const cam = MediaItem.parse({ id: 'cam', kind: 'video', name: 'cam.mp4', path: 'cam.mp4', duration: 30, width: 1280, height: 720, hasAudio: true })
  const words = 'So today we build it So today we build an editor'.split(' ').map((text, i) => ({ text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 }))
  return applyOps(p, [
    { op: 'addMedia', items: [cam] },
    { op: 'insertClip', trackId: p.tracks[0].id, mediaId: 'cam', start: 0, clipId: 'C' },
    { op: 'setTranscript', mediaId: 'cam', transcript: { provider: 't', model: 't', createdAt: '', words } }
  ])
}

/** The "model": reads the transcript, makes a mistake, fixes it, then answers. */
const SCRIPT = [
  { tool: 'get_transcript', input: { start: 0, end: 10 } },
  { tool: 'propose_edits', input: { summary: 'bad', edits: [{ op: 'moveClip', clipId: 'nope', start: 1 }] } },
  { tool: 'propose_edits', input: { summary: 'Removed the first, repeated take.', edits: [{ op: 'cutRanges', ranges: [[0.9, 3.5]] }] } },
  { text: 'Done: I cut the repeated first take.' }
]

let server: Server
const bodies: { path: string; headers: Record<string, unknown>; body: any }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      bodies.push({ path: req.url!, headers: req.headers, body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/chat/completions' && !body.tools) {
        // The feedback refiner: a plain chat call that answers in JSON.
        const content = 'Here you go:\n{"intent":"The demo drags","instruction":"Cut every pause longer than 0.4 s between 1:30 and 2:30","remember":"Keep the pace fast"}'
        res.end(JSON.stringify({ id: 'r', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
      } else if (req.url === '/v1/chat/completions') {
        const step = SCRIPT[body.messages.filter((m: { role: string }) => m.role === 'assistant').length]
        const message = step.tool
          ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${bodies.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.input) } }] }
          : { role: 'assistant', content: step.text }
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: step.tool ? 'tool_calls' : 'stop' }] }))
      } else if (req.url?.startsWith('/v1/messages')) {
        const step = SCRIPT[body.messages.filter((m: { role: string }) => m.role === 'assistant').length]
        const thinking = { type: 'thinking', thinking: '', signature: `sig${bodies.length}` }
        const content = step.tool
          ? [thinking, { type: 'tool_use', id: `tu_${bodies.length}`, name: step.tool, input: step.input }]
          : [thinking, { type: 'text', text: step.text }]
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content, stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  await setSettings({ projectsRoot: join(tmp, 'projects'), ai: { baseUrls: { openai: `http://127.0.0.1:${port}/v1`, anthropic: `http://127.0.0.1:${port}` } } })
  await setKey('openai', 'sk-test')
  await setKey('anthropic', 'sk-ant-test')
})

afterAll(() => {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

const FRAME = 'data:image/jpeg;base64,/9j/AAAA'

for (const provider of ['openai', 'anthropic'] as const) {
  describe(`assistant via ${provider}`, () => {
    it('runs the tool loop, feeds back validation errors and returns a valid proposal', async () => {
      await setSettings({ ai: { assistant: { provider, model: provider === 'openai' ? 'gpt-5' : 'claude-opus-5-5' } } })
      bodies.length = 0
      const statuses: string[] = []
      const r = await runAssistant(
        { project: project(), selection: null, playhead: 0, prompt: 'Remove the repeated take', history: [], images: [FRAME] },
        (s) => statuses.push(s)
      )
      expect(r.reply).toBe('Done: I cut the repeated first take.')
      expect(r.proposal).toEqual({ summary: 'Removed the first, repeated take.', edits: [{ op: 'cutRanges', ranges: [[0.9, 3.5]] }] })
      expect(statuses).toContain('Reading the transcript…')
      expect(bodies).toHaveLength(4)

      const last = JSON.stringify(bodies[3].body)
      expect(last).toContain('So@1.00-1.40') // transcript tool result went back
      expect(last).toContain('Clip not found: nope') // validation error went back
      expect(last).toContain('Proposal recorded')

      const first = bodies[0].body
      expect(JSON.stringify(first)).toContain('REQUEST: Remove the repeated take')
      if (provider === 'openai') {
        expect(first.messages[0]).toMatchObject({ role: 'system' })
        expect(first.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: FRAME } })
        expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['get_transcript', 'propose_edits'])
      } else {
        expect(bodies[0].path).toContain('/v1/messages')
        expect(bodies[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
        expect(first.fallbacks).toBe('default')
        expect(first.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } })
        // Thinking blocks are passed back unchanged; tool results come in one user message.
        const second = bodies[1].body.messages
        expect(second[1].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig1' })
        expect(second[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] })
      }
    })
  })
}

it('feedback step 1: the refiner turns vague feedback into a precise instruction', async () => {
  await setSettings({ ai: { assistant: { provider: 'openai', model: 'gpt-5' } } })
  bodies.length = 0
  const p = applyOps(project(), [{ op: 'setMode', mode: 'demo', extraPrompt: 'warm mood' }])
  const r = await refineFeedback({ project: p, feedback: 'the middle feels slow', history: [{ role: 'user', text: 'Generate edit' }], playhead: 0 })
  expect(r).toMatchObject({ intent: 'The demo drags', instruction: 'Cut every pause longer than 0.4 s between 1:30 and 2:30', remember: 'Keep the pace fast' })
  // It saw the mode recipe, the standing instructions, the timeline, the chat and the feedback.
  const sent = JSON.stringify(bodies[0].body)
  expect(sent).toContain('PROJECT DEMO')
  expect(sent).toContain('STANDING INSTRUCTIONS FROM THE USER: warm mood')
  expect(sent).toContain('So@1.00-1.40')
  expect(sent).toContain('User: Generate edit')
  expect(sent).toContain('NEW FEEDBACK: the middle feels slow')
  expect(bodies[0].body.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('Reply with JSON only') })
})

it('asks for a model before running', async () => {
  await setSettings({ ai: { assistant: { provider: 'openai', model: '' } } })
  await expect(runAssistant({ project: project(), selection: null, playhead: 0, prompt: 'x', history: [], images: [] }, () => undefined)).rejects.toThrow(/Choose an assistant model/)
})
