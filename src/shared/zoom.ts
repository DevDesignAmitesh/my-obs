import { z } from 'zod'

/**
 * Auto zoom for screen recordings (like Screen Studio): the picture zooms in where you click or
 * type, then back out. A zoom narrows the part of the source that is shown (a moving crop), so the
 * clip keeps its place and size on the canvas. Times are SOURCE seconds (like keyframes), and
 * x/y are 0..1 of the source frame.
 */

export const ZoomPoint = z.object({ t: z.number(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export type ZoomPoint = z.infer<typeof ZoomPoint>

export const Zoom = z.object({
  start: z.number(),
  end: z.number(),
  /** 2 = twice as close. */
  scale: z.number().min(1).max(4),
  /** Where to look; the view pans from one point to the next, arriving at each point's time. */
  points: z.array(ZoomPoint).min(1)
})
export type Zoom = z.infer<typeof Zoom>

/** A click or keystroke during recording, in source seconds and 0..1 of the recorded screen. */
export interface InputMark {
  t: number
  kind: 'click' | 'key'
  x: number
  y: number
}

export const DEFAULT_ZOOM_SCALE = 1.8
/** Seconds to zoom in / out / pan to the next point. */
const ZOOM_IN = 0.45
const ZOOM_OUT = 0.6
const PAN = 0.6
/** A click zooms in a little before it (so it is already close when it happens) and stays a while. */
const CLICK_LEAD = 0.5
const CLICK_HOLD = 1.6
/** Keystrokes less than this apart are one bit of typing. */
const KEY_GAP = 1.5
const KEY_LEAD = 0.3
const KEY_HOLD = 1.0
/** Zooms closer than this are joined (no zooming out and straight back in). */
const MERGE_GAP = 1.0

/** Zooms for the clicks and typing of a recording. */
export function zoomsFromInput(marks: InputMark[], scale: number, duration: number): Zoom[] {
  const sorted = marks.filter((m) => m.t >= 0 && m.t <= duration).sort((a, b) => a.t - b.t)
  const raw: Zoom[] = []
  let burst: InputMark[] = []
  const endBurst = (): void => {
    if (!burst.length) return
    const first = burst[0]
    raw.push({ start: first.t - KEY_LEAD, end: burst[burst.length - 1].t + KEY_HOLD, scale, points: [{ t: first.t, x: first.x, y: first.y }] })
    burst = []
  }
  for (const m of sorted) {
    if (m.kind === 'key') {
      if (burst.length && m.t - burst[burst.length - 1].t > KEY_GAP) endBurst()
      burst.push(m)
    } else raw.push({ start: m.t - CLICK_LEAD, end: m.t + CLICK_HOLD, scale, points: [{ t: m.t, x: m.x, y: m.y }] })
  }
  endBurst()
  raw.sort((a, b) => a.start - b.start)
  const out: Zoom[] = []
  for (const z of raw) {
    const last = out[out.length - 1]
    if (last && z.start <= last.end + MERGE_GAP) {
      last.end = Math.max(last.end, z.end)
      last.points.push(...z.points)
    } else out.push({ ...z, points: [...z.points] })
  }
  return out
    .map((z) => ({ ...z, start: Math.max(0, z.start), end: Math.min(duration, z.end), points: z.points.sort((a, b) => a.t - b.t) }))
    .filter((z) => z.end - z.start > 0.3)
}

const smooth = (u: number): number => u * u * (3 - 2 * u)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** How far zoomed in, and where, at a source time (null when not zoomed). */
export function zoomAt(zooms: Zoom[], t: number): { scale: number; x: number; y: number } | null {
  const z = zooms.find((x) => t >= x.start && t <= x.end)
  if (!z) return null
  const len = z.end - z.start
  const rin = Math.min(ZOOM_IN, len / 2)
  const rout = Math.min(ZOOM_OUT, len / 2)
  const k = t < z.start + rin ? smooth((t - z.start) / rin) : t > z.end - rout ? smooth((z.end - t) / rout) : 1
  let x = z.points[0].x
  let y = z.points[0].y
  for (const p of z.points.slice(1)) {
    const u = (t - (p.t - PAN)) / PAN
    if (u <= 0) break
    const s = smooth(Math.min(1, u))
    x += (p.x - x) * s
    y += (p.y - y) * s
  }
  return { scale: 1 + (z.scale - 1) * k, x, y }
}

type Crop = { left: number; top: number; right: number; bottom: number }

/**
 * The crop that shows `zoom.scale` times closer around (x, y), inside the clip's own crop. The
 * clip's box on the canvas stays the same size (the narrower source is scaled up to fill it).
 */
export function zoomCrop(crop: Crop, zoom: { scale: number; x: number; y: number }): Crop {
  if (zoom.scale <= 1.0001) return crop
  const w0 = 1 - crop.left - crop.right
  const h0 = 1 - crop.top - crop.bottom
  const w = w0 / zoom.scale
  const h = h0 / zoom.scale
  const left = clamp(zoom.x - w / 2, crop.left, crop.left + w0 - w)
  const top = clamp(zoom.y - h / 2, crop.top, crop.top + h0 - h)
  return { left, top, right: 1 - left - w, bottom: 1 - top - h }
}
