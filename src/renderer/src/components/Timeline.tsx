import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { clipEnd, clipLength, isStill, newId, projectDuration, type Clip, type MediaItem, type Project, type Track } from '@shared/project'
import { IMAGE_DEFAULT_SECONDS, withGroupMembers } from '@shared/ops'
import { useStudio } from '../store'
import { formatTime } from '../time'
import { MEDIA_DRAG_TYPE, mediaDrag } from './MediaBin'
import { ClipAudio } from './ClipAudio'
import { graphicLabel } from '@shared/graphics'
import { keyGainAt } from '@shared/render-plan'
import { closeGaps, closeTrackGap, copySelected, cutMarkedRange, emptySpaceAt, hasClipboard, insertSpace, paste, removeSpace, setPasteTrack, markIn, markOut, mergeSelected, selectFrom, splitAtPlayhead, ungroupSelected } from '../editing'
import { modeById } from '@shared/modes'
import { MODE_COLOR } from './ThemePanel'

const HEADER_W = 110
const TRACK_H = 52
const AUDIO_TRACK_H = 64
const RULER_H = 26
/** Width of the grab zone at each clip edge for trimming (less on very short clips). */
const EDGE_PX = 8
/** How close (in pixels) an edge must come to a clip edge or the playhead to snap to it. */
const SNAP_PX = 8

type DragKind = 'move' | 'trim-start' | 'trim-end'
interface Drag {
  kind: DragKind
  clipId: string
  /** Every clip that follows this drag (the clip, plus its merged group). */
  clipIds: string[]
  originX: number
  dx: number
  /** Time offset to apply, after snapping. */
  dt: number
  /** Where the clip snapped to (draws a guide line), or null. */
  snapT: number | null
  targetTrackId: string
  /** Ctrl held while trimming: later clips on the track move with the edge. */
  ripple: boolean
  /** Moving onto other clips: dropping inserts here and pushes everything later (null = just place; Ctrl overwrites). */
  insertT: number | null
  /** Alt held: drop a copy and leave the original where it is. */
  copy: boolean
}

/** Where a right-click menu is open: on a clip, or on an empty spot of a track. */
interface Menu {
  x: number
  y: number
  time: number
  trackId: string
  clipId?: string
}

