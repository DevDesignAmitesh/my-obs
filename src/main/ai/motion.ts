import { z } from 'zod'
import { EASES, extractJson, Motion, MOTION_KIND_INFO, sanitizeSvg } from '@shared/motion'
import type { MotionRequest } from '@shared/api'
import { getSettings } from '../settings'
import { chatProvider } from './index'
import { AiError, type ChatMessage } from './types'

const Reply = z.object({ name: z.string().default('Animation'), motion: Motion })

function system(req: MotionRequest): string {
  const { width: W, height: H } = req.canvas
  const t = req.theme
  return `You design SVG graphics and animations for a video editor. Reply with ONE JSON object only (no prose):
{"name": "<2-5 word label>", "motion": {"svg": "<svg …>…</svg>", "width": <viewBox width>, "height": <viewBox height>, "duration": <seconds>, "loop": <bool>, "tracks": [ … ]}}

SVG rules
- Pure static SVG markup with viewBox="0 0 width height". No <script>, no CSS animations, no SMIL (<animate>), no external images or fonts, no foreignObject.
- Transparent background unless a background is asked for (it is layered over video).
- Icons, logos and single objects: a tight square-ish viewBox (e.g. 0 0 512 512) with the art filling it.
- Full-screen pieces (diagrams, titles, text motion, intros): viewBox exactly 0 0 ${W} ${H} (the video canvas). Keep important things inside the middle 90%.
- Give every element you animate an id (or a shared class for groups like words or bars). Group parts that move together in <g id="…">.
- Lines that should "draw themselves" must be stroked shapes (stroke set, fill="none").
- Text: font-family "${t.font}, Segoe UI, sans-serif" (code: "${t.monoFont}, Consolas, monospace"); text-anchor/dominant-baseline for alignment. For word-by-word text use one <text> or <tspan> per word with class="word".
- Style to match the video theme unless the user asks otherwise: text ${t.text}, muted ${t.muted}, accent ${t.accent}, second accent ${t.accent2}, panels ${t.panel}, background ${t.background}. Bold, clean, modern, readable at video size.

Animation ("tracks"; leave empty for a still image)
- A track: {"target": "<CSS selector, e.g. #arrow or .word>", "stagger": <seconds between matched elements, 0 = together>, "keys": [ {"t": <seconds>, …values…, "ease": "<${EASES.join('|')}>"} ]}
- Values (each optional, each interpolated only between keys that set it): opacity 0..1; x, y = offset in viewBox units from the element's own position; scale (1 = normal); rotate (degrees, around its center); draw 0..1 (fraction of the outline drawn); fill / stroke ("#rrggbb").
- "ease" on a key is how the motion arrives at it. "back" overshoots (pops), "bounce" lands with bounces, "elastic" wobbles.
- Elements are drawn as in the SVG when no key sets a value, so to make something appear, start it at opacity 0 / scale 0 / draw 0 in a key at t=0.
- Entrances usually 0.3–0.8 s; stagger reveals 0.08–0.3 s; leave the final state still for at least 1 s. Keep everything within "duration".
- "loop": true only for things meant to repeat (spinners, pulsing icons).

Kind of piece: ${MOTION_KIND_INFO[req.kind].name}.${req.duration ? ` Duration: about ${req.duration} s.` : ''}`
}

/** Asks the assistant model for an SVG/animation; retries once if the reply doesn't validate. */
export async function generateMotion(req: MotionRequest): Promise<{ name: string; motion: Motion }> {
  if (!req.prompt.trim()) throw new AiError('Describe what to make first.')
  const { assistant } = (await getSettings()).ai
  if (!assistant.model) throw new AiError('Choose an assistant model in Settings → AI.')
  const provider = await chatProvider(assistant.provider)
  const ask = req.current
    ? `Here is the current piece:\n${JSON.stringify({ motion: req.current })}\n\nChange it: ${req.prompt}\nReturn the complete updated JSON.`
    : req.prompt
  const messages: ChatMessage[] = [{ role: 'user', content: ask }]
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await provider.chat({ model: assistant.model, system: system(req), messages, maxTokens: 16000 })
    try {
      const r = Reply.parse(extractJson(text))
      if (!/^\s*<svg[\s>]/i.test(r.motion.svg)) throw new Error('"svg" must start with <svg')
      return { name: r.name, motion: { ...r.motion, svg: sanitizeSvg(r.motion.svg), prompt: req.current ? `${req.current.prompt}\n${req.prompt}` : req.prompt } }
    } catch (e) {
      lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That reply was not valid (${lastError}). Reply again with only the corrected JSON object.` })
    }
  }
  throw new AiError(`The AI's animation was not usable (${lastError}). Try again or simplify the request.`)
}
