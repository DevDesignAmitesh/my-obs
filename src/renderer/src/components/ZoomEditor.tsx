import { clipEnd, type Clip } from '@shared/project'
import { DEFAULT_ZOOM_SCALE, type Zoom } from '@shared/zoom'
import { useStudio } from '../store'
import { formatTime } from '../time'

const STRENGTHS: [number, string][] = [
  [1.25, 'Subtle'],
  [1.5, 'Light'],
  [1.8, 'Medium'],
  [2.2, 'Strong'],
  [3, 'Very close']
]

/** A clip's auto zooms (from clicks/typing while recording): jump to, remove, change strength, add. */
export function ZoomEditor({ clip }: { clip: Clip }) {
  const playhead = useStudio((s) => s.playhead)
  const { dispatch, setPlayhead } = useStudio.getState()
  const set = (zooms: Zoom[]): void => void dispatch({ op: 'setZooms', clipId: clip.id, zooms })
  // Zooms are in source time; show the ones inside this clip, at their timeline time.
  const toTimeline = (t: number): number => clip.start + (t - clip.in)
  const visible = clip.zooms.map((z, i) => ({ z, i })).filter(({ z }) => z.end > clip.in && z.start < clip.out)
  const strength = clip.zooms[0]?.scale ?? DEFAULT_ZOOM_SCALE
  const src = clip.in + (playhead - clip.start)
  const canAdd = playhead >= clip.start && playhead < clipEnd(clip) && !clip.zooms.some((z) => src >= z.start && src <= z.end)

  const add = (): void => {
    const start = Math.max(clip.in, src - 0.3)
    const zoom: Zoom = { start, end: Math.min(clip.out, start + 2.5), scale: strength, points: [{ t: src, x: 0.5, y: 0.5 }] }
    set([...clip.zooms, zoom])
  }

  return (
    <div className="space-y-2">
      {visible.length ? (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Strength</span>
            <select
              className="ml-auto rounded border border-line bg-panel-2 px-1 py-0.5"
              value={STRENGTHS.reduce((best, s) => (Math.abs(s[0] - strength) < Math.abs(best[0] - strength) ? s : best))[0]}
              onChange={(e) => set(clip.zooms.map((z) => ({ ...z, scale: Number(e.target.value) })))}
            >
              {STRENGTHS.map(([v, label]) => (
                <option key={v} value={v}>{label} ({v}×)</option>
              ))}
            </select>
          </div>
          <ul className="max-h-40 space-y-0.5 overflow-auto text-xs">
            {visible.map(({ z, i }) => (
              <li key={i} className="group flex items-center gap-2 rounded px-1 hover:bg-panel-2">
                <button className="flex-1 text-left" title="Go to this zoom" onClick={() => setPlayhead(toTimeline(z.start))}>
                  🔍 {formatTime(toTimeline(z.start), true)} – {formatTime(toTimeline(z.end), true)}
                  {z.points.length > 1 && <span className="text-muted"> · follows {z.points.length} clicks</span>}
                </button>
                <button className="text-muted opacity-0 group-hover:opacity-100 hover:text-danger" title="Remove this zoom" onClick={() => set(clip.zooms.filter((_, k) => k !== i))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-[11px] text-muted">No zooms. Screen recordings zoom in automatically where you click or type (Recorder → Zoom).</p>
      )}
      <div className="flex gap-3">
        <button className="text-xs text-accent hover:underline disabled:text-muted disabled:no-underline" disabled={!canAdd} onClick={add} title="Zoom into the middle of the picture at the playhead">
          + Zoom at playhead
        </button>
        {clip.zooms.length > 0 && (
          <button className="text-xs text-accent hover:underline" onClick={() => set([])}>
            Remove all
          </button>
        )}
      </div>
    </div>
  )
}
