import { animateKeys, cornerTransform, transformAt, type Corner } from '@shared/animation'
import { clipEnd, type Clip, type MediaItem } from '@shared/project'
import { useStudio } from '../store'
import { formatTime } from '../time'

const CORNERS: [Corner, string][] = [
  ['top-left', '↖'],
  ['top-right', '↗'],
  ['bottom-left', '↙'],
  ['bottom-right', '↘'],
  ['full', '⛶']
]

/** Keyframe animation of a clip: one-click moves at the playhead, plus the list of keys. */
export function AnimationEditor({ clip, media }: { clip: Clip; media: MediaItem | undefined }) {
  const playhead = useStudio((s) => s.playhead)
  const { width: W, height: H } = useStudio.getState().project!.settings
  const inside = playhead >= clip.start && playhead < clipEnd(clip)
  const mw = media?.kind === 'graphic' || !media?.width ? W : media.width
  const mh = media?.kind === 'graphic' || !media?.height ? H : media.height

  const animate = (to: Parameters<typeof animateKeys>[3]): void => {
    useStudio.getState().dispatch({ op: 'setTransformKeys', clipId: clip.id, keys: animateKeys(clip, playhead, 0.6, to) })
  }
  const now = transformAt(clip, clip.in + (playhead - clip.start))

  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Animation</h3>
      {!inside && <p className="text-xs text-muted">Move the playhead over this clip to animate from that moment.</p>}
      <div className="flex items-center gap-1">
        <span className="w-20 shrink-0 text-xs text-muted">Move to</span>
        {CORNERS.map(([c, icon]) => (
          <button
            key={c}
            disabled={!inside}
            title={c === 'full' ? 'Back to full screen' : `Shrink into the ${c} corner`}
            className="h-7 w-7 rounded bg-panel-2 hover:bg-line disabled:opacity-30"
            onClick={() => animate(cornerTransform(c, mw, mh, W, H))}
          >
            {icon}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20 shrink-0 text-xs text-muted">Fade</span>
        <button disabled={!inside} className="rounded bg-panel-2 px-2 py-1 text-xs hover:bg-line disabled:opacity-30" onClick={() => animate({ opacity: 0 })}>Out here</button>
        <button disabled={!inside} className="rounded bg-panel-2 px-2 py-1 text-xs hover:bg-line disabled:opacity-30" onClick={() => animate({ opacity: 1 })}>In here</button>
      </div>
      <p className="text-[11px] text-muted">Each move takes 0.6 s from the playhead. Now: x {now.x.toFixed(2)}, y {now.y.toFixed(2)}, size {Math.round(now.scale * 100)}%</p>
      {clip.keys.length > 0 && (
        <div className="space-y-0.5">
          {clip.keys.map((k, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <button className="font-mono text-accent hover:underline" onClick={() => useStudio.getState().setPlayhead(clip.start + (k.t - clip.in))}>
                {formatTime(clip.start + (k.t - clip.in), true)}
              </button>
              <span className="truncate text-muted">
                {(['x', 'y', 'scale', 'opacity'] as const).filter((p) => k[p] !== undefined).map((p) => `${p} ${k[p]!.toFixed(2)}`).join(' · ')}
              </span>
              <button className="ml-auto text-muted hover:text-danger" onClick={() => useStudio.getState().dispatch({ op: 'setTransformKeys', clipId: clip.id, keys: clip.keys.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <button className="text-xs text-accent hover:underline" onClick={() => useStudio.getState().dispatch({ op: 'setTransformKeys', clipId: clip.id, keys: [] })}>
            Clear animation
          </button>
        </div>
      )}
    </section>
  )
}
