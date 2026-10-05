import { useRef, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { Rect, Scene } from '@shared/scene'
import { useFitBox } from '../components/useFitBox'

const MIN = 0.03

interface Props {
  canvasRef: RefObject<HTMLCanvasElement | null>
  scene: Scene
  width: number
  height: number
  selectedId: string | null
  onSelect(id: string | null): void
  /** `commit` is false while dragging (preview only) and true on release. */
  onRectChange(id: string, rect: Rect, commit: boolean): void
  overlay?: React.ReactNode
}

/** The live scene canvas, with click-to-select and drag/resize handles for the selected source. */
export function PreviewStage({ canvasRef, scene, width, height, selectedId, onSelect, onRectChange, overlay }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const fit = useFitBox<HTMLDivElement>(width, height)
  const selected = scene.items.find((i) => i.id === selectedId && i.visible)

  const toNorm = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  /** Generic drag helper: calls `update` with the pointer position, commits on release. */
  const drag = (id: string, update: (p: { x: number; y: number }, shift: boolean) => Rect): void => {
    let last: Rect | null = null
    const move = (ev: PointerEvent): void => {
      last = update(toNorm(ev), ev.shiftKey)
      onRectChange(id, last, false)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (last) onRectChange(id, last, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onStagePointerDown = (e: ReactPointerEvent): void => {
    const p = toNorm(e)
    // Topmost visible item under the pointer.
    const hit = [...scene.items].reverse().find((i) => i.visible && p.x >= i.rect.x && p.x <= i.rect.x + i.rect.w && p.y >= i.rect.y && p.y <= i.rect.y + i.rect.h)
    onSelect(hit?.id ?? null)
    if (!hit) return
    const start = hit.rect
    drag(hit.id, (q) => ({
      ...start,
      x: Math.min(1 - MIN, Math.max(MIN - start.w, start.x + q.x - p.x)),
      y: Math.min(1 - MIN, Math.max(MIN - start.h, start.y + q.y - p.y))
    }))
  }

  const onHandlePointerDown = (e: ReactPointerEvent, sx: 1 | -1, sy: 1 | -1): void => {
    e.stopPropagation()
    const r = selected!.rect
    // The corner opposite the handle stays put. Aspect ratio is kept unless Shift is held.
    const ax = sx > 0 ? r.x : r.x + r.w
    const ay = sy > 0 ? r.y : r.y + r.h
    drag(selected!.id, (q, free) => {
      const w = Math.max(MIN, sx * (q.x - ax))
      const h = free ? Math.max(MIN, sy * (q.y - ay)) : (w * r.h) / r.w
      return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h }
    })
  }

  /** Side handles resize one dimension; the opposite side stays put. */
  const onEdgePointerDown = (e: ReactPointerEvent, edge: 'l' | 'r' | 't' | 'b'): void => {
    e.stopPropagation()
    const r = selected!.rect
    drag(selected!.id, (q) => {
      if (edge === 'r') return { ...r, w: Math.max(MIN, q.x - r.x) }
      if (edge === 'b') return { ...r, h: Math.max(MIN, q.y - r.y) }
      if (edge === 'l') {
        const x = Math.min(q.x, r.x + r.w - MIN)
        return { ...r, x, w: r.x + r.w - x }
      }
      const y = Math.min(q.y, r.y + r.h - MIN)
      return { ...r, y, h: r.y + r.h - y }
    })
  }

  return (
    <div ref={fit.ref} className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-4">
      <div
        ref={boxRef}
        className="relative shrink-0 bg-black shadow-lg"
        style={{ width: fit.width, height: fit.height }}
        onPointerDown={onStagePointerDown}
      >
        <canvas ref={canvasRef} width={width} height={height} className="h-full w-full" />
        {selected && (
          <div
            className="pointer-events-none absolute border-2 border-accent"
            style={{
              left: `${selected.rect.x * 100}%`,
              top: `${selected.rect.y * 100}%`,
              width: `${selected.rect.w * 100}%`,
              height: `${selected.rect.h * 100}%`
            }}
          >
            {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sy]) => (
              <div
                key={`${sx}${sy}`}
                onPointerDown={(e) => onHandlePointerDown(e, sx === -1 ? -1 : 1, sy === -1 ? -1 : 1)}
                className="pointer-events-auto absolute h-3 w-3 rounded-sm border border-white bg-accent"
                style={{
                  left: sx < 0 ? -7 : undefined,
                  right: sx > 0 ? -7 : undefined,
                  top: sy < 0 ? -7 : undefined,
                  bottom: sy > 0 ? -7 : undefined,
                  // Handle at top-left drags the top-left corner, etc.
                  cursor: sx === sy ? 'nwse-resize' : 'nesw-resize'
                }}
              />
            ))}
            {(['l', 'r', 't', 'b'] as const).map((edge) => {
              const vertical = edge === 'l' || edge === 'r'
              return (
                <div
                  key={edge}
                  onPointerDown={(e) => onEdgePointerDown(e, edge)}
                  className="pointer-events-auto absolute rounded-sm border border-white bg-accent"
                  style={{
                    width: vertical ? 8 : 22,
                    height: vertical ? 22 : 8,
                    left: edge === 'l' ? -5 : vertical ? undefined : 'calc(50% - 11px)',
                    right: edge === 'r' ? -5 : undefined,
                    top: edge === 't' ? -5 : vertical ? 'calc(50% - 11px)' : undefined,
                    bottom: edge === 'b' ? -5 : undefined,
                    cursor: vertical ? 'ew-resize' : 'ns-resize'
                  }}
                />
              )
            })}
          </div>
        )}
        {overlay}
      </div>
    </div>
  )
}
