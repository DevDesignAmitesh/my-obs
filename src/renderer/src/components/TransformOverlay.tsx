import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { visualLayersAt, type VisualLayer } from '@shared/render-plan'
import { graphicLabel } from '@shared/graphics'
import { cornerPoint, hitLayer, layerGeometry, placeClip, scaleFromCorner, visibleRect, type Corner, type LayerGeometry, type Point } from '@shared/layer-geometry'
import type { EditOp } from '@shared/ops'
import { useStudio } from '../store'

/** How close (screen pixels) an edge or center must come to a canvas edge/center line to snap. */
const SNAP_PX = 8
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

interface Item {
  layer: VisualLayer
  geo: LayerGeometry
  name: string
  trackName: string
  locked: boolean
}

/**
 * Select what is on screen in the paused preview and move/scale it by dragging.
 * Click: pick the top layer there · Alt+click: the one below · Shift/Ctrl+click: add to selection ·
 * drag: move (snaps to canvas edges and center; hold Shift for free) · corner handles: resize
 * (Alt: from the center) · double-click: play/pause · Layers menu: pick anything, even a covered background.
 */
export function TransformOverlay(props: { width: number; height: number; onTogglePlay(): void }) {
  const project = useStudio((s) => s.project)!
  const playhead = useStudio((s) => s.playhead)
  const selected = useStudio((s) => s.selectedClipIds)
  const { width: W, height: H, fps } = project.settings
  const k = props.width / W // screen px per project px
  const [hover, setHover] = useState<string | null>(null)
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] })
  const [readout, setReadout] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const items: Item[] = visualLayersAt(project, playhead).flatMap((layer) => {
    const geo = layerGeometry(layer.media, layer.transform, W, H)
    const track = project.tracks.find((t) => t.clips.some((c) => c.id === layer.clip.id))
    if (!geo || !track) return []
    const name = layer.media.graphic ? graphicLabel(layer.media.graphic) : layer.media.name
    return [{ layer, geo, name, trackName: track.name, locked: track.locked }]
  })
  const topFirst = [...items].reverse()

  const toCanvas = (e: { clientX: number; clientY: number }): Point => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  const select = (ids: string[]): void => {
    const s = useStudio.getState()
    s.selectClips(ids)
    if (ids.length && s.rightTab === 'captions') s.setRightTab('clip')
  }

  /** Writes new centers/scales for the dragged layers, at most once per frame, as one undo step. */
  const writer = (session: string) => {
    let pending: Map<string, { item: Item; values: { x?: number; y?: number; scale?: number } }> | null = null
    let raf = 0
    const flush = (): void => {
      raf = 0
      if (!pending) return
      const ops: EditOp[] = []
      for (const { item, values } of pending.values()) {
        const clip = useStudio.getState().project!.tracks.flatMap((t) => t.clips).find((c) => c.id === item.layer.clip.id)
        if (!clip) continue
        const r = placeClip(clip, values, item.layer.sourceTime, fps)
        if (Object.keys(r.transform).length) ops.push({ op: 'updateClip', clipId: clip.id, transform: r.transform })
        if (r.keys) ops.push({ op: 'setTransformKeys', clipId: clip.id, keys: r.keys })
      }
      pending = null
      if (ops.length) useStudio.getState().dispatch(ops, { coalesce: session })
    }
    return {
      set(item: Item, values: { x?: number; y?: number; scale?: number }): void {
        const round = (v: number | undefined): number | undefined => (v === undefined ? v : Math.round(v * 10000) / 10000)
        pending ??= new Map()
        pending.set(item.layer.clip.id, { item, values: { x: round(values.x), y: round(values.y), scale: round(values.scale) } })
        if (!raf) raf = requestAnimationFrame(flush)
      },
      end(): void {
        if (raf) cancelAnimationFrame(raf)
        flush()
      }
    }
  }

  const track = (move: (ev: PointerEvent) => void, done: () => void): void => {
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      done()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onPointerDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    setMenu(false)
    const p0 = toCanvas(e)
    const hits = topFirst.filter((it) => hitLayer(it.geo, p0))
    const id = (it: Item): string => it.layer.clip.id
    let pick: Item | undefined
    if (e.altKey) {
      // Select through: the layer under the current one.
      const i = hits.findIndex((it) => selected.includes(id(it)))
      pick = hits[(i + 1) % Math.max(1, hits.length)]
    } else pick = hits.find((it) => selected.includes(id(it))) ?? hits[0] // keep dragging what's selected
    if (!pick) return select([])
    if (e.shiftKey || e.ctrlKey) {
      select(selected.includes(id(pick)) ? selected.filter((x) => x !== id(pick!)) : [...selected, id(pick)])
      return
    }
    const ids = selected.includes(id(pick)) ? selected : [id(pick)]
    select(ids)

    // Move everything selected that is on screen and not locked.
    const moving = items.filter((it) => ids.includes(id(it)) && !it.locked)
    if (!moving.length) return useStudio.getState().showToast(`Track ${pick.trackName} is locked`)
    const w = writer(`viewer-move:${Date.now()}`)
    const lead = moving.find((it) => it === pick) ?? moving[0]
    const leadRect = visibleRect(lead.geo)
    let movedAtAll = false
    track(
      (ev) => {
        const p = toCanvas(ev)
        let dx = p.x - p0.x
        let dy = p.y - p0.y
        if (!movedAtAll && Math.hypot(dx, dy) * k < 3) return // still a click
        movedAtAll = true
        const v: number[] = []
        const h: number[] = []
        if (!ev.shiftKey) {
          // Snap the lead layer's left/center/right (top/middle/bottom) to the canvas edges and center.
          const snap1 = (edges: number[], lines: number[], out: number[]): number => {
            let best = SNAP_PX / k
            let shift = 0
            let at: number | null = null
            for (const e1 of edges) for (const l of lines) if (Math.abs(l - e1) < best) (best = Math.abs(l - e1)), (shift = l - e1), (at = l)
            if (at !== null) out.push(at)
            return shift
          }
          const r = { ...leadRect, x: leadRect.x + dx, y: leadRect.y + dy }
          dx += snap1([r.x, r.x + r.w / 2, r.x + r.w], [0, W / 2, W], v)
          dy += snap1([r.y, r.y + r.h / 2, r.y + r.h], [0, H / 2, H], h)
        }
        setGuides({ v, h })
        for (const it of moving) w.set(it, { x: (it.geo.cx + dx) / W, y: (it.geo.cy + dy) / H })
        setReadout(`X ${Math.round(((lead.geo.cx + dx) / W) * 100)}% · Y ${Math.round(((lead.geo.cy + dy) / H) * 100)}%`)
      },
      () => {
        w.end()
        setGuides({ v: [], h: [] })
        setReadout(null)
      }
    )
  }

  const startScale = (e: ReactPointerEvent, it: Item, corner: Corner): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    if (it.locked) return useStudio.getState().showToast(`Track ${it.trackName} is locked`)
    const w = writer(`viewer-scale:${Date.now()}`)
    track(
      (ev) => {
        const r = scaleFromCorner(it.geo, corner, toCanvas(ev), ev.altKey)
        w.set(it, { x: r.cx / W, y: r.cy / H, scale: r.scale })
        setReadout(`Size ${Math.round(r.scale * 100)}%`)
      },
      () => {
        w.end()
        setReadout(null)
      }
    )
  }

  const outline = (it: Item, sel: boolean) => {
    const r = visibleRect(it.geo)
    return (
      <div
        key={it.layer.clip.id}
        className={`pointer-events-none absolute ${sel ? 'border-2 border-accent' : 'border border-dashed border-white/70'}`}
        style={{
          left: r.x * k,
          top: r.y * k,
          width: r.w * k,
          height: r.h * k,
          transform: it.geo.rotation ? `rotate(${it.geo.rotation}deg)` : undefined,
          transformOrigin: `${(it.geo.cx - r.x) * k}px ${(it.geo.cy - r.y) * k}px`
        }}
      >
        {sel &&
          !it.locked &&
          CORNERS.map((c) => (
            <div
              key={c}
              title="Drag to resize · Alt: from the center"
              className="pointer-events-auto absolute h-3 w-3 rounded-sm border border-accent bg-white"
              style={{
                left: c[1] === 'e' ? '100%' : 0,
                top: c[0] === 's' ? '100%' : 0,
                transform: 'translate(-50%, -50%)',
                cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize'
              }}
              onPointerDown={(e) => startScale(e, it, c)}
            />
          ))}
      </div>
    )
  }

  const selItems = items.filter((it) => selected.includes(it.layer.clip.id))
  const hoverItem = hover && !selected.includes(hover) ? items.find((it) => it.layer.clip.id === hover) : undefined

  return (
    <div
      ref={boxRef}
      className="absolute inset-0 z-[5] cursor-move overflow-visible"
      onPointerDown={onPointerDown}
      onDoubleClick={props.onTogglePlay}
      onPointerMove={(e) => {
        if (e.buttons) return
        const p = toCanvas(e)
        setHover(topFirst.find((it) => hitLayer(it.geo, p))?.layer.clip.id ?? null)
      }}
      onPointerLeave={() => setHover(null)}
    >
      {hoverItem && outline(hoverItem, false)}
      {selItems.map((it) => outline(it, true))}
      {guides.v.map((x) => <div key={`v${x}`} className="pointer-events-none absolute inset-y-0 w-0 border-l border-[#ff3ea5]" style={{ left: x * k }} />)}
      {guides.h.map((y) => <div key={`h${y}`} className="pointer-events-none absolute inset-x-0 h-0 border-t border-[#ff3ea5]" style={{ top: y * k }} />)}

      {readout && <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/75 px-2 py-0.5 font-mono text-[11px] text-white">{readout}</div>}

      {/* Layers at this moment, top first: pick anything, even a background hidden under other layers. */}
      <div className="absolute top-2 right-2 text-xs" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="rounded bg-black/60 px-2 py-0.5 text-white hover:bg-black/80" onClick={() => setMenu((m) => !m)} title="Everything on screen right now">
          ▤ Layers ({items.length})
        </button>
        {menu && (
          <div className="absolute right-0 mt-1 w-56 overflow-hidden rounded border border-line bg-panel shadow-lg">
            {topFirst.length === 0 && <p className="px-2 py-1.5 text-muted">Nothing on screen here.</p>}
            {topFirst.map((it) => {
              const id = it.layer.clip.id
              return (
                <button
                  key={id}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-panel-2 ${selected.includes(id) ? 'text-accent' : ''}`}
                  onClick={(e) => select(e.shiftKey || e.ctrlKey ? [...new Set([...selected, id])] : [id])}
                  onPointerEnter={() => setHover(id)}
                >
                  <span className="w-6 shrink-0 text-muted">{it.trackName}</span>
                  <span className="min-w-0 flex-1 truncate">{it.name}</span>
                  <span className="shrink-0 text-muted">{it.locked ? '🔒' : `${Math.round(it.geo.scale * 100)}%`}</span>
                </button>
              )
            })}
            {items.length > 1 && (
              <button className="w-full border-t border-line px-2 py-1.5 text-left text-muted hover:bg-panel-2 hover:text-text" onClick={() => select(items.map((it) => it.layer.clip.id))}>
                Select all on screen
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
