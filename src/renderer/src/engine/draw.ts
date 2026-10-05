import type { VisualLayer } from '@shared/render-plan'
import { transformToPlacement } from '@shared/scene'
import type { Theme } from '@shared/theme'
import { applyMask } from '../recorder/compositor'
import { drawGraphic } from './graphics-draw'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface LayerImage {
  layer: VisualLayer
  /** null for color and text layers (drawn directly). */
  image: CanvasImageSource | null
  width: number
  height: number
}

export interface FrameOptions {
  theme: Theme
  /** Render smaller than the project size (e.g. a 4K project previewed at 1080p) with identical layout. */
  scale?: number
  /** Drawn in project pixels on top of everything (captions). */
  overlay?: (ctx: Ctx2D) => void
}

/** Draws one timeline frame. Used by the preview and the exporter, so both match. */
export function drawTimelineFrame(ctx: Ctx2D, W: number, H: number, layers: LayerImage[], opts: FrameOptions): void {
  ctx.save()
  const scale = opts.scale ?? 1
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  for (const { layer, image, width, height } of layers) {
    // Text layers are always laid out on the current canvas size.
    const isGraphic = layer.media.kind === 'graphic'
    const w = isGraphic ? W : width
    const h = isGraphic ? H : height
    if (!w || !h || layer.alpha <= 0) continue
    const t = layer.transform
    const p = transformToPlacement(t, w, h, W, H)
    ctx.save()
    ctx.globalAlpha = Math.min(1, layer.alpha)
    if (t.rotation || t.flipH || t.flipV) {
      const cx = p.dx + p.dw / 2
      const cy = p.dy + p.dh / 2
      ctx.translate(cx, cy)
      if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180)
      if (t.flipH || t.flipV) ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1)
      ctx.translate(-cx, -cy)
    }
    if (isGraphic && layer.media.graphic) {
      ctx.translate(p.dx, p.dy)
      ctx.scale(p.dw / W, p.dh / H)
      drawGraphic(ctx, layer.media.graphic, opts.theme, W, H, layer.localTime)
    } else {
      applyMask(ctx as CanvasRenderingContext2D, t.mask, p.dx, p.dy, p.dw, p.dh)
      if (image) ctx.drawImage(image, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh)
      else {
        ctx.fillStyle = layer.media.color ?? '#000000'
        ctx.fillRect(p.dx, p.dy, p.dw, p.dh)
      }
    }
    ctx.restore()
  }
  opts.overlay?.(ctx)
  ctx.restore()
}
