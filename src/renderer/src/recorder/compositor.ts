import { placeInRect, rectToPixels, type Mask, type Scene, type SceneItem } from '@shared/scene'

export interface Drawable {
  el: CanvasImageSource
  width: number
  height: number
}

/** Clip path for masked items (rounded corners / circular camera bubble). */
export function applyMask(ctx: CanvasRenderingContext2D, mask: Mask, x: number, y: number, w: number, h: number): void {
  if (mask === 'none') return
  ctx.beginPath()
  // Always a true circle (never an oval), centered in the box.
  if (mask === 'circle') ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2)
  else ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.08)
  ctx.clip()
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, item: SceneItem, W: number, H: number): void {
  const r = rectToPixels(item.rect, W, H)
  ctx.save()
  ctx.fillStyle = '#1b1f27'
  ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.strokeStyle = '#3a4150'
  ctx.lineWidth = Math.max(2, W / 640)
  ctx.setLineDash([12, 8])
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  ctx.fillStyle = '#8b93a5'
  ctx.font = `${Math.round(H / 30)}px Segoe UI, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(item.name, r.x + r.w / 2, r.y + r.h / 2)
  ctx.restore()
}

/** Draws one frame of a scene. Used for the live preview and for the recorded "program" video. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  W: number,
  H: number,
  resolve: (item: SceneItem) => Drawable | null
): void {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  for (const item of scene.items) {
    if (!item.visible) continue
    const d = resolve(item)
    if (!d || !d.width || !d.height) {
      drawPlaceholder(ctx, item, W, H)
      continue
    }
    const p = placeInRect(d.width, d.height, rectToPixels(item.rect, W, H), item.fit)
    ctx.save()
    applyMask(ctx, item.mask, p.dx, p.dy, p.dw, p.dh)
    if (item.flipH) {
      ctx.translate(p.dx * 2 + p.dw, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(d.el, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh)
    ctx.restore()
  }
}
