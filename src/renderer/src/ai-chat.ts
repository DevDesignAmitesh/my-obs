import { useEffect } from 'react'
import { create } from 'zustand'
import { expandEdits, validateEdits, type ChatTurn } from '@shared/assistant'
import { rippleSections } from '@shared/sections'
import type { Project } from '@shared/project'
import { useStudio } from './store'

/**
 * The assistant chat of the open project. It lives outside the AI tab so its proposals can also be
 * managed from the Bin panel ("Suggestion 1, 2, …").
 */

export interface Turn extends ChatTurn {
  /** The project the proposal was made for (to warn if the timeline changed since). Not saved. */
  basis?: Project
}

interface ChatState {
  turns: Turn[]
  /** True once the saved chat of the open project has been loaded (nothing is saved before that). */
  loaded: boolean
  setTurns(fn: (ts: Turn[]) => Turn[]): void
  update(i: number, patch: Partial<Turn>): void
}

export const useChat = create<ChatState>((set) => ({
  turns: [],
  loaded: false,
  setTurns: (fn) => set((s) => ({ turns: fn(s.turns) })),
  update: (i, patch) => set((s) => ({ turns: s.turns.map((t, j) => (j === i ? { ...t, ...patch } : t)) }))
}))

/** Loads the chat when a project opens and saves it (ai-history.json) whenever it changes. */
export function useChatHistory(projectPath: string, demo?: () => Turn[]): void {
  useEffect(() => {
    useChat.setState({ turns: [], loaded: false })
    if (demo) return useChat.setState({ turns: demo() })
    let alive = true
    window.studio.ai.historyLoad(projectPath).then((saved) => alive && useChat.setState({ turns: saved, loaded: true }))
    return () => {
      alive = false
    }
  }, [projectPath])
  useEffect(
    () =>
      useChat.subscribe((s, prev) => {
        if (!s.loaded || s.turns === prev.turns) return
        window.studio.ai.historySave(projectPath, s.turns.map(({ basis: _basis, ...t }) => t)).catch(() => undefined)
      }),
    [projectPath]
  )
}

/** Suggestion number (1-based) of each turn that carries a proposal. */
export function suggestionNumbers(turns: Turn[]): Map<number, number> {
  const out = new Map<number, number>()
  turns.forEach((t, i) => t.proposal && out.set(i, out.size + 1))
  return out
}

/** Applies the ticked edits of turn i's proposal as one undo step. */
export function applyProposal(i: number): boolean {
  const t = useChat.getState().turns[i]
  if (!t?.proposal) return false
  const edits = t.proposal.edits.filter((_, k) => t.picked?.[k] ?? true)
  const s = useStudio.getState()
  const opts = { scope: t.scope }
  const v = validateEdits(s.project!, edits, opts)
  if (!v.ok) {
    s.showToast(`Can't apply: ${v.error}. The timeline may have changed; ask again.`)
    return false
  }
  const ops = expandEdits(edits, s.project!, opts)
  if (!s.dispatch(ops)) return false
  if (t.scope) {
    // Cuts inside the part make it shorter: keep In/Out on the part.
    let r = t.scope
    for (const op of ops) {
      if (op.op === 'rippleDeleteRange') r = rippleSections([{ id: '', mode: 'demo', mood: '', ...r }], op.start, op.end)[0] ?? r
    }
    s.setMarks(r.start, r.end)
  }
  useChat.getState().update(i, { state: 'applied' })
  s.showToast('Applied. Press Ctrl+Z to undo.')
  return true
}
