import { themeAt } from '@shared/sections'
import { audioSegments, gainAt, visualLayersAt, type AudioSegment } from '@shared/render-plan'
import { projectDuration, type MediaItem, type Project } from '@shared/project'
import { drawTimelineFrame, type LayerImage } from './draw'
import { drawCaptions } from './captions-draw'
import { LiveMotionFrames, rasterWidth } from './motion-render'

type El = HTMLVideoElement | HTMLAudioElement | HTMLImageElement

interface Entry {
  el: El
  mediaId: string
  /** Web Audio gain for this element's sound (allows >100% volume and smooth ramps). */
  gain?: GainNode
}

/** The element key and media to play a segment's sound from (processed audio gets its own element). */
export function soundSource(s: AudioSegment): { key: string; media: MediaItem } {
  if (!s.audioPath) return { key: s.key, media: s.media }
  return { key: `${s.key}:fx`, media: { ...s.media, id: `${s.media.id}:${s.audioPath}`, kind: 'audio', path: s.audioPath } }
}

/** Color, text and generated SVG layers are drawn from data; they need no media element. */
const drawnDirectly = (m: MediaItem): boolean => m.kind === 'color' || m.kind === 'graphic' || m.kind === 'motion'

/** How far ahead clips get loaded so cuts play without a hiccup. */
const PRELOAD_S = 1.5
/** Re-sync an element when it drifts this far from the timeline clock while playing. */
const MAX_DRIFT_S = 0.2

/** The player currently shown (so keyboard shortcuts can reach it). */
export let activePlayer: Player | null = null

/**
 * Timeline preview. Uses native <video>/<audio> elements (hardware decoding, smooth on a laptop)
 * kept in sync with a timeline clock, drawn through the same renderer as export.
 * Frame-exact rendering happens at export time.
 */
export class Player {
  time = 0
  playing = false
  onTime?: (t: number) => void
  onPlayingChange?: (playing: boolean) => void

  private els = new Map<string, Entry>()
  private box = document.createElement('div')
  private clockStart = 0
  private timeAtStart = 0
  private raf = 0
  private drawQueued = false
  private ctx: CanvasRenderingContext2D
  private scale: number
  private audioCtx = new AudioContext()
  private motion = new LiveMotionFrames(() => this.queueDraw())

  constructor(
    private canvas: HTMLCanvasElement,
    private project: Project,
    private projectPath: string
  ) {
    const { width: W, height: H } = project.settings
    // Preview at most at 1080p; export always renders at full size.
    this.scale = Math.min(1, 1920 / Math.max(W, H))
    canvas.width = Math.round(W * this.scale)
    canvas.height = Math.round(H * this.scale)
    this.ctx = canvas.getContext('2d')!
    this.box.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    document.body.appendChild(this.box)
    activePlayer = this
    this.sync()
  }

  setProject(p: Project): void {
    const sizeChanged = p.settings.width !== this.project.settings.width || p.settings.height !== this.project.settings.height
    this.project = p
    if (sizeChanged) {
      const { width: W, height: H } = p.settings
      this.scale = Math.min(1, 1920 / Math.max(W, H))
      this.canvas.width = Math.round(W * this.scale)
      this.canvas.height = Math.round(H * this.scale)
    }
    this.sync()
  }

  get duration(): number {
    return projectDuration(this.project)
  }

  seek(t: number): void {
    this.time = Math.max(0, t)
    if (this.playing) {
      this.clockStart = performance.now()
      this.timeAtStart = this.time
    }
    this.sync()
  }

  play(): void {
    if (this.playing) return
    void this.audioCtx.resume() // play() is called from a click/key, so audio may start
    if (this.time >= this.duration - 0.05) this.time = 0
    this.playing = true
    this.clockStart = performance.now()
    this.timeAtStart = this.time
    this.onPlayingChange?.(true)
    const loop = (): void => {
      if (!this.playing) return
      this.time = this.timeAtStart + (performance.now() - this.clockStart) / 1000
      if (this.time >= this.duration) {
        this.time = this.duration
        this.pause()
      } else this.sync()
      this.onTime?.(this.time)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this.raf)
    for (const { el } of this.els.values()) if (!(el instanceof HTMLImageElement)) el.pause()
    this.onPlayingChange?.(false)
    this.sync()
  }

