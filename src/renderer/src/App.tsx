import { useEffect } from 'react'
import { useStudio } from './store'
import { Home } from './components/Home'
import { Workspace } from './components/Workspace'

export function App() {
  const project = useStudio((s) => s.project)
  const toast = useStudio((s) => s.toast)
  const showToast = useStudio((s) => s.showToast)

  // Dev: STUDIO_DEV_MODE=new-project opens a fresh throwaway project (used for UI screenshots).
  useEffect(() => {
    if (window.studio.dev.mode === 'new-project') {
      window.studio.projects.create(`devcheck-${Date.now()}`).then(useStudio.getState().open)
    }
    if (window.studio.dev.mode === 'reset-ui') localStorage.clear()
    if (window.studio.dev.mode?.startsWith('demo')) import('./recorder/selftest').then((m) => m.openDemoProject())
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => showToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast, showToast])

  return (
    <>
      {project ? <Workspace /> : <Home />}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-line bg-panel-2 px-4 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}
