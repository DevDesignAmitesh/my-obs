import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { runExportSelftest, runSelftest } from './recorder/selftest'

if (location.hash === '#selftest') runSelftest()
if (location.hash === '#selftest-export') runExportSelftest()
if (window.studio.dev.mode === 'cli-export' && window.studio.dev.project) import('./cli-export').then((m) => m.runCliExport(window.studio.dev.project!))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