export function Timeline() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const selected = useStudio((s) => s.selectedClipIds)
  const tool = useStudio((s) => s.tool)
  const markInT = useStudio((s) => s.markIn)
  const markOutT = useStudio((s) => s.markOut)
  const { dispatch, setPlayhead, selectClips, setViewerMode, setTool } = useStudio.getState()
  const [razorX, setRazorX] = useState<number | null>(null)
  const [pxPerSec, setPxPerSec] = useState(40)
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem('timelineHeight')) || 290
    } catch {
      return 290
    }
  })

  /** Drag the top edge to resize the timeline (remembered per computer). */
  const startResize = (e: ReactPointerEvent): void => {
    const startY = e.clientY
    const startH = height
    let h = startH
    const move = (ev: PointerEvent): void => {
      h = Math.max(160, Math.min(window.innerHeight - 250, startH + startY - ev.clientY))
      setHeight(h)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem('timelineHeight', String(h))
      } catch {
        // storage unavailable: size just isn't remembered
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const [drag, setDrag] = useState<Drag | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Visible part of the timeline (for drawing only the on-screen part of waveforms).
  const [view, setView] = useState({ left: 0, width: 1600 })
  useEffect(() => {
    const el = scrollRef.current!
    const update = (): void => setView({ left: el.scrollLeft, width: el.clientWidth - HEADER_W })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => (ro.disconnect(), el.removeEventListener('scroll', update))
  }, [])

  const duration = projectDuration(project)
  const width = Math.max((duration + 30) * pxPerSec, 2000)
  const mediaById = new Map(project.media.map((m) => [m.id, m]))
  const selectedGroups = new Set(project.tracks.flatMap((t) => t.clips.filter((c) => c.groupId && selected.includes(c.id)).map((c) => c.groupId!)))
  const selectionGrouped = selectedGroups.size > 0

  /** Converts a clientX inside the scroll area to timeline seconds. */
  const timeAt = (clientX: number): number => {
    const el = scrollRef.current!
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEADER_W + el.scrollLeft) / pxPerSec)
  }

  /** Whether [start, start+len) on a track would cover any clip (other than `exceptId`). */
  const covers = (track: Track, start: number, len: number, exceptId?: string): boolean =>
    track.clips.some((c) => c.id !== exceptId && c.start < start + len - 1e-3 && clipEnd(c) > start + 1e-3)

  /** Where media dropped from the bin lands, and whether it inserts (it would cover clips; Alt overwrites). */
  const dropPlace = (e: { clientX: number; shiftKey: boolean; ctrlKey: boolean }, track: Track, media: MediaItem): { start: number; insert: boolean } => {
    const len = isStill(media) ? IMAGE_DEFAULT_SECONDS : media.duration
    let start = timeAt(e.clientX)
    if (!e.shiftKey) start += snapShift([start, start + len]).shift
    start = Math.max(0, start)
    return { start, insert: !e.ctrlKey && !track.locked && covers(track, start, len) }
  }

  const [menu, setMenu] = useState<Menu | null>(null)
  const [spaceSecs, setSpaceSecs] = useState(5)
  // While dragging media from the bin over clips: where it would be inserted.
  const [dropInsertT, setDropInsertT] = useState<number | null>(null)

  const scrubRuler = (e: ReactPointerEvent): void => {
    setViewerMode('program')
    setPlayhead(timeAt(e.clientX))
    const move = (ev: PointerEvent): void => setPlayhead(timeAt(ev.clientX))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * How far to shift so one of `edges` lands on a clip edge (any track) or the playhead,
   * if one is within SNAP_PX. `skipClipIds` are the clips being dragged.
   */
  const snapShift = (edges: number[], skipClipIds: string[] = []): { shift: number; at: number | null } => {
    const targets = [
      useStudio.getState().playhead,
      ...project.tracks.flatMap((t) => t.clips.filter((c) => !skipClipIds.includes(c.id)).flatMap((c) => [c.start, clipEnd(c)]))
    ]
    let best = { shift: 0, at: null as number | null }
    let bestDist = SNAP_PX / pxPerSec
    for (const e of edges) {
      for (const t of targets) {
        if (Math.abs(t - e) < bestDist) {
          bestDist = Math.abs(t - e)
          best = { shift: t - e, at: t }
        }
      }
    }
    return best
  }

  const startClipDrag = (e: ReactPointerEvent, track: Track, clip: Clip, edge?: 'trim-start' | 'trim-end'): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    setViewerMode('program')
    // Razor: cut this clip where clicked (Shift: cut every track there).
    if (tool === 'razor') {
      const time = timeAt(e.clientX)
      if (e.shiftKey) dispatch({ op: 'splitAt', time })
      else if (!track.locked) dispatch(withGroupMembers(project, [clip.id]).map((clipId) => ({ op: 'splitClip' as const, clipId, time })))
      return
    }
    // Alt+click adds a volume point at that spot, at the current level (Alt+drag copies instead).
    const media = mediaById.get(clip.mediaId)
    const addVolumePoint = (): void => {
      if (!media || media.kind === 'image' || !media.hasAudio) return
      const src = clip.in + (timeAt(e.clientX) - clip.start)
      dispatch({ op: 'setVolumeKeys', clipId: clip.id, keys: [...clip.volumeKeys, { t: src, v: keyGainAt(clip.volumeKeys, src) }] })
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const kind: DragKind =
      edge ?? (e.clientX - rect.left < EDGE_PX ? 'trim-start' : rect.right - e.clientX < EDGE_PX ? 'trim-end' : 'move')
    // Pressing on a clip that is already part of a multi-selection keeps the selection, so it can be dragged as one.
    const inSelection = selected.length > 1 && selected.includes(clip.id)
    if (!inSelection) selectClips(e.shiftKey || e.ctrlKey ? [...new Set([...selected, clip.id])] : [clip.id])
    if (track.locked) return

    // A merged group (or a multi-selection, when moving) moves as one; trimming takes along
    // group members whose edge lines up with this one.
    const all = project.tracks.flatMap((t) => t.clips)
    const memberSet = new Set(withGroupMembers(project, kind === 'move' && inSelection ? selected : [clip.id]))
    const members = all.filter((c) => memberSet.has(c.id))
    const grouped = members.length > 1
    const following =
      kind === 'move' ? members
      : kind === 'trim-start' ? members.filter((c) => Math.abs(c.start - clip.start) < 1e-3)
      : members.filter((c) => Math.abs(clipEnd(c) - clipEnd(clip)) < 1e-3)
    const memberIds = members.map((c) => c.id)
    let current: Drag = { kind, clipId: clip.id, clipIds: following.map((c) => c.id), originX: e.clientX, dx: 0, dt: 0, snapT: null, targetTrackId: track.id, ripple: false, insertT: null, copy: false }
    setDrag(current)
    const move = (ev: PointerEvent): void => {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-track-id]')
      const rowTrack = project.tracks.find((t) => t.id === row?.dataset.trackId)
      const dx = ev.clientX - current.originX
      const raw = dx / pxPerSec
      // Snap the edges that are moving (hold Shift to place freely).
      const edges =
        kind === 'move' ? following.flatMap((c) => [c.start + raw, clipEnd(c) + raw]) : kind === 'trim-start' ? [clip.start + raw] : [clipEnd(clip) + raw]
      const copy = kind === 'move' && (e.altKey || ev.altKey)
      // A copy may snap to the original's edges.
      const snap = ev.shiftKey ? { shift: 0, at: null } : snapShift(edges, copy ? [] : memberIds)
      // Only allow moving onto a track of the same kind. A group keeps its tracks.
      const targetTrackId = kind === 'move' && !grouped && rowTrack?.kind === track.kind ? rowTrack.id : current.targetTrackId
      const dt = raw + snap.shift
      // Dropping one clip onto others inserts it there (everything later moves along); Ctrl overwrites instead.
      const target = project.tracks.find((t) => t.id === targetTrackId)!
      const newStart = Math.max(0, clip.start + dt)
      const insertT =
        kind === 'move' && !grouped && !ev.ctrlKey && Math.abs(dx) >= 2 && covers(target, newStart, clipLength(clip), copy ? undefined : clip.id) ? newStart : null
      current = { ...current, dx, dt, snapT: snap.at, ripple: kind !== 'move' && ev.ctrlKey, targetTrackId, insertT, copy }
      setDrag(current)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      const { dt, ripple } = current
      if (Math.abs(current.dx) < 2 && current.targetTrackId === track.id) {
        if (e.altKey && kind === 'move') addVolumePoint()
        // A plain click inside a multi-selection selects just that clip.
        else if (inSelection && !e.shiftKey && !e.ctrlKey) selectClips([clip.id])
        return // a click, not a drag
      }
      if (current.copy) {
        const clipIds = grouped ? memberIds : [clip.id]
        const newClipIds = clipIds.map(() => newId())
        const op = { op: 'copyClips' as const, clipIds, delta: dt, trackId: grouped ? undefined : current.targetTrackId, insert: current.insertT !== null, newClipIds }
        if (dispatch(op)) selectClips(newClipIds)
        return
      }
      if (kind === 'move' && grouped) dispatch({ op: 'moveClips', clipIds: memberIds, delta: dt })
      else if (kind === 'move') dispatch({ op: 'moveClip', clipId: clip.id, start: clip.start + dt, trackId: current.targetTrackId, insert: current.insertT !== null })
      else if (kind === 'trim-start') dispatch(following.map((c) => ({ op: 'trimClip' as const, clipId: c.id, edge: 'start' as const, time: c.start + dt, ripple })))
      else dispatch(following.map((c) => ({ op: 'trimClip' as const, clipId: c.id, edge: 'end' as const, time: clipEnd(c) + dt, ripple })))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * A clip's place and length while one of its edges is dragged by dt, limited the same way the
   * trim op limits it (source length, neighbours unless rippling, at least one frame).
   */
  const trimmed = (clip: Clip, track: Track, dt: number, kind: 'trim-start' | 'trim-end', ripple: boolean): { start: number; len: number } => {
    const media = mediaById.get(clip.mediaId)
    const maxOut = !media || isStill(media) ? Infinity : media.duration
    const minLen = 1 / project.settings.fps
    const len = clipLength(clip)
    const idx = track.clips.findIndex((c) => c.id === clip.id)
    const prevEnd = idx > 0 ? clipEnd(track.clips[idx - 1]) : 0
    const nextStart = idx >= 0 && idx < track.clips.length - 1 ? track.clips[idx + 1].start : Infinity
    if (kind === 'trim-start') {
      const d = Math.min(Math.max(dt, -clip.in, ripple ? -Infinity : prevEnd - clip.start), len - minLen)
      return ripple ? { start: clip.start, len: len - d } : { start: clip.start + d, len: len - d }
    }
    const end = Math.max(Math.min(clipEnd(clip) + dt, ripple ? Infinity : nextStart, clip.start + maxOut - clip.in), clip.start + minLen)
    return { start: clip.start, len: end - clip.start }
  }

  // While ripple-trimming, the clips after the trimmed one shift by how much it grew or shrank.
  const rippleShift = new Map<string, { after: number; delta: number }>()
  if (drag?.ripple && drag.kind !== 'move') {
    for (const t of project.tracks) {
      const c = t.clips.find((x) => drag.clipIds.includes(x.id))
      if (c) rippleShift.set(t.id, { after: clipEnd(c) - 1e-6, delta: trimmed(c, t, drag.dt, drag.kind, true).len - clipLength(c) })
    }
  }

  /** Where a clip should be drawn right now, including an in-progress drag. */
  const layout = (clip: Clip, track: Track): { left: number; w: number; len: number } => {
    let start = clip.start
    let len = clipLength(clip)
    if (drag?.clipIds.includes(clip.id)) {
      // A copy is drawn as a ghost (CopyGhosts); the original stays put.
      if (drag.kind === 'move') start = drag.copy ? start : Math.max(0, start + drag.dt)
      else ({ start, len } = trimmed(clip, track, drag.dt, drag.kind, drag.ripple))
    } else {
      const r = rippleShift.get(track.id)
      if (r && clip.start >= r.after) start += r.delta
    }
    return { left: start * pxPerSec, w: len * pxPerSec, len }
  }

  // Ruler tick spacing that stays readable at any zoom.
  const tickStep = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pxPerSec >= 70) ?? 600
  const ticks = Array.from({ length: Math.ceil(width / pxPerSec / tickStep) }, (_, i) => i * tickStep)

  return (
    <div className="relative flex shrink-0 flex-col border-t border-line bg-panel" style={{ height }}>
      <div className="absolute -top-1 right-0 left-0 z-40 h-2 cursor-ns-resize hover:bg-accent/40" onPointerDown={startResize} title="Drag to resize the timeline" />
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3 text-xs text-muted">
        <PlayheadTime />
        <span>/ {formatTime(duration, true)}</span>
        <div className="ml-3 flex items-center gap-1">
          <ToolBtn on={tool === 'select'} title="Select / move (V)" onClick={() => setTool('select')}>↖ Select</ToolBtn>
          <ToolBtn on={tool === 'razor'} title="Razor (C): click a clip to cut it there; Shift+click cuts every track" onClick={() => setTool(tool === 'razor' ? 'select' : 'razor')}>✂ Razor</ToolBtn>
          <span className="mx-1 h-4 w-px bg-line" />
          <ToolBtn title="Cut all tracks (or the selected clips) at the playhead (S)" onClick={splitAtPlayhead}>Split at playhead</ToolBtn>
          <span className="mx-1 h-4 w-px bg-line" />
          <ToolBtn on={markInT !== null} title="Mark In at the playhead (I)" onClick={markIn}>⟦ In</ToolBtn>
          <ToolBtn on={markOutT !== null} title="Mark Out at the playhead (O)" onClick={markOut}>Out ⟧</ToolBtn>
          <ToolBtn
            danger
            disabled={markInT === null || markOutT === null}
            title="Remove the marked section from video and audio and close the gap (Delete)"
            onClick={cutMarkedRange}
          >
            ✂ Cut out marked
          </ToolBtn>
          {(markInT !== null || markOutT !== null) && <ToolBtn title="Clear marks (Esc)" onClick={() => useStudio.getState().setMarks(null, null)}>✕</ToolBtn>}
          <span className="mx-1 h-4 w-px bg-line" />
          <ToolBtn disabled={selected.length < 2} title="Merge the selected clips into one block that moves, cuts and deletes together (Ctrl+G). Ctrl+click clips to select several." onClick={mergeSelected}>⧉ Merge</ToolBtn>
          {selectionGrouped && <ToolBtn title="Unmerge: make the clips separate again (Ctrl+Shift+G)" onClick={ungroupSelected}>Unmerge</ToolBtn>}
          <ToolBtn title="Remove empty space where no track has anything, so clips sit back to back (tracks stay in sync)" onClick={closeGaps}>⇤ Close gaps</ToolBtn>
        </div>
        <span className="ml-2 truncate">Right-click: add / remove space · Drop onto clips: insert (Ctrl: overwrite) · Alt+drag or Ctrl+C / Ctrl+V: copy · Drag clip edges to trim (Ctrl: ripple) · A select all after playhead · M marker · Alt+click volume point · Shift+drag no snap · Ctrl+wheel zoom</span>
        <div className="ml-auto flex shrink-0 gap-2">
          <button className="hover:text-text" onClick={() => dispatch({ op: 'addTrack', kind: 'video' })}>+ Video track</button>
          <button className="hover:text-text" onClick={() => dispatch({ op: 'addTrack', kind: 'audio' })}>+ Audio track</button>
          <input
            type="range"
            min={5}
            max={400}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            title="Zoom"
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto"
        onWheel={(e) => {
          if (!e.ctrlKey) return
          setPxPerSec((z) => Math.min(400, Math.max(5, z * (e.deltaY < 0 ? 1.2 : 1 / 1.2))))
        }}
        onPointerDown={() => selectClips([])}
        onPointerMove={(e) => tool === 'razor' && setRazorX(timeAt(e.clientX) * pxPerSec)}
        onPointerLeave={() => setRazorX(null)}
        style={{ cursor: tool === 'razor' ? 'crosshair' : undefined }}
      >
        <div style={{ width: width + HEADER_W }} className="relative">
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-b border-line bg-panel" style={{ width: HEADER_W }} />
            <div className="relative flex-1 cursor-col-resize border-b border-line bg-panel-2" onPointerDown={(e) => (e.stopPropagation(), scrubRuler(e))}>
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-line pl-1 text-[10px] text-muted" style={{ left: t * pxPerSec }}>
                  {formatTime(t)}
                </div>
              ))}
              {markInT !== null && markOutT !== null && (
                <div className="absolute inset-y-0 bg-accent/30" style={{ left: Math.min(markInT, markOutT) * pxPerSec, width: Math.abs(markOutT - markInT) * pxPerSec }} />
              )}
              {markInT !== null && <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: markInT * pxPerSec }} title="In" />}
              {markOutT !== null && <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: markOutT * pxPerSec }} title="Out" />}
              {project.markers.map((m) => (
                <div key={m.id} title={m.label} className="absolute bottom-0 h-2 w-2 -translate-x-1 rotate-45 bg-yellow-400" style={{ left: m.time * pxPerSec }} />
              ))}
              {/* Parts with their own mode and mood: click to select (sets In/Out). */}
              {project.sections.map((p) => (
                <div
                  key={p.id}
                  title={`${modeById(p.mode).name}${p.mood.trim() ? ` · ${p.mood.trim()}` : ''} — click to select this part`}
                  className="absolute top-0 h-1.5 cursor-pointer rounded-b-sm opacity-80 hover:opacity-100"
                  style={{ left: p.start * pxPerSec, width: Math.max(2, (p.end - p.start) * pxPerSec), background: MODE_COLOR[p.mode] }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    useStudio.getState().setMarks(p.start, p.end)
                    setPlayhead(p.start)
                  }}
                />
              ))}
            </div>
          </div>

          {/* Tracks: video tracks shown top-down (top layer first), then audio */}
          {[...project.tracks.filter((t) => t.kind === 'video').reverse(), ...project.tracks.filter((t) => t.kind === 'audio')].map((track) => (
            <div key={track.id} className="flex border-b border-line" style={{ height: track.kind === 'audio' ? AUDIO_TRACK_H : TRACK_H }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-panel px-2" style={{ width: HEADER_W }}>
                <span className="w-7 font-semibold">{track.name}</span>
                {track.kind === 'video' ? (
                  <ToggleBtn on={track.hidden} label="👁" title="Hide" onClick={() => dispatch({ op: 'updateTrack', trackId: track.id, patch: { hidden: !track.hidden } })} />
                ) : (
                  <ToggleBtn on={track.muted} label="M" title="Mute" onClick={() => dispatch({ op: 'updateTrack', trackId: track.id, patch: { muted: !track.muted } })} />
                )}
                <ToggleBtn on={track.locked} label="🔒" title="Lock" onClick={() => dispatch({ op: 'updateTrack', trackId: track.id, patch: { locked: !track.locked } })} />
              </div>
              <div
                data-track-id={track.id}
                className={`relative flex-1 ${drag?.targetTrackId === track.id && drag.kind === 'move' ? 'bg-accent/5' : ''} ${track.locked ? 'opacity-50' : ''}`}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return
                  e.preventDefault()
                  const media = mediaById.get(mediaDrag.id ?? '')
                  const drop = media && dropPlace(e, track, media)
                  setDropInsertT(drop?.insert ? drop.start : null)
                }}
                onDragLeave={() => setDropInsertT(null)}
                onDrop={(e) => {
                  setDropInsertT(null)
                  const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE)
                  const media = mediaById.get(mediaId)
                  if (!media) return
                  const { start, insert } = dropPlace(e, track, media)
                  dispatch({ op: 'insertClip', trackId: track.id, mediaId, start, insert })
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, time: timeAt(e.clientX), trackId: track.id })
                }}
                onPointerEnter={() => setPasteTrack(track.id)}
                onPointerDown={(e) => {
                  setPasteTrack(track.id)
                  // Clicking an empty spot puts the playhead there (e.g. to paste at it).
                  if (e.button !== 0 || tool !== 'select') return
                  setViewerMode('program')
                  setPlayhead(timeAt(e.clientX))
                }}
              >
                {track.clips.map((clip) => {
                  const media = mediaById.get(clip.mediaId)
                  const { left, w, len } = layout(clip, track)
                  const edgeW = Math.max(3, Math.min(EDGE_PX, w / 4))
                  const trimming = drag?.clipIds.includes(clip.id) && drag.kind !== 'move'
                  const color = media?.kind === 'audio' ? 'bg-audio' : media?.kind === 'image' ? 'bg-image' : media?.kind === 'graphic' ? 'bg-[#7c4dcc]' : media?.kind === 'motion' ? 'bg-[#c2477e]' : 'bg-video'
                  const isSel = selected.includes(clip.id)
                  // Other clips of a selected merged group get a softer outline.
                  const inSelGroup = !isSel && !!clip.groupId && selectedGroups.has(clip.groupId)
                  const moving = drag?.clipId === clip.id && drag.kind === 'move' && !drag.copy && drag.targetTrackId !== track.id
                  return (
                    <div
                      key={clip.id}
                      className={`absolute top-1 bottom-1 ${tool === 'razor' ? 'cursor-crosshair' : 'cursor-grab'} overflow-hidden rounded ${color} px-1.5 text-xs text-white ${
                        isSel ? 'ring-2 ring-white' : inSelGroup ? 'ring-2 ring-white/40' : ''
                      } ${moving ? 'opacity-30' : ''}`}
                      style={{ left, width: Math.max(2, w), ...(media?.kind === 'color' ? { background: media.color, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.35)' } : {}) }}
                      onPointerDown={(e) => startClipDrag(e, track, clip)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (!selected.includes(clip.id)) selectClips([clip.id])
                        setMenu({ x: e.clientX, y: e.clientY, time: timeAt(e.clientX), trackId: track.id, clipId: clip.id })
                      }}
                    >
                      {media && media.kind !== 'image' && media.hasAudio && (
                        <ClipAudio
                          clip={clip}
                          media={media}
                          projectPath={projectPath}
                          pxPerSec={pxPerSec}
                          left={left}
                          width={w}
                          height={(track.kind === 'audio' ? AUDIO_TRACK_H : TRACK_H) - 8}
                          viewLeft={view.left}
                          viewWidth={view.width}
                          showVolumeLine={!clip.muted && !track.locked && (track.kind === 'audio' || isSel || clip.volumeKeys.length > 0)}
                          onKeysChange={(keys) => dispatch({ op: 'setVolumeKeys', clipId: clip.id, keys }, { coalesce: `keys:${clip.id}` })}
                        />
                      )}
                      {/* Trim handles: drag to shorten/lengthen; Ctrl+drag also moves the clips after it. */}
                      {(['trim-start', 'trim-end'] as const).map((edge) => (
                        <div
                          key={edge}
                          title="Drag to change the length · Ctrl+drag: later clips follow"
                          className={`absolute inset-y-0 z-20 bg-white/20 hover:bg-white/60 ${edge === 'trim-start' ? 'left-0 rounded-l' : 'right-0 rounded-r'} ${tool === 'razor' ? '' : 'cursor-ew-resize'} ${
                            drag?.clipIds.includes(clip.id) && drag.kind === edge ? 'bg-yellow-300/80' : ''
                          }`}
                          style={{ width: edgeW }}
                          onPointerDown={(e) => startClipDrag(e, track, clip, edge)}
                        />
                      ))}
                      {/* Auto zooms: a strip along the bottom of the clip. */}
                      {clip.zooms.map((z, i) => (
                        <div
                          key={`z${i}`}
                          className="pointer-events-none absolute bottom-0 z-10 h-1.5 rounded-sm bg-yellow-300/90"
                          style={{ left: (z.start - clip.in) * pxPerSec, width: Math.max(2, (z.end - z.start) * pxPerSec) }}
                          title={`Zoom ${z.scale}×`}
                        />
                      ))}
                      {clip.fadeIn > 0 && <FadeMark side="in" width={clip.fadeIn * pxPerSec} />}
                      {clip.fadeOut > 0 && <FadeMark side="out" width={clip.fadeOut * pxPerSec} />}
                      {clip.crossfadeIn > 0 && (
                        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-1 bg-yellow-300" title={`Crossfade ${clip.crossfadeIn.toFixed(2)} s`} />
                      )}
                      <div className="relative truncate pt-0.5">
                        {clip.groupId && <span title="Merged with other clips (Ctrl+Shift+G to unmerge)">🔗 </span>}
                        {clip.muted && <span title="Sound muted">🔇 </span>}
                        {clip.enhance !== 'off' && <span title={`Enhance voice: ${clip.enhance}`}>✨ </span>}
                        {clip.keys.length > 0 && <span title="Animated">◆ </span>}
                        {media?.graphic ? graphicLabel(media.graphic) : (media?.name ?? 'Missing media')}
                      </div>
                      <div className={`relative truncate ${trimming ? 'font-semibold text-yellow-200' : 'opacity-70'}`}>
                        {formatTime(len, true)}
                        {trimming && drag?.ripple && ' · ripple'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {markInT !== null && markOutT !== null && (
            <div
              className="pointer-events-none absolute bottom-0 z-20 bg-accent/10"
              style={{ top: RULER_H, left: HEADER_W + Math.min(markInT, markOutT) * pxPerSec, width: Math.abs(markOutT - markInT) * pxPerSec }}
            />
          )}
          {drag?.snapT != null && (
            <div className="pointer-events-none absolute bottom-0 z-30 w-0 border-l border-yellow-300" style={{ top: RULER_H, left: HEADER_W + drag.snapT * pxPerSec }} />
          )}
          {drag?.copy && Math.abs(drag.dx) >= 2 && <CopyGhosts drag={drag} project={project} pxPerSec={pxPerSec} />}
          {(drag?.insertT ?? dropInsertT) != null && (
            <div className="pointer-events-none absolute bottom-0 z-30 w-1 -translate-x-0.5 bg-accent" style={{ top: RULER_H, left: HEADER_W + (drag?.insertT ?? dropInsertT)! * pxPerSec }}>
              <span className="absolute top-0 left-1.5 rounded bg-accent px-1 text-[10px] whitespace-nowrap text-white">Insert here · later clips move (Ctrl: overwrite)</span>
            </div>
          )}
          {tool === 'razor' && razorX !== null && (
            <div className="pointer-events-none absolute bottom-0 z-30 w-0 border-l border-dashed border-danger" style={{ top: RULER_H, left: HEADER_W + razorX }} />
          )}
          <Playhead pxPerSec={pxPerSec} scrollRef={scrollRef} />
        </div>
      </div>
      {menu && <TimelineMenu menu={menu} secs={spaceSecs} setSecs={setSpaceSecs} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Dashed outlines where Alt+dragged copies will land (the originals stay where they are). */
function CopyGhosts({ drag, project, pxPerSec }: { drag: Drag; project: Project; pxPerSec: number }) {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-track-id]')]
  const single = drag.clipIds.length === 1
  return (
    <>
      {project.tracks.flatMap((t) =>
        t.clips
          .filter((c) => drag.clipIds.includes(c.id))
          .map((c) => {
            const row = rows.find((r) => r.dataset.trackId === (single ? drag.targetTrackId : t.id))
            if (!row) return null
            return (
              <div
                key={c.id}
                className="pointer-events-none absolute z-30 rounded border-2 border-dashed border-white/80 bg-white/10 px-1.5 text-xs text-white"
                style={{ top: row.offsetTop + 4, height: row.offsetHeight - 8, left: HEADER_W + Math.max(0, c.start + drag.dt) * pxPerSec, width: Math.max(2, clipLength(c) * pxPerSec) }}
              >
                + copy
              </div>
            )
          })
      )}
    </>
  )
}

/** Right-click menu on a clip or an empty spot: add space (shifts the whole timeline), select what follows, delete. */
function TimelineMenu({ menu, secs, setSecs, onClose }: { menu: Menu; secs: number; setSecs(n: number): void; onClose(): void }) {
  const project = useStudio((s) => s.project)!
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  useEffect(() => {
    // Keep the menu on screen.
    const r = ref.current!.getBoundingClientRect()
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 8), top: Math.min(menu.y, window.innerHeight - r.height - 8) })
    const away = (e: PointerEvent): void => void (ref.current?.contains(e.target as Node) || onClose())
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && onClose())
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => (window.removeEventListener('pointerdown', away, true), window.removeEventListener('keydown', key), window.removeEventListener('blur', onClose))
  }, [menu])

  const s = useStudio.getState()
  const clip = menu.clipId ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === menu.clipId) : undefined
  const ids = clip ? withGroupMembers(project, s.selectedClipIds.includes(clip.id) ? s.selectedClipIds : [clip.id]) : []
  const at = clip ? clip.start : menu.time
  const gap = clip ? null : emptySpaceAt(project, menu.trackId, menu.time)
  const item = (label: string, onClick: () => void, hint?: string, danger?: boolean) => (
    <button
      className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left hover:bg-accent/20 ${danger ? 'text-danger' : ''}`}
      onClick={() => (onClick(), onClose())}
    >
      <span>{label}</span>
      {hint && <span className="text-muted">{hint}</span>}
    </button>
  )
  const sep = <div className="my-1 h-px bg-line" />
  return (
    <div ref={ref} className="fixed z-50 min-w-60 rounded-md border border-line bg-panel-2 py-1 text-xs text-text shadow-xl" style={pos} onContextMenu={(e) => e.preventDefault()}>
      <label className="flex items-center gap-2 px-3 py-1.5 text-muted">
        Space to add
        <input
          type="number"
          min={0.1}
          step={0.5}
          value={secs}
          className="w-14 rounded border border-line bg-transparent px-1 text-text"
          onChange={(e) => setSecs(Number(e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && (insertSpace(at, secs, [menu.trackId]), onClose())}
        />
        s
      </label>
      {clip ? (
        <>
          {item('⇥ Add space before this clip', () => insertSpace(clip.start, secs, [menu.trackId]), 'Enter')}
          {item('⇥ Add space after this clip', () => insertSpace(clipEnd(clip), secs, [menu.trackId]))}
          {item('⇥ Add space before it on all tracks', () => insertSpace(clip.start, secs))}
          {sep}
          {item('Copy', () => copySelected(), 'Ctrl+C')}
          {item('Cut', () => copySelected(true), 'Ctrl+X')}
          {hasClipboard() && item('Paste before this clip (makes room)', () => paste(clip.start, menu.trackId))}
          {hasClipboard() && item('Paste after this clip (makes room)', () => paste(clipEnd(clip), menu.trackId))}
          {sep}
          {item('Select this and everything after', () => selectFrom(clip.start), 'A')}
          {s.playhead > clip.start && s.playhead < clipEnd(clip) &&
            item('Split at playhead', () => s.dispatch(withGroupMembers(project, [clip.id]).map((clipId) => ({ op: 'splitClip' as const, clipId, time: s.playhead }))), 'S')}
          {sep}
          {item('Delete', () => s.dispatch({ op: 'deleteClips', clipIds: ids }) && s.selectClips([]), 'Del', true)}
          {item('Delete and close the gap', () => s.dispatch({ op: 'deleteClips', clipIds: ids, ripple: true }) && s.selectClips([]), 'Shift+Del', true)}
        </>
      ) : (
        <>
          {gap &&
            (gap.allTracks
              ? item(`⇤ Remove this empty space (${(gap.end - gap.start).toFixed(1)} s)`, () => removeSpace(gap.start, gap.end))
              : item(`⇤ Close this gap on this track only (${(gap.end - gap.start).toFixed(1)} s)`, () => closeTrackGap(menu.trackId, gap.start, gap.end)))}
          {hasClipboard() && item('Paste here (makes room)', () => paste(menu.time, menu.trackId), 'Ctrl+V')}
          {item('⇥ Add space here (this track)', () => insertSpace(menu.time, secs, [menu.trackId]), 'Enter')}
          {item('⇥ Add space here on all tracks', () => insertSpace(menu.time, secs))}
          {item('Select everything after here', () => selectFrom(menu.time))}
        </>
      )}
    </div>
  )
}

function ToggleBtn(props: { on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={props.onClick}
      className={`h-6 w-6 rounded text-[11px] ${props.on ? 'bg-accent text-white' : 'text-muted hover:bg-panel-2'}`}
    >
      {props.label}
    </button>
  )
}

function PlayheadTime() {
  const playhead = useStudio((s) => s.playhead)
  return <span className="font-mono text-text">{formatTime(playhead, true)}</span>
}

/** The red line. Subscribes on its own so playback doesn't re-render the whole timeline. */
function Playhead({ pxPerSec, scrollRef }: { pxPerSec: number; scrollRef: RefObject<HTMLDivElement | null> }) {
  const playhead = useStudio((s) => s.playhead)
  const x = playhead * pxPerSec

  // Keep the playhead in view (page forward when it runs off the right edge).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const visible = el.clientWidth - HEADER_W
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 20) el.scrollLeft = Math.max(0, x - 40)
  }, [x])

  return <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-danger" style={{ left: HEADER_W + x }} />
}

/** Diagonal shading at a clip's start/end showing a fade. */
function FadeMark({ side, width }: { side: 'in' | 'out'; width: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-y-0"
      style={{
        [side === 'in' ? 'left' : 'right']: 0,
        width,
        background: `linear-gradient(to ${side === 'in' ? 'top left' : 'top right'}, transparent 50%, rgba(0,0,0,0.45) 50%)`
      }}
    />
  )
}

function ToolBtn(props: { on?: boolean; danger?: boolean; disabled?: boolean; title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded px-2 py-0.5 disabled:opacity-30 ${
        props.on ? 'bg-accent text-white' : props.danger ? 'text-danger hover:bg-danger/15' : 'hover:bg-panel-2 hover:text-text'
      }`}
    >
      {props.children}
    </button>
  )
}
