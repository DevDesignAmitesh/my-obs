import { motionTime, sanitizeSvg, valuesAt, type Motion, type MotionValues } from '@shared/motion'

/**
 * Draws generated SVG animations ("motion" media). The SVG is parsed once; for each frame the
 * animated values are written onto its elements as inline styles and the result is decoded as an
 * image, so preview and export use the exact same pixels.
 */

const SHAPES = 'path,line,polyline,polygon,circle,ellipse,rect'
const COLORABLE = `${SHAPES},text,tspan`
/** Elements that can't be wrapped in a <g> (they must stay inside their parent). */
const NO_WRAP = new Set(['tspan', 'textPath', 'stop', 'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'svg'])
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Target {
  /** Gets transform/opacity (a <g> wrapped around `el`, so the element's own transform is kept). */
  box: SVGElement
  el: SVGElement
}

interface Prepared {
  root: SVGSVGElement
  /** Matched elements per track, in document order. */
  targets: Target[][]
}

const prepared = new WeakMap<Motion, Prepared>()

/** Without xmlns the markup parses as plain XML (no SVG elements, nothing draws), and AIs often leave it out. */
function withNamespaces(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg)
  if (!open) return svg
  let tag = open[0]
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace(/<svg\b/i, `<svg xmlns="${SVG_NS}"`)
  if (/xlink:/.test(svg) && !/xmlns:xlink/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"')
  return svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length)
}

function prepare(m: Motion): Prepared {
  let p = prepared.get(m)
  if (p) return p
  const doc = new DOMParser().parseFromString(withNamespaces(sanitizeSvg(m.svg)), 'image/svg+xml')
  const root = doc.documentElement as unknown as SVGSVGElement
  if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) throw new Error('The animation has broken SVG markup')
  if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`)
  const targets = m.tracks.map((track) => {
    let els: SVGElement[] = []
    try {
      els = [...root.querySelectorAll<SVGElement>(track.target)]
    } catch {
      // invalid selector: this track animates nothing
    }
    return els.map((el): Target => {
      if (NO_WRAP.has(el.localName) || el.closest('defs')) return { box: el, el }
      const g = doc.createElementNS(SVG_NS, 'g') as SVGElement
      el.parentNode!.insertBefore(g, el)
      g.appendChild(el)
      return { box: g, el }
    })
  })
  p = { root, targets }
  prepared.set(m, p)
  return p
}

function apply({ box, el }: Target, v: MotionValues): void {
  const tf: string[] = []
  if (v.x || v.y) tf.push(`translate(${v.x ?? 0}px, ${v.y ?? 0}px)`)
  if (v.rotate) tf.push(`rotate(${v.rotate}deg)`)
  if (v.scale !== undefined && v.scale !== 1) tf.push(`scale(${Math.max(0, v.scale)})`)
  box.style.transform = tf.join(' ')
  box.style.transformBox = 'fill-box'
  box.style.transformOrigin = 'center'
  box.style.opacity = v.opacity === undefined ? '' : String(v.opacity)
  const self = (sel: string): SVGElement[] => [...(el.matches(sel) ? [el] : []), ...el.querySelectorAll<SVGElement>(sel)]
  if (v.fill || v.stroke) {
    for (const s of self(COLORABLE)) {
      if (v.fill) s.style.fill = v.fill
      if (v.stroke) s.style.stroke = v.stroke
    }
  }
  if (v.draw !== undefined) {
    for (const s of self(SHAPES)) {
      s.setAttribute('pathLength', '1')
      s.style.strokeDasharray = '1 1'
      s.style.strokeDashoffset = String(1 - v.draw)
    }
  }
}

/** The SVG markup of one frame, `pxW` pixels wide. */
export function frameMarkup(m: Motion, sourceTime: number, pxW: number): string {
  const p = prepare(m)
  const t = motionTime(m, sourceTime)
  m.tracks.forEach((track, i) => p.targets[i].forEach((target, j) => apply(target, valuesAt(track.keys, t - j * track.stagger))))
  const w = Math.max(16, Math.min(4096, Math.round(pxW)))
  p.root.setAttribute('width', String(w))
  p.root.setAttribute('height', String(Math.round((w * m.height) / m.width)))
  return new XMLSerializer().serializeToString(p.root)
}

/** A frame as a data: URL (for <img> previews). */
export const frameUrl = (m: Motion, sourceTime: number, pxW: number): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(frameMarkup(m, sourceTime, pxW))}`

/** A decoded frame, ready for drawImage. */
export async function renderFrame(m: Motion, sourceTime: number, pxW: number): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = frameUrl(m, sourceTime, pxW)
  await img.decode()
  return img
}

/** Pixel width that keeps the art sharp where it's drawn (fit to the canvas, then scaled). */
export function rasterWidth(m: Motion, W: number, H: number, scale: number): number {
  const fit = Math.min(W / m.width, H / m.height)
  return m.width * fit * Math.max(1, scale)
}

const ids = new WeakMap<Motion, number>()
let nextId = 1
function motionId(m: Motion): number {
  let id = ids.get(m)
  if (!id) ids.set(m, (id = nextId++))
  return id
}

/**
 * For the preview: hands back the latest finished frame for a layer straight away and renders the
 * requested one in the background (calling `onReady` when it's there).
 */
export class LiveMotionFrames {
  private state = new Map<string, { img: HTMLImageElement | null; have: string; busy: boolean }>()

  constructor(private onReady: () => void) {}

  get(key: string, m: Motion, sourceTime: number, pxW: number): HTMLImageElement | null {
    const t = Math.round(motionTime(m, sourceTime) * 30) / 30
    const w = Math.round(pxW / 64) * 64 || 64
    // An edited animation is a new Motion object, so it gets a new id and renders again.
    const want = `${motionId(m)}|${t}|${w}`
    let s = this.state.get(key)
    if (!s) {
      s = { img: null, have: '', busy: false }
      this.state.set(key, s)
    }
    if (s.have !== want && !s.busy) {
      s.busy = true
      renderFrame(m, t, w)
        .then((img) => {
          s!.img = img
          s!.have = want
        })
        .catch(() => undefined)
        .finally(() => {
          s!.busy = false
          this.onReady()
        })
    }
    return s.img
  }

  /** Forgets layers that are no longer showing. */
  keep(keys: Set<string>): void {
    for (const k of [...this.state.keys()]) if (!keys.has(k)) this.state.delete(k)
  }
}
