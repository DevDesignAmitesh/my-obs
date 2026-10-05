import { toSrt } from '@shared/captions'
import { projectDuration } from '@shared/project'
import { cuesFor } from './engine/captions-draw'
import { exportProject } from './engine/exporter'

/** `--cli export --project <dir>`: renders the project with the app's exporter, then reports back. */
export async function runCliExport(projectPath: string): Promise<void> {
  const result: Record<string, unknown> = { ok: false }
  try {
    const { project } = await window.studio.projects.open(projectPath)
    const { width, height, fps } = project.settings
    const out = await window.studio.files.exportPath(projectPath, project.name)
    const t0 = performance.now()
    let last = { done: 0, total: 0, speed: 0 }
    await exportProject(project, projectPath, { path: out, width, height, fps, videoBitrate: 12_000_000 }, (p) => {
      last = p
      if (p.done % 300 === 0) console.log(`export ${p.done}/${p.total}`)
    }, new AbortController().signal)
    result.loudness = await window.studio.audio.normalize(out, -14)
    if (Object.keys(project.transcripts).length) {
      result.subtitles = await window.studio.files.saveText(projectPath, `${project.name}.srt`, toSrt(cuesFor(project)))
    }
    result.output = out
    result.duration = Number(projectDuration(project).toFixed(2))
    result.size = `${width}x${height} @ ${fps} fps`
    result.renderSeconds = Number(((performance.now() - t0) / 1000).toFixed(1))
    result.renderFps = Number(last.speed.toFixed(1))
    result.ok = true
  } catch (e) {
    result.error = (e as Error).stack ?? String(e)
  }
  window.studio.system.selftestDone(result)
}
