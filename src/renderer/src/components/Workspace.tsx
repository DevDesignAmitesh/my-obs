import { useEffect, useState } from 'react'
import { useStudio } from '../store'
import { Viewer } from './Viewer'
import { Timeline } from './Timeline'
import { RecorderView } from '../recorder/RecorderView'
import { LeftPanel, RightPanel } from './SidePanels'
import { SettingsDialog } from './SettingsDialog'
import { ExportDialog } from './ExportDialog'
import { activePlayer } from '../engine/player'
import { projectDuration } from '@shared/project'
import { copySelected, cutMarkedRange, markIn, markOut, mergeSelected, paste, selectFromPlayhead, splitAtPlayhead, ungroupSelected } from '../editing'
import { withGroupMembers } from '@shared/ops'
import { useChatHistory } from '../ai-chat'
import { demoTurns } from './AssistantPanel'

type Mode = 'record' | 'edit'

export function Workspace() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const saving = useStudio((s) => s.saving)
  const canUndo = useStudio((s) => s.past.length > 0)
  const canRedo = useStudio((s) => s.future.length > 0)
  const { undo, redo, close, dispatch } = useStudio.getState()
  const recording = useStudio((s) => s.recording)
  const [mode, setMode] = useState<Mode>(project.media.length ? 'edit' : 'record')
  const [exporting, setExporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Ctrl+Shift+F9 from the editor opens the recorder (press again there to start).
  useEffect(() => window.studio.window.onHotkey((key) => key === 'toggle-record' && setMode('record')), [])

  useKeyboardShortcuts(mode)
  useDropMissingMedia()
  // The AI chat is saved per project (ai-history.json); loaded here so the Bin panel sees it too.
  useChatHistory(projectPath, window.studio.dev.mode === 'demo' ? () => demoTurns(useStudio.getState().project!) : undefined)

  const back = async (): Promise<void> => {
    // Make sure the latest edits are on disk before leaving.
    await window.studio.projects.save(projectPath, useStudio.getState().project!)
    close()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <button className="text-muted hover:text-text disabled:opacity-30" disabled={recording} onClick={back} title="Back to projects">
          ←
        </button>
        <span className="font-semibold">{project.name}</span>
        <span className="text-xs text-muted">
          {saving === 'saved' ? 'Saved' : saving === 'pending' ? 'Saving…' : 'Save failed'}
        </span>

        <div className="mx-auto flex rounded-md border border-line p-0.5">
          {(['record', 'edit'] as Mode[]).map((m) => (
            <button
              key={m}
              className={`rounded px-4 py-1 capitalize ${mode === m ? 'bg-accent text-white' : 'text-muted hover:text-text'}`}
              title={recording && m === 'record' && mode !== m ? 'Recording is running. Open the recorder to pause or stop it (or Ctrl+Shift+F9)' : undefined}
              onClick={() => setMode(m)}
            >
              {/* While a take runs in the background, the Record tab shows it. */}
              {recording && m === 'record' && mode !== m ? <span className="animate-pulse font-semibold text-danger">● Rec</span> : m}
            </button>
          ))}
        </div>

        <button className="px-2 text-muted hover:text-text disabled:opacity-30" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button className="px-2 text-muted hover:text-text disabled:opacity-30" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">
          ↷
        </button>
        <select
          className="rounded border border-line bg-panel-2 px-2 py-1"
          value={`${project.settings.width}x${project.settings.height}`}
          onChange={(e) => {
            const [width, height] = e.target.value.split('x').map(Number)
            dispatch({ op: 'setSettings', patch: { width, height } })
          }}
          title="Canvas size"
        >
          <option value="1920x1080">16:9 · 1080p</option>
          <option value="3840x2160">16:9 · 4K</option>
          <option value="1080x1920">9:16 · Shorts/Reels</option>
          <option value="1080x1080">1:1 · Square</option>
        </select>
        <button className="text-muted hover:text-text" onClick={() => window.studio.projects.reveal(projectPath)} title={projectPath}>
          Open folder
        </button>
        <button className="text-muted hover:text-text" title="Settings (AI keys)" onClick={() => setSettingsOpen(true)}>
          ⚙ Settings
        </button>
        {mode === 'edit' && (
          <button className="rounded bg-accent px-3 py-1 font-medium text-white" onClick={() => (activePlayer?.pause(), setExporting(true))}>
            Export
          </button>
        )}
      </header>

      {/* The recorder stays alive (hidden) while a take runs, so the editor can be used meanwhile. */}
      {(mode === 'record' || recording) && (
        <div className={mode === 'record' ? 'flex min-h-0 flex-1 flex-col' : 'pointer-events-none fixed top-0 -left-[20000px] h-[720px] w-[1280px] overflow-hidden'} aria-hidden={mode !== 'record'}>
          <RecorderView onTakeSaved={() => setMode('edit')} />
        </div>
      )}
      {mode === 'edit' && (
        <>
          <div className="flex min-h-0 flex-1">
            <LeftPanel onOpenSettings={() => setSettingsOpen(true)} />
            <Viewer />
            <RightPanel onOpenSettings={() => setSettingsOpen(true)} />
          </div>
          <Timeline />
        </>
      )}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/**
 * Files deleted from the project folder in Explorer are dropped from the project (into ♻ Bin → Deleted,
 * so they can be put back) when the project opens and whenever Studio regains focus.
 */
function useDropMissingMedia(): void {
  const projectPath = useStudio((s) => s.projectPath)
  useEffect(() => {
    if (!projectPath) return
    const check = async (): Promise<void> => {
      const paths = [...new Set(useStudio.getState().project?.media.filter((m) => m.path).map((m) => m.path) ?? [])]
      if (!paths.length) return
      const gone = new Set(await window.studio.media.missing(projectPath, paths))
      const s = useStudio.getState()
      if (!gone.size || s.projectPath !== projectPath || s.recording) return
      const removed = s.project!.media.filter((m) => m.path && gone.has(m.path))
      if (!removed.length || !s.dispatch(removed.map((m) => ({ op: 'removeMedia' as const, mediaId: m.id })))) return
      if (removed.some((m) => m.id === s.selectedMediaId)) s.selectMedia(null)
      s.showToast(`${removed.length} file${removed.length > 1 ? 's were' : ' was'} deleted from disk and removed: ${removed.map((m) => m.name).join(', ')}`)
    }
    void check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [projectPath])
}

/** Keys typed into text fields (inputs, textareas, contenteditable) are never editor shortcuts. */
function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  )
}

function useKeyboardShortcuts(mode: Mode): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      if (document.querySelector('.fixed.inset-0')) return // a dialog is open
      const s = useStudio.getState()
      if (s.recording && mode === 'record') return
      const key = e.key.toLowerCase()
      if (e.ctrlKey && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (e.ctrlKey && key === 'y') {
        e.preventDefault()
        s.redo()
      } else if (e.ctrlKey && (key === 'c' || key === 'x') && s.selectedClipIds.length) {
        e.preventDefault()
        copySelected(key === 'x')
      } else if (e.ctrlKey && key === 'v') {
        e.preventDefault()
        paste()
      } else if (e.ctrlKey && key === 'g') {
        e.preventDefault()
        if (e.shiftKey) ungroupSelected()
        else mergeSelected()
      } else if (!e.ctrlKey && key === 's') {
        splitAtPlayhead()
      } else if (!e.ctrlKey && key === 'c') {
        s.setTool(s.tool === 'razor' ? 'select' : 'razor')
      } else if (!e.ctrlKey && key === 'v') {
        s.setTool('select')
      } else if (!e.ctrlKey && key === 'a') {
        selectFromPlayhead()
      } else if (key === 'i') {
        markIn()
      } else if (key === 'o') {
        markOut()
      } else if (key === 'escape') {
        s.setMarks(null, null)
        s.setTool('select')
      } else if ((key === 'delete' || key === 'backspace') && !s.selectedClipIds.length && s.markedRange()) {
        cutMarkedRange()
      } else if ((key === 'delete' || key === 'backspace') && s.selectedClipIds.length) {
        // Shift+Delete = ripple delete (close the gap).
        if (s.dispatch({ op: 'deleteClips', clipIds: withGroupMembers(s.project!, s.selectedClipIds), ripple: e.shiftKey })) s.selectClips([])
      } else if (key === 'm') {
        s.dispatch({ op: 'addMarker', time: s.playhead, label: 'Marker' })
      } else if (key === 'home') {
        s.setPlayhead(0)
      } else if (key === 'end') {
        s.setPlayhead(projectDuration(s.project!))
      } else if (key === ' ' || key === 'k' || key === 'l') {
        e.preventDefault()
        s.setViewerMode('program')
        if (key === ' ') activePlayer?.toggle()
        else if (key === 'k') activePlayer?.pause()
        else activePlayer?.play()
      } else if (key === 'j') {
        s.setPlayhead(s.playhead - 5)
      } else if (key === 'arrowleft' || key === 'arrowright') {
        // One frame, or one second with Shift.
        e.preventDefault()
        activePlayer?.pause()
        const fps = s.project!.settings.fps
        const d = (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / fps)
        s.setPlayhead(Math.max(0, Math.round((s.playhead + d) * fps) / fps))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])
}
