import { create } from 'zustand'
import type { OpenedProject } from '@shared/api'
import type { Focus } from '@shared/assistant'
import type { Project } from '@shared/project'
import { applyOps, type EditOp } from '@shared/ops'

const HISTORY_LIMIT = 200
const SAVE_DELAY_MS = 800

interface StudioState {
  projectPath: string | null
  project: Project | null
  past: Project[]
  future: Project[]
  saving: 'saved' | 'pending' | 'error'
  /** Timeline playhead, seconds. */
  playhead: number
  selectedClipIds: string[]
  selectedMediaId: string | null
  toast: string | null
  /** True while a take is being recorded or saved (locks leaving the recorder). */
  recording: boolean
  /** What the viewer shows: the edited timeline, or the media item selected in the bin. */
  viewerMode: 'program' | 'source'
  /** Timeline tool: select/move, or razor (click a clip to cut it). */
  tool: 'select' | 'razor'
  /** In/Out marks for cutting out a section (and as the AI's selection). */
  markIn: number | null
  markOut: number | null
  /** Which tab the right-hand panel shows. */
  rightTab: 'clip' | 'captions' | 'ai'
  /** "Ask about this frame": the moment and area the user pointed at (+ the frame, as an image). */
  focus: (Focus & { image?: string }) | null
  /** A request for the AI tab to run (e.g. "Generate edit" from the mode panel). */
  /** Generate request from the mode panel; `scope` limits it to a marked part. */
  aiRequest: { kind: 'generate'; scope?: { start: number; end: number } | null } | null

  open(p: OpenedProject): void
  close(): void
  /**
   * Applies one or more edit ops as a single undo step. Returns false if the edit was rejected.
   * Edits with the same `coalesce` key in quick succession (e.g. dragging a slider) merge into one step.
   */
  dispatch(ops: EditOp | EditOp[], opts?: { coalesce?: string }): boolean
  undo(): void
  redo(): void
  setPlayhead(t: number): void
  selectClips(ids: string[]): void
  selectMedia(id: string | null): void
  showToast(msg: string | null): void
  setRecording(on: boolean): void
  setViewerMode(mode: 'program' | 'source'): void
  setTool(tool: 'select' | 'razor'): void
  setMarks(markIn: number | null, markOut: number | null): void
  setRightTab(tab: 'clip' | 'captions' | 'ai'): void
  setFocus(focus: (Focus & { image?: string }) | null): void
  requestAi(req: { kind: 'generate'; scope?: { start: number; end: number } | null } | null): void
  /** The marked range, ordered, or null if not both marks are set. */
  markedRange(): { start: number; end: number } | null
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let lastCoalesce: { key: string; at: number } | null = null
const COALESCE_MS = 1500

export const useStudio = create<StudioState>((set, get) => {
  const scheduleSave = (): void => {
    set({ saving: 'pending' })
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const { projectPath, project } = get()
      if (!projectPath || !project) return
      try {
        await window.studio.projects.save(projectPath, project)
        set({ saving: 'saved' })
      } catch (e) {
        set({ saving: 'error', toast: `Save failed: ${(e as Error).message}` })
      }
    }, SAVE_DELAY_MS)
  }

  const commit = (next: Project, coalesce?: string): void => {
    const { project, past } = get()
    if (!project || next === project) return
    const now = Date.now()
    const merge = coalesce && lastCoalesce?.key === coalesce && now - lastCoalesce.at < COALESCE_MS && past.length
    lastCoalesce = coalesce ? { key: coalesce, at: now } : null
    // Merged edits keep the undo point from before the first one.
    set({ project: next, past: merge ? past : [...past, project].slice(-HISTORY_LIMIT), future: [] })
    scheduleSave()
  }

  return {
    projectPath: null,
    project: null,
    past: [],
    future: [],
    saving: 'saved',
    playhead: 0,
    selectedClipIds: [],
    selectedMediaId: null,
    toast: null,
    recording: false,
    viewerMode: 'program',
    tool: 'select',
    markIn: null,
    markOut: null,
    rightTab: window.studio?.dev?.mode === 'demo' ? 'ai' : 'clip',
    focus: null,
    aiRequest: null,

    open: ({ path, project }) =>
      set({ projectPath: path, project, past: [], future: [], playhead: 0, selectedClipIds: [], selectedMediaId: null, markIn: null, markOut: null, tool: 'select', focus: null }),
    close: () => set({ projectPath: null, project: null, past: [], future: [] }),

    dispatch(ops, opts) {
      const { project } = get()
      if (!project) return false
      try {
        commit(applyOps(project, Array.isArray(ops) ? ops : [ops]), opts?.coalesce)
        return true
      } catch (e) {
        set({ toast: (e as Error).message })
        return false
      }
    },

    undo() {
      lastCoalesce = null
      const { past, project, future } = get()
      if (!past.length || !project) return
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] })
      scheduleSave()
    },
    redo() {
      const { past, project, future } = get()
      if (!future.length || !project) return
      set({ project: future[0], past: [...past, project], future: future.slice(1) })
      scheduleSave()
    },

    setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
    selectClips: (ids) => set({ selectedClipIds: ids }),
    selectMedia: (id) => set({ selectedMediaId: id }),
    showToast: (toast) => set({ toast }),
    setRecording: (recording) => set({ recording }),
    setViewerMode: (viewerMode) => set({ viewerMode }),
    setTool: (tool) => set({ tool }),
    setMarks: (markIn, markOut) => set({ markIn, markOut }),
    setRightTab: (rightTab) => set({ rightTab }),
    setFocus: (focus) => set({ focus }),
    requestAi: (aiRequest) => set({ aiRequest }),
    markedRange() {
      const { markIn, markOut } = get()
      if (markIn === null || markOut === null || Math.abs(markOut - markIn) < 1e-3) return null
      return { start: Math.min(markIn, markOut), end: Math.max(markIn, markOut) }
    }
  }
})
