import { useEffect, useState } from 'react'
import { fmt } from '@shared/assistant'
import { describesMood, MODES, modeById, type ModeId } from '@shared/modes'
import { newId } from '@shared/project'
import { sectionFor } from '@shared/sections'
import type { Theme } from '@shared/theme'
import { useStudio } from '../store'

const FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Georgia', 'Verdana', 'Impact', 'Trebuchet MS', 'Cascadia Mono', 'Consolas']

/** Badge colour per mode (timeline bands and the parts list). */
export const MODE_COLOR: Record<ModeId, string> = { explainer: '#6ea8ff', demo: '#3bd38a', happening: '#ffb347' }

/**
 * Video mode (the editing recipe), mood / extra instructions, and "Generate edit" — for the whole
 * video, or, when In/Out are marked, for just that part (its own mode and mood). The look comes
 * from the mood, or the mode's default look if no mood is given.
 */
export function ModePanel() {
  const project = useStudio((s) => s.project)!
  const markIn = useStudio((s) => s.markIn)
  const markOut = useStudio((s) => s.markOut)
  const range = markIn !== null && markOut !== null && Math.abs(markOut - markIn) > 0.05 ? { start: Math.min(markIn, markOut), end: Math.max(markIn, markOut) } : null
  const part = range ? sectionFor(project, range.start, range.end) : undefined
  const hasTranscript = Object.keys(project.transcripts).length > 0

  // A marked range without a part yet: its choices are kept here until "Generate" creates the part.
  const [draft, setDraft] = useState<{ mode: ModeId; mood: string }>({ mode: project.mode, mood: '' })
  const rangeKey = range ? `${range.start.toFixed(2)}-${range.end.toFixed(2)}` : ''
  useEffect(() => setDraft({ mode: project.mode, mood: '' }), [rangeKey])

  const modeId: ModeId = range ? (part?.mode ?? draft.mode) : project.mode
  const mood = range ? (part?.mood ?? draft.mood) : project.extraPrompt
  const mode = modeById(modeId)
  const dispatch = useStudio.getState().dispatch

  const setModeId = (m: ModeId): void => {
    if (!range) dispatch({ op: 'setMode', mode: m })
    else if (part) dispatch({ op: 'updateSection', id: part.id, patch: { mode: m } })
    else setDraft((d) => ({ ...d, mode: m }))
  }
  const setMood = (v: string): void => {
    if (!range) dispatch({ op: 'setMode', extraPrompt: v }, { coalesce: 'extraPrompt' })
    else if (part) dispatch({ op: 'updateSection', id: part.id, patch: { mood: v } }, { coalesce: `mood:${part.id}` })
    else setDraft((d) => ({ ...d, mood: v }))
  }
  const generate = (): void => {
    const s = useStudio.getState()
    if (range && !part) s.dispatch({ op: 'setSection', section: { id: newId(), start: range.start, end: range.end, mode: draft.mode, mood: draft.mood } })
    s.requestAi({ kind: 'generate', scope: range })
    s.setRightTab('ai')
  }

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Video mode</h3>

      {range ? (
        <div className="rounded border border-accent/60 bg-accent/10 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold whitespace-nowrap">🎯 This part only</span>
            <button className="ml-auto whitespace-nowrap text-muted hover:text-text" title="Clear the In/Out marks to work on the whole video" onClick={() => useStudio.getState().setMarks(null, null)}>
              ✕ Whole video
            </button>
          </div>
          <div className="mt-0.5 font-mono">
            {fmt(range.start)} – {fmt(range.end)} <span className="font-sans text-muted">({(range.end - range.start).toFixed(1)} s)</span>
          </div>
          <p className="mt-1 text-[11px] text-muted">
            {part ? 'This part has its own mode and mood. Changes here apply to it only.' : 'Pick a mode and mood for this part, then generate. Nothing outside it is changed.'}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted">
          Whole video. To style just one part, mark In and Out on the timeline (<kbd>I</kbd> / <kbd>O</kbd>) — from a fraction of a second to several minutes.
        </p>
      )}

      <div className="space-y-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setModeId(m.id)}
            className={`block w-full rounded border px-2.5 py-2 text-left ${modeId === m.id ? 'border-accent bg-accent/10' : 'border-line hover:border-muted'}`}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <span className="h-2 w-2 rounded-full" style={{ background: MODE_COLOR[m.id] }} />
              {m.name}
            </span>
            <span className="block text-[11px] text-muted">{m.tagline}</span>
          </button>
        ))}
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted">{range ? 'Mood for this part' : 'Mood & extra instructions'}</span>
        <textarea
          rows={4}
          value={mood}
          placeholder={`e.g. “warm and playful, pastel colours” or “serious and premium”.\nLeave empty to use the ${mode.name} default look: ${mode.defaultLook.description}.`}
          className="w-full resize-y rounded border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
          onChange={(e) => setMood(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="block text-[10px] text-muted">
          {mood.trim() ? (describesMood(mood) ? 'Your mood sets the look (colours, fonts, energy).' : 'No mood described: the mode’s default look is used.') : `Default look: ${mode.defaultLook.description}.`}{' '}
          {range ? 'Saved with this part.' : 'Saved with the project and used by every AI edit.'}
        </span>
      </label>

      <button className="w-full rounded bg-accent px-3 py-2 font-semibold text-white disabled:opacity-40" onClick={generate}>
        ✨ Generate edit {range ? `for this part (${mode.name})` : `(${mode.name})`}
      </button>
      {!hasTranscript && <p className="text-[11px] text-yellow-300">Tip: transcribe your voice first (Transcript tab) — the AI times everything to your words.</p>}
      <p className="text-[11px] text-muted">The AI proposes the edit for you to review. Then use “Feedback” in the AI tab to fix anything.</p>

      <PartsList />

      {(!range || part) && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">Adjust the look by hand{part ? ' (this part)' : ''}</summary>
          <LookControls sectionId={part?.id} />
        </details>
      )}
    </section>
  )
}

