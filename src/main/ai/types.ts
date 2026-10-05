import type { Word } from '@shared/transcript'

/** Provider-neutral interfaces. Each provider adapter implements what it supports. */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
}

/** A tool the model may call; `schema` is JSON Schema for its input. */
export interface ToolDef {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface ToolLoopRequest {
  model: string
  system: string
  /** Earlier turns of the conversation (text only). */
  history: ChatMessage[]
  /** This turn: text plus optional images as data: URLs (JPEG/PNG). */
  user: { text: string; images?: string[] }
  tools: ToolDef[]
  /** Runs a tool call; the returned text goes back to the model. */
  runTool(name: string, input: unknown): Promise<string>
  maxSteps?: number
  /** Called with every model response and tool result (for logs). */
  onLog?(event: LoopEvent): void
}

export type LoopEvent =
  | { type: 'model'; step: number; text: string; toolCalls: { name: string; input: unknown }[]; stopReason?: string | null; usage?: unknown }
  | { type: 'tool'; step: number; name: string; input: unknown; output: string }

export interface ChatProvider {
  listModels(): Promise<string[]>
  chat(req: ChatRequest): Promise<string>
  /** Lets the model call tools until it answers in text; returns that answer. */
  runTools(req: ToolLoopRequest): Promise<string>
}

export const DEFAULT_MAX_STEPS = 8

/** Splits a data: URL into media type and base64 data. */
export function parseDataUrl(url: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (!m) throw new Error('Images must be data: URLs')
  return { mediaType: m[1], data: m[2] }
}

export interface TranscribeOptions {
  model: string
  /** ISO-639-1 code; omit to auto-detect. */
  language?: string
  /** Style hint (e.g. to keep filler words). */
  prompt?: string
}

export interface TranscribeResult {
  words: Word[]
  language?: string
}

export interface TranscriptionProvider {
  /** Transcribes one audio file (well under the provider's upload limit). */
  transcribe(file: string, opts: TranscribeOptions): Promise<TranscribeResult>
}

/** Errors shown to the user as-is. */
export class AiError extends Error {}
