import { ASSISTANT_SYSTEM, buildContext, compileEdits, scopeSplits, transcriptText, validateEdits, type AiEdit, type Focus, type Proposal, type Selection } from '@shared/assistant'
import { GRAPHIC_TEMPLATES } from '@shared/graphics'
import { timelineWords } from '@shared/captions'
import type { Project } from '@shared/project'
import { getSettings } from '../settings'
import { chatProvider } from './index'
import { AiError, type ChatMessage, type LoopEvent, type ToolDef } from './types'

export interface AssistRequest {
  project: Project
  selection: Selection | null
  playhead: number
  prompt: string
  history: ChatMessage[]
  /** Optional frames as data: URLs. */
  images: string[]
  /** "Ask about this frame": the moment (and area) the user pointed at. */
  focus?: Focus | null
}

export interface AssistResult {
  reply: string
  proposal: Proposal | null
}

const num = { type: 'number' }
const str = { type: 'string' }
const clipId = { type: 'string', description: 'Clip id from the context' }
const op = (name: string, props: Record<string, unknown>, required: string[], description?: string) => ({
  type: 'object',
  description,
  properties: { op: { const: name }, ...props },
  required: ['op', ...required]
})

/** JSON Schema of every edit the assistant may propose (see AiEdit). */
const box = {
  type: 'object',
  description: 'Normalized area on the canvas (0..1): x,y = top-left corner',
  properties: { x: num, y: num, w: num, h: num },
  required: ['x', 'y', 'w', 'h']
}
const graphicFields = {
  box,
  align: { enum: ['left', 'center', 'right'] },
  kicker: { ...str, description: 'Small label above the title' },
  title: str,
  subtitle: str,
  body: { ...str, description: 'Text (text template) or label under a stat' },
  value: { ...str, description: 'Big stat value' },
  items: { type: 'array', items: { type: 'object', properties: { text: str, done: { type: 'boolean' }, at: { ...num, description: 'Seconds after the graphic starts' } }, required: ['text'] } },
  code: { ...str, description: 'Code; lines starting with "+ " or "- " show as a diff' },
  filename: str,
  tag: str,
  highlights: { type: 'array', items: { type: 'object', properties: { lines: { type: 'array', items: num }, at: num }, required: ['lines'] } },
  size: { ...num, description: 'Text size multiplier (default 1)' },
  enter: { enum: ['none', 'fade', 'rise', 'pop', 'type'] },
  panel: { type: 'boolean', description: 'Card behind the content' },
  scrim: { type: 'boolean', description: 'Dark gradient behind text over video' },
  accent: { ...str, description: '#rrggbb accent override' },
  font: { ...str, description: 'Font family override: any Google Fonts family (e.g. "Poppins", "Bebas Neue") or a Windows font' }
}
const animValues = { type: 'object', properties: { x: num, y: num, scale: num, opacity: num, rotation: num } }

