import { useEffect, useRef, useState } from 'react'
import type { ImageRequest } from '@shared/api'
import { MOTION_KIND_INFO, MOTION_KINDS, type MotionKind } from '@shared/motion'
import type { MusicSource, MusicSuggestion, MusicTrack } from '@shared/music'
import { motionMedia, newId, projectDuration, type MediaItem } from '@shared/project'
import { audioTrackFor, placeOnTop } from '@shared/placement'
import type { EditOp } from '@shared/ops'
import { themeAt } from '@shared/sections'
import { useStudio } from '../store'
import { formatTime } from '../time'
import { frameMarkup, frameUrl } from '../engine/motion-render'

/** Create tab: images & logos, SVG art & animations, and music, all from a prompt. */
export function CreatePanel({ onOpenSettings }: { onOpenSettings(): void }) {
  const [open, setOpen] = useState<'image' | 'motion' | 'music'>('motion')
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section title="🎞 Animation / SVG" open={open === 'motion'} onToggle={() => setOpen('motion')}>
        <MotionMaker />
      </Section>
      <Section title="🖼 Image / logo" open={open === 'image'} onToggle={() => setOpen('image')}>
        <ImageMaker onOpenSettings={onOpenSettings} />
      </Section>
      <Section title="🎵 Music" open={open === 'music'} onToggle={() => setOpen('music')}>
        <MusicFinder onOpenSettings={onOpenSettings} />
      </Section>
    </div>
  )
}

function Section(props: { title: string; open: boolean; onToggle(): void; children: React.ReactNode }) {
  return (
    <div className="border-b border-line">
      <button className="flex w-full items-center px-3 py-2 text-left font-semibold hover:bg-panel-2" onClick={props.onToggle}>
        {props.title}
        <span className="ml-auto text-muted">{props.open ? '▾' : '▸'}</span>
      </button>
      {props.open && <div className="space-y-2 px-3 pb-3">{props.children}</div>}
    </div>
  )
}

/** Runs an async job with a busy flag, elapsed seconds and errors shown as a toast. */
function useJob(): { busy: boolean; seconds: number; run(fn: () => Promise<void>): Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setSeconds(0)
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000)
    try {
      await fn()
    } catch (e) {
      useStudio.getState().showToast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      clearInterval(timer)
      setBusy(false)
    }
  }
  return { busy, seconds, run }
}

/** Puts a new visual item on top of the video at the playhead and selects it. */
function placeVisual(media: MediaItem, length: number, small: boolean): void {
  const s = useStudio.getState()
  const p = s.project!
  const { ops, clipId } = placeOnTop(p, media, s.playhead, s.playhead + length)
  // Logos and icons start as a corner-sized overlay; resize/move them in the Clip tab.
  const extra: EditOp[] = small ? [{ op: 'updateClip', clipId, transform: { scale: 0.35, x: 0.78, y: 0.24 } }] : []
  if (s.dispatch([...ops, ...extra])) {
    s.selectClips([clipId])
    s.setViewerMode('program')
  }
}

const CHIP = (on: boolean): string => `rounded px-2 py-0.5 text-xs ${on ? 'bg-accent text-white' : 'bg-panel-2 text-muted hover:text-text'}`
const INPUT = 'w-full rounded border border-line bg-panel-2 px-2 py-1 outline-none focus:border-accent'
const PRIMARY = 'w-full rounded bg-accent py-1.5 font-medium text-white disabled:opacity-50'

// ---------------------------------------------------------------------------------- animation

const DEFAULT_SECONDS: Record<MotionKind, number> = { icon: 3, diagram: 8, intro: 4, text: 4 }

function MotionMaker() {
  const [kind, setKind] = useState<MotionKind>('diagram')
  const [prompt, setPrompt] = useState('')
  const [seconds, setSeconds] = useState(DEFAULT_SECONDS.diagram)
  const [place, setPlace] = useState(true)
  const job = useJob()

  const generate = (): Promise<void> =>
    job.run(async () => {
      const s = useStudio.getState()
      const p = s.project!
      const { name, motion } = await window.studio.create.motion({
        prompt,
        kind,
        duration: seconds,
        canvas: { width: p.settings.width, height: p.settings.height },
        theme: themeAt(p, s.playhead)
      })
      frameMarkup(motion, motion.duration, 64) // throws if the SVG can't be read
      const media = motionMedia(newId(), name, motion)
      if (place) placeVisual(media, Math.max(motion.duration, 1), kind === 'icon')
      else s.dispatch({ op: 'addMedia', items: [media] })
      s.showToast(`Made “${name}”. Select it and use the Clip tab to change it with AI.`)
    })

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {MOTION_KINDS.map((k) => (
          <button key={k} className={CHIP(kind === k)} onClick={() => (setKind(k), setSeconds(DEFAULT_SECONDS[k]))}>
            {MOTION_KIND_INFO[k].name}
          </button>
        ))}
      </div>
      <textarea className={`${INPUT} h-20 resize-none`} placeholder={MOTION_KIND_INFO[kind].hint} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <label className="flex items-center gap-2 text-xs text-muted">
        Length
        <input type="range" min={1} max={20} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="flex-1" />
        <span className="w-8 text-right">{seconds} s</span>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={place} onChange={(e) => setPlace(e.target.checked)} /> Put it on the timeline at the playhead
      </label>
      <button className={PRIMARY} disabled={job.busy || !prompt.trim()} onClick={generate}>
        {job.busy ? `Designing… ${job.seconds}s` : '✨ Generate'}
      </button>
      <p className="text-xs text-muted">Uses your AI assistant model. Everything is vector, so it stays sharp at any size and exports exactly as previewed.</p>
    </>
  )
}

