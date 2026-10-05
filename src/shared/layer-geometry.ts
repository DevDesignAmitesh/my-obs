import type { Clip, MediaItem, Transform } from './project'
import type { TransformKey } from './animation'

/**
 * Where a layer sits on the canvas, for picking and dragging it in the preview.
 * A layer is drawn around its center c = (x·W, y·H), scaled by `scale` and rotated about c
 * (see transformToPlacement / drawTimelineFrame). `local` is the visible rect relative to c at
 * scale 1, so the visible rect is c + scale·local, rotated about c. Project pixels.
 */
export interface LayerGeometry {
  cx: number
  cy: number
  scale: number
  /** Degrees. */
  rotation: number
  local: { x: number; y: number; w: number; h: number }
}

export interface Point {
  x: number
  y: number
}

export function layerGeometry(media: MediaItem, t: Pick<Transform, 'x' | 'y' | 'scale' | 'rotation' | 'crop'>, W: number, H: number): LayerGeometry | null {
  const base = { cx: t.x * W, cy: t.y * H, scale: t.scale, rotation: t.rotation }
  if (media.kind === 'audio') return null
  if (media.kind === 'graphic') {
    // Text layers are canvas-sized; what you see is their box.
    const b = media.graphic?.box ?? { x: 0, y: 0, w: 1, h: 1 }
    return { ...base, local: { x: b.x * W - W / 2, y: b.y * H - H / 2, w: b.w * W, h: b.h * H } }
  }
  const srcW = media.kind === 'color' ? W : media.width
  const srcH = media.kind === 'color' ? H : media.height
  if (!srcW || !srcH) return null
  const sw = srcW * (1 - t.crop.left - t.crop.right)
  const sh = srcH * (1 - t.crop.top - t.crop.bottom)
  if (sw <= 0 || sh <= 0) return null
  const fit = Math.min(W / sw, H / sh)
  return { ...base, local: { x: (-sw * fit) / 2, y: (-sh * fit) / 2, w: sw * fit, h: sh * fit } }
}

const rot = (p: Point, deg: number): Point => {
  if (!deg) return p
  const a = (deg * Math.PI) / 180
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }
}

/** The visible rect before rotation (project pixels). */
export const visibleRect = (g: LayerGeometry): { x: number; y: number; w: number; h: number } => ({
  x: g.cx + g.scale * g.local.x,
  y: g.cy + g.scale * g.local.y,
  w: g.scale * g.local.w,
  h: g.scale * g.local.h
})

/** Is canvas point p on the layer? */
export function hitLayer(g: LayerGeometry, p: Point): boolean {
  if (g.scale <= 0) return false
  const q = rot({ x: p.x - g.cx, y: p.y - g.cy }, -g.rotation)
  const x = q.x / g.scale
  const y = q.y / g.scale
  return x >= g.local.x && x <= g.local.x + g.local.w && y >= g.local.y && y <= g.local.y + g.local.h
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se'
const OPPOSITE: Record<Corner, Corner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }

/** A corner of the visible rect, relative to the center at scale 1 (unrotated). */
function cornerLocal(g: LayerGeometry, c: Corner): Point {
  return { x: g.local.x + (c[1] === 'e' ? g.local.w : 0), y: g.local.y + (c[0] === 's' ? g.local.h : 0) }
}

/** Where a corner is on the canvas. */
export function cornerPoint(g: LayerGeometry, c: Corner): Point {
  const l = cornerLocal(g, c)
  const r = rot({ x: l.x * g.scale, y: l.y * g.scale }, g.rotation)
  return { x: g.cx + r.x, y: g.cy + r.y }
}

/**
 * New center and scale after dragging `corner` to pointer p, keeping the opposite corner fixed
 * (or the center, with `fromCenter`). The aspect ratio is always kept.
 */
export function scaleFromCorner(g: LayerGeometry, corner: Corner, p: Point, fromCenter = false): { cx: number; cy: number; scale: number } {
  const anchorLocal = fromCenter ? { x: 0, y: 0 } : cornerLocal(g, OPPOSITE[corner])
  const anchor = fromCenter ? { x: g.cx, y: g.cy } : cornerPoint(g, OPPOSITE[corner])
  const grabbed = cornerPoint(g, corner)
  const d = { x: grabbed.x - anchor.x, y: grabbed.y - anchor.y }
  const len2 = d.x * d.x + d.y * d.y
  if (len2 < 1e-9) return { cx: g.cx, cy: g.cy, scale: g.scale }
  const ratio = ((p.x - anchor.x) * d.x + (p.y - anchor.y) * d.y) / len2
  const scale = Math.max(0.02, g.scale * ratio)
  const off = rot({ x: anchorLocal.x * scale, y: anchorLocal.y * scale }, g.rotation)
  return { cx: anchor.x - off.x, cy: anchor.y - off.y, scale }
}

type Placed = Partial<Pick<Transform, 'x' | 'y' | 'scale'>>

/**
 * Edit ops payload for setting a clip's position/scale as seen at `sourceTime`: values that are
 * keyframed get a key at that moment (updated if one is within half a frame); the rest change the
 * clip's base transform.
 */
export function placeClip(clip: Pick<Clip, 'keys'>, values: Placed, sourceTime: number, fps: number): { transform: Placed; keys: TransformKey[] | null } {
  const animated = (k: keyof Placed): boolean => clip.keys.some((key) => key[k] !== undefined)
  const transform: Placed = {}
  const keyed: Placed = {}
  for (const k of Object.keys(values) as (keyof Placed)[]) (animated(k) ? keyed : transform)[k] = values[k]
  if (!Object.keys(keyed).length) return { transform, keys: null }
  const i = clip.keys.findIndex((k) => Math.abs(k.t - sourceTime) < 0.5 / fps)
  const keys =
    i >= 0
      ? clip.keys.map((k, j) => (j === i ? { ...k, ...keyed } : k))
      : [...clip.keys, { t: sourceTime, ease: 'smooth' as const, ...keyed }].sort((a, b) => a.t - b.t)
  return { transform, keys }
}
