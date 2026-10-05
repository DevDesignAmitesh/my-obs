import { useEffect, useRef, useState } from 'react'
import { describeEdit, fmt, validateEdits, type Selection } from '@shared/assistant'
import { sectionFor } from '@shared/sections'
import { providerInfo, type AiSettings } from '@shared/ai'
import { projectDuration, type Project } from '@shared/project'
import { activePlayer } from '../engine/player'
import { useStudio } from '../store'
import { buildModeRequest, modeById } from '@shared/modes'
import { applyProposal, suggestionNumbers, useChat, type Turn } from '../ai-chat'

const SUGGESTIONS = [
  'Remove mistakes and repeated takes (keep the best take)',
  'Cut silences longer than 1 second',
  'Remove filler words like um and uh',
  'Make the captions bold, yellow and a bit bigger',
  'Add a 1 second fade in at the start and fade out at the end',
  'Lower the music while I am talking'
]

/** "Ask AI to edit": chat with the assistant; its proposals are reviewed here before applying. */
export function AssistantPanel({ onOpenSettings }: { onOpenSettings(): void }) {
  const project = useStudio((s) => s.project)!
  const markIn = useStudio((s) => s.markIn)
  const markOut = useStudio((s) => s.markOut)
  const focus = useStudio((s) => s.focus)
  const [ai, setAi] = useState<{ settings: AiSettings; hasKey: boolean } | null>(null)
  const turns = useChat((s) => s.turns)
  const loaded = useChat((s) => s.loaded)
  const { setTurns: updateTurns, update } = useChat.getState()
  const setTurns = (v: Turn[] | ((ts: Turn[]) => Turn[])): void => updateTurns(typeof v === 'function' ? v : () => v)
  const [input, setInput] = useState('')
  const [withFrame, setWithFrame] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [kind, setKind] = useState<'ask' | 'feedback'>('ask')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.studio.ai.status().then((s) => setAi({ settings: s.settings, hasKey: !!s.providers.find((p) => p.id === s.settings.assistant.provider)?.configured }))
    return window.studio.ai.onAssistStatus(setStatus)
  }, [])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, status])

  const range = useStudio.getState().markedRange()
  const ready = ai?.hasKey && ai.settings.assistant.model

  /**
   * ask: a direct instruction · feedback: an AI first works out what the user means and writes a
   * precise instruction, which then goes to the editor · generate: the whole-video mode recipe.
   */
  const send = async (text: string, k: 'ask' | 'feedback' | 'generate' = kind, generateScope?: Selection | null): Promise<void> => {
    const raw = text.trim()
    if ((k !== 'generate' && !raw) || status) return
    setInput('')
    const s = useStudio.getState()
    // A marked part limits every kind of request to that part (enforced when checking the edits).
    const scope = k === 'generate' && generateScope !== undefined ? generateScope : s.markedRange()
    const history = turns.filter((t) => !t.error).slice(-8).map((t) => ({ role: t.role, content: t.text || t.proposal?.summary || '' }))
    const now = (): string => new Date().toISOString()
    const pointed = s.focus
    const focusArg = pointed ? { time: pointed.time, box: pointed.box } : null
    const p0 = s.project!
    const part = scope ? sectionFor(p0, scope.start, scope.end) : undefined
    const genMode = part?.mode ?? p0.mode
    const genMood = (part ? part.mood : p0.extraPrompt).trim()
    const where = scope ? `${fmt(scope.start)}–${fmt(scope.end)} · ` : ''
    const shown =
      k === 'generate'
        ? `✨ Generate edit — ${where}${modeById(genMode).name} mode${genMood ? ` · “${genMood}”` : ''}`
        : `${k === 'feedback' ? '💬 ' : ''}${scope ? `🎯 ${where}` : ''}${pointed ? `📍 ${fmt(pointed.time)}${pointed.box ? ' (area)' : ''} · ` : ''}${raw}`
    setTurns((ts) => [...ts, { role: 'user', text: shown, time: now(), scope, kind: k }])
    try {
      let prompt = raw
      if (k === 'generate') prompt = buildModeRequest(genMode, genMood, { scope, project: p0, standing: part ? p0.extraPrompt : '' })
      if (k === 'feedback') {
        setStatus('Understanding your feedback…')
        const refined = await window.studio.ai.refine({
          project: p0,
          feedback: raw,
          history: turns.filter((t) => !t.error).slice(-8).map((t) => ({ role: t.role, text: t.text })),
          focus: focusArg,
          selection: scope,
          playhead: s.playhead
        })
        if (refined.remember) {
          // A lasting preference: keep it with the part's mood, or the project's standing instructions.
          const dispatch = useStudio.getState().dispatch
          if (part) dispatch({ op: 'updateSection', id: part.id, patch: { mood: [part.mood.trim(), refined.remember].filter(Boolean).join('\n') } })
          else dispatch({ op: 'setMode', extraPrompt: [p0.extraPrompt.trim(), refined.remember].filter(Boolean).join('\n') })
        }
        setTurns((ts) => [
          ...ts,
          {
            role: 'assistant',
            text: `🎯 Understood: ${refined.intent || raw}\n→ ${refined.instruction}${refined.remember ? `\n📌 Remembered for this ${part ? "part" : "project"}: ${refined.remember}` : ''}`,
            time: now(),
            refined,
            provider: ai?.settings.assistant.provider,
            model: ai?.settings.assistant.model
          }
        ])
        prompt = `${refined.instruction}\n\n(The user's own words: "${raw}")`
      }
      setStatus('Thinking…')
      const basis = useStudio.getState().project!
      // "Ask about this frame" always sends that frame (with the box outlined).
      const images = pointed?.image ? [pointed.image] : withFrame && activePlayer ? [activePlayer.snapshot()] : []
      const r = await window.studio.ai.assist({ project: basis, selection: scope, playhead: s.playhead, prompt, history, images, focus: focusArg })
      setTurns((ts) => [
        ...ts,
        {
          role: 'assistant',
          text: r.reply,
          time: now(),
          provider: ai?.settings.assistant.provider,
          model: ai?.settings.assistant.model,
          proposal: r.proposal ?? undefined,
          scope,
          basis,
          state: r.proposal ? 'pending' : undefined,
          picked: r.proposal?.edits.map(() => true)
        }
      ])
    } catch (e) {
      const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
      setTurns((ts) => [...ts, { role: 'assistant', text: msg, error: true, time: now(), provider: ai?.settings.assistant.provider, model: ai?.settings.assistant.model }])
    }
    setStatus(null)
  }

  const apply = (i: number): void => {
    if (applyProposal(i)) setKind('feedback') // what comes next is usually feedback on the result
  }
  const numbers = suggestionNumbers(turns)

  // "Generate edit" from the mode panel.
  const aiRequest = useStudio((s) => s.aiRequest)
  useEffect(() => {
    if (!aiRequest || !loaded) return
    useStudio.getState().requestAi(null)
    if (!ready) return useStudio.getState().showToast('Set up an AI provider and model in Settings first.')
    void send('', 'generate', aiRequest.scope ?? null)
  }, [aiRequest, ready, loaded])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted">
        {ai && ready ? (
          <span>
            {providerInfo(ai.settings.assistant.provider).name} · <span className="text-text">{ai.settings.assistant.model}</span>
          </span>
        ) : (
          <span className="text-yellow-300">Set up an AI provider and model first.</span>
        )}
        {turns.length > 0 && (
          <button className="ml-auto text-muted hover:text-danger" disabled={!!status} onClick={() => setTurns([])} title="Clears this project's chat history">
            Clear chat
          </button>
        )}
        <button className={`${turns.length ? '' : 'ml-auto '}text-accent hover:underline`} onClick={onOpenSettings}>Change</button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted">
              Start with a whole edit in your video mode, or tell the AI what to change. It proposes edits and you choose what to apply. It uses the
              transcript, so transcribe your voice first.
            </p>
            <button disabled={!ready} className="block w-full rounded bg-accent px-2 py-2 text-left text-sm font-semibold text-white disabled:opacity-40" onClick={() => send('', 'generate')}>
              ✨ Generate edit — {range ? `${fmt(range.start)}–${fmt(range.end)} · ` : ''}{modeById((range && sectionFor(project, range.start, range.end)?.mode) || project.mode).name} mode
            </button>
            {SUGGESTIONS.map((sug) => (
              <button key={sug} disabled={!ready} className="block w-full rounded border border-line px-2 py-1.5 text-left text-xs hover:border-accent disabled:opacity-40" onClick={() => send(sug, 'ask')}>
                {sug}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="ml-6 rounded-lg bg-accent/20 px-3 py-2 text-sm">{t.text}</div>
          ) : (
            <div key={i} className={`mr-2 space-y-2 rounded-lg px-3 py-2 text-sm ${t.error ? 'bg-danger/15 text-danger' : 'bg-panel-2'}`}>
              {t.text && <p className="whitespace-pre-wrap">{t.text}</p>}
              {t.proposal && <ProposalCard turn={t} number={numbers.get(i)} onPick={(picked) => update(i, { picked })} onApply={() => apply(i)} onDiscard={() => update(i, { state: 'discarded' })} onReopen={() => update(i, { state: 'pending' })} />}
            </div>
          )
        )}
        {status && <p className="animate-pulse text-xs text-muted">{status}</p>}
      </div>

      <div className="space-y-1.5 border-t border-line p-2">
        {focus && (
          <div className="flex items-center gap-2 rounded border border-[#ff3ea5]/60 bg-[#ff3ea5]/10 p-1.5 text-xs">
            {focus.image && <img src={focus.image} className="h-10 rounded" />}
            <span className="min-w-0 flex-1">
              📍 Here only: <span className="font-mono">{fmt(focus.time)}</span>
              {focus.box ? ', inside the box you drew' : ', whole frame'}
            </span>
            <button className="text-muted hover:text-text" title="Stop pointing at this frame" onClick={() => useStudio.getState().setFocus(null)}>✕</button>
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="truncate">
            Scope: {range ? <span className="text-accent">only the marked part {fmt(range.start)}–{fmt(range.end)}</span> : markIn !== null || markOut !== null ? 'set both In and Out to limit' : 'whole video (mark In/Out to limit)'}
          </span>
          <label className="ml-auto flex shrink-0 items-center gap-1" title="Sends the current preview frame so the AI can see the video">
            <input type="checkbox" checked={withFrame} onChange={(e) => setWithFrame(e.target.checked)} />
            show frame
          </label>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-line p-0.5 text-xs">
            {(
              [
                ['ask', 'Ask', 'A direct instruction to the editor'],
                ['feedback', 'Feedback', 'Say what you don’t like; an AI first works out the fix, then the editor makes it']
              ] as const
            ).map(([k, label, tip]) => (
              <button key={k} title={tip} className={`rounded px-2 py-0.5 ${kind === k ? 'bg-accent text-white' : 'text-muted hover:text-text'}`} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <span className="truncate text-[10px] text-muted">{kind === 'feedback' ? 'AI understands your intent, then edits' : 'Sent to the editor as written'}</span>
        </div>
        <div className="flex gap-1.5">
          <textarea
            rows={2}
            disabled={!ready}
            value={input}
            placeholder={
              !ready ? 'Add an API key and model in Settings'
              : kind === 'feedback' ? 'e.g. “the middle part feels slow” or “the cards look too plain”'
              : focus ? 'e.g. “Put a title here saying …”'
              : 'e.g. “Cut the part where I restart the sentence”'
            }
            className="min-w-0 flex-1 resize-none rounded border border-line bg-panel-2 px-2 py-1 text-sm outline-none focus:border-accent"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation() // keep editor shortcuts (S, Delete, Space…) out of the text box
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
          />
          <button disabled={!ready || !input.trim() || !!status} className="rounded bg-accent px-3 text-white disabled:opacity-40" onClick={() => send(input)}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProposalCard(props: { turn: Turn; number?: number; onPick(p: boolean[]): void; onApply(): void; onDiscard(): void; onReopen?(): void }) {
  const project = useStudio((s) => s.project)!
  const { proposal, state, picked = [], basis } = props.turn
  if (!proposal) return null
  const chosen = proposal.edits.filter((_, k) => picked[k])
  const v = validateEdits(project, chosen.length ? chosen : proposal.edits, { scope: props.turn.scope })
  const before = projectDuration(project)
  const after = v.ok ? projectDuration(v.after) : before

  return (
    <div className="space-y-2 rounded border border-line bg-bg p-2">
      <div className="text-xs font-semibold">
        {props.number && <span className="mr-1 rounded bg-accent/25 px-1 text-[10px] text-accent">Suggestion {props.number}</span>}
        {proposal.summary || 'Proposed changes'}
      </div>
      <ul className="space-y-1">
        {proposal.edits.map((e, k) => (
          <li key={k} className="flex items-start gap-1.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={state !== 'pending'}
              checked={!!picked[k]}
              onChange={(ev) => props.onPick(picked.map((p, j) => (j === k ? ev.target.checked : p)))}
            />
            <span>{describeEdit(e, basis ?? project)}</span>
          </li>
        ))}
      </ul>
      {Math.abs(after - before) > 0.05 && (
        <p className="text-[11px] text-muted">
          Length: {fmt(before)} → {fmt(after)} ({(after - before).toFixed(1)} s)
        </p>
      )}
      {state === 'pending' && basis && basis !== project && <p className="text-[11px] text-yellow-300">The timeline changed since this was proposed. Review before applying.</p>}
      {state === 'pending' && !v.ok && <p className="text-[11px] text-danger">{v.error}</p>}
      {state === 'pending' ? (
        <div className="flex gap-2">
          <button className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-40" disabled={!chosen.length || !v.ok} onClick={props.onApply}>
            Apply {chosen.length < proposal.edits.length ? `${chosen.length} of ${proposal.edits.length}` : ''}
          </button>
          <button className="rounded px-3 py-1 text-xs text-muted hover:text-text" onClick={props.onDiscard}>
            Discard
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-muted">
          {state === 'applied' ? '✓ Applied (Ctrl+Z to undo)' : 'Discarded'}
          {state === 'discarded' && props.onReopen && (
            <button className="ml-2 text-accent hover:underline" onClick={props.onReopen}>
              Bring back
            </button>
          )}
        </p>
      )}
    </div>
  )
}

/** Dev only (STUDIO_DEV_MODE=demo): a sample exchange for checking the layout without an API key. */
export function demoTurns(project: Project): Turn[] {
  return [
    { role: 'user', text: 'Remove the repeated take and make captions bigger', time: '' },
    {
      role: 'assistant',
      time: '',
      text: 'I found the sentence twice and kept the second take. I also made the captions larger.',
      basis: project,
      state: 'pending',
      picked: [true, true],
      proposal: {
        summary: 'Cut the first take (0:01.2–0:02.6) and enlarge captions',
        edits: [
          { op: 'cutRanges', ranges: [[1.2, 2.6]] },
          { op: 'setCaptionStyle', patch: { size: 7.5 } }
        ]
      }
    }
  ]
}
