import { z } from 'zod'

/**
 * Scenes (OBS-style): a canvas made of sources, each placed in a rectangle.
 * Rects are normalized to the canvas (0..1), top-left origin.
 */

export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
export type Rect = z.infer<typeof Rect>

export const Fit = z.enum(['contain', 'cover'])
export type Fit = z.infer<typeof Fit>

export const Mask = z.enum(['none', 'rounded', 'circle'])
export type Mask = z.infer<typeof Mask>

export const SceneSource = z.discriminatedUnion('type', [
  /** A monitor or a window, from Electron's desktopCapturer. `name` helps re-find windows after restarts. */
  z.object({ type: z.literal('display'), sourceId: z.string().optional(), name: z.string().optional() }),
  z.object({ type: z.literal('camera'), deviceId: z.string().optional(), label: z.string().optional() }),
  /** An image from the project's media (logo, background, frame…). */
  z.object({ type: z.literal('image'), mediaId: z.string().optional() })
])
export type SceneSource = z.infer<typeof SceneSource>

export const SceneItem = z.object({
  id: z.string(),
  name: z.string(),
  source: SceneSource,
  rect: Rect,
  fit: Fit.default('contain'),
  mask: Mask.default('none'),
  /** Mirror left-right (typical for webcams). */
  flipH: z.boolean().default(false),
  visible: z.boolean().default(true)
})
export type SceneItem = z.infer<typeof SceneItem>

export const Scene = z.object({
  id: z.string(),
  name: z.string(),
  /** Drawing order: first item is at the back. */
  items: z.array(SceneItem).default([])
})
export type Scene = z.infer<typeof Scene>

// ---------------------------------------------------------------------------------------------
// Presets

const id = (): string => globalThis.crypto.randomUUID()

const screenItem = (rect: Rect): SceneItem => ({
  id: id(), name: 'Screen', source: { type: 'display' }, rect, fit: 'contain', mask: 'none', flipH: false, visible: true
})
const cameraItem = (rect: Rect, mask: Mask = 'none'): SceneItem => ({
  id: id(), name: 'Camera', source: { type: 'camera' }, rect, fit: 'cover', mask, flipH: false, visible: true
})

export interface ScenePreset {
  key: string
  name: string
  build(canvasW: number, canvasH: number): SceneItem[]
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    key: 'screen-cam',
    name: 'Screen + camera bubble',
    build(W, H) {
      // A square bubble, 32% of the canvas height, in the bottom-right corner.
      const size = Math.min(W, H) * 0.32
      const m = Math.min(W, H) * 0.03
      return [
        screenItem({ x: 0, y: 0, w: 1, h: 1 }),
        cameraItem({ x: (W - size - m) / W, y: (H - size - m) / H, w: size / W, h: size / H }, 'circle')
      ]
    }
  },
  { key: 'screen', name: 'Screen only', build: () => [screenItem({ x: 0, y: 0, w: 1, h: 1 })] },
  { key: 'cam', name: 'Camera only', build: () => [cameraItem({ x: 0, y: 0, w: 1, h: 1 })] },
  {
    key: 'side',
    name: 'Side by side',
    build: (W, H) =>
      W >= H
        ? [screenItem({ x: 0, y: 0, w: 0.68, h: 1 }), cameraItem({ x: 0.68, y: 0, w: 0.32, h: 1 })]
        : [screenItem({ x: 0, y: 0, w: 1, h: 0.5 }), cameraItem({ x: 0, y: 0.5, w: 1, h: 0.5 })]
  }
]

/**
 * Identity of what a scene item captures. Scenes that show the same screen or camera share one
 * capture and one recorded file, so switching scenes while recording only changes the layout.
 */
export const sourceKey = (item: SceneItem): string => {
  const s = item.source
  if (s.type === 'display') return `display:${s.sourceId ?? 'primary'}`
  if (s.type === 'camera') return `camera:${s.deviceId ?? 'default'}`
  return `image:${s.mediaId ?? ''}`
}

/** One recorded source per distinct screen/camera shown (visible) in any of the scenes, in first-seen order. */
export function recordedSources(scenes: Scene[]): SceneItem[] {
  const seen = new Map<string, SceneItem>()
  for (const scene of scenes) {
    for (const item of scene.items) {
      if (item.visible && item.source.type !== 'image' && !seen.has(sourceKey(item))) seen.set(sourceKey(item), item)
    }
  }
  return [...seen.values()]
}

export function createScene(name: string, preset: ScenePreset, canvasW: number, canvasH: number): Scene {
  return { id: id(), name, items: preset.build(canvasW, canvasH) }
}

// ---------------------------------------------------------------------------------------------
// Layout math shared by the live compositor and the timeline.

export interface Placement {
  /** Source crop, in source pixels. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Destination, in canvas pixels. */
  dx: number
  dy: number
  dw: number
  dh: number
}

/** Where to draw a srcW×srcH image inside a destination rect (pixels) for the given fit. */
export function placeInRect(srcW: number, srcH: number, dest: Rect, fit: Fit): Placement {
  const srcAspect = srcW / srcH
  const destAspect = dest.w / dest.h
  if (fit === 'cover') {
    // Crop the source to the destination's aspect ratio, centered.
    let sw = srcW
    let sh = srcH
    if (srcAspect > destAspect) sw = srcH * destAspect
    else sh = srcW / destAspect
    return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, dx: dest.x, dy: dest.y, dw: dest.w, dh: dest.h }
  }
  // contain: letterbox inside the rect, centered.
  let dw = dest.w
  let dh = dest.h
  if (srcAspect > destAspect) dh = dest.w / srcAspect
  else dw = dest.h * srcAspect
  return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: dest.x + (dest.w - dw) / 2, dy: dest.y + (dest.h - dh) / 2, dw, dh }
}

export const rectToPixels = (r: Rect, W: number, H: number): Rect => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H })

/**
 * Converts a scene item placement into a timeline clip Transform.
 * Clip transform semantics: the (cropped) source is first contain-fitted to the canvas, then
 * multiplied by `scale`, and centered at (x, y) in normalized canvas coordinates.
 */
export function placementToTransform(
  p: Placement,
  srcW: number,
  srcH: number,
  W: number,
  H: number
): { x: number; y: number; scale: number; crop: { left: number; top: number; right: number; bottom: number } } {
  const fitScale = Math.min(W / p.sw, H / p.sh)
  return {
    x: (p.dx + p.dw / 2) / W,
    y: (p.dy + p.dh / 2) / H,
    scale: p.dw / (p.sw * fitScale),
    crop: {
      left: p.sx / srcW,
      top: p.sy / srcH,
      right: (srcW - p.sx - p.sw) / srcW,
      bottom: (srcH - p.sy - p.sh) / srcH
    }
  }
}

/** Inverse of placementToTransform: where a clip with this transform is drawn on the canvas. */
export function transformToPlacement(
  t: { x: number; y: number; scale: number; crop: { left: number; top: number; right: number; bottom: number } },
  srcW: number,
  srcH: number,
  W: number,
  H: number
): Placement {
  const sx = t.crop.left * srcW
  const sy = t.crop.top * srcH
  const sw = Math.max(1, srcW * (1 - t.crop.left - t.crop.right))
  const sh = Math.max(1, srcH * (1 - t.crop.top - t.crop.bottom))
  const fitScale = Math.min(W / sw, H / sh)
  const dw = sw * fitScale * t.scale
  const dh = sh * fitScale * t.scale
  return { sx, sy, sw, sh, dx: t.x * W - dw / 2, dy: t.y * H - dh / 2, dw, dh }
}