const EDIT_SCHEMA = {
  anyOf: [
    op(
      'addGraphic',
      { template: { enum: [...GRAPHIC_TEMPLATES] }, start: num, end: num, clipId: { ...str, description: 'Optional new unique id' }, trackId: { ...str, description: 'Optional; normally chosen automatically on top' }, ...graphicFields },
      ['template', 'start', 'end'],
      'Text layer / card on top of the video.'
    ),
    op('updateGraphic', { clipId, patch: { type: 'object', properties: graphicFields } }, ['clipId', 'patch'], 'Change a text layer.'),
    op(
      'animate',
      {
        clipId,
        time: { ...num, description: 'Timeline time the animation starts' },
        duration: num,
        corner: { enum: ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'full'] },
        size: { ...num, description: 'Corner box width as a fraction of the canvas (default 0.33)' },
        to: animValues,
        ease: { enum: ['linear', 'smooth'] }
      },
      ['clipId', 'time', 'duration'],
      'Keyframe animation: move into a corner / back to full screen, or to explicit values.'
    ),
    op('setTheme', { preset: { enum: ['explainer', 'demo', 'happening'], description: "A mode's default look" }, patch: { type: 'object', properties: { font: str, monoFont: str, text: str, muted: str, accent: str, accent2: str, panel: str, panelBorder: str, background: str, radius: num } } }, [], 'Restyle all text layers.'),
    op(
      'cutRanges',
      {
        ranges: { type: 'array', items: { type: 'array', items: num, minItems: 2, maxItems: 2 }, description: '[start, end] pairs in timeline seconds' },
        userAskedToRemove: { type: 'boolean', description: 'Only when the user explicitly asked to drop/shorten spoken content (not for mistakes, pauses, repeats)' }
      },
      ['ranges'],
      'Remove time ranges from ALL tracks and close the gaps.'
    ),
    op('fixWord', { time: { ...num, description: 'Timeline start of the word' }, text: str }, ['time', 'text'], 'Correct the caption text of one word.'),
    op('addColor', { color: { ...str, description: '#rrggbb' }, trackId: str, start: num, end: num, clipId: { ...str, description: 'Optional new unique id' } }, ['color', 'trackId', 'start', 'end'], 'Solid color layer (background/panel) on a video track.'),
    op('splitAt', { time: num, trackIds: { type: 'array', items: str } }, ['time'], 'Split every (or the listed) track at a time.'),
    op('splitClip', { clipId, time: num, newClipId: { ...str, description: 'Unique id for the right-hand piece, so later edits can change it' } }, ['clipId', 'time', 'newClipId']),
    op('addTrack', { kind: { enum: ['video', 'audio'] }, trackId: { ...str, description: 'New unique id' } }, ['kind', 'trackId'], 'New video tracks go on top of existing ones.'),
    op('updateMedia', { mediaId: str, patch: { type: 'object', properties: { color: str } } }, ['mediaId', 'patch'], 'Change the color of a color layer.'),
    op('deleteClips', { clipIds: { type: 'array', items: str }, ripple: { type: 'boolean', description: 'Close the gap' } }, ['clipIds']),
    op('moveClip', { clipId, start: num, trackId: str }, ['clipId', 'start']),
    op('trimClip', { clipId, edge: { enum: ['start', 'end'] }, time: { ...num, description: 'New timeline time of that edge' } }, ['clipId', 'edge', 'time']),
    op(
      'updateClip',
      {
        clipId,
        transform: {
          type: 'object',
          properties: {
            x: num, y: num, scale: num, rotation: num, opacity: num,
            crop: { type: 'object', properties: { left: num, top: num, right: num, bottom: num } },
            mask: { enum: ['none', 'rounded', 'circle'] },
            flipH: { type: 'boolean', description: 'Mirror left-right' },
            flipV: { type: 'boolean' }
          }
        },
        volume: { ...num, description: '0..4, 1 = unchanged' },
        fadeIn: num,
        fadeOut: num,
        crossfadeIn: { ...num, description: 'Crossfade from the previous adjacent clip, seconds' },
        muted: { type: 'boolean' },
        enhance: { enum: ['off', 'light', 'medium', 'strong'], description: 'Voice noise cleanup' }
      },
      ['clipId']
    ),
    op('setVolumeKeys', { clipId, keys: { type: 'array', items: { type: 'object', properties: { t: { ...num, description: 'SOURCE seconds' }, v: { ...num, description: 'gain, 1 = 100%' } }, required: ['t', 'v'] } } }, ['clipId', 'keys'], 'Volume automation (replaces existing points).'),
    op('addMarker', { time: num, label: str }, ['time', 'label']),
    op(
      'setCaptionStyle',
      {
        patch: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' }, font: str, size: { ...num, description: '% of canvas height' }, color: str, highlightColor: str,
            highlight: { enum: ['none', 'word', 'karaoke'] }, outline: { type: 'boolean' }, background: { type: 'boolean' },
            y: { ...num, description: 'Vertical center, 0 top .. 1 bottom' },
            x: { ...num, description: 'Horizontal center of the caption area, 0 left .. 1 right' },
            width: { ...num, description: 'Caption area width as a fraction of the canvas (0.1..1)' },
            uppercase: { type: 'boolean' }, maxChars: num, maxLines: num
          }
        }
      },
      ['patch']
    ),
    op('insertClip', { trackId: str, mediaId: str, start: num, in: num, out: num, clipId: { ...str, description: 'Optional new unique id' } }, ['trackId', 'mediaId', 'start']),
    op('detachAudio', { clipId }, ['clipId']),
    op('insertGap', { at: num, length: { ...num, description: 'Seconds of empty space' } }, ['at', 'length'], 'Push everything at or after `at` later on ALL tracks, making room (e.g. for an intro).')
  ]
}

