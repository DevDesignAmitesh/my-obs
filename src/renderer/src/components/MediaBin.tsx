import { useState } from 'react'
import type { MediaItem } from '@shared/project'
import { clipEnd, colorMedia, graphicMedia, newId } from '@shared/project'
import { defaultGraphic, GRAPHIC_TEMPLATES, TEMPLATE_INFO, type GraphicTemplate } from '@shared/graphics'
import { placeOnTop } from '@shared/placement'
import { useStudio } from '../store'
import { formatTime } from '../time'
import { MotionThumb } from './CreatePanel'
import { RenameField } from './RenameField'

export const MEDIA_DRAG_TYPE = 'application/x-studio-media'
/** The media being dragged from the bin (drag data can't be read until the drop). */
export const mediaDrag = { id: null as string | null }

export function MediaBin() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const selectedMediaId = useStudio((s) => s.selectedMediaId)
  const { dispatch, selectMedia, showToast, setViewerMode } = useStudio.getState()
  const [importing, setImporting] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Text layers belong to their clip; they are edited on the timeline, not listed here.
  const files = project.media.filter((m) => m.kind !== 'graphic')

  const importFiles = async (files: string[]): Promise<void> => {
    if (!files.length) return
    setImporting(true)
    try {
      const items = await window.studio.media.import(projectPath, files)
      dispatch({ op: 'addMedia', items })
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  /** Adds a text layer at the playhead, on top of whatever is showing, and selects it. */
  const addText = (template: GraphicTemplate): void => {
    const s = useStudio.getState()
    const p = s.project!
    const { width: W, height: H } = p.settings
    const length = template === 'code' || template === 'list' ? 8 : 4
    const { ops, clipId } = placeOnTop(p, graphicMedia(newId(), defaultGraphic(template, W, H), W, H), s.playhead, s.playhead + length)
    if (s.dispatch(ops)) {
      s.selectClips([clipId])
      s.setRightTab('clip')
      s.setViewerMode('program')
    }
  }

  /** Appends the item to the end of the first matching track (the simplest way to "merge" clips). */
  const addToTimeline = (m: MediaItem): void => {
    const track = useStudio.getState().project!.tracks.find((t) => (t.kind === 'audio') === (m.kind === 'audio') && !t.locked)
    if (!track) return showToast('No unlocked track for this media type')
    const start = track.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0)
    dispatch({ op: 'insertClip', trackId: track.id, mediaId: m.id, start })
  }

  /** Removes the item (and its clips) from the project. It goes to ♻ Bin → Deleted; the file on disk is kept. */
  const removeMedia = (m: MediaItem): void => {
    const uses = useStudio.getState().project!.tracks.reduce((n, t) => n + t.clips.filter((c) => c.mediaId === m.id).length, 0)
    if (!dispatch({ op: 'removeMedia', mediaId: m.id })) return
    selectMedia(null)
    showToast(`Removed “${m.name}”${uses ? ` and ${uses} clip${uses > 1 ? 's' : ''} using it` : ''} — restore it from ♻ Bin or Ctrl+Z`)
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const files = [...e.dataTransfer.files].map((f) => window.studio.media.pathForFile(f)).filter(Boolean)
        importFiles(files)
      }}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs text-muted">{files.length} items</span>
        <select
          className="ml-auto w-[68px] cursor-pointer rounded bg-panel-2 px-1 py-1 hover:bg-line"
          value=""
          title="Add a title, lower third, card… at the playhead"
          onChange={(e) => e.target.value && addText(e.target.value as GraphicTemplate)}
        >
          <option value="">+ Text</option>
          {GRAPHIC_TEMPLATES.map((t) => (
            <option key={t} value={t}>{TEMPLATE_INFO[t].name}</option>
          ))}
        </select>
        <label className="mx-1 cursor-pointer rounded bg-panel-2 px-2 py-1 hover:bg-line" title="Add a solid color layer (backgrounds, panels)">
          + Color
          <input
            type="color"
            className="hidden"
            defaultValue="#1e2a4a"
            onChange={(e) => {
              const { width, height } = useStudio.getState().project!.settings
              dispatch({ op: 'addMedia', items: [colorMedia(newId(), e.target.value, width, height)] })
            }}
          />
        </label>
        <button
          className="rounded bg-panel-2 px-2 py-1 hover:bg-line disabled:opacity-50"
          disabled={importing}
          onClick={async () => importFiles(await window.studio.dialog.pickMediaFiles())}
        >
          {importing ? 'Importing…' : '+ Import'}
        </button>
      </div>

      <div className="grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-auto p-2">
        {files.length === 0 && (
          <p className="col-span-2 p-4 text-center text-muted">Import or drop videos, audio and images here.</p>
        )}
        {files.map((m) => (
          <div
            key={m.id}
            draggable={renamingId !== m.id}
            onDragStart={(e) => (e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id), (mediaDrag.id = m.id))}
            onDragEnd={() => (mediaDrag.id = null)}
            onClick={() => (selectMedia(m.id), setViewerMode('source'))}
            onDoubleClick={() => addToTimeline(m)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'F2') return e.preventDefault(), e.stopPropagation(), setRenamingId(m.id)
              if (e.key !== 'Backspace' && e.key !== 'Delete') return
              // Handled here so the editor's Delete shortcut doesn't also delete selected timeline clips.
              e.preventDefault()
              e.stopPropagation()
              removeMedia(m)
            }}
            title={`${m.name}\nDouble-click to add to the end of the timeline\nDouble-click the name or press F2 to rename\nBackspace/Delete to remove from the project`}
            className={`group cursor-pointer overflow-hidden rounded border outline-none ${
              selectedMediaId === m.id ? 'border-accent' : 'border-line'
            } bg-panel-2`}
          >
            <div className="relative flex aspect-video items-center justify-center bg-black">
              {m.kind === 'color' ? (
                <div className="h-full w-full" style={{ background: m.color }} />
              ) : m.kind === 'motion' ? (
                <MotionThumb media={m} />
              ) : m.thumbnail ? (
                <img className="h-full w-full object-cover" src={window.studio.media.url(projectPath, m.thumbnail)} />
              ) : (
                <span className="text-2xl text-muted">{m.kind === 'audio' ? '♪' : '▣'}</span>
              )}
              {m.kind === 'motion' && <span className="absolute top-1 left-1 rounded bg-black/70 px-1 text-[10px]">{m.motion?.tracks.length ? 'Animation' : 'SVG'}</span>}
              {m.kind !== 'image' && m.kind !== 'color' && (m.kind !== 'motion' || !!m.motion?.tracks.length) && (
                <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px]">{formatTime(m.duration)}</span>
              )}
            </div>
            <RenameField
              mediaId={m.id}
              name={m.name}
              className="px-1.5 py-1 text-xs"
              editing={renamingId === m.id}
              onDone={() => setRenamingId(null)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
