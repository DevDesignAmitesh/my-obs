import { z } from 'zod'

/**
 * Generated vector art and animation ("motion" media): an SVG plus keyframe tracks that animate
 * its elements. Pure data, so it's undoable, editable by the AI ("make it slower") and renders the
 * same in preview and export: each frame the renderer applies `valuesAt()` to the SVG and draws it.
 */

export const EASES = ['linear', 'in', 'out', 'inOut', 'back', 'bounce', 'elastic'] as const
export const Ease = z.enum(EASES)
export type Ease = z.infer<typeof Ease>

const Color = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)

export const MotionKey = z.object({
  /** Seconds from the start of the animation (for staggered elements: from that element's start). */
  t: z.number().nonnegative(),
  opacity: z.number().min(0).max(1).optional(),
  /** Offset from the element's own position, in viewBox units. */
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().optional(),
  /** Degrees, around the element's center. */
  rotate: z.number().optional(),
  /** How much of the outline is drawn, 0..1 (lines that draw themselves). */
  draw: z.number().min(0).max(1).optional(),
  fill: Color.optional(),
  stroke: Color.optional(),
  /** Easing used to arrive at this key. */
  ease: Ease.optional()
})
export type MotionKey = z.infer<typeof MotionKey>

export const MotionTrack = z.object({
  /** CSS selector of the element(s) to animate, e.g. "#arrow" or ".word". */
  target: z.string().min(1),
  /** When the selector matches several elements, each starts this many seconds after the previous. */
  stagger: z.number().nonnegative().default(0),
  keys: z.array(MotionKey).min(1)
})
export type MotionTrack = z.infer<typeof MotionTrack>

export const Motion = z.object({
  /** Complete <svg> markup with a viewBox of `width`×`height`. */
  svg: z.string().min(10),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Length of the animation in seconds (a still SVG has no tracks). */
  duration: z.number().positive().default(4),
  /** Repeat when the clip is longer than the animation (otherwise it holds the last frame). */
  loop: z.boolean().default(false),
  tracks: z.array(MotionTrack).default([]),
  /** What the user asked for (kept so it can be changed later). */
  prompt: z.string().default('')
})
export type Motion = z.infer<typeof Motion>

export const MOTION_KINDS = ['icon', 'diagram', 'intro', 'text'] as const
export type MotionKind = (typeof MOTION_KINDS)[number]
export const MOTION_KIND_INFO: Record<MotionKind, { name: string; hint: string }> = {
  icon: { name: 'Icon / illustration', hint: 'e.g. a rocket icon, a laptop with code, a thumbs-up' },
  diagram: { name: 'Animated diagram', hint: 'e.g. client → server → database flow, a bar chart growing' },
  intro: { name: 'Logo / title intro', hint: 'e.g. my channel name revealing with a glow' },
  text: { name: 'Text motion', hint: 'e.g. "Stop wasting time" words popping in one by one' }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

export function ease(kind: Ease | undefined, x: number): number {
  x = clamp01(x)
  switch (kind ?? 'inOut') {
    case 'linear':
      return x
    case 'in':
      return x * x * x
    case 'out':
      return 1 - (1 - x) ** 3
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
    case 'back': {
      const c = 1.70158
      return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2
    }
    case 'bounce': {
      const n = 7.5625
      const d = 2.75
      if (x < 1 / d) return n * x * x
      if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75
      if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375
      return n * (x -= 2.625 / d) * x + 0.984375
    }
    case 'elastic':
      return x === 0 || x === 1 ? x : 2 ** (-10 * x) * Math.sin(((x * 10 - 0.75) * 2 * Math.PI) / 3) + 1
  }
}

const NUMERIC = ['opacity', 'x', 'y', 'scale', 'rotate', 'draw'] as const
const COLORS = ['fill', 'stroke'] as const
export type MotionValues = Partial<Record<(typeof NUMERIC)[number], number> & Record<(typeof COLORS)[number], string>>

function hexToRgb(h: string): [number, number, number] {
  const s = h.length === 4 ? h.slice(1).replace(/./g, (c) => c + c) : h.slice(1)
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number]
}
const rgbToHex = (c: number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/**
 * Values of every animated property at time t (seconds). Each property is interpolated between
 * the keys that set it; before the first such key it holds that key's value, after the last the last.
 */
export function valuesAt(keys: MotionKey[], t: number): MotionValues {
  const out: MotionValues = {}
  for (const prop of [...NUMERIC, ...COLORS]) {
    const ks = keys.filter((k) => k[prop] !== undefined).sort((a, b) => a.t - b.t)
    if (!ks.length) continue
    let value: number | string = ks[ks.length - 1][prop]!
    if (t <= ks[0].t) value = ks[0][prop]!
    else {
      for (let i = 1; i < ks.length; i++) {
        if (t > ks[i].t) continue
        const a = ks[i - 1]
        const b = ks[i]
        const f = b.t - a.t < 1e-6 ? 1 : ease(b.ease, (t - a.t) / (b.t - a.t))
        if (typeof a[prop] === 'number') value = (a[prop] as number) + ((b[prop] as number) - (a[prop] as number)) * f
        else {
          const ca = hexToRgb(a[prop] as string)
          const cb = hexToRgb(b[prop] as string)
          value = rgbToHex(ca.map((v, j) => v + (cb[j] - v) * f))
        }
        break
      }
    }
    ;(out as Record<string, number | string>)[prop] = value
  }
  return out
}

/** Animation time for a clip's source time (looping or holding the last frame). */
export function motionTime(m: Motion, sourceTime: number): number {
  if (m.loop && m.duration > 0) return ((sourceTime % m.duration) + m.duration) % m.duration
  return Math.max(0, Math.min(m.duration, sourceTime))
}

/** Pulls the JSON object out of a model reply (tolerates ```json fences and chatter around it). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('The AI did not return JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/**
 * Removes anything that could run code or load outside files. (SVGs drawn as images can't run
 * scripts anyway; this keeps the stored markup clean too.)
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href\s*=\s*)("|')(?!#|data:image\/)[^"']*\2/gi, '$1$2#$2')
}
