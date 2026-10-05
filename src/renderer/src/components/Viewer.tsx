import { useEffect, useRef, useState } from 'react'
import { MotionThumb } from './CreatePanel'
import { projectDuration } from '@shared/project'
import { useStudio } from '../store'
import { Player } from '../engine/player'
import { FocusBox, FramePicker } from './FramePicker'
import { useFitBox } from './useFitBox'
import { TransformOverlay } from './TransformOverlay'
import { ensureProjectFonts } from '../fonts'

/** Timecode with frames: 1:02:03:15 / 2:03:15. */
export function timecode(t: number, fps: number): string {
  const frames = Math.round(t * fps)
  const f = frames % Math.round(fps)
  const s = Math.floor(frames / Math.round(fps))
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:${pad(m)}` : m}:${pad(s % 60)}:${pad(f)}`
}

export function Viewer() {
  const mode = useStudio((s) => s.viewerMode)
  return mode === 'source' ? <SourceViewer /> : <ProgramViewer />
}

/** Plays the edited timeline. */
function ProgramViewer() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const playhead = useStudio((s) => s.playhead)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<Player | null>(null)
  const [playing, setPlaying] = useState(false)
  const [picking, setPicking] = useState(false)
  const focus = useStudio((s) => s.focus)
  const { width: W, height: H, fps } = project.settings
  const fit = useFitBox<HTMLDivElement>(W, H)

  useEffect(() => {
    const player = new Player(canvasRef.current!, useStudio.getState().project!, projectPath)
    player.time = useStudio.getState().playhead
    player.onTime = (t) => useStudio.getState().setPlayhead(t)
    player.onPlayingChange = setPlaying
    playerRef.current = player
    player.seek(player.time)
    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [projectPath])

  useEffect(() => {
    playerRef.current?.setProject(project)
    // Google fonts download on first use; redraw once they're in.
    void ensureProjectFonts(project).then((added) => {
      const p = playerRef.current
      if (added && p) p.seek(p.time)
    })
  }, [project])

  // Playhead moved from outside (timeline click, shortcuts): seek. Our own updates match player.time.
  useEffect(() => {
    const p = playerRef.current
    if (p && Math.abs(p.time - playhead) > 1e-3) p.seek(playhead)
  }, [playhead])

  const step = (frames: number): void => {
    playerRef.current?.pause()
    useStudio.getState().setPlayhead(Math.max(0, Math.round((playhead + frames / fps) * fps) / fps))
  }
  const duration = projectDuration(project)

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg">
      <div ref={fit.ref} className="flex min-h-0 flex-1 items-center justify-center p-3">
        <div className="relative shrink-0 shadow-lg" style={{ width: fit.width, height: fit.height }}>
          <canvas ref={canvasRef} className="h-full w-full bg-black" onClick={() => playerRef.current?.toggle()} />
          {/* Paused: click things on screen to select them, drag to move, corners to resize. */}
          {!playing && !picking && <TransformOverlay width={fit.width} height={fit.height} onTogglePlay={() => playerRef.current?.toggle()} />}
          {focus?.box && Math.abs(focus.time - playhead) < 0.05 && !picking && <FocusBox box={focus.box} />}
          {picking && (
            <FramePicker
              onCancel={() => setPicking(false)}
              onPick={(box) => {
                setPicking(false)
                const s = useStudio.getState()
                s.setFocus({ time: s.playhead, box, image: playerRef.current?.snapshot(1024, box) })
                s.setRightTab('ai')
              }}
            />
          )}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-t border-line text-muted">
        <TBtn title="Go to start (Home)" onClick={() => useStudio.getState().setPlayhead(0)}>⏮</TBtn>
        <TBtn title="Previous frame (←)" onClick={() => step(-1)}>◀|</TBtn>
        <button
          className="mx-1 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white"
          title="Play / pause (Space)"
          onClick={() => playerRef.current?.toggle()}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <TBtn title="Next frame (→)" onClick={() => step(1)}>|▶</TBtn>
        <TBtn title="Go to end (End)" onClick={() => useStudio.getState().setPlayhead(duration)}>⏭</TBtn>
        <span className="ml-3 font-mono text-text">{timecode(playhead, fps)}</span>
        <span className="font-mono">/ {timecode(duration, fps)}</span>
        <button
          className="ml-4 rounded bg-panel-2 px-2 py-1 text-xs text-text hover:bg-line"
          title="Point at this frame (and an area of it) and ask the AI to add or change something right here"
          onClick={() => (playerRef.current?.pause(), setPicking(true))}
        >
          ✨ Ask about this frame
        </button>
      </div>
    </section>
  )
}

function TBtn(props: { title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button title={props.title} onClick={props.onClick} className="rounded px-2 py-1 text-xs hover:bg-panel-2 hover:text-text">
      {props.children}
    </button>
  )
}

/** Previews a media item from the bin as-is. */
function SourceViewer() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const selectedMediaId = useStudio((s) => s.selectedMediaId)
  const setViewerMode = useStudio((s) => s.setViewerMode)
  const media = project.media.find((m) => m.id === selectedMediaId)
  const src = media && window.studio.media.url(projectPath, media.path)

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {!media && <span className="text-muted">Select a media item to preview it</span>}
        {media?.kind === 'image' && <img key={src} src={src} className="max-h-full max-w-full object-contain" />}
        {media?.kind === 'color' && <div className="aspect-video h-full max-h-full max-w-full" style={{ background: media.color }} />}
        {media?.kind === 'motion' && (
          <div className="aspect-video h-full max-h-full max-w-full bg-[repeating-conic-gradient(#333_0_25%,#222_0_50%)] bg-[length:16px_16px]">
            <MotionThumb media={media} animate />
          </div>
        )}
        {media && media.kind !== 'image' && media.kind !== 'color' && media.kind !== 'motion' && <video key={src} src={src} controls className="max-h-full max-w-full bg-black" />}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-3 border-t border-line px-3 text-xs text-muted">
        <span className="truncate">
          Source: {media?.name}
          {media?.width ? ` · ${media.width}×${media.height}` : ''}
          {media?.fps ? ` · ${media.fps.toFixed(2)} fps` : ''}
        </span>
        <button className="ml-auto rounded bg-panel-2 px-3 py-1 text-text hover:bg-line" onClick={() => setViewerMode('program')}>
          Back to timeline
        </button>
      </div>
    </section>
  )
}
