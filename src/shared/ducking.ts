import { clipEnd, type Clip, type Project, type VolumeKey } from './project'
import { audioSegments } from './render-plan'

export interface DuckOptions {
  /** Gain while someone is speaking (0.25 ≈ -12 dB). */
  level: number
  /** Seconds to fade down before speech starts. */
  attack: number
  /** Seconds to fade back up after speech ends. */
  release: number
}

export const DEFAULT_DUCK: DuckOptions = { level: 0.25, attack: 0.3, release: 0.8 }

type Interval = [number, number]

/** Sorts and merges intervals closer than `gap`. */
export function mergeIntervals(intervals: Interval[], gap: number): Interval[] {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Interval[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/**
 * Volume keys (source time) that lower `clip` while speech (timeline intervals) is playing.
 * Pauses shorter than attack + release don't bring the music back up, so it doesn't "pump".
 */
export function duckKeys(clip: Clip, speech: Interval[], opts: DuckOptions = DEFAULT_DUCK): VolumeKey[] {
  const start = clip.start
  const end = clipEnd(clip)
  const toSrc = (t: number): number => clip.in + (t - start)
  const keys: VolumeKey[] = []
  for (const [a, b] of mergeIntervals(speech, opts.attack + opts.release)) {
    if (b <= start || a >= end) continue
    const downStart = Math.max(start, a - opts.attack)
    const upEnd = Math.min(end, b + opts.release)
    if (downStart > start) keys.push({ t: toSrc(downStart), v: 1 })
    keys.push({ t: toSrc(Math.max(start, a)), v: opts.level })
    keys.push({ t: toSrc(Math.min(end, b)), v: opts.level })
    if (upEnd < end) keys.push({ t: toSrc(upEnd), v: 1 })
  }
  return keys
}

/**
 * Speech on the timeline from every other sound source, given each media item's speech
 * intervals in its own (source) time.
 */
export function timelineSpeech(p: Project, excludeClipId: string, speechByMedia: Map<string, Interval[]>): Interval[] {
  const out: Interval[] = []
  for (const seg of audioSegments(p)) {
    if (seg.key === excludeClipId) continue
    const speech = speechByMedia.get(seg.media.id)
    if (!speech) continue
    const segEnd = seg.start + seg.duration
    for (const [a, b] of speech) {
      const ta = seg.start + (a - seg.in)
      const tb = seg.start + (b - seg.in)
      if (tb <= seg.start || ta >= segEnd) continue
      out.push([Math.max(seg.start, ta), Math.min(segEnd, tb)])
    }
  }
  return mergeIntervals(out, 0)
}
