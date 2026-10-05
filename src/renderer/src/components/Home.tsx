import { useEffect, useState } from 'react'
import type { AppSettings, FfmpegInfo, ProjectSummary } from '@shared/api'
import { useStudio } from '../store'
import { SettingsDialog } from './SettingsDialog'

export function Home() {
  const open = useStudio((s) => s.open)
  const showToast = useStudio((s) => s.showToast)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(window.studio.dev.mode === 'settings')

  const refresh = async (): Promise<void> => {
    setSettings(await window.studio.settings.get())
    setProjects(await window.studio.projects.list())
  }

  useEffect(() => {
    refresh().catch((e) => showToast(String(e)))
    window.studio.system.ffmpegInfo().then(setFfmpeg, () => setFfmpeg(null))
  }, [])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const create = () => run(async () => open(await window.studio.projects.create(name.trim() || 'Untitled')))

  const changeRoot = () =>
    run(async () => {
      const dir = await window.studio.dialog.pickFolder()
      if (dir) {
        await window.studio.settings.set({ projectsRoot: dir })
        await refresh()
      }
    })

  return (
    <div className="flex h-full items-start justify-center overflow-auto p-12">
      <div className="w-full max-w-3xl">
        <div className="flex items-center">
          <h1 className="text-3xl font-semibold">Studio</h1>
          <button className="ml-auto text-muted hover:text-text" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
        </div>
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
        <p className="mt-1 text-muted">Record, edit and caption your videos in one place.</p>

        <div className="mt-8 flex gap-2">
          <input
            className="flex-1 rounded-md border border-line bg-panel px-3 py-2 outline-none focus:border-accent"
            placeholder="New project name, e.g. React tutorial #3"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button
            className="rounded-md bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
            disabled={busy}
            onClick={create}
          >
            New project
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 text-muted">
          <span>Projects are saved in</span>
          <code className="rounded bg-panel px-2 py-0.5 text-text">{settings?.projectsRoot ?? '…'}</code>
          <button className="text-accent hover:underline" onClick={changeRoot}>
            Change
          </button>
        </div>

        <h2 className="mt-10 mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Recent projects</h2>
        {projects.length === 0 && <p className="text-muted">No projects yet.</p>}
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-panel">
          {projects.map((p) => (
            <li key={p.path}>
              <button
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-panel-2"
                onClick={() => run(async () => open(await window.studio.projects.open(p.path)))}
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-muted">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ''}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="mt-10 text-xs text-muted">
          {ffmpeg
            ? `${ffmpeg.version} · hardware encoders: ${ffmpeg.hwEncoders.join(', ') || 'none found'}`
            : 'Checking FFmpeg…'}
        </p>
      </div>
    </div>
  )
}
