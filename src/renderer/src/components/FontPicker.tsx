import { useEffect, useMemo, useRef, useState } from 'react'
import { FONT_CATEGORIES, SYSTEM_FONTS, type FontInfo } from '@shared/fonts'
import { fontCatalog, loadFont, previewFamily } from '../fonts'
import { useStudio } from '../store'

type Filter = 'All' | 'Installed' | (typeof FONT_CATEGORIES)[number]
const FILTERS: [Filter, string][] = [['All', 'All'], ['Sans Serif', 'Sans'], ['Serif', 'Serif'], ['Display', 'Display'], ['Handwriting', 'Hand'], ['Monospace', 'Mono'], ['Installed', 'Windows']]
const PAGE = 60

/**
 * Searchable font menu: every Google Fonts family (downloaded when picked) plus installed Windows
 * fonts. `value` undefined = the default (e.g. the theme font), offered when `defaultLabel` is set.
 */
export function FontPicker(props: { value?: string; onChange(family: string | undefined): void; defaultLabel?: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  const pick = async (family: string | undefined): Promise<void> => {
    setOpen(false)
    if (family) {
      setBusy(family)
      try {
        await loadFont(family)
      } catch {
        return useStudio.getState().showToast(`Could not download ${family}. Check your internet connection.`)
      } finally {
        setBusy(null)
      }
    }
    props.onChange(family)
  }

  const label = props.value ?? props.defaultLabel ?? 'Choose a font'
  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <button
        className="flex w-full items-center gap-2 rounded border border-line bg-panel-2 px-2 py-1 text-left text-sm hover:border-accent"
        onClick={() => setOpen(!open)}
        title="Choose a font (all Google Fonts + Windows fonts)"
      >
        <span className="min-w-0 flex-1 truncate" style={{ fontFamily: props.value ? `"${props.value}", "Segoe UI"` : undefined }}>
          {busy ? `Downloading ${busy}…` : label}
        </span>
        <span className="text-xs text-muted">▾</span>
      </button>
      {open && <FontMenu value={props.value} defaultLabel={props.defaultLabel} onPick={pick} onClose={() => setOpen(false)} />}
    </div>
  )
}

function FontMenu(props: { value?: string; defaultLabel?: string; onPick(family: string | undefined): void; onClose(): void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('All')
  const [fonts, setFonts] = useState<FontInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    fontCatalog().then(setFonts, (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }, [])
  useEffect(() => setShown(PAGE), [query, filter])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (name: string): boolean => !q || name.toLowerCase().includes(q)
    const system = filter === 'All' || filter === 'Installed' ? SYSTEM_FONTS.filter(match).map((f) => ({ family: f, google: false, category: 'Windows' })) : []
    const google =
      filter === 'Installed'
        ? []
        : (fonts ?? [])
            .filter((f) => (filter === 'All' || f.category === filter) && match(f.family))
            .map((f) => ({ family: f.family, google: true, category: f.category }))
    // Names that start with the query first; otherwise Windows fonts, then Google by popularity (stable sort).
    const starts = (name: string): number => Number(!(q && name.toLowerCase().startsWith(q)))
    return [...system, ...google].sort((a, b) => (q ? starts(a.family) - starts(b.family) : 0))
  }, [fonts, query, filter])

  return (
    <div className="absolute top-full right-0 left-0 z-50 mt-1 flex max-h-96 flex-col rounded border border-line bg-panel shadow-xl">
      <div className="space-y-1 border-b border-line p-1.5">
        <input
          autoFocus
          className="w-full rounded border border-line bg-panel-2 px-2 py-1 text-sm outline-none focus:border-accent"
          placeholder={fonts ? `Search ${fonts.length + SYSTEM_FONTS.length} fonts…` : 'Search fonts…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') props.onClose()
            if (e.key === 'Enter' && rows[0]) props.onPick(rows[0].family)
          }}
        />
        <div className="flex flex-wrap gap-0.5">
          {FILTERS.map(([f, l]) => (
            <button key={f} className={`rounded px-1.5 py-0.5 text-[11px] ${filter === f ? 'bg-accent text-white' : 'text-muted hover:bg-panel-2 hover:text-text'}`} onClick={() => setFilter(f)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto py-1"
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && shown < rows.length) setShown(shown + PAGE)
        }}
      >
        {props.defaultLabel && !query && (
          <button className={`block w-full px-2 py-1 text-left text-sm hover:bg-panel-2 ${props.value === undefined ? 'text-accent' : ''}`} onClick={() => props.onPick(undefined)}>
            {props.defaultLabel}
          </button>
        )}
        {rows.slice(0, shown).map((r) => (
          <FontRow key={r.family} family={r.family} google={r.google} category={r.category} selected={props.value === r.family} onPick={() => props.onPick(r.family)} />
        ))}
        {!fonts && !error && <p className="px-2 py-1 text-xs text-muted">Loading Google Fonts…</p>}
        {error && <p className="px-2 py-1 text-xs text-yellow-400">Google Fonts unavailable ({error}). Windows fonts still work.</p>}
        {fonts && rows.length === 0 && <p className="px-2 py-1 text-xs text-muted">No font matches “{query}”.</p>}
      </div>
    </div>
  )
}

/** A font name drawn in its own font once it scrolls into view. */
function FontRow(props: { family: string; google: boolean; category: string; selected: boolean; onPick(): void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [face, setFace] = useState<string | undefined>(props.google ? undefined : `"${props.family}"`)

  useEffect(() => {
    if (!props.google || face) return
    const el = ref.current!
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      void previewFamily(props.family).then(setFace)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [props.family, props.google, face])

  return (
    <button ref={ref} className={`flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-panel-2 ${props.selected ? 'bg-panel-2 text-accent' : ''}`} onClick={props.onPick}>
      <span className="min-w-0 flex-1 truncate text-base" style={{ fontFamily: face }}>{props.family}</span>
      <span className="shrink-0 text-[10px] text-muted">{props.category}</span>
    </button>
  )
}