/** Parts of the video that have their own mode and mood. */
function PartsList() {
  const sections = useStudio((s) => s.project!.sections)
  if (!sections.length) return null
  const select = (start: number, end: number): void => {
    const s = useStudio.getState()
    s.setMarks(start, end)
    s.setPlayhead(start)
  }
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Parts with their own style</h4>
      {sections.map((p) => (
        <div key={p.id} className="group flex items-center gap-1.5 rounded border border-line px-2 py-1 text-xs hover:border-muted">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: MODE_COLOR[p.mode] }} />
          <button className="min-w-0 flex-1 truncate text-left" title="Select this part" onClick={() => select(p.start, p.end)}>
            <span className="font-mono">{fmt(p.start)}–{fmt(p.end)}</span> · {modeById(p.mode).name}
            {p.mood.trim() && <span className="text-muted"> · {p.mood.trim()}</span>}
          </button>
          <button
            className="invisible text-muted group-hover:visible hover:text-danger"
            title="Remove this part’s own mode, mood and look (edits already applied stay)"
            onClick={() => useStudio.getState().dispatch({ op: 'removeSection', id: p.id })}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

function LookControls({ sectionId }: { sectionId?: string }) {
  const theme = useStudio((s) => s.project!.sections.find((x) => x.id === sectionId)?.theme ?? s.project!.theme)
  const set = (patch: Partial<Theme>, key: string): void => {
    useStudio.getState().dispatch({ op: 'setTheme', patch, sectionId }, { coalesce: `theme:${sectionId ?? ''}:${key}` })
  }
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
      <label className="col-span-2 flex items-center gap-2">
        <span className="w-12 text-muted">Font</span>
        <select className="flex-1 rounded border border-line bg-panel-2 px-1 py-0.5" value={theme.font} onChange={(e) => set({ font: e.target.value }, 'font')}>
          {[...new Set([theme.font, ...FONTS])].map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
      </label>
      {(
        [
          ['text', 'Text'],
          ['muted', 'Muted'],
          ['accent', 'Accent'],
          ['accent2', 'Accent 2'],
          ['panel', 'Cards'],
          ['background', 'Background']
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="flex items-center gap-1.5">
          <input type="color" className="h-5 w-6" value={theme[k]} onChange={(e) => set({ [k]: e.target.value }, k)} />
          <span className="text-muted">{label}</span>
        </label>
      ))}
    </div>
  )
}
