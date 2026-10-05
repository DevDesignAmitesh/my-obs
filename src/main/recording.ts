import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { mkdir, open, rm, type FileHandle } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { promisify } from 'util'
import type { FinishedStream, TakeStream } from '@shared/api'
import { getSettings } from './settings'
import { ffmpegPath, ffprobePath } from './ffmpeg'
import { importMedia } from './project-store'
import { SYSTEM_LABEL } from '@shared/take'

/** System audio quieter than this at its loudest is treated as "nothing was playing". */
const SILENT_DB = -70

/** Loudest peak of a file's audio, in dB (-Infinity if silent). */
export async function peakDb(file: string): Promise<number> {
  const { stderr } = await run(ffmpegPath, ['-v', 'info', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 1 << 26 })
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr)
  return !m || m[1] === '-inf' ? -Infinity : Number(m[1])
}

const run = promisify(execFile)

/**
 * A take is streamed by the renderer into one fragmented MP4 (crash-safe, all tracks in sync),
 * written here chunk by chunk. When recording stops it is split into one file per source.
 */
const handles = new Map<number, FileHandle>()
let nextHandle = 1

export async function assertInsideProjects(path: string): Promise<void> {
  const root = resolve((await getSettings()).projectsRoot).toLowerCase()
  if (!resolve(path).toLowerCase().startsWith(root + sep)) throw new Error('Refusing to write outside the projects folder')
}

export function registerRecording(): void {
  ipcMain.handle('rec:open', async (_e, path: string) => {
    await assertInsideProjects(path)
    await mkdir(dirname(path), { recursive: true })
    const fh = await open(path, 'w')
    const id = nextHandle++
    handles.set(id, fh)
    return id
  })

  ipcMain.handle('rec:write', async (_e, id: number, position: number, data: Uint8Array) => {
    const fh = handles.get(id)
    if (!fh) throw new Error('Recording file is not open')
    await fh.write(data, 0, data.byteLength, position)
  })

  ipcMain.handle('rec:close', async (_e, id: number) => {
    await handles.get(id)?.close()
    handles.delete(id)
  })

  ipcMain.handle('rec:finish', (_e, projectPath: string, takeFile: string, streams: TakeStream[]) =>
    finishTake(projectPath, takeFile, streams)
  )
}

/** Splits the take into per-source files (stream copy, no re-encode) and imports them into the project. */
export async function finishTake(projectPath: string, takeFile: string, streams: TakeStream[]): Promise<FinishedStream[]> {
  await assertInsideProjects(takeFile)
  const dir = join(takeFile, '..')

  // Per-stream start times, so sources that started a few ms late stay in sync on the timeline.
  const { stdout } = await run(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', takeFile])
  const probed = (JSON.parse(stdout).streams as Array<{ codec_type: string; start_time?: string }>) ?? []
  const startsOf = (kind: string): number[] => probed.filter((s) => s.codec_type === kind).map((s) => Number(s.start_time ?? 0) || 0)
  const starts = { video: startsOf('video'), audio: startsOf('audio') }
  const zero = Math.min(...starts.video, ...starts.audio, Infinity)

  const counters = { video: 0, audio: 0 }
  const outputs: string[] = []
  const offsets: number[] = []
  const peaks: (number | undefined)[] = []
  const kept: TakeStream[] = []
  for (const s of streams) {
    const n = counters[s.kind]++
    // A source that produced no data has no track in the file: skip it, keep everything else.
    if (n >= starts[s.kind].length) continue
    const base = (s.name ?? s.label).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || s.label
    const out = join(dir, `${base}.${s.kind === 'video' ? 'mp4' : 'm4a'}`)
    await run(ffmpegPath, [
      '-y', '-v', 'error',
      '-i', takeFile,
      '-map', `0:${s.kind === 'video' ? 'v' : 'a'}:${n}`,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      out
    ])
    let peak: number | undefined
    if (s.kind === 'audio') {
      peak = await peakDb(out)
      // Nothing played on the computer during the take: don't add an empty track.
      if (s.label === SYSTEM_LABEL && peak < SILENT_DB) {
        await rm(out)
        continue
      }
    }
    kept.push(s)
    outputs.push(out)
    peaks.push(peak)
    offsets.push(Math.max(0, (starts[s.kind][n] ?? zero) - zero))
  }

  const items = await importMedia(projectPath, outputs, 'in-place')
  await rm(takeFile) // every stream is now in its own file
  return kept.map((s, i) => ({ label: s.label, item: items[i], offset: offsets[i], peakDb: peaks[i] }))
}
