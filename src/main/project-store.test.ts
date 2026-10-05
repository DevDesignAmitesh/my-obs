import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tmp = mkdtempSync(join(tmpdir(), 'studio-test-'))
vi.mock('electron', () => ({ app: { getPath: () => join(tmp, 'userData') } }))

const { setSettings } = await import('./settings')
const { createProjectFolder, importMedia, listProjects, openProject, saveProject } = await import('./project-store')
const { ffmpegPath } = await import('./ffmpeg')
const { applyOp } = await import('@shared/ops')

const sample = join(tmp, 'sample clip.mp4')

beforeAll(async () => {
  await setSettings({ projectsRoot: join(tmp, 'MY-STUDIO') })
  // 2-second 640x360 test video with a tone.
  execFileSync(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample
  ])
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('project store', () => {
  it('creates, imports, saves, lists and reopens a project', async () => {
    const { path, project } = await createProjectFolder('My: Tutorial?')
    expect(path).toBe(join(tmp, 'MY-STUDIO', 'My Tutorial'))
    for (const d of ['recordings', 'media', 'generated', 'cache', 'exports', 'autosave']) {
      expect(existsSync(join(path, d))).toBe(true)
    }

    const [item] = await importMedia(path, [sample])
    expect(item).toMatchObject({ kind: 'video', width: 640, height: 360, hasAudio: true, path: join('media', 'sample clip.mp4') })
    expect(item.duration).toBeCloseTo(2, 0)
    expect(existsSync(join(path, item.path))).toBe(true)
    expect(existsSync(join(path, item.thumbnail!))).toBe(true)

    let p = applyOp(project, { op: 'addMedia', items: [item] })
    p = applyOp(p, { op: 'insertClip', trackId: p.tracks[0].id, mediaId: item.id, start: 0 })
    await saveProject(path, p)

    const reopened = await openProject(path)
    expect(reopened.project.tracks[0].clips).toHaveLength(1)
    expect(readdirSync(join(path, 'autosave')).length).toBeGreaterThan(0)

    const list = await listProjects()
    expect(list.map((x) => x.name)).toContain('My Tutorial')

    // A second project with the same name gets a unique folder.
    const second = await createProjectFolder('My: Tutorial?')
    expect(second.path).toBe(join(tmp, 'MY-STUDIO', 'My Tutorial (2)'))
  }, 30000)
})
