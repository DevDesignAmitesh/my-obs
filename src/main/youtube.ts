import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, rename, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import type { MusicTrack } from '@shared/music'
import { ffmpegPath } from './ffmpeg'
import { AiError } from './ai/types'

/**
 * YouTube as a music source, through yt-dlp. The yt-dlp.exe binary is downloaded once into
 * userData/bin on first use (it is updated often, so it is not bundled) and kept up to date
 * with `yt-dlp -U` when a search fails.
 */

const run = promisify(execFile)
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const binDir = (): string => join(app.getPath('userData'), 'bin')
const ytDlpPath = (): string => join(binDir(), 'yt-dlp.exe')

let installing: Promise<string> | null = null

/** Path to yt-dlp, downloading it the first time. */
async function ytDlp(): Promise<string> {
  const exe = ytDlpPath()
  if (existsSync(exe)) return exe
  installing ??= (async () => {
    await mkdir(binDir(), { recursive: true })
    let res: Response
    try {
      res = await fetch(RELEASE)
    } catch {
      throw new AiError('Could not download yt-dlp (needed for YouTube). Check your internet connection.')
    }
    if (!res.ok) throw new AiError(`Could not download yt-dlp (${res.status}).`)
    await writeFile(`${exe}.tmp`, Buffer.from(await res.arrayBuffer()))
    await rename(`${exe}.tmp`, exe)
    return exe
  })().finally(() => (installing = null))
  return installing
}

async function ytRun(args: string[], timeout = 60_000): Promise<string> {
  const exe = await ytDlp()
  try {
    const { stdout } = await run(exe, ['--no-warnings', '--ignore-config', ...args], { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    const msg = (err.stderr || err.message).split('\n').find((l) => l.startsWith('ERROR:')) ?? err.message
    // YouTube changes often; an old yt-dlp is the usual cause. Update quietly for next time.
    run(exe, ['-U'], { timeout: 120_000, windowsHide: true }).catch(() => {})
    throw new AiError(`YouTube: ${msg.replace(/^ERROR:\s*/, '').slice(0, 300)}`)
  }
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim())

interface YtEntry {
  id: string
  title?: string
  channel?: string
  uploader?: string
  duration?: number | null
  url?: string
  webpage_url?: string
  live_status?: string | null
}

function toTrack(e: YtEntry): MusicTrack {
  const pageUrl = e.webpage_url ?? (e.url && isUrl(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`)
  const artist = e.channel ?? e.uploader ?? 'YouTube'
  const title = e.title ?? 'Untitled'
  return {
    id: `youtube:${e.id}`,
    source: 'youtube',
    title,
    artist,
    duration: e.duration ?? 0,
    // Stream URLs expire, so the preview is resolved when Play is pressed (youtubeStreamUrl).
    previewUrl: '',
    downloadUrl: pageUrl,
    license: 'YouTube: check rights',
    licenseUrl: pageUrl,
    pageUrl,
    credit: `"${title}" by ${artist} (${pageUrl})`,
    tags: [],
    monetizable: false
  }
}

/** Searches YouTube, or looks up a pasted video/playlist link. */
export async function searchYouTube(query: string): Promise<MusicTrack[]> {
  const target = isUrl(query) ? query.trim() : `ytsearch20:${query.trim()}`
  const out = await ytRun(['--flat-playlist', '--dump-single-json', '--playlist-end', '50', target])
  const data = JSON.parse(out) as YtEntry & { entries?: YtEntry[] }
  const entries = data.entries ?? [data]
  return entries.filter((e) => e.id && e.live_status !== 'is_live' && e.live_status !== 'is_upcoming').map(toTrack)
}

/** A short-lived direct audio URL for listening before adding. */
export async function youtubeStreamUrl(pageUrl: string): Promise<string> {
  const out = await ytRun(['-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '-g', pageUrl])
  const url = out.trim().split('\n')[0]
  if (!url) throw new AiError('YouTube did not return an audio stream for this video.')
  return url
}

/** Downloads the audio of a video into `dir` as MP3 and returns the file path. */
export async function downloadYouTubeAudio(pageUrl: string, dir: string, baseName: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const before = new Set(await readdir(dir))
  const out = await ytRun(
    [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
      '--ffmpeg-location', ffmpegPath,
      '--restrict-filenames',
      '-o', join(dir, `${baseName}.%(ext)s`),
      '--print', 'after_move:filepath',
      pageUrl
    ],
    10 * 60_000
  )
  const file = out.trim().split('\n').pop()?.trim()
  if (file && existsSync(file)) return file
  // Fallback: the newest new file in the folder.
  const added = (await readdir(dir)).filter((f) => !before.has(f) && f.endsWith('.mp3'))
  if (!added.length) throw new AiError('YouTube download finished but no audio file was found.')
  const withTimes = await Promise.all(added.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })))
  return join(dir, withTimes.sort((a, b) => b.t - a.t)[0].f)
}