const TOOLS: ToolDef[] = [
  {
    name: 'get_transcript',
    description: 'Returns the spoken words (word@start-end in timeline seconds) between two timeline times.',
    schema: { type: 'object', properties: { start: num, end: num }, required: ['start', 'end'] }
  },
  {
    name: 'propose_edits',
    description: 'Proposes timeline edits for the user to review. Call once with all edits. Returns an error message if an edit is invalid.',
    schema: {
      type: 'object',
      properties: { summary: { ...str, description: 'One short sentence describing the change' }, edits: { type: 'array', items: EDIT_SCHEMA } },
      required: ['summary', 'edits']
    }
  }
]

export interface AssistLog {
  /** What is sent to the model before the loop starts. */
  request(info: { provider: string; model: string; system: string; userText: string; images: number; tools: ToolDef[] }): void
  event(e: LoopEvent): void
}

export async function runAssistant(req: AssistRequest, onStatus: (text: string) => void, log?: AssistLog): Promise<AssistResult> {
  const { assistant } = (await getSettings()).ai
  if (!assistant.model) throw new AiError('Choose an assistant model in Settings → AI first.')
  const provider = await chatProvider(assistant.provider)

  let proposal: Proposal | null = null
  // A marked part: clips crossing its edges are split first, so the AI only works inside it.
  const scope = req.selection
  const pre = scope ? scopeSplits(req.project, scope) : []
  const base = pre.length ? compileEdits(req.project, pre).after : req.project
  const words = timelineWords(base)
  onStatus('Thinking…')
  const userText = `${buildContext(base, scope, req.playhead, req.focus ?? null)}\n\nREQUEST: ${req.prompt}`
  log?.request({ provider: assistant.provider, model: assistant.model, system: ASSISTANT_SYSTEM, userText, images: req.images.length, tools: TOOLS })
  const reply = await provider.runTools({
    model: assistant.model,
    system: ASSISTANT_SYSTEM,
    history: req.history,
    user: { text: userText, images: req.images },
    tools: TOOLS,
    onLog: log ? (e) => log.event(e) : undefined,
    async runTool(name, input) {
      const args = (input ?? {}) as Record<string, unknown>
      if (name === 'get_transcript') {
        onStatus('Reading the transcript…')
        return transcriptText(words, Number(args.start), Number(args.end)) || 'No words in that range.'
      }
      if (name === 'propose_edits') {
        onStatus('Checking the proposed edits…')
        const edits = [...pre, ...((Array.isArray(args.edits) ? args.edits : []) as AiEdit[])]
        const v = validateEdits(req.project, Array.isArray(args.edits) && args.edits.length ? edits : args.edits, { scope })
        if (!v.ok) return `Error: ${v.error}. Fix the edits and call propose_edits again.`
        proposal = { summary: String(args.summary ?? ''), edits }
        return 'Proposal recorded. The user will review it before it is applied.'
      }
      return `Error: unknown tool ${name}`
    }
  })
  return { reply, proposal }
}
