import { useState } from 'react'
import { fmt } from '@shared/assistant'
import { useStudio } from '../store'
import { applyProposal, suggestionNumbers, useChat } from '../ai-chat'
import { ProposalCard } from './AssistantPanel'

/**
 * Things to bring back: AI suggestions from the chat (numbered like in the chat, apply / discard /
 * bring back any of them) and everything that was deleted from the timeline.
 */
export function BinPanel() {
  const [tab, setTab] = useState<'suggestions' | 'deleted'>('suggestions')
  const pending = useChat((s) => s.turns.filter((t) => t.proposal && t.state === 'pending').length)
  const deleted = useStudio((s) => s.project!.trash.length)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-line p-1.5 text-xs">
        {(
          [
            ['suggestions', `💡 AI suggestions${pending ? ` (${pending})` : ''}`],
            ['deleted', `🗑 Deleted${deleted ? ` (${deleted})` : ''}`]
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`flex-1 rounded px-2 py-1 ${tab === k ? 'bg-accent text-white' : 'text-muted hover:text-text'}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">{tab === 'suggestions' ? <Suggestions /> : <Deleted />}</div>
    </div>
  )
}

function Suggestions() {
  const turns = useChat((s) => s.turns)
  const update = useChat((s) => s.update)
  const [filter, setFilter] = useState<'all' | 'pending'>('all')
  const numbers = suggestionNumbers(turns)
  const list = [...numbers.entries()].filter(([i]) => filter === 'all' || turns[i].state === 'pending').reverse()

  if (!numbers.size) return <p className="text-xs text-muted">Edits the AI proposes in the ✨ AI tab show up here as Suggestion 1, 2, … so you can apply or bring them back later.</p>
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span>Newest first</span>
        <select className="ml-auto rounded border border-line bg-panel-2 px-1 py-0.5" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'pending')}>
          <option value="all">All</option>
          <option value="pending">Not applied yet</option>
        </select>
      </div>
      {list.length === 0 && <p className="text-xs text-muted">Nothing waiting.</p>}
      {list.map(([i, n]) => {
        // The request this suggestion answered (the closest user turn before it).
        const ask = [...turns.slice(0, i)].reverse().find((t) => t.role === 'user')
        return (
          <div key={i} className="space-y-1">
            {ask && <p className="truncate text-[11px] text-muted" title={ask.text}>↳ {ask.text}</p>}
            <ProposalCard
              turn={turns[i]}
              number={n}
              onPick={(picked) => update(i, { picked })}
              onApply={() => applyProposal(i)}
              onDiscard={() => update(i, { state: 'discarded' })}
              onReopen={() => update(i, { state: 'pending' })}
            />
          </div>
        )
      })}
    </div>
  )
}

function Deleted() {
  const trash = useStudio((s) => s.project!.trash)
  const media = useStudio((s) => s.project!.media)
  const dispatch = useStudio((s) => s.dispatch)
  const thumbOf = (mediaId: string): string | undefined => media.find((m) => m.id === mediaId)?.thumbnail

  const restore = (entryId: string, at?: number): void => {
    if (dispatch({ op: 'restoreTrash', entryId, at })) useStudio.getState().showToast('Put back. Ctrl+Z to undo.')
  }

  if (!trash.length) return <p className="text-xs text-muted">Deleted clips and cut-out parts (yours or the AI’s) are kept here so you can put them back.</p>
  return (
    <div className="space-y-2">
      <div className="flex items-center text-[11px] text-muted">
        <span>Newest first · kept with the project</span>
        <button className="ml-auto hover:text-danger" onClick={() => confirm('Forget every deleted item? This cannot be put back.') && dispatch({ op: 'removeTrash', entryIds: trash.map((e) => e.id) })}>
          Empty
        </button>
      </div>
      {[...trash].reverse().map((e) => {
        const thumb = e.clips.map((c) => thumbOf(c.clip.mediaId)).find(Boolean)
        return (
          <div key={e.id} className="space-y-1.5 rounded border border-line bg-panel-2 p-2 text-xs">
            <div className="flex items-start gap-2">
              {thumb && <MediaThumb rel={thumb} />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold" title={e.label}>{e.label}</div>
                <div className="text-[11px] text-muted">
                  {fmt(e.start)}–{fmt(e.end)} · {(e.end - e.start).toFixed(1)} s{e.gap !== 'none' ? ' · gap was closed' : ''} · {timeAgo(e.time)}
                </div>
              </div>
              <button className="text-muted hover:text-danger" title="Forget this item" onClick={() => dispatch({ op: 'removeTrash', entryIds: [e.id] })}>
                ✕
              </button>
            </div>
            <div className="flex gap-1.5">
              <button className="rounded bg-accent px-2 py-0.5 text-white" title={e.gap !== 'none' ? 'Put it back where it was and re-open the gap' : 'Put it back where it was'} onClick={() => restore(e.id)}>
                ↩ Restore
              </button>
              <button className="rounded border border-line px-2 py-0.5 hover:border-accent" title="Put it back starting at the playhead" onClick={() => restore(e.id, useStudio.getState().playhead)}>
                At playhead
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MediaThumb({ rel }: { rel: string }) {
  const projectPath = useStudio((s) => s.projectPath)!
  return <img className="h-9 w-16 shrink-0 rounded object-cover" src={window.studio.media.url(projectPath, rel)} />
}

function timeAgo(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!(s >= 0)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}
