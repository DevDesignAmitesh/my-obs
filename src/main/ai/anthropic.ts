import Anthropic from '@anthropic-ai/sdk'
import { AiError, DEFAULT_MAX_STEPS, parseDataUrl, type ChatProvider, type ChatRequest, type ToolLoopRequest } from './types'

function explain(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return new AiError('Anthropic rejected the API key. Check it in Settings → AI.')
  if (e instanceof Anthropic.RateLimitError) return new AiError('Anthropic rate limit reached. Wait a moment and try again.')
  if (e instanceof Anthropic.NotFoundError) return new AiError(`Anthropic: ${e.message} (is the model name right?)`)
  if (e instanceof Anthropic.APIConnectionError) return new AiError('Could not reach Anthropic. Check your internet connection.')
  if (e instanceof Anthropic.APIError) return new AiError(`Anthropic error ${e.status ?? ''}: ${e.message}`)
  return e as Error
}

/** Claude (chat only: Anthropic has no speech-to-text API). */
export class AnthropicProvider implements ChatProvider {
  private client: Anthropic

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseURL || undefined })
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = []
      for await (const m of this.client.models.list()) ids.push(m.id)
      return ids
    } catch (e) {
      throw explain(e)
    }
  }

  async runTools(req: ToolLoopRequest): Promise<string> {
    const images: Anthropic.Beta.BetaImageBlockParam[] = (req.user.images ?? []).map((url) => {
      const { mediaType, data } = parseDataUrl(url)
      return { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png', data } }
    })
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...req.history,
      { role: 'user', content: [...images, { type: 'text', text: req.user.text }] }
    ]
    const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema
    }))
    try {
      for (let step = 0; step < (req.maxSteps ?? DEFAULT_MAX_STEPS); step++) {
        const r = await this.client.beta.messages.create({
          model: req.model,
          max_tokens: 16000,
          system: req.system,
          tools,
          messages,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default'
        })
        if (r.stop_reason === 'refusal') throw new AiError('Claude declined this request.')
        // Keep the whole response (including thinking blocks) in the conversation, unchanged.
        messages.push({ role: 'assistant', content: r.content })
        if (r.stop_reason === 'pause_turn') continue
        const uses = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        req.onLog?.({ type: 'model', step, text, toolCalls: uses.map((u) => ({ name: u.name, input: u.input })), stopReason: r.stop_reason, usage: r.usage })
        if (r.stop_reason !== 'tool_use' || !uses.length) {
          if (r.stop_reason === 'max_tokens') throw new AiError('The answer was too long. Try a smaller request.')
          return text
        }
        // All tool results go back together in one user message.
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const u of uses) {
          let output: string
          try {
            output = await req.runTool(u.name, u.input)
            results.push({ type: 'tool_result', tool_use_id: u.id, content: output })
          } catch (e) {
            output = (e as Error).message
            results.push({ type: 'tool_result', tool_use_id: u.id, content: output, is_error: true })
          }
          req.onLog?.({ type: 'tool', step, name: u.name, input: u.input, output })
        }
        messages.push({ role: 'user', content: results })
      }
    } catch (e) {
      throw explain(e)
    }
    throw new AiError('The assistant took too many steps. Try a more specific request.')
  }

  async chat(req: ChatRequest): Promise<string> {
    try {
      // Streaming avoids HTTP timeouts on long answers. Server-side fallback ("default") lets a
      // safety-classifier decline be re-run on a fallback model instead of failing outright.
      const stream = this.client.beta.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: req.messages,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      })
      const msg = await stream.finalMessage()
      if (msg.stop_reason === 'refusal') throw new AiError('Claude declined this request.')
      return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    } catch (e) {
      throw explain(e)
    }
  }
}
