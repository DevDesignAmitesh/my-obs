import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'path'
import {
  createProject,
  MediaItem,
  newId,
  Project,
  PROJECT_DIRS,
  PROJECT_FILE,
  type MediaKind
} from '@shared/project'
import type { OpenedProject, ProjectSummary } from '@shared/api'
import { getSettings } from './settings'
import { probe, thumbnail } from './ffmpeg'

const AUTOSAVE_EVERY_MS = 2 * 60 * 1000
const AUTOSAVE_KEEP = 20

export const safeName = (name: string): string =>
  name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '') || 'Untitled'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const base = basename(name, ext)
  let candidate = join(dir, name)
  for (let i = 2; await exists(candidate); i++) candidate = join(dir, `${base} (${i})${ext}`)
  return candidate
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const { projectsRoot } = await getSettings()
  const entries = await readdir(projectsRoot, { withFileTypes: true })
  const out: ProjectSummary[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const path = join(projectsRoot, e.name)
    try {
      const raw = JSON.parse(await readFile(join(path, PROJECT_FILE), 'utf8'))
      out.push({ name: raw.name ?? e.name, path, updatedAt: raw.updatedAt ?? '' })
    } catch {
      // not a project folder
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createProjectFolder(name: string): Promise<OpenedProject> {
  const { projectsRoot } = await getSettings()
  const path = await uniquePath(projectsRoot, safeName(name))
  await mkdir(path, { recursive: true })
  for (const d of PROJECT_DIRS) await mkdir(join(path, d), { recursive: true })
  const project = createProject(basename(path))
  await saveProject(path, project)
  return { path, project }
}

export async function openProject(path: string): Promise<OpenedProject> {
  const raw = JSON.parse(await readFile(join(path, PROJECT_FILE), 'utf8'))
  for (const d of PROJECT_DIRS) await mkdir(join(path, d), { recursive: true })
  return { path, project: Project.parse(raw) }
}

const lastAutosave = new Map<string, number>()

/** Atomic save (write temp file, then rename) plus a periodic history copy in autosave/. */
export async function saveProject(path: string, project: Project): Promise<void> {
  const data = JSON.stringify({ ...project, updatedAt: new Date().toISOString() }, null, 2)
  const file = join(path, PROJECT_FILE)
  const tmp = `${file}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)

  const now = Date.now()
  if (now - (lastAutosave.get(path) ?? 0) < AUTOSAVE_EVERY_MS) return
  lastAutosave.set(path, now)
  const dir = join(path, 'autosave')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `project-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`), data)
  const old = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().slice(0, -AUTOSAVE_KEEP)
  await Promise.all(old.map((f) => rm(join(dir, f))))
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/**
 * copy: copy into media/ (default) · link: reference the file where it is ·
 * in-place: the file already lives inside the project (e.g. recordings/).
 */
export type ImportMode = 'copy' | 'link' | 'in-place'

export async function importMedia(projectPath: string, files: string[], mode: ImportMode = 'copy'): Promise<MediaItem[]> {
  const items: MediaItem[] = []
  for (const src of files) {
    const id = newId()
    const isImage = IMAGE_EXT.has(extname(src).toLowerCase())
    const info = await probe(src)
    const kind: MediaKind = isImage ? 'image' : info.video ? 'video' : 'audio'
    if (!isImage && !info.video && !info.audio) throw new Error(`Unsupported file: ${basename(src)}`)

    let storedPath = mode === 'in-place' ? relative(projectPath, src) : src
    if (mode === 'copy') {
      const dest = await uniquePath(join(projectPath, 'media'), basename(src))
      await copyFile(src, dest)
      storedPath = join('media', basename(dest))
    }
    const absPath = isAbsolute(storedPath) ? storedPath : join(projectPath, storedPath)

    let thumb: string | undefined
    if (kind !== 'audio') {
      const thumbDir = join(projectPath, 'cache', 'thumbs')
      await mkdir(thumbDir, { recursive: true })
      try {
        await thumbnail(absPath, join(thumbDir, `${id}.jpg`), kind === 'video' ? Math.min(1, info.duration / 2) : 0)
        thumb = join('cache', 'thumbs', `${id}.jpg`)
      } catch {
        // thumbnail is optional
      }
    }

    items.push(
      MediaItem.parse({
        id,
        kind,
        name: basename(src),
        path: storedPath,
        linked: mode === 'link',
        duration: isImage ? 0 : info.duration,
        width: info.video?.width,
        height: info.video?.height,
        fps: isImage ? undefined : info.video?.fps,
        hasAudio: !!info.audio,
        thumbnail: thumb
      })
    )
  }
  return items
}
