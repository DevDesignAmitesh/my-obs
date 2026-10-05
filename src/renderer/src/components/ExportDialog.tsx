import { useRef, useState } from 'react'
import { projectDuration } from '@shared/project'
import { LOUDNESS_TARGETS, type LoudnessTarget } from '@shared/audio'
import { exportProject, type ExportProgress } from '../engine/exporter'
import { cuesFor } from '../engine/captions-draw'
import { toSrt } from '@shared/captions'
import { useStudio } from '../store'
import { formatTime } from '../time'

type Quality = 'high' | 'medium' | 'small'
const QUALITY_FACTOR: Record<Quality, number> = { high: 1, medium: 0.6, small: 0.35 }

/** ~12 Mbps at 1080p30 for "High", scaled by pixel count and frame rate. */
function bitrateFor(w: number, h: number, fps: number, q: Quality): number {
  return Math.round(12_000_000 * ((w * h) / (1920 * 1080)) * Math.max(1, fps / 30) ** 0.5 * QUALITY_FACTOR[q])
}

/** Resolutions with the project's aspect ratio (shorter side 720 / 1080 / 2160), even-sized for H.264. */
function sizeOptions(W: number, H: number): { label: string; w: number; h: number }[] {
  const even = (n: number): number => Math.round(n / 2) * 2
  return [720, 1080, 2160].map((short) => {
    const s = short / Math.min(W, H)
    return { label: `${short === 2160 ? '4K' : `${short}p`}`, w: even(W * s), h: even(H * s) }
  })
}

export function ExportDialog({ onClose }: { onClose(): void }) {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const { width: W, height: H, fps } = project.settings
  const sizes = sizeOptions(W, H)
  const [name, setName] = useState(project.name)
  const [size, setSize] = useState(sizes.find((s) => s.w === W && s.h === H)?.label ?? '1080p')
  const [quality, setQuality] = useState<Quality>('high')
  const [loudness, setLoudness] = useState<LoudnessTarget | 'off'>('youtube')
  const [phase, setPhase] = useState('')
  const hasTranscript = Object.keys(project.transcripts).length > 0
  const [srt, setSrt] = useState(hasTranscript)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [state, setState] = useState<'setup' | 'running' | 'done' | 'error'>('setup')
  const [message, setMessage] = useState('')
  const [output, setOutput] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const duration = projectDuration(project)
  const chosen = sizes.find((s) => s.label === size)!
  const bitrate = bitrateFor(chosen.w, chosen.h, fps, quality)
  const estimatedMB = Math.round(((bitrate + 192_000) * duration) / 8 / 1e6)

  const start = async (): Promise<void> => {
    const path = await window.studio.files.exportPath(projectPath, name.trim() || project.name)
    setOutput(path)
    setState('running')
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      // Cleaned-up voice files are cached; recreate any that were deleted.
      setPhase('Preparing audio…')
      for (const track of project.tracks) {
        for (const c of track.clips) {
          const media = project.media.find((m) => m.id === c.mediaId)
          if (media && c.enhance !== 'off') await window.studio.audio.enhance(projectPath, media, c.enhance)
        }
      }
      setPhase('')
      await exportProject(project, projectPath, { path, width: chosen.w, height: chosen.h, fps, videoBitrate: bitrate }, setProgress, ctl.signal)
      if (loudness !== 'off') {
        setPhase(`Balancing loudness to ${LOUDNESS_TARGETS[loudness]} LUFS…`)
        const r = await window.studio.audio.normalize(path, LOUDNESS_TARGETS[loudness])
        setMessage(r.before === null ? '' : `Loudness: ${r.before.toFixed(1)} → ${r.after} LUFS`)
      }
      if (srt && hasTranscript) {
        await window.studio.files.saveText(projectPath, `${name.trim() || project.name}.srt`, toSrt(cuesFor(project)))
      }
      setState('done')
    } catch (e) {
      const err = e as Error
      setMessage(err.name === 'AbortError' ? 'Export cancelled.' : err.message)
      setState('error')
    }
  }

  const pctDone = progress ? progress.done / progress.total : 0
  const eta = progress && progress.speed > 0 ? (progress.total - progress.done) / progress.speed : 0

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div className="w-[460px] space-y-4 rounded-lg border border-line bg-panel p-5">
        <h2 className="text-lg font-semibold">Export video</h2>

        {state === 'setup' && (
          <>
            <label className="block space-y-1">
              <span className="text-muted">File name</span>
              <input className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 outline-none focus:border-accent" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <Choice label="Resolution" value={size} options={sizes.map((s) => [s.label, `${s.label} (${s.w}×${s.h})`])} onChange={setSize} />
            <Choice label="Quality" value={quality} options={[['high', 'High'], ['medium', 'Medium'], ['small', 'Small file']]} onChange={(v) => setQuality(v as Quality)} />
            <Choice
              label="Loudness"
              value={loudness}
              options={[['youtube', 'YouTube / social (−14 LUFS)'], ['podcast', 'Podcast (−16 LUFS)'], ['off', 'Leave as is']]}
              onChange={(v) => setLoudness(v as LoudnessTarget | 'off')}
            />
            {hasTranscript && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={srt} onChange={(e) => setSrt(e.target.checked)} />
                Also save subtitles (.srt) {project.captionStyle.enabled ? '· captions are burned into the video' : ''}
              </label>
            )}
            <p className="text-xs text-muted">
              {formatTime(duration)} · {fps} fps · MP4 (H.264 + AAC) · about {estimatedMB} MB · saved to the project's exports folder
            </p>
            {duration <= 0 && <p className="text-xs text-danger">The timeline is empty.</p>}
            <div className="flex justify-end gap-2">
              <button className="rounded px-4 py-1.5 text-muted hover:text-text" onClick={onClose}>Cancel</button>
              <button className="rounded bg-accent px-4 py-1.5 font-medium text-white disabled:opacity-40" disabled={duration <= 0} onClick={start}>
                Export
              </button>
            </div>
          </>
        )}

        {state === 'running' && (
          <>
            <div className="h-2 overflow-hidden rounded bg-panel-2">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pctDone * 100}%` }} />
            </div>
            <p className="text-xs text-muted">
              {phase || `${Math.round(pctDone * 100)}% · ${progress ? `${progress.speed.toFixed(0)} frames/s · about ${formatTime(eta)} left` : 'Starting…'}`}
            </p>
            <div className="flex justify-end">
              <button className="rounded px-4 py-1.5 text-muted hover:text-danger" onClick={() => abortRef.current?.abort()}>Cancel export</button>
            </div>
          </>
        )}

        {state === 'done' && (
          <>
            <p>Done! Saved as <span className="font-mono text-xs break-all">{output}</span></p>
            {message && <p className="text-xs text-muted">{message}</p>}
            <div className="flex justify-end gap-2">
              <button className="rounded bg-panel-2 px-4 py-1.5 hover:bg-line" onClick={() => window.studio.files.showInFolder(output)}>Show in folder</button>
              <button className="rounded bg-accent px-4 py-1.5 text-white" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {state === 'error' && (
          <>
            <p className="text-danger">{message}</p>
            <div className="flex justify-end">
              <button className="rounded bg-panel-2 px-4 py-1.5 hover:bg-line" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Choice(props: { label: string; value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <div className="space-y-1">
      <span className="text-muted">{props.label}</span>
      <div className="flex rounded border border-line p-0.5">
        {props.options.map(([v, label]) => (
          <button
            key={v}
            onClick={() => props.onChange(v)}
            className={`flex-1 rounded px-2 py-1 text-xs ${props.value === v ? 'bg-accent text-white' : 'text-muted hover:text-text'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
