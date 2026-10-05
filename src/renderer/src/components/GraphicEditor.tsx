import { GRAPHIC_TEMPLATES, TEMPLATE_INFO, type Graphic, type ListItem } from '@shared/graphics'
import type { Rect } from '@shared/scene'
import { useStudio } from '../store'
import { FontPicker } from './FontPicker'

/** Edits a text/card layer. Every change is an undoable op on the clip's media. */
export function GraphicEditor({ mediaId, clipId, graphic }: { mediaId: string; clipId: string; graphic: Graphic }) {
  const set = (patch: Partial<Graphic>, key: string): void => {
    useStudio.getState().dispatch({ op: 'updateMedia', mediaId, clipId, patch: { graphic: patch } }, { coalesce: `graphic:${clipId}:${key}` })
  }
  const g = graphic
  const themeFont = useStudio((s) => s.project!.theme.font)
  const has = (...fields: (keyof Graphic)[]): boolean => fields.some((f) => fieldsFor(g.template).includes(f))

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Text layer</h3>
        <select className="ml-auto rounded border border-line bg-panel-2 px-1 py-0.5 text-xs" value={g.template} onChange={(e) => set({ template: e.target.value as Graphic['template'] }, 'template')}>
          {GRAPHIC_TEMPLATES.map((t) => (
            <option key={t} value={t}>{TEMPLATE_INFO[t].name}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-muted">Font</span>
        <FontPicker value={g.font} defaultLabel={`Theme font (${themeFont})`} onChange={(font) => set({ font }, 'font')} />
      </div>

      {has('kicker') && <Field label="Label" value={g.kicker} onChange={(v) => set({ kicker: v }, 'kicker')} />}
      {has('title') && <Field label={g.template === 'badge' ? 'Text' : 'Title'} value={g.title} multiline={g.template !== 'badge'} onChange={(v) => set({ title: v }, 'title')} />}
      {has('value') && <Field label="Value" value={g.value} onChange={(v) => set({ value: v }, 'value')} />}
      {has('body') && <Field label={g.template === 'stat' ? 'Label' : 'Text'} value={g.body} multiline onChange={(v) => set({ body: v }, 'body')} />}
      {has('subtitle') && <Field label="Subtitle" value={g.subtitle} onChange={(v) => set({ subtitle: v }, 'subtitle')} />}
      {has('items') && (
        <Field
          label="Items"
          multiline
          rows={5}
          hint="One per line. Start with [x] for done, [ ] for to-do; add @3.5 to appear 3.5 s in."
          value={(g.items ?? []).map(itemToLine).join('\n')}
          onChange={(v) => set({ items: v.split('\n').filter((l) => l.trim()).map(lineToItem) }, 'items')}
        />
      )}
      {has('code') && (
        <>
          <Field label="File" value={g.filename} onChange={(v) => set({ filename: v }, 'filename')} />
          <Field label="Code" value={g.code} multiline rows={7} mono hint='Lines starting with "+ " / "- " show as added / removed.' onChange={(v) => set({ code: v }, 'code')} />
          <Field
            label="Highlight"
            hint="Line numbers, e.g. 3, 5-6 (add @2 to turn on 2 s in)"
            value={(g.highlights ?? []).map((h) => `${compactLines(h.lines)}${h.at !== undefined ? `@${h.at}` : ''}`).join('; ')}
            onChange={(v) => set({ highlights: parseHighlights(v) }, 'highlights')}
          />
        </>
      )}
      {has('tag') && <Field label="Tag" value={g.tag} onChange={(v) => set({ tag: v }, 'tag')} />}

      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-muted">Place</span>
        <PlaceGrid box={g.box} onPick={(box) => set({ box }, 'box')} />
        <div className="flex flex-1 flex-col gap-1">
          <Seg value={g.align} options={[['left', '⟸'], ['center', '≡'], ['right', '⟹']]} onChange={(v) => set({ align: v as Graphic['align'] }, 'align')} />
          <label className="flex items-center gap-1 text-xs text-muted">
            Size
            <input type="range" className="min-w-0 flex-1 accent-[#6d8cff]" min={0.5} max={2.5} step={0.05} value={g.size} onChange={(e) => set({ size: Number(e.target.value) }, 'size')} />
          </label>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-muted">Enter</span>
        <Seg value={g.enter} options={[['none', 'Cut'], ['fade', 'Fade'], ['rise', 'Rise'], ['pop', 'Pop'], ['type', 'Type']]} onChange={(v) => set({ enter: v as Graphic['enter'] }, 'enter')} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <label className="flex items-center gap-1"><input type="checkbox" checked={g.panel} onChange={(e) => set({ panel: e.target.checked }, 'panel')} /> Card behind</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={g.scrim} onChange={(e) => set({ scrim: e.target.checked }, 'scrim')} /> Darken video behind</label>
        <label className="flex items-center gap-1">
          <input type="color" className="h-5 w-6" value={g.accent ?? useStudio.getState().project!.theme.accent} onChange={(e) => set({ accent: e.target.value }, 'accent')} /> accent
        </label>
      </div>
    </section>
  )
}

/** Which content fields each template uses. */
function fieldsFor(t: Graphic['template']): (keyof Graphic)[] {
  switch (t) {
    case 'title':
      return ['kicker', 'title', 'subtitle']
    case 'lowerThird':
      return ['title', 'subtitle']
    case 'heading':
      return ['kicker', 'title', 'subtitle']
    case 'text':
      return ['body']
    case 'badge':
      return ['title']
    case 'stat':
      return ['value', 'body']
    case 'list':
      return ['title', 'items']
    case 'code':
      return ['code', 'filename', 'tag', 'highlights']
  }
}

const itemToLine = (i: ListItem): string => `${i.done === true ? '[x] ' : i.done === false ? '[ ] ' : ''}${i.text}${i.at !== undefined ? ` @${i.at}` : ''}`

function lineToItem(line: string): ListItem {
  let text = line.trim()
  let done: boolean | undefined
  if (/^\[x\]\s*/i.test(text)) (done = true), (text = text.replace(/^\[x\]\s*/i, ''))
  else if (/^\[ \]\s*/.test(text)) (done = false), (text = text.replace(/^\[ \]\s*/, ''))
  const at = /\s@(\d+(?:\.\d+)?)$/.exec(text)
  if (at) text = text.slice(0, at.index)
  return { text, done, at: at ? Number(at[1]) : undefined }
}

function compactLines(lines: number[]): string {
  const s = [...lines].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`)
    i = j
  }
  return out.join(', ')
}

function parseHighlights(v: string): Graphic['highlights'] {
  return v
    .split(';')
    .map((part) => {
      const [lines, at] = part.split('@')
      const nums: number[] = []
      for (const r of lines.split(',')) {
        const [a, b] = r.split('-').map((x) => parseInt(x, 10))
        if (Number.isFinite(a)) for (let n = a; n <= (Number.isFinite(b) ? b : a); n++) nums.push(n)
      }
      return { lines: nums, at: at !== undefined && at.trim() ? Number(at) : undefined }
    })
    .filter((h) => h.lines.length)
}

/** 3×3 grid: moves the layer's box to that area of the frame, keeping its size. */
function PlaceGrid({ box, onPick }: { box: Rect; onPick(b: Rect): void }) {
  const cells = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => [c, r] as const))
  const pos = (i: number, size: number): number => [0.05, (1 - size) / 2, 0.95 - size][i]
  return (
    <div className="grid grid-cols-3 gap-0.5 rounded border border-line p-0.5" title="Place the layer on the frame">
      {cells.map(([c, r]) => {
        const target = { ...box, x: Math.max(0, pos(c, box.w)), y: Math.max(0, pos(r, box.h)) }
        const on = Math.abs(target.x - box.x) < 0.02 && Math.abs(target.y - box.y) < 0.02
        return <button key={`${c}${r}`} className={`h-3.5 w-5 rounded-sm ${on ? 'bg-accent' : 'bg-panel-2 hover:bg-line'}`} onClick={() => onPick(target)} />
      })}
    </div>
  )
}

function Field(props: { label: string; value?: string; onChange(v: string): void; multiline?: boolean; rows?: number; mono?: boolean; hint?: string }) {
  const cls = `w-full rounded border border-line bg-panel-2 px-2 py-1 text-sm outline-none focus:border-accent ${props.mono ? 'font-mono text-xs' : ''}`
  return (
    <label className="block space-y-0.5">
      <span className="text-xs text-muted">{props.label}</span>
      {props.multiline ? (
        <textarea className={`${cls} resize-y`} rows={props.rows ?? 2} value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      ) : (
        <input className={cls} value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      )}
      {props.hint && <span className="block text-[10px] text-muted">{props.hint}</span>}
    </label>
  )
}

function Seg(props: { value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <div className="flex flex-1 rounded border border-line p-0.5">
      {props.options.map(([v, l]) => (
        <button key={v} className={`flex-1 rounded px-1 py-0.5 text-xs ${props.value === v ? 'bg-accent text-white' : 'text-muted hover:text-text'}`} onClick={() => props.onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}
