import { useEffect, useMemo, useRef, useState } from 'react'
import { fillerRanges, pauseRanges, timelineWords, wordDeleteRange, type TimelineWord } from '@shared/captions'
import type { EditOp } from '@shared/ops'
import type { MediaItem } from '@shared/project'
import { TRANSCRIPTION_USD_PER_MIN } from '@shared/ai'
import { useStudio } from '../store'
import { formatTime } from '../time'

type Job = { done: number; total: number } | { error: string }

/** Ripple-deletes ranges latest-first, so earlier ranges keep their positions. One undo step. */
function cutRanges(ranges: [number, number][]): boolean {
  const ops: EditOp[] = [...ranges].sort((a, b) => b[0] - a[0]).map(([start, end]) => ({ op: 'rippleDeleteRange', start, end }))
  return ops.length > 0 && useStudio.getState().dispatch(ops)
}

/** Index of the word being spoken at t (or -1). */
function wordAt(words: TimelineWord[], t: number): number {
  let lo = 0
  let hi = words.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t < words[mid].start) hi = mid - 1
    else if (t >= (words[mid + 1]?.start ?? words[mid].end + 0.5)) lo = mid + 1
    else return mid
  }
  return -1
}

export function TranscriptPanel({ onOpenSettings }: { onOpenSettings(): void }) {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const words = useMemo(() => timelineWords(project), [project])
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  const [sel, setSel] = useState<[number, number] | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.studio.ai.status().then((s) => setHasKey(!!s.providers.find((p) => p.id === s.settings.transcription.provider)?.configured))
    return window.studio.ai.onProgress((p) => setJobs((j) => ({ ...j, [p.mediaId]: { done: p.done, total: p.total } })))
  }, [])

  // Media with sound that is actually used on the timeline.
  const candidates = useMemo(() => {
    const used = new Set(project.tracks.flatMap((t) => t.clips.filter((c) => !c.muted).map((c) => c.mediaId)))
    return project.media.filter((m) => used.has(m.id) && m.kind !== 'image' && m.hasAudio)
  }, [project])

  const transcribe = async (m: MediaItem): Promise<void> => {
    setJobs((j) => ({ ...j, [m.id]: { done: 0, total: 1 } }))
    try {
      const transcript = await window.studio.ai.transcribe(projectPath, m)
      useStudio.getState().dispatch({ op: 'setTranscript', mediaId: m.id, transcript })
      setJobs(({ [m.id]: _, ...rest }) => rest)
    } catch (e) {
      setJobs((j) => ({ ...j, [m.id]: { error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } }))
    }
  }

  // Highlight the spoken word without re-rendering thousands of spans every frame.
  useEffect(() => {
    let last = -1
    const update = (t: number): void => {
      const i = wordAt(words, t)
      if (i === last) return
      boxRef.current?.querySelector(`[data-i="${last}"]`)?.classList.remove('bg-accent/40')
      const el = boxRef.current?.querySelector(`[data-i="${i}"]`)
      el?.classList.add('bg-accent/40')
      if (el && useStudio.getState().viewerMode === 'program') el.scrollIntoView({ block: 'nearest' })
      last = i
    }
    update(useStudio.getState().playhead)
    return useStudio.subscribe((s) => update(s.playhead))
  }, [words])

  const deleteSelection = (): void => {
    if (!sel) return
    if (cutRanges([wordDeleteRange(words, sel[0], sel[1])])) setSel(null)
  }

  const fillers = useMemo(() => fillerRanges(words), [words])
  const pauses = useMemo(() => pauseRanges(words, 1, 0.35), [words])
  const pauseSeconds = pauses.reduce((n, [a, b]) => n + b - a, 0)
  const [lo, hi] = sel ? [Math.min(...sel), Math.max(...sel)] : [-1, -1]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-line p-2">
        {!hasKey && (
          <div className="rounded bg-yellow-500/10 p-2 text-xs text-yellow-300">
            Add an API key to transcribe. <button className="underline" onClick={onOpenSettings}>Open Settings → AI</button>
          </div>
        )}
        {candidates.length === 0 && <p className="p-2 text-xs text-muted">Put a clip with sound on the timeline to transcribe it.</p>}
        {candidates.map((m) => {
          const job = jobs[m.id]
          const done = project.transcripts[m.id]
          return (
            <div key={m.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate" title={m.name}>{m.name}</span>
              {job && 'total' in job ? (
                <span className="text-yellow-400">Transcribing… {job.total > 1 ? `${job.done}/${job.total}` : ''}</span>
              ) : (
                <>
                  {done && <span className="text-audio" title={`${done.model}, ${done.language ?? ''}`}>✓ {done.words.length} words</span>}
                  <button
                    className="rounded bg-panel-2 px-2 py-0.5 hover:bg-line disabled:opacity-40"
                    disabled={!hasKey}
                    title={`About $${Math.max(0.01, (m.duration / 60) * TRANSCRIPTION_USD_PER_MIN).toFixed(2)} (${formatTime(m.duration)} of audio)`}
                    onClick={() => transcribe(m)}
                  >
                    {done ? 'Redo' : 'Transcribe'}
                  </button>
                </>
              )}
              {job && 'error' in job && <span className="basis-full text-danger">{job.error}</span>}
            </div>
          )
        })}
      </div>

      {words.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-line p-2 text-xs">
          <button className="rounded bg-panel-2 px-2 py-1 hover:bg-line disabled:opacity-40" disabled={!fillers.length} onClick={() => cutRanges(fillers)}>
            ✂ Remove {fillers.length} filler words
          </button>
          <button className="rounded bg-panel-2 px-2 py-1 hover:bg-line disabled:opacity-40" disabled={!pauses.length} onClick={() => cutRanges(pauses)}>
            ✂ Shorten {pauses.length} long pauses (−{pauseSeconds.toFixed(1)} s)
          </button>
          {sel && (
            <button className="rounded bg-danger px-2 py-1 text-white" onClick={deleteSelection}>
              Delete {hi - lo + 1} words from video
            </button>
          )}
        </div>
      )}

      <div
        ref={boxRef}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto p-3 leading-7 outline-none"
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && sel && editing === null) {
            e.preventDefault()
            e.stopPropagation()
            deleteSelection()
          } else if (e.key === 'Escape') setSel(null)
        }}
      >
        {words.length === 0 && candidates.length > 0 && <p className="text-xs text-muted">Transcribe a clip to see its words here. Click a word to jump to it; select words and press Delete to cut them from the video.</p>}
        {words.map((w, i) => {
          const gapBefore = i > 0 && w.start - words[i - 1].end > 1
          return (
            <span key={`${w.clipId}-${w.index}`}>
              {gapBefore && <span className="mx-0.5 rounded bg-panel-2 px-1 text-[10px] text-muted">⏸ {(w.start - words[i - 1].end).toFixed(1)}s</span>}
              {editing === i ? (
                <input
                  autoFocus
                  defaultValue={w.text}
                  className="w-24 rounded bg-panel-2 px-1"
                  onBlur={(e) => {
                    const text = e.target.value.trim()
                    if (text && text !== w.text) useStudio.getState().dispatch({ op: 'editWord', mediaId: w.mediaId, index: w.index, text })
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <span
                  data-i={i}
                  className={`cursor-pointer rounded px-0.5 hover:bg-line ${i >= lo && i <= hi ? 'bg-danger/40' : ''}`}
                  onClick={(e) => {
                    setSel(e.shiftKey && sel ? [sel[0], i] : [i, i])
                    const s = useStudio.getState()
                    s.setViewerMode('program')
                    s.setPlayhead(w.start)
                    boxRef.current?.focus()
                  }}
                  onDoubleClick={() => setEditing(i)}
                  title="Click: jump here · Shift+click: select a range · Double-click: fix the text"
                >
                  {w.text}
                </span>
              )}{' '}
            </span>
          )
        })}
      </div>
    </div>
  )
}
