import { useEffect, useState } from 'react'
import type { DisplaySource } from '@shared/api'

/** Modal grid of screens and windows to capture. */
export function SourcePicker(props: { onPick(source: DisplaySource): void; onClose(): void }) {
  const [sources, setSources] = useState<DisplaySource[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.studio.capture.sources().then(setSources, (e) => setError(String(e)))
  }, [])

  const group = (kind: DisplaySource['kind']): DisplaySource[] => (sources ?? []).filter((s) => s.kind === kind)

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onPointerDown={props.onClose}>
      <div className="max-h-[80vh] w-[860px] overflow-auto rounded-lg border border-line bg-panel p-5" onPointerDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Choose what to capture</h2>
          <button className="text-muted hover:text-text" onClick={props.onClose}>✕</button>
        </div>
        {error && <p className="text-danger">{error}</p>}
        {!sources && !error && <p className="text-muted">Looking for screens and windows…</p>}
        {(['screen', 'window'] as const).map((kind) =>
          group(kind).length ? (
            <section key={kind} className="mb-5">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{kind === 'screen' ? 'Screens' : 'Windows'}</h3>
              <div className="grid grid-cols-4 gap-3">
                {group(kind).map((s) => (
                  <button key={s.id} className="overflow-hidden rounded border border-line bg-panel-2 text-left hover:border-accent" onClick={() => props.onPick(s)}>
                    <img src={s.thumbnail} className="aspect-video w-full bg-black object-contain" />
                    <div className="truncate px-2 py-1 text-xs">{s.name}</div>
                  </button>
                ))}
              </div>
            </section>
          ) : null
        )}
      </div>
    </div>
  )
}
