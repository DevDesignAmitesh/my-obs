import { useState } from 'react'
import { clipEnd, clipLength, type EnhanceLevel, type Transform } from '@shared/project'
import { dbToGain, ENHANCE_SPEED, gainToDb } from '@shared/audio'
import { DEFAULT_DUCK, duckKeys, timelineSpeech } from '@shared/ducking'
import { audioSegments } from '@shared/render-plan'
import { crossfadeInto } from '@shared/render-plan'
import { findClip, type EditOp } from '@shared/ops'
import { useStudio } from '../store'
import { formatTime } from '../time'
import { GraphicEditor } from './GraphicEditor'
import { CreditNote, MotionEditor } from './MotionEditor'
import { AnimationEditor } from './AnimationEditor'
import { ModePanel } from './ThemePanel'
import { RenameField } from './RenameField'
import { ZoomEditor } from './ZoomEditor'

type ClipPatch = Omit<Extract<EditOp, { op: 'updateClip' }>, 'op' | 'clipId'>

/** Properties of the selected clip. Slider drags merge into a single undo step. */
export function Inspector() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const selected = useStudio((s) => s.selectedClipIds)
  const [busy, setBusy] = useState<string | null>(null)
  const [duckDb, setDuckDb] = useState(-12)

  let found: ReturnType<typeof findClip> | null = null
  if (selected.length === 1) {
    try {
      found = findClip(project, selected[0])
    } catch {
      found = null
    }
  }

  if (!found) {
    return (
      <div className="space-y-4 p-3">
        {selected.length > 1 && <p className="text-muted">{selected.length} clips selected</p>}
        <ModePanel />
      </div>
    )
  }

  const { track, clip } = found
  const media = project.media.find((m) => m.id === clip.mediaId)
  const visual = media?.kind !== 'audio'
  const audible = media?.kind === 'audio' || !!media?.hasAudio
  const t = clip.transform
  const hasPrevious = track.clips.some((c) => Math.abs(clipEnd(c) - clip.start) < 1e-3)
  const xf = crossfadeInto(project, track, clip)

  const update = (patch: ClipPatch, key: string): void => {
    useStudio.getState().dispatch({ op: 'updateClip', clipId: clip.id, ...patch }, { coalesce: `${clip.id}:${key}` })
  }
  const setEnhance = async (level: EnhanceLevel): Promise<void> => {
    if (!media || level === clip.enhance) return
    if (level !== 'off') {
      const est = Math.max(1, Math.round(media.duration * ENHANCE_SPEED))
      setBusy(`Cleaning up the voice… (about ${est < 60 ? `${est} s` : `${Math.round(est / 60)} min`})`)
      try {
        await window.studio.audio.enhance(projectPath, media, level)
      } catch (e) {
        useStudio.getState().showToast(`Enhance voice failed: ${(e as Error).message}`)
        return setBusy(null)
      }
      setBusy(null)
    }
    useStudio.getState().dispatch({ op: 'updateClip', clipId: clip.id, enhance: level })
  }

  const autoDuck = async (): Promise<void> => {
    setBusy('Listening for speech on the other tracks…')
    try {
      const others = audioSegments(project).filter((s) => s.key !== clip.id)
      const speechByMedia = new Map<string, [number, number][]>()
      for (const s of others) {
        if (!speechByMedia.has(s.media.id)) speechByMedia.set(s.media.id, await window.studio.audio.speech(projectPath, s.media))
      }
      const speech = timelineSpeech(project, clip.id, speechByMedia)
      const keys = duckKeys(clip, speech, { ...DEFAULT_DUCK, level: dbToGain(duckDb) })
      if (!keys.length) useStudio.getState().showToast('No speech found under this clip.')
      else {
        useStudio.getState().dispatch({ op: 'setVolumeKeys', clipId: clip.id, keys })
        useStudio.getState().showToast(`Lowered the music under ${speech.filter(([a, b]) => b > clip.start && a < clipEnd(clip)).length} stretches of speech.`)
      }
    } catch (e) {
      useStudio.getState().showToast(`Auto-duck failed: ${(e as Error).message}`)
    }
    setBusy(null)
  }

  const setT = (k: keyof Transform, v: number): void => update({ transform: { [k]: v } }, k)
  const setCrop = (k: keyof Transform['crop'], v: number): void => update({ transform: { crop: { ...t.crop, [k]: v } } }, `crop.${k}`)

  return (
    <div className="space-y-5 p-3">
      <section>
        {media && !media.graphic ? (
          <RenameField mediaId={media.id} name={media.name} className="font-semibold" />
        ) : (
          <div className="truncate font-semibold" title={media?.name}>{media?.name ?? 'Missing media'}</div>
        )}
        <div className="text-xs text-muted">
          {track.name} · {formatTime(clip.start, true)} → {formatTime(clipEnd(clip), true)} · {formatTime(clipLength(clip), true)} long
        </div>
      </section>

      {media?.kind === 'graphic' && media.graphic && <GraphicEditor mediaId={media.id} clipId={clip.id} graphic={media.graphic} />}
      {media?.kind === 'motion' && media.motion && <MotionEditor media={media} clipId={clip.id} />}
      {media?.credit && <CreditNote credit={media.credit} />}

      {visual && (
        <Section title="Transform" onReset={() => update({ transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } } }, 'reset')}>
          <Slider label="Position X" value={t.x} min={-0.5} max={1.5} step={0.001} format={pct} onChange={(v) => setT('x', v)} />
          <Slider label="Position Y" value={t.y} min={-0.5} max={1.5} step={0.001} format={pct} onChange={(v) => setT('y', v)} />
          <Slider label="Scale" value={t.scale} min={0.05} max={4} step={0.01} format={pct} onChange={(v) => setT('scale', v)} />
          <Slider label="Rotation" value={t.rotation} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={(v) => setT('rotation', v)} />
          <Slider label="Opacity" value={t.opacity} min={0} max={1} step={0.01} format={pct} onChange={(v) => setT('opacity', v)} />
          <div className="flex items-center gap-2 pt-1">
            <span className="w-20 shrink-0 text-muted">Shape</span>
            <div className="flex flex-1 rounded border border-line p-0.5">
              {(['none', 'rounded', 'circle'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => update({ transform: { mask: m } }, 'mask')}
                  className={`flex-1 rounded px-1 py-0.5 text-xs capitalize ${t.mask === m ? 'bg-accent text-white' : 'text-muted hover:text-text'}`}
                >
                  {m === 'none' ? 'Square' : m}
                </button>
              ))}
            </div>
          </div>
        </Section>
      )}

      {visual && <AnimationEditor clip={clip} media={media} />}

      {visual && (
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-muted">Flip</span>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={t.flipH} onChange={(e) => update({ transform: { flipH: e.target.checked } }, 'flipH')} /> ↔ Mirror
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={t.flipV} onChange={(e) => update({ transform: { flipV: e.target.checked } }, 'flipV')} /> ↕ Upside down
          </label>
        </div>
      )}

      {media?.kind === 'color' && (
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-muted">Color</span>
          <input
            type="color"
            value={media.color ?? '#000000'}
            onChange={(e) => useStudio.getState().dispatch({ op: 'updateMedia', mediaId: media.id, clipId: clip.id, patch: { color: e.target.value, name: `Color ${e.target.value}` } }, { coalesce: `color:${clip.id}` })}
          />
          <span className="text-xs text-muted">used by every clip of this color layer</span>
        </div>
      )}

      {visual && media?.kind !== 'color' && media?.kind !== 'graphic' && (
        <Section title="Crop">
          <Slider label="Left" value={t.crop.left} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setCrop('left', v)} />
          <Slider label="Right" value={t.crop.right} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setCrop('right', v)} />
          <Slider label="Top" value={t.crop.top} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setCrop('top', v)} />
          <Slider label="Bottom" value={t.crop.bottom} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setCrop('bottom', v)} />
        </Section>
      )}

      {audible && (
        <Section title="Audio">
          <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={db} onChange={(v) => update({ volume: v }, 'volume')} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={clip.muted} onChange={(e) => update({ muted: e.target.checked }, 'muted')} />
            Mute this clip's sound
          </label>
          {track.muted && <p className="text-xs text-yellow-400">This track is muted.</p>}

          <div className="flex items-center gap-2 pt-1">
            <span className="w-20 shrink-0 text-muted" title="Removes background noise (fans, hiss, room hum)">Enhance voice</span>
            <div className="flex flex-1 rounded border border-line p-0.5">
              {(['off', 'light', 'medium', 'strong'] as EnhanceLevel[]).map((lvl) => (
                <button
                  key={lvl}
                  disabled={!!busy}
                  onClick={() => setEnhance(lvl)}
                  className={`flex-1 rounded px-1 py-0.5 text-xs capitalize disabled:opacity-50 ${clip.enhance === lvl ? 'bg-accent text-white' : 'text-muted hover:text-text'}`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={!!busy}
              onClick={autoDuck}
              className="flex-1 rounded bg-panel-2 px-2 py-1 text-left text-xs hover:bg-line disabled:opacity-50"
              title="For music: automatically lowers this clip while someone is talking on other tracks"
            >
              🎵 Lower under speech
            </button>
            <select className="rounded border border-line bg-panel-2 px-1 py-1 text-xs" value={duckDb} onChange={(e) => setDuckDb(Number(e.target.value))}>
              {[-6, -12, -18, -24].map((d) => (
                <option key={d} value={d}>{d} dB</option>
              ))}
            </select>
          </div>
          {clip.volumeKeys.length > 0 && (
            <button className="text-xs text-accent hover:underline" onClick={() => useStudio.getState().dispatch({ op: 'setVolumeKeys', clipId: clip.id, keys: [] })}>
              Clear {clip.volumeKeys.length} volume points
            </button>
          )}
          {track.kind === 'video' && media?.kind === 'video' && !clip.muted && (
            <button
              className="block text-xs text-accent hover:underline"
              title="Puts the sound on an audio track so you can trim it separately (J/L cuts)"
              onClick={() => useStudio.getState().dispatch({ op: 'detachAudio', clipId: clip.id })}
            >
              Detach audio to its own track
            </button>
          )}
          {busy && <p className="text-xs text-yellow-400">{busy}</p>}
          <p className="text-[11px] text-muted">Tip: Alt+click the yellow volume line on the timeline to add a point; drag points; double-click to remove.</p>
        </Section>
      )}

      {track.kind === 'video' && (media?.kind === 'video' || clip.zooms.length > 0) && (
        <Section title="Zoom">
          <ZoomEditor clip={clip} />
        </Section>
      )}

      <Section title="Transitions">
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={Math.min(5, clipLength(clip))} step={0.05} format={secs} onChange={(v) => update({ fadeIn: v }, 'fadeIn')} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={Math.min(5, clipLength(clip))} step={0.05} format={secs} onChange={(v) => update({ fadeOut: v }, 'fadeOut')} />
        {hasPrevious ? (
          <>
            <Slider label="Crossfade" value={clip.crossfadeIn} min={0} max={4} step={0.05} format={secs} onChange={(v) => update({ crossfadeIn: v }, 'crossfadeIn')} />
            {clip.crossfadeIn > 0 && xf && xf.end - xf.start < clip.crossfadeIn - 0.01 && (
              <p className="text-xs text-yellow-400">
                Shortened to {secs(xf.end - xf.start)}: there isn't enough extra footage beyond the cut.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">Crossfade: place this clip right after another one on the same track.</p>
        )}
      </Section>
    </div>
  )
}

const pct = (v: number): string => `${Math.round(v * 100)}%`
const db = (v: number): string => (v <= 0.001 ? '-∞ dB' : `${gainToDb(v) >= 0 ? '+' : ''}${gainToDb(v).toFixed(1)} dB`)
const secs = (v: number): string => `${v.toFixed(2)} s`

function Section(props: { title: string; onReset?: () => void; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{props.title}</h3>
        {props.onReset && (
          <button className="ml-auto text-xs text-accent hover:underline" onClick={props.onReset}>
            Reset
          </button>
        )}
      </div>
      {props.children}
    </section>
  )
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; format(v: number): string; onChange(v: number): void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-muted">{props.label}</span>
      <input
        type="range"
        className="min-w-0 flex-1 accent-[#6d8cff]"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => props.onChange(props.label === 'Scale' || props.label === 'Opacity' || props.label === 'Volume' ? 1 : props.label.startsWith('Position') ? 0.5 : 0)}
      />
      <span className="w-14 text-right font-mono text-xs">{props.format(props.value)}</span>
    </label>
  )
}

