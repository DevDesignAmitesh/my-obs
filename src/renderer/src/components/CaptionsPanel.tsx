import { toSrt } from '@shared/captions'
import type { CaptionStyle } from '@shared/project'
import { cuesFor } from '../engine/captions-draw'
import { useStudio } from '../store'
import { FontPicker } from './FontPicker'


const PRESETS: { name: string; style: Partial<CaptionStyle> }[] = [
  { name: 'Bold pop', style: { font: 'Arial Black', size: 6.5, color: '#ffffff', highlightColor: '#ffd400', highlight: 'word', outline: true, background: false, uppercase: true, maxChars: 16, maxLines: 2 } },
  { name: 'Clean', style: { font: 'Segoe UI', size: 4.5, color: '#ffffff', highlight: 'none', outline: true, background: false, uppercase: false, maxChars: 40, maxLines: 2 } },
  { name: 'Karaoke', style: { font: 'Bahnschrift', size: 5.5, color: '#ffffff', highlightColor: '#3ddc84', highlight: 'karaoke', outline: true, background: false, uppercase: false, maxChars: 28, maxLines: 2 } },
  { name: 'Boxed', style: { font: 'Segoe UI', size: 4.5, color: '#ffffff', highlightColor: '#ffd400', highlight: 'word', outline: false, background: true, uppercase: false, maxChars: 36, maxLines: 2 } }
]

export function CaptionsPanel() {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const style = project.captionStyle
  const hasWords = Object.keys(project.transcripts).length > 0
  const set = (patch: Partial<CaptionStyle>, key = Object.keys(patch).join()): void => {
    useStudio.getState().dispatch({ op: 'setCaptionStyle', patch }, { coalesce: `caption:${key}` })
  }

  const saveSrt = async (): Promise<void> => {
    const path = await window.studio.files.saveText(projectPath, `${project.name} captions.srt`, toSrt(cuesFor(project)))
    window.studio.files.showInFolder(path)
  }

  return (
    <div className="space-y-4 overflow-auto p-3">
      {!hasWords && <p className="text-xs text-yellow-300">Captions come from the transcript. Transcribe your voice clip in the Transcript tab (left panel) first.</p>}
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={style.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Show captions on the video
      </label>

      <div className="grid grid-cols-2 gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.name} className="rounded border border-line bg-panel-2 px-2 py-2 text-xs hover:border-accent" onClick={() => set({ ...p.style, enabled: true }, 'preset')}>
            <span style={{ fontFamily: p.style.font, color: p.style.highlight === 'none' ? '#fff' : p.style.highlightColor, textTransform: p.style.uppercase ? 'uppercase' : 'none', fontWeight: 800 }}>{p.name}</span>
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <Row label="Font">
          <FontPicker value={style.font} onChange={(font) => font && set({ font })} />
        </Row>
        <Range label="Size" value={style.size} min={2} max={12} step={0.1} show={(v) => `${v.toFixed(1)}%`} onChange={(v) => set({ size: v })} />
        <Range label="Across" value={style.x} min={0.05} max={0.95} step={0.005} show={(v) => (v > 0.6 ? 'right' : v < 0.4 ? 'left' : 'center')} onChange={(v) => set({ x: v })} />
        <Range label="Width" value={style.width} min={0.2} max={1} step={0.01} show={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ width: v })} />
        <Range label="Height" value={style.y} min={0.08} max={0.95} step={0.005} show={(v) => (v > 0.66 ? 'bottom' : v < 0.34 ? 'top' : 'middle')} onChange={(v) => set({ y: v })} />
        <Range label="Length" value={style.maxChars} min={8} max={60} step={1} show={(v) => `${v} ch`} onChange={(v) => set({ maxChars: v })} />
        <Row label="Lines">
          <Seg value={String(style.maxLines)} options={[['1', '1'], ['2', '2'], ['3', '3']]} onChange={(v) => set({ maxLines: Number(v) })} />
        </Row>
        <Row label="Highlight">
          <Seg value={style.highlight} options={[['none', 'Off'], ['word', 'Word'], ['karaoke', 'Karaoke']]} onChange={(v) => set({ highlight: v as CaptionStyle['highlight'] })} />
        </Row>
        <Row label="Colors">
          <div className="flex items-center gap-2 text-xs text-muted">
            <input type="color" className="h-6 w-8" value={style.color} onChange={(e) => set({ color: e.target.value })} title="Text color" /> text
            <input type="color" className="h-6 w-8" value={style.highlightColor} onChange={(e) => set({ highlightColor: e.target.value })} title="Highlight color" /> spoken
          </div>
        </Row>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Check label="Outline" checked={style.outline} onChange={(v) => set({ outline: v })} />
          <Check label="Box behind" checked={style.background} onChange={(v) => set({ background: v })} />
          <Check label="UPPERCASE" checked={style.uppercase} onChange={(v) => set({ uppercase: v })} />
        </div>
      </div>

      <button className="w-full rounded bg-panel-2 px-3 py-1.5 hover:bg-line disabled:opacity-40" disabled={!hasWords} onClick={saveSrt}>
        Save subtitles file (.srt)
      </button>
      <p className="text-[11px] text-muted">Captions follow your edits automatically. Fix a wrong word by double-clicking it in the Transcript tab.</p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Range(props: { label: string; value: number; min: number; max: number; step: number; show(v: number): string; onChange(v: number): void }) {
  return (
    <Row label={props.label}>
      <div className="flex items-center gap-2">
        <input type="range" className="min-w-0 flex-1 accent-[#6d8cff]" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
        <span className="w-12 shrink-0 text-right text-[11px] text-muted">{props.show(props.value)}</span>
      </div>
    </Row>
  )
}

function Seg(props: { value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <div className="flex rounded border border-line p-0.5">
      {props.options.map(([v, l]) => (
        <button key={v} className={`flex-1 rounded px-1 py-0.5 text-xs ${props.value === v ? 'bg-accent text-white' : 'text-muted hover:text-text'}`} onClick={() => props.onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

function Check(props: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  )
}
