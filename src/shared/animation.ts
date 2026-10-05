import { z } from 'zod'
import type { Clip, Transform } from './project'

/**
 * Keyframe animation of a clip's position / size / opacity / rotation. Keys are anchored to the
 * clip's SOURCE time (like volume points), so trimming a clip never shifts its animation.
 */

export const TransformKey = z.object({
  /** Source seconds. */
  t: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().optional(),
  /** Easing of the move INTO this key. */
  ease: z.enum(['linear', 'smooth']).default('smooth')
})
export type TransformKey = z.infer<typeof TransformKey>

const PROPS = ['x', 'y', 'scale', 'opacity', 'rotation'] as const
type Prop = (typeof PROPS)[number]
export type AnimatedValues = Pick<Transform, Prop>

const smooth = (u: number): number => u * u * (3 - 2 * u)

/** A clip's transform at a source time, with its keyframes applied. */
export function transformAt(clip: Pick<Clip, 'transform' | 'keys'>, sourceTime: number): Transform {
  const keys = clip.keys
  if (!keys?.length) return clip.transform
  const out: Transform = { ...clip.transform }
  for (const prop of PROPS) {
    const ks = keys.filter((k) => k[prop] !== undefined)
    if (!ks.length) continue
    let v: number
    if (sourceTime <= ks[0].t) v = ks[0][prop]!
    else if (sourceTime >= ks[ks.length - 1].t) v = ks[ks.length - 1][prop]!
    else {
      const i = ks.findIndex((k) => k.t > sourceTime)
      const a = ks[i - 1]
      const b = ks[i]
      const u = (sourceTime - a.t) / Math.max(1e-6, b.t - a.t)
      v = a[prop]! + (b[prop]! - a[prop]!) * (b.ease === 'linear' ? u : smooth(u))
    }
    ;(out as Record<Prop, number>)[prop] = v
  }
  return out
}

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'full'

/**
 * Position/scale that puts media of mw×mh into a canvas corner at `size` (fraction of the canvas
 * width), `margin` from the edges — or back to full screen.
 */
export function cornerTransform(corner: Corner, mw: number, mh: number, W: number, H: number, size = 0.33, margin = 0.035): AnimatedValues {
  if (corner === 'full') return { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0 }
  const fit = Math.min(W / mw, H / mh)
  const scale = (size * W) / (mw * fit)
  const halfW = (mw * fit * scale) / 2 / W
  const halfH = (mh * fit * scale) / 2 / H
  const mx = margin
  const my = (margin * W) / H
  return {
    x: corner.endsWith('right') ? 1 - mx - halfW : mx + halfW,
    y: corner.startsWith('bottom') ? 1 - my - halfH : my + halfH,
    scale,
    opacity: 1,
    rotation: 0
  }
}

/**
 * Keys that animate `clip` from wherever it is at timeline time `time` to `to` over `duration`.
 * Existing keys inside that window are replaced.
 */
export function animateKeys(clip: Clip, time: number, duration: number, to: Partial<AnimatedValues>, ease: 'linear' | 'smooth' = 'smooth'): TransformKey[] {
  const s0 = clip.in + (time - clip.start)
  const s1 = s0 + Math.max(0.05, duration)
  const from = transformAt(clip, s0)
  const startKey: TransformKey = { t: s0, ease }
  const endKey: TransformKey = { t: s1, ease }
  for (const prop of PROPS) {
    if (to[prop] === undefined) continue
    startKey[prop] = from[prop]
    endKey[prop] = to[prop]
  }
  const kept = (clip.keys ?? []).filter((k) => k.t < s0 - 1e-6 || k.t > s1 + 1e-6)
  return [...kept, startKey, endKey].sort((a, b) => a.t - b.t)
}