// ---------------------------------------------------------------------------------- images

const STYLES: [ImageRequest['style'], string][] = [
  ['logo', 'Logo'],
  ['icon', 'Icon'],
  ['illustration', 'Illustration'],
  ['photo', 'Photo'],
  ['thumbnail', 'Thumbnail bg'],
  ['none', 'Free']
]

function ImageMaker({ onOpenSettings }: { onOpenSettings(): void }) {
  const projectPath = useStudio((s) => s.projectPath)!
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState<ImageRequest['style']>('logo')
  const [shape, setShape] = useState<ImageRequest['shape']>('square')
  const [transparent, setTransparent] = useState(true)
  const [quality, setQuality] = useState<ImageRequest['quality']>('medium')
  const [place, setPlace] = useState(true)
  const [made, setMade] = useState<MediaItem[]>([])
  const job = useJob()

  const pickStyle = (st: ImageRequest['style']): void => {
    setStyle(st)
    setShape(st === 'logo' || st === 'icon' ? 'square' : 'wide')
    setTransparent(st === 'logo' || st === 'icon')
  }

  const generate = (): Promise<void> =>
    job.run(async () => {
      const item = await window.studio.create.image(projectPath, { prompt, style, shape, transparent, quality })
      setMade((m) => [item, ...m].slice(0, 6))
      if (place) placeVisual(item, 5, style === 'logo' || style === 'icon')
      else useStudio.getState().dispatch({ op: 'addMedia', items: [item] })
    })

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {STYLES.map(([v, label]) => (
          <button key={v} className={CHIP(style === v)} onClick={() => pickStyle(v)}>{label}</button>
        ))}
      </div>
      <textarea
        className={`${INPUT} h-20 resize-none`}
        placeholder={style === 'logo' ? 'e.g. logo for my coding channel "DevDaily", a bracket and a sun, orange and navy' : 'Describe the image'}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex items-center gap-1 text-xs">
        {(['square', 'wide', 'tall'] as const).map((s) => (
          <button key={s} className={CHIP(shape === s)} onClick={() => setShape(s)}>{s === 'square' ? '■ Square' : s === 'wide' ? '▬ Wide' : '▮ Tall'}</button>
        ))}
        <select className="ml-auto rounded bg-panel-2 px-1 py-0.5" value={quality} onChange={(e) => setQuality(e.target.value as ImageRequest['quality'])} title="Higher quality costs more">
          <option value="low">Draft (cheap)</option>
          <option value="medium">Good</option>
          <option value="high">Best</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent background
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={place} onChange={(e) => setPlace(e.target.checked)} /> Put it on the timeline at the playhead
      </label>
      <button className={PRIMARY} disabled={job.busy || !prompt.trim()} onClick={generate}>
        {job.busy ? `Generating… ${job.seconds}s` : '✨ Generate image'}
      </button>
      <p className="text-xs text-muted">
        Uses the image service chosen in <button className="text-accent hover:underline" onClick={onOpenSettings}>Settings</button> and is billed there. Images are saved in the project’s generated folder.
      </p>
      {made.length > 0 && (
        <div className="grid grid-cols-3 gap-1">
          {made.map((m) => (
            <button key={m.id} title="Add at the playhead" className="aspect-square overflow-hidden rounded border border-line bg-[repeating-conic-gradient(#333_0_25%,#222_0_50%)] bg-[length:12px_12px]" onClick={() => placeVisual(m, 5, false)}>
              <img className="h-full w-full object-contain" src={window.studio.media.url(projectPath, m.path)} />
            </button>
          ))}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------- music

function MusicFinder({ onOpenSettings }: { onOpenSettings(): void }) {
  const projectPath = useStudio((s) => s.projectPath)!
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<MusicSource>('openverse')
  const [safe, setSafe] = useState(true)
  const [results, setResults] = useState<MusicTrack[] | null>(null)
  const [suggestion, setSuggestion] = useState<MusicSuggestion | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const searchJob = useJob()
  const suggestJob = useJob()
  const aiJob = useJob()
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiSeconds, setAiSeconds] = useState(60)
  const [instrumental, setInstrumental] = useState(true)

  useEffect(() => () => audio.current?.pause(), [])

  const search = (q = query): Promise<void> =>
    searchJob.run(async () => {
      setQuery(q)
      setResults(await window.studio.create.musicSearch(q, source, safe))
    })

  const suggest = (): Promise<void> =>
    suggestJob.run(async () => {
      const s = await window.studio.create.musicSuggest(useStudio.getState().project!)
      setSuggestion(s)
      setAiPrompt(s.aiPrompt)
      await search(s.queries[0])
    })

  const preview = async (t: MusicTrack): Promise<void> => {
    if (playing === t.id) {
      audio.current?.pause()
      setPlaying(null)
      return
    }
    audio.current?.pause()
    setPlaying(t.id)
    let url = t.previewUrl
    if (!url && t.source === 'youtube') {
      try {
        url = await window.studio.create.musicStreamUrl(t.pageUrl)
      } catch (e) {
        setPlaying(null)
        return useStudio.getState().showToast(errorText(e))
      }
    }
    const el = new Audio(url)
    el.volume = 0.8
    el.onended = () => setPlaying(null)
    audio.current = el
    el.play().catch(() => (setPlaying((p) => (p === t.id ? null : p)), useStudio.getState().showToast('Could not play this preview')))
  }

  const add = async (t: MusicTrack): Promise<void> => {
    setAdding(t.id)
    try {
      placeMusic(await window.studio.create.musicDownload(projectPath, t))
      useStudio.getState().showToast(
        t.source === 'youtube'
          ? `Added “${t.title}” from YouTube. Make sure you have the rights before publishing.`
          : `Added “${t.title}”. Licence ${t.license}: credit is in the Clip tab (and “Copy credits” below).`
      )
    } catch (e) {
      useStudio.getState().showToast(errorText(e))
    } finally {
      setAdding(null)
    }
  }

  const generate = (): Promise<void> =>
    aiJob.run(async () => {
      placeMusic(await window.studio.create.musicGenerate(projectPath, { prompt: aiPrompt, seconds: aiSeconds, instrumental }))
    })

  const copyCredits = async (): Promise<void> => {
    const p = useStudio.getState().project!
    const used = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)))
    const credits = p.media.filter((m) => used.has(m.id) && m.credit).map((m) => m.credit)
    if (!credits.length) return useStudio.getState().showToast('No credited music on the timeline yet.')
    await navigator.clipboard.writeText(`Music:\n${credits.join('\n')}`)
    useStudio.getState().showToast('Credits copied. Paste them into your video description.')
  }

  useEffect(() => {
    const p = useStudio.getState().project!
    setAiSeconds(Math.max(10, Math.min(300, Math.round(projectDuration(p)) || 60)))
  }, [])

  return (
    <>
      <button className={PRIMARY} disabled={suggestJob.busy} onClick={suggest}>
        {suggestJob.busy ? `Listening to your video… ${suggestJob.seconds}s` : '✨ Suggest music for this video'}
      </button>
      {suggestion && (
        <div className="space-y-1 rounded border border-line p-2 text-xs">
          <div><span className="font-semibold">{suggestion.mood}</span> <span className="text-muted">· {suggestion.why}</span></div>
          <div className="flex flex-wrap gap-1">
            {suggestion.queries.map((q) => (
              <button key={q} className={CHIP(query === q)} onClick={() => search(q)}>{q}</button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-1">
        <input className={INPUT} placeholder={source === 'youtube' ? 'Search YouTube or paste a link' : 'Search music, e.g. lofi chill'} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button className="rounded bg-panel-2 px-2 hover:bg-line disabled:opacity-50" disabled={searchJob.busy || !query.trim()} onClick={() => search()}>
          {searchJob.busy ? '…' : 'Search'}
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        <select className="rounded bg-panel-2 px-1 py-0.5" value={source} onChange={(e) => setSource(e.target.value as MusicSource)}>
          <option value="openverse">Openverse (free)</option>
          <option value="jamendo">Jamendo (free ID)</option>
          <option value="youtube">YouTube</option>
        </select>
        {source !== 'youtube' && (
          <label className="flex items-center gap-1" title="Only Creative Commons licences that allow commercial use and syncing to video (CC BY, BY-SA, CC0)">
            <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> OK for monetized videos
          </label>
        )}
      </div>
      {source === 'youtube' && (
        <p className="text-xs text-yellow-400">
          Most YouTube music is copyrighted and can get your video muted or claimed. Prefer the YouTube Audio Library, no-copyright channels, or music you have rights to. First use downloads yt-dlp (~15 MB).
        </p>
      )}

      {results && (
        <div className="space-y-1">
          {results.length === 0 && <p className="text-xs text-muted">Nothing found. Try simpler words (genre or mood), or the other library.</p>}
          {results.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded border border-line p-1.5 text-xs">
              <button className="h-7 w-7 shrink-0 rounded-full bg-panel-2 hover:bg-line" title="Listen" onClick={() => preview(t)}>
                {playing === t.id ? '❚❚' : '▶'}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={t.title}>{t.title}</div>
                <div className="truncate text-muted" title={t.tags.join(', ')}>
                  {t.artist} · {t.duration ? formatTime(t.duration) : '?'} ·{' '}
                  <a href={t.licenseUrl || t.pageUrl} target="_blank" rel="noreferrer" className={t.monetizable ? 'text-audio' : 'text-yellow-400'} title={t.source === 'youtube' ? 'Open on YouTube: check the description for the licence' : t.monetizable ? 'Free to use with credit, also in monetized videos' : 'Non-commercial / no-derivatives licence: avoid in monetized videos'}>
                    {t.license}
                  </a>
                </div>
              </div>
              <button className="shrink-0 rounded bg-panel-2 px-2 py-1 hover:bg-line disabled:opacity-50" disabled={adding !== null} onClick={() => add(t)}>
                {adding === t.id ? '…' : '+ Add'}
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="text-xs text-accent hover:underline" onClick={copyCredits}>Copy music credits for the description</button>

      <details className="rounded border border-line p-2">
        <summary className="cursor-pointer text-xs font-semibold">AI-composed music (optional, ElevenLabs)</summary>
        <div className="mt-2 space-y-2">
          <textarea className={`${INPUT} h-20 resize-none`} placeholder="e.g. calm lofi hip hop, soft piano and vinyl crackle, 80 BPM, instrumental" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
          <label className="flex items-center gap-2 text-xs text-muted">
            Length
            <input type="range" min={10} max={300} step={5} value={aiSeconds} onChange={(e) => setAiSeconds(Number(e.target.value))} className="flex-1" />
            <span className="w-10 text-right">{formatTime(aiSeconds)}</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={instrumental} onChange={(e) => setInstrumental(e.target.checked)} /> Instrumental (no vocals)
          </label>
          <button className={PRIMARY} disabled={aiJob.busy || !aiPrompt.trim()} onClick={generate}>
            {aiJob.busy ? `Composing… ${aiJob.seconds}s` : '✨ Compose music'}
          </button>
          <p className="text-xs text-muted">
            Needs an ElevenLabs key in <button className="text-accent hover:underline" onClick={onOpenSettings}>Settings</button> (billed by ElevenLabs). Original music, so no licence worries.
          </p>
        </div>
      </details>
    </>
  )
}

const errorText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Adds music under the video from the playhead, quiet enough for a voice, with soft fades. */
function placeMusic(item: MediaItem): void {
  const s = useStudio.getState()
  const p = s.project!
  const start = s.playhead
  const videoEnd = projectDuration(p)
  // Run to the end of the video when it's long enough, otherwise the whole track.
  const length = videoEnd - start > 1 ? Math.min(item.duration, videoEnd - start) : item.duration
  const { trackId, ops } = audioTrackFor(p, start, start + length)
  const clipId = newId()
  const ok = s.dispatch([
    { op: 'addMedia', items: [item] },
    ...ops,
    { op: 'insertClip', trackId, mediaId: item.id, start, in: 0, out: length, clipId },
    { op: 'updateClip', clipId, volume: 0.25, fadeIn: Math.min(1.5, length / 4), fadeOut: Math.min(3, length / 4) }
  ])
  if (ok) s.selectClips([clipId])
}

/** Small preview of generated SVG art (for the bin and the inspector). */
export function MotionThumb({ media, animate = false, className }: { media: MediaItem; animate?: boolean; className?: string }) {
  const m = media.motion
  const [t, setT] = useState(m ? m.duration * 0.9 : 0)
  useEffect(() => {
    if (!animate || !m) return
    let raf = 0
    const started = performance.now()
    const tick = (): void => {
      setT(((performance.now() - started) / 1000) % (m.duration + 1))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animate, m])
  if (!m) return null
  let src = ''
  try {
    src = frameUrl(m, t, 320)
  } catch {
    return <span className="text-xs text-danger">Broken SVG</span>
  }
  return <img className={className ?? 'h-full w-full object-contain'} src={src} />
}
