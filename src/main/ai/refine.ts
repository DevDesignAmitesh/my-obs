import { buildContext, type ChatTurn, type Focus, type Selection } from '@shared/assistant'
import { sectionAt } from '@shared/sections'
import { modeById, parseRefined, REFINER_SYSTEM, type RefinedFeedback } from '@shared/modes'
import type { Project } from '@shared/project'
import { getSettings } from '../settings'
import { chatProvider } from './index'
import { AiError } from './types'

export interface RefineRequest {
  project: Project
  feedback: string
  /** Recent chat, oldest first. */
  history: Pick<ChatTurn, 'role' | 'text'>[]
  focus?: Focus | null
  /** The marked part the feedback is about, if any. */
  selection?: Selection | null
  playhead: number
}

/**
 * Step 1 of feedback: an AI reads the feedback in the context of the mode, the standing
 * instructions, the timeline and the conversation, and rewrites it as one precise editing
 * instruction (plus anything to remember). Step 2 is the normal editing assistant.
 */
export async function refineFeedback(req: RefineRequest): Promise<RefinedFeedback & { raw: string; prompt: string }> {
  const { assistant } = (await getSettings()).ai
  if (!assistant.model) throw new AiError('Choose an assistant model in Settings → AI first.')
  const scope = req.selection ?? null
  // Feedback on a marked part follows that part's own mode and mood.
  const part = scope ? sectionAt(req.project, (scope.start + scope.end) / 2) : undefined
  const mode = modeById(part?.mode ?? req.project.mode)
  const prompt = [
    `VIDEO MODE: ${mode.name}\n${mode.recipe}`,
    `STANDING INSTRUCTIONS FROM THE USER: ${req.project.extraPrompt.trim() || '(none)'}`,
    ...(part?.mood.trim() ? [`MOOD OF THIS PART: ${part.mood.trim()}`] : []),
    ...(scope ? [`THE FEEDBACK IS ABOUT THE MARKED PART ${scope.start.toFixed(2)}–${scope.end.toFixed(2)} s ONLY: the instruction must change nothing outside it.`] : []),
    `CURRENT PROJECT:\n${buildContext(req.project, scope, req.playhead, req.focus ?? null)}`,
    `RECENT CONVERSATION:\n${req.history.slice(-8).map((t) => `${t.role === 'user' ? 'User' : 'Editor'}: ${t.text}`).join('\n') || '(none)'}`,
    `NEW FEEDBACK: ${req.feedback}`
  ].join('\n\n')
  const raw = await (await chatProvider(assistant.provider)).chat({
    model: assistant.model,
    system: REFINER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    // Reasoning models spend part of this on thinking; leave room for the answer.
    maxTokens: 16000
  })
  return { ...parseRefined(raw, req.feedback), raw, prompt }
}
