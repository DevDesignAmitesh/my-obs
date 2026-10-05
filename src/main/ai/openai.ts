import { createReadStream } from 'fs'
import OpenAI from 'openai'
import { punctuateWords, type Word } from '@shared/transcript'
import {
  AiError,
  DEFAULT_MAX_STEPS,
  type ChatProvider,
  type ChatRequest,
  type ToolLoopRequest,
  type TranscribeOptions,
  type TranscribeResult,
  type TranscriptionProvider
} from './types'

/** Shape of a verbose_json transcription (words and/or segments with times). */
export interface VerboseTranscription {
  language?: string
  text?: string
  words?: { word: string; start: number; end: number }[]
  segments?: { text: string; start: number; end: number }[]
}

/**
 * Words with timings from a transcription response. Models that only return segment timings get
 * their words spread across each segment by character length (good enough for captions).
 */
export function wordsFromVerbose(r: VerboseTranscription): Word[] {
  if (r.words?.length) {
    const words = r.words.map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.text)
    return punctuateWords(words, r.text ?? r.segments?.map((s) => s.text).join(' '))
  }
  const out: Word[] = []
  for (const s of r.segments ?? []) {
    const parts = s.text.trim().split(/\s+/).filter(Boolean)
    const total = parts.reduce((n, p) => n + p.length, 0) || 1
    let t = s.start
    for (const p of parts) {
      const d = ((s.end - s.start) * p.length) / total
      out.push({ text: p, start: t, end: t + d })
      t += d
    }
  }
  return out
}

/** Turns SDK errors into messages a user can act on. */
function explain(e: unknown): Error {
  if (e instanceof OpenAI.AuthenticationError) return new AiError('OpenAI rejected the API key. Check it in Settings → AI.')
  if (e instanceof OpenAI.RateLimitError) return new AiError('OpenAI rate limit or quota reached. Check your OpenAI billing, then try again.')
  if (e instanceof OpenAI.NotFoundError) return new AiError(`OpenAI: ${e.message} (is the model name right?)`)
  if (e instanceof OpenAI.APIConnectionError) return new AiError('Could not reach OpenAI. Check your internet connection.')
  if (e instanceof OpenAI.APIError) return new AiError(`OpenAI error ${e.status ?? ''}: ${e.message}`)
  return e as Error
}

export class OpenAIProvider implements ChatProvider, TranscriptionProvider {
  private client: OpenAI

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseURL || undefined, maxRetries: 3, timeout: 10 * 60 * 1000 })
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = []
      for await (const m of this.client.models.list()) ids.push(m.id)
      return ids.sort()
    } catch (e) {
      throw explain(e)
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    try {
      const r = await this.client.chat.completions.create({
        model: req.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        max_completion_tokens: req.maxTokens ?? 4096
      })
      return r.choices[0]?.message?.content ?? ''
    } catch (e) {
      throw explain(e)
    }
  }

  async runTools(req: ToolLoopRequest): Promise<string> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      ...req.history,
      {
        role: 'user',
        content: [{ type: 'text', text: req.user.text }, ...(req.user.images ?? []).map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
      }
    ]
    const tools: OpenAI.ChatCompletionTool[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema }
    }))
    try {
      for (let step = 0; step < (req.maxSteps ?? DEFAULT_MAX_STEPS); step++) {
        const r = await this.client.chat.completions.create({ model: req.model, messages, tools, tool_choice: 'auto' })
        const msg = r.choices[0]?.message
        if (!msg) throw new AiError('OpenAI returned an empty response.')
        messages.push(msg)
        const calls = (msg.tool_calls ?? []).filter((c) => c.type === 'function')
        const parsed = calls.map((c) => {
          try {
            return JSON.parse(c.function.arguments || '{}') as unknown
          } catch {
            return c.function.arguments
          }
        })
        req.onLog?.({ type: 'model', step, text: msg.content ?? '', toolCalls: calls.map((c, i) => ({ name: c.function.name, input: parsed[i] })), stopReason: r.choices[0]?.finish_reason, usage: r.usage })
        if (!calls.length) return msg.content ?? ''
        for (const [i, call] of calls.entries()) {
          let output: string
          try {
            if (typeof parsed[i] === 'string') throw new Error('arguments were not valid JSON')
            output = await req.runTool(call.function.name, parsed[i])
          } catch (e) {
            output = `Error: ${(e as Error).message}`
          }
          req.onLog?.({ type: 'tool', step, name: call.function.name, input: parsed[i], output })
          messages.push({ role: 'tool', tool_call_id: call.id, content: output })
        }
      }
    } catch (e) {
      throw explain(e)
    }
    throw new AiError('The assistant took too many steps. Try a more specific request.')
  }

  async transcribe(file: string, opts: TranscribeOptions): Promise<TranscribeResult> {
    try {
      const r = (await this.client.audio.transcriptions.create({
        file: createReadStream(file),
        model: opts.model,
        response_format: 'verbose_json',
        timestamp_granularities: ['word', 'segment'],
        language: opts.language,
        prompt: opts.prompt
      })) as unknown as VerboseTranscription
      return { words: wordsFromVerbose(r), language: r.language }
    } catch (e) {
      throw explain(e)
    }
  }
}
