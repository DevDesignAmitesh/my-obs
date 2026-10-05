import { clipEnd, clipLength, isStill, type Clip, type MediaItem, type Project, type Track, type VolumeKey } from './project'
import { enhancedAudioPath } from './audio'
import { transformAt } from './animation'
import { zoomAt, zoomCrop } from './zoom'

/**
 * What to show and play at any moment of the timeline. Used by both the preview player and the
 * exporter, so what you see is exactly what gets exported.
 */

const EPS = 1e-6

export interface VisualLayer {
  /** Stable key for decoder/element reuse (the clip id). */
  key: string
  clip: Clip
  media: MediaItem
  /** Time inside the source media, seconds. */
  sourceTime: number
  /** Seconds since the clip started on the timeline (drives text-layer entrance animations). */
  localTime: number
  /** The clip's transform at this moment (keyframes applied). */
  transform: Clip['transform']
  /** Final opacity (animated opacity × fades × crossfade). */
  alpha: number
}

const mediaEnd = (m: MediaItem): number => (isStill(m) ? Infinity : m.duration)

/** Fade in/out multiplier for a clip at timeline time t. */
function fadeFactor(c: Clip, t: number): number {
  let f = 1
  if (c.fadeIn > EPS) f = Math.min(f, (t - c.start) / c.fadeIn)
  if (c.fadeOut > EPS) f = Math.min(f, (clipEnd(c) - t) / c.fadeOut)
  return Math.max(0, Math.min(1, f))
}

export interface Crossfade {
  from: Clip
  to: Clip
  /** Timeline window [start, end) centered on the cut. */
  start: number
  end: number
}

/**
 * Crossfade into `to` from the clip that ends exactly where it starts. The window is centered on
 * the cut and shortened if either clip lacks enough extra source ("handles") beyond the cut.
 */
export function crossfadeInto(p: Project, track: Track, to: Clip): Crossfade | null {
  if (to.crossfadeIn <= EPS) return null
  const from = track.clips.find((c) => Math.abs(clipEnd(c) - to.start) < 1e-3)
  if (!from) return null
  const fromMedia = p.media.find((m) => m.id === from.mediaId)
  if (!fromMedia) return null
  const handleFrom = mediaEnd(fromMedia) - from.out // extra source after `from` ends
  const toMedia = p.media.find((m) => m.id === to.mediaId)
  const handleTo = toMedia && isStill(toMedia) ? Infinity : to.in // before `to` starts
  const half = Math.min(to.crossfadeIn / 2, handleFrom, handleTo, clipLength(from), clipLength(to))
  if (half <= EPS) return null
  return { from, to, start: to.start - half, end: to.start + half }
}

function layer(p: Project, c: Clip, t: number, factor: number): VisualLayer | null {
  const media = p.media.find((m) => m.id === c.mediaId)
  if (!media || media.kind === 'audio') return null
  const sourceTime = c.in + (t - c.start)
  const animated = transformAt(c, sourceTime)
  const zoom = c.zooms?.length ? zoomAt(c.zooms, sourceTime) : null
  const transform = zoom ? { ...animated, crop: zoomCrop(animated.crop, zoom) } : animated
  return { key: c.id, clip: c, media, sourceTime, localTime: t - c.start, transform, alpha: transform.opacity * factor }
}

/** Visible layers at time t, bottom to top. */
export function visualLayersAt(p: Project, t: number): VisualLayer[] {
  const out: VisualLayer[] = []
  for (const track of p.tracks) {
    if (track.kind !== 'video' || track.hidden) continue

    // Inside a crossfade window: previous clip underneath, next clip fading in on top.
    const xf = track.clips
      .map((c) => crossfadeInto(p, track, c))
      .find((x): x is Crossfade => !!x && t >= x.start - EPS && t < x.end)
    if (xf) {
      const progress = (t - xf.start) / (xf.end - xf.start)
      const a = layer(p, xf.from, t, t < clipEnd(xf.from) ? fadeFactor(xf.from, t) : 1)
      const b = layer(p, xf.to, t, progress * (t >= xf.to.start ? fadeFactor(xf.to, t) : 1))
      if (a) out.push(a)
      if (b) out.push(b)
      continue
    }

    const c = track.clips.find((x) => t >= x.start - EPS && t < clipEnd(x) - EPS)
    if (!c) continue
    const l = layer(p, c, t, fadeFactor(c, t))
    if (l && l.alpha > 0) out.push(l)
  }
  return out
}