  /** The current preview frame as a JPEG data URL, at most `maxW` wide (for the AI assistant). */
  snapshot(maxW = 1024, box?: { x: number; y: number; w: number; h: number } | null): string {
    const s = Math.min(1, maxW / this.canvas.width)
    const c = document.createElement('canvas')
    c.width = Math.round(this.canvas.width * s)
    c.height = Math.round(this.canvas.height * s)
    const ctx = c.getContext('2d')!
    ctx.drawImage(this.canvas, 0, 0, c.width, c.height)
    if (box) {
      // The area the user pointed at, outlined so the AI can see it.
      ctx.strokeStyle = '#ff3ea5'
      ctx.lineWidth = Math.max(3, c.width / 300)
      ctx.setLineDash([12, 8])
      ctx.strokeRect(box.x * c.width, box.y * c.height, box.w * c.width, box.h * c.height)
    }
    return c.toDataURL('image/jpeg', 0.8)
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  dispose(): void {
    this.pause()
    for (const key of [...this.els.keys()]) this.drop(key)
    this.box.remove()
    void this.audioCtx.close()
    if (activePlayer === this) activePlayer = null
  }

  // ------------------------------------------------------------------------------------------

  private element(key: string, media: MediaItem): El {
    const existing = this.els.get(key)
    if (existing && existing.mediaId === media.id) return existing.el
    if (existing) this.drop(key)
    const src = window.studio.media.url(this.projectPath, media.path)
    let el: El
    if (media.kind === 'image') {
      el = new Image()
    } else {
      el = document.createElement(media.kind === 'video' ? 'video' : 'audio')
      el.preload = 'auto'
      ;(el as HTMLVideoElement).playsInline = true
      el.addEventListener('seeked', () => this.queueDraw())
      el.addEventListener('loadeddata', () => this.queueDraw())
    }
    el.crossOrigin = 'anonymous'
    if (el instanceof HTMLImageElement) el.onload = () => this.queueDraw()
    el.src = src
    this.box.appendChild(el)
    const entry: Entry = { el, mediaId: media.id }
    if (!(el instanceof HTMLImageElement)) {
      entry.gain = this.audioCtx.createGain()
      entry.gain.gain.value = 0
      this.audioCtx.createMediaElementSource(el).connect(entry.gain).connect(this.audioCtx.destination)
    }
    this.els.set(key, entry)
    return el
  }

  private drop(key: string): void {
    const e = this.els.get(key)
    if (!e) return
    if (!(e.el instanceof HTMLImageElement)) {
      e.el.pause()
      e.el.removeAttribute('src')
      e.el.load()
    }
    e.el.remove()
    e.gain?.disconnect()
    this.els.delete(key)
  }

  /** Brings every element to the right state for `this.time`, then draws. */
  private sync(): void {
    const p = this.project
    const t = this.time
    const fps = p.settings.fps
    const layers = visualLayersAt(p, t)
    const segs = audioSegments(p)
    // Sound comes from the clip's own element, or from a separate one for processed audio.
    const activeSegs = new Map<string, AudioSegment>()
    const wanted = new Map<string, { media: MediaItem; sourceTime: number; active: boolean }>()
    for (const l of layers) if (!drawnDirectly(l.media)) wanted.set(l.key, { media: l.media, sourceTime: l.sourceTime, active: true })
    for (const s of segs) {
      if (t < s.start || t >= s.start + s.duration) continue
      const { key, media } = soundSource(s)
      activeSegs.set(key, s)
      wanted.set(key, { media, sourceTime: s.in + (t - s.start), active: true })
    }
    // Upcoming clips: load them and park them at their first frame.
    for (const track of p.tracks) {
      for (const c of track.clips) {
        if (wanted.has(c.id) || c.start < t || c.start > t + PRELOAD_S) continue
        const media = p.media.find((m) => m.id === c.mediaId)
        if (media && !drawnDirectly(media)) wanted.set(c.id, { media, sourceTime: c.in, active: false })
      }
    }

    for (const key of [...this.els.keys()]) if (!wanted.has(key)) this.drop(key)

    for (const [key, w] of wanted) {
      const el = this.element(key, w.media)
      if (el instanceof HTMLImageElement) continue
      const seg = activeSegs.get(key)
      const gain = this.els.get(key)!.gain!
      gain.gain.setTargetAtTime(seg ? gainAt(seg, t) : 0, this.audioCtx.currentTime, 0.01)
      const target = Math.max(0, w.sourceTime)
      if (this.playing && w.active) {
        if (el.paused) {
          el.currentTime = target
          el.play().catch(() => undefined)
        } else if (Math.abs(el.currentTime - target) > MAX_DRIFT_S) el.currentTime = target
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - target) > 0.5 / fps) el.currentTime = target
      }
    }
    this.draw(layers)
  }

  private queueDraw(): void {
    if (this.drawQueued || this.playing) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      this.draw(visualLayersAt(this.project, this.time))
    })
  }

  private draw(layers: ReturnType<typeof visualLayersAt>): void {
    const images: LayerImage[] = []
    const { width: W, height: H } = this.project.settings
    this.motion.keep(new Set(layers.map((l) => l.key)))
    for (const layer of layers) {
      const m = layer.media.motion
      if (layer.media.kind === 'motion' && m) {
        const img = this.motion.get(layer.key, m, layer.sourceTime, rasterWidth(m, W, H, layer.transform.scale) * this.scale)
        if (img) images.push({ layer, image: img, width: img.naturalWidth, height: img.naturalHeight })
        continue
      }
      if (drawnDirectly(layer.media)) {
        images.push({ layer, image: null, width: W, height: H })
        continue
      }
      const e = this.els.get(layer.key)
      if (!e) continue
      const el = e.el
      if (el instanceof HTMLImageElement) {
        if (el.complete && el.naturalWidth) images.push({ layer, image: el, width: el.naturalWidth, height: el.naturalHeight })
      } else if (el instanceof HTMLVideoElement && el.readyState >= 2) {
        images.push({ layer, image: el, width: el.videoWidth, height: el.videoHeight })
      }
    }
    const t = this.time
    drawTimelineFrame(this.ctx, W, H, images, { theme: themeAt(this.project, t), scale: this.scale, overlay: (c) => drawCaptions(c, this.project, t, W, H) })
  }
}
