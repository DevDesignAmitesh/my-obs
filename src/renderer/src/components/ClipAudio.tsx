import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Clip, MediaItem, VolumeKey } from '@shared/project'
import { keyGainAt } from '@shared/render-plan'
import { gainToDb } from '@shared/audio'

const PEAKS_PER_SECOND = 100
/** Max gain shown on the volume line (top edge = 200%). */
const MAX_GAIN = 2

const cache = new Map<string, Promise<Uint8Array>>()

function useWaveform(projectPath: string, media: MediaItem | undefined): Uint8Array | null {
  const [data, setData] = useState<Uint8Array | null>(null)
  useEffect(() => {
    if (!media || media.kind === 'image' || !media.hasAudio) return
    const key = `${projectPath}|${media.id}`
    let p = cache.get(key)
    if (!p) {
      p = window.studio.audio.waveform(projectPath, media)
      cache.set(key, p)
      p.catch(() => cache.delete(key))
    }
    let alive = true
    p.then((d) => alive && setData(d), () => undefined)
    return () => {
      alive = false
    }
  }, [projectPath, media?.id])
  return data
}

interface Props {
  clip: Clip
  media: MediaItem | undefined
  projectPath: string
  pxPerSec: number
  /** Clip position/size in timeline pixels (including in-progress drags). */
  left: number
  width: number
  height: number
  /** Visible part of the timeline, in timeline pixels. */
  viewLeft: number
  viewWidth: number
  showVolumeLine: boolean
  onKeysChange(keys: VolumeKey[]): void
}

/** Waveform (only the on-screen part is drawn) and the editable volume line of a clip. */
export function ClipAudio(props: Props) {
  const { clip, media, pxPerSec, left, width, height } = props
  const peaks = useWaveform(props.projectPath, media)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const visFrom = Math.max(0, props.viewLeft - left)
  const visTo = Math.min(width, props.viewLeft + props.viewWidth - left)
  const visW = Math.max(0, Math.min(4000, Math.ceil(visTo - visFrom)))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || !visW) return
    canvas.width = visW
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, visW, height)
    // Scale to this media's loudest peak so quiet recordings are still readable.
    let loudest = 1
    for (const v of peaks) if (v > loudest) loudest = v
    const perPx = PEAKS_PER_SECOND / pxPerSec
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    const mid = height / 2
    for (let x = 0; x < visW; x++) {
      const src = clip.in + (visFrom + x) / pxPerSec
      const i0 = Math.floor(src * PEAKS_PER_SECOND)
      const i1 = Math.max(i0 + 1, Math.floor(i0 + perPx))
      let m = 0
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i]
      const h = (m / loudest) * (height / 2 - 2)
      ctx.fillRect(x, mid - h, 1, h * 2)
    }
  }, [peaks, visFrom, visW, height, pxPerSec, clip.in])

  // ---- volume line ------------------------------------------------------------------------
  const keys = clip.volumeKeys
  const xOf = (srcT: number): number => (srcT - clip.in) * pxPerSec
  const yOf = (gain: number): number => height * (1 - Math.min(gain, MAX_GAIN) / MAX_GAIN)
  const len = clip.out - clip.in
  const pts: [number, number][] = keys.length
    ? [[0, keyGainAt(keys, clip.in)], ...keys.filter((k) => k.t > clip.in && k.t < clip.out).map((k) => [xOf(k.t), k.v] as [number, number]), [len * pxPerSec, keyGainAt(keys, clip.out)]]
    : [[0, 1], [len * pxPerSec, 1]]
  const path = pts.map(([x, g], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yOf(g * clip.volume).toFixed(1)}`).join(' ')

  const dragKey = (e: ReactPointerEvent, index: number): void => {
    e.stopPropagation()
    e.preventDefault()
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      const x = ev.clientX - svg.left
      const y = Math.max(0, Math.min(height, ev.clientY - svg.top))
      const next = keys.map((k) => ({ ...k }))
      const lo = index > 0 ? next[index - 1].t + 0.01 : clip.in
      const hi = index < next.length - 1 ? next[index + 1].t - 0.01 : clip.out
      next[index] = {
        t: Math.max(lo, Math.min(hi, clip.in + x / pxPerSec)),
        v: Math.max(0, ((1 - y / height) * MAX_GAIN) / (clip.volume || 1))
      }
      props.onKeysChange(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      {peaks && visW > 0 && (
        <canvas ref={canvasRef} className="pointer-events-none absolute top-0" style={{ left: visFrom, width: visW, height }} />
      )}
      {props.showVolumeLine && (
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={width} height={height}>
          <path d={path} fill="none" stroke="#f5c542" strokeWidth={1.5} />
          {keys.map((k, i) =>
            k.t >= clip.in && k.t <= clip.out ? (
              <circle
                key={i}
                cx={xOf(k.t)}
                cy={yOf(k.v * clip.volume)}
                r={4}
                className="pointer-events-auto cursor-move"
                fill="#f5c542"
                stroke="#000"
                onPointerDown={(e) => dragKey(e, i)}
                onDoubleClick={(e) => (e.stopPropagation(), props.onKeysChange(keys.filter((_, j) => j !== i)))}
              >
                <title>{`${gainToDb(k.v * clip.volume).toFixed(1)} dB · double-click to remove`}</title>
              </circle>
            ) : null
          )}
        </svg>
      )}
    </>
  )
}
