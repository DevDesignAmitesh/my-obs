import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Rect } from '@shared/scene'

/**
 * Overlay on the viewer for "Ask about this frame": drag a box where the change should go, or
 * use the whole frame. Coordinates are normalized to the frame.
 */
export function FramePicker(props: { onPick(box: Rect | null): void; onCancel(): void }) {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const norm = (e: { clientX: number; clientY: number }, el: HTMLElement): { x: number; y: number } => {
    const r = el.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }

  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const p0 = norm(e, el)
    let cur = { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y }
    setDrag(cur)
    const move = (ev: PointerEvent): void => {
      const p = norm(ev, el)
      cur = { ...cur, x1: p.x, y1: p.y }
      setDrag(cur)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const box = { x: Math.min(cur.x0, cur.x1), y: Math.min(cur.y0, cur.y1), w: Math.abs(cur.x1 - cur.x0), h: Math.abs(cur.y1 - cur.y0) }
      setDrag(null)
      // A click (tiny box) means "this whole frame".
      props.onPick(box.w < 0.02 || box.h < 0.02 ? null : round(box))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="absolute inset-0 z-10 cursor-crosshair bg-black/25" onPointerDown={down}>
      <div className="pointer-events-auto absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-panel/95 px-3 py-1.5 text-xs shadow" onPointerDown={(e) => e.stopPropagation()}>
        <span>Drag a box where you want the change</span>
        <button className="rounded bg-panel-2 px-2 py-0.5 hover:bg-line" onClick={() => props.onPick(null)}>Whole frame</button>
        <button className="text-muted hover:text-text" onClick={props.onCancel}>Cancel</button>
      </div>
      {drag && <FocusBox box={{ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }} />}
    </div>
  )
}

/** The dashed magenta outline of the pointed-at area. */
export function FocusBox({ box }: { box: Rect }) {
  return (
    <div
      className="pointer-events-none absolute border-2 border-dashed border-[#ff3ea5] bg-[#ff3ea5]/10"
      style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
    />
  )
}

const round = (b: Rect): Rect => ({ x: +b.x.toFixed(3), y: +b.y.toFixed(3), w: +b.w.toFixed(3), h: +b.h.toFixed(3) })
