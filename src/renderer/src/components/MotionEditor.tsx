import { useState } from 'react'
import type { MediaItem } from '@shared/project'
import { MOTION_KINDS, type MotionKind } from '@shared/motion'
import { themeAt } from '@shared/sections'
import { useStudio } from '../store'
import { frameMarkup } from '../engine/motion-render'
import { MotionThumb } from './CreatePanel'

/** Clip tab for generated SVG art / animation: preview, change it with a prompt, loop. */
export function MotionEditor({ media, clipId }: { media: MediaItem; clipId?: string }) {
  const m = media.motion!
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const { dispatch, showToast } = useStudio.getState()

  const change = async (): Promise<void> => {
    setBusy(true)
    try {
      const s = useStudio.getState()
      const p = s.project!
      // Guess the kind from the canvas: full-canvas pieces are diagrams/text, small ones icons.
      const kind: MotionKind = m.width === p.settings.width && m.height === p.settings.height ? 'diagram' : MOTION_KINDS[0]
      const r = await window.studio.create.motion({
        prompt,
        kind,
        current: m,
        canvas: { width: p.settings.width, height: p.settings.height },
        theme: themeAt(p, s.playhead)
      })
      frameMarkup(r.motion, r.motion.duration, 64)
      dispatch({ op: 'updateMedia', mediaId: media.id, clipId, patch: { motion: r.motion, name: r.name } })
      setPrompt('')
    } catch (e) {
      showToast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="aspect-video overflow-hidden rounded border border-line bg-[repeating-conic-gradient(#333_0_25%,#222_0_50%)] bg-[length:12px_12px]">
        <MotionThumb media={media} animate />
      </div>
      <textarea
        className="h-16 w-full resize-none rounded border border-line bg-panel-2 px-2 py-1 outline-none focus:border-accent"
        placeholder="Change it with AI, e.g. make it blue, slower, add a third box called Cache"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <button className="w-full rounded bg-accent py-1 font-medium text-white disabled:opacity-50" disabled={busy || !prompt.trim()} onClick={change}>
        {busy ? 'Changing…' : '✨ Change with AI'}
      </button>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span>Animation {m.duration.toFixed(1)} s{m.tracks.length ? '' : ' (still)'}</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={m.loop} onChange={(e) => dispatch({ op: 'updateMedia', mediaId: media.id, clipId, patch: { motion: { ...m, loop: e.target.checked } } })} /> Loop
        </label>
      </div>
      {m.prompt && <p className="line-clamp-3 text-xs text-muted" title={m.prompt}>Asked: {m.prompt}</p>}
    </section>
  )
}

/** Licence/attribution of downloaded music (shown in the Clip tab). */
export function CreditNote({ credit }: { credit: string }) {
  return (
    <div className="space-y-1 rounded border border-line p-2 text-xs">
      <div className="text-muted">Credit (put this in your video description)</div>
      <div className="break-words">{credit}</div>
      <button
        className="text-accent hover:underline"
        onClick={async () => (await navigator.clipboard.writeText(credit), useStudio.getState().showToast('Credit copied'))}
      >
        Copy
      </button>
    </div>
  )
}