/** A piece of audio to play: `duration` seconds of `media` from `in`, placed at `start`. */
export interface AudioSegment {
  key: string
  media: MediaItem
  start: number
  in: number
  duration: number
  /** Gain envelope as (timeline time, gain) points, linear in between; constant outside. */
  envelope: [number, number][]
  /** Play this project-relative file instead of the media's own sound (e.g. cleaned-up voice). */
  audioPath?: string
}

/** Volume automation gain at source time `t` (linear between points, flat beyond the ends). */
export function keyGainAt(keys: VolumeKey[], t: number): number {
  if (!keys.length) return 1
  if (t <= keys[0].t) return keys[0].v
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1]
      const b = keys[i]
      return b.t - a.t < EPS ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }
  }
  return keys[keys.length - 1].v
}

/** All audio of the timeline: audio clips plus the sound of video clips, with fades/crossfades. */
export function audioSegments(p: Project): AudioSegment[] {
  const out: AudioSegment[] = []
  for (const track of p.tracks) {
    if (track.muted) continue
    for (const c of track.clips) {
      const media = p.media.find((m) => m.id === c.mediaId)
      if (!media || isStill(media) || !media.hasAudio || c.muted) continue
      let start = c.start
      let end = clipEnd(c)
      const v = c.volume
      const env: [number, number][] = []

      // Crossfade with the previous clip: this one starts early (ramping up)…
      const xin = crossfadeInto(p, track, c)
      if (xin) {
        start = xin.start
        env.push([xin.start, 0], [xin.end, v])
      } else if (c.fadeIn > EPS) env.push([c.start, 0], [c.start + c.fadeIn, v])
      else env.push([c.start, v])

      // …and the previous clip runs late (ramping down) when the next one crossfades in.
      const next = track.clips.find((n) => Math.abs(n.start - end) < 1e-3)
      const xout = next ? crossfadeInto(p, track, next) : null
      if (xout && xout.from.id === c.id) {
        env.push([xout.start, v], [xout.end, 0])
        end = xout.end
      } else if (c.fadeOut > EPS) env.push([end - c.fadeOut, v], [end, 0])
      else env.push([end, v])

      env.sort((a, b) => a[0] - b[0])
      const segIn = c.in - (c.start - start)
      const seg: AudioSegment = { key: c.id, media, start, in: segIn, duration: end - start, envelope: env }
      if (c.volumeKeys.length) {
        // Multiply in the automation: sample the product at every fade and key point.
        const toTimeline = (srcT: number): number => start + (srcT - segIn)
        const times = new Set(env.map(([t]) => t))
        for (const k of c.volumeKeys) {
          const t = toTimeline(k.t)
          if (t > start && t < end) times.add(t)
        }
        seg.envelope = [...times].sort((a, b) => a - b).map((t) => [t, gainAt({ ...seg, envelope: env }, t) * keyGainAt(c.volumeKeys, segIn + (t - start))])
      }
      if (c.enhance !== 'off') seg.audioPath = enhancedAudioPath(media.id, c.enhance)
      out.push(seg)
    }
  }
  return out
}

/** Gain of a segment at timeline time t. */
export function gainAt(seg: AudioSegment, t: number): number {
  const e = seg.envelope
  if (t <= e[0][0]) return e[0][1]
  for (let i = 1; i < e.length; i++) {
    const [t1, g1] = e[i]
    if (t <= t1) {
      const [t0, g0] = e[i - 1]
      return t1 - t0 < EPS ? g1 : g0 + ((g1 - g0) * (t - t0)) / (t1 - t0)
    }
  }
  return e[e.length - 1][1]
}
