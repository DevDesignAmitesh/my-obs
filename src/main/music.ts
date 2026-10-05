import { mkdir, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { z } from 'zod'
import { extractJson } from '@shared/motion'
import { isMonetizable, licenseCode, licenseName, musicContext, type MusicSource, type MusicSuggestion, type MusicTrack } from '@shared/music'
import type { MediaItem, Project } from '@shared/project'
import { getKey } from './secrets'
import { getSettings } from './settings'
import { importMedia, safeName, uniquePath } from './project-store'
import { chatProvider } from './ai/index'
import { AiError } from './ai/types'
import { downloadYouTubeAudio, searchYouTube } from './youtube'

/**
 * Music for videos: search free Creative Commons libraries (Openverse needs no key; Jamendo needs
 * a free client id), let the AI suggest what fits, and optionally compose music with ElevenLabs.
 */

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new AiError('Could not reach the music library. Check your internet connection.')
  }
  const body = (await res.json().catch(() => null)) as T | null
  if (!res.ok || !body) throw new AiError(`Music search failed (${res.status} ${res.statusText}).`)
  return body
}

interface OpenverseAudio {
  id: string
  title?: string
  creator?: string
  url: string
  foreign_landing_url?: string
  license: string
  license_version?: string
  license_url?: string
  attribution?: string
  duration?: number | null
  tags?: { name: string }[]
  genres?: string[] | null
}

async function searchOpenverse(query: string, safe: boolean): Promise<MusicTrack[]> {
  const params = new URLSearchParams({ q: query, category: 'music', page_size: '20' })
  if (safe) params.set('license_type', 'commercial,modification')
  const r = await getJson<{ results: OpenverseAudio[] }>(`https://api.openverse.org/v1/audio/?${params}`)
  return r.results.map((a) => {
    const code = licenseCode(a.license)
    return {
      id: `openverse:${a.id}`,
      source: 'openverse',
      title: a.title ?? 'Untitled',
      artist: a.creator ?? 'Unknown artist',
      duration: (a.duration ?? 0) / 1000,
      previewUrl: a.url,
      downloadUrl: a.url,
      license: licenseName(code, a.license_version),
      licenseUrl: a.license_url ?? '',
      pageUrl: a.foreign_landing_url ?? '',
      credit: a.attribution ?? `"${a.title}" by ${a.creator} (${licenseName(code, a.license_version)})`,
      tags: [...(a.genres ?? []), ...(a.tags ?? []).map((t) => t.name)].slice(0, 6),
      monetizable: isMonetizable(code)
    }
  })
}

interface JamendoTrack {
  id: string
  name: string
  artist_name: string
  duration: number
  audio: string
  audiodownload: string
  audiodownload_allowed: boolean
  license_ccurl: string
  shareurl: string
  musicinfo?: { tags?: { genres?: string[]; vartags?: string[] } }
}

export async function searchJamendo(clientId: string, query: string, safe: boolean): Promise<MusicTrack[]> {
  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: '30',
    search: query,
    include: 'musicinfo',
    audioformat: 'mp32',
    audiodlformat: 'mp32',
    order: 'relevance'
  })
  const r = await getJson<{ headers: { status: string; error_message?: string }; results: JamendoTrack[] }>(`https://api.jamendo.com/v3.0/tracks/?${params}`)
  if (r.headers.status !== 'success') throw new AiError(`Jamendo: ${r.headers.error_message || 'the client ID was rejected'}`)
  return r.results
    .map((t): MusicTrack => {
      const code = licenseCode(t.license_ccurl)
      const version = /\/(\d\.\d)\//.exec(t.license_ccurl)?.[1]
      return {
        id: `jamendo:${t.id}`,
        source: 'jamendo',
        title: t.name,
        artist: t.artist_name,
        duration: t.duration,
        previewUrl: t.audio,
        downloadUrl: t.audiodownload_allowed && t.audiodownload ? t.audiodownload : t.audio,
        license: licenseName(code, version),
        licenseUrl: t.license_ccurl,
        pageUrl: t.shareurl,
        credit: `"${t.name}" by ${t.artist_name} (${t.shareurl}), licensed under ${licenseName(code, version)}: ${t.license_ccurl}`,
        tags: [...(t.musicinfo?.tags?.genres ?? []), ...(t.musicinfo?.tags?.vartags ?? [])].slice(0, 6),
        monetizable: isMonetizable(code)
      }
    })
    .filter((t) => !safe || t.monetizable)
}

export async function searchMusic(query: string, source: MusicSource, safe: boolean): Promise<MusicTrack[]> {
  if (!query.trim()) return []
  if (source === 'jamendo') {
    const id = await getKey('jamendo')
    if (!id) throw new AiError('Add a free Jamendo client ID in Settings → AI to search Jamendo.')
    return searchJamendo(id, query, safe)
  }
  // YouTube has no licence data, so "safe" can't filter; the UI warns instead.
  if (source === 'youtube') return searchYouTube(query)
  return searchOpenverse(query, safe)
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a' }

async function saveAudio(projectPath: string, folder: string, name: string, bytes: Buffer, contentType: string): Promise<MediaItem> {
  const dir = join(projectPath, folder)
  await mkdir(dir, { recursive: true })
  const ext = EXT[contentType.split(';')[0].trim()] ?? 'mp3'
  const file = await uniquePath(dir, `${safeName(name).slice(0, 60) || 'music'}.${ext}`)
  await writeFile(file, bytes)
  const [item] = await importMedia(projectPath, [file], 'in-place')
  return item
}

/** Downloads a library track into the project (media/music) with its credit attached. */
export async function downloadMusic(projectPath: string, track: MusicTrack): Promise<MediaItem> {
  if (track.source === 'youtube') {
    const dir = join(projectPath, 'media', 'music')
    await mkdir(dir, { recursive: true })
    const slot = await uniquePath(dir, `${safeName(`${track.title} - ${track.artist}`).slice(0, 60) || 'music'}.mp3`)
    const file = await downloadYouTubeAudio(track.downloadUrl, dir, basename(slot, extname(slot)))
    const [item] = await importMedia(projectPath, [file], 'in-place')
    return { ...item, name: `${track.title} — ${track.artist}`, credit: track.credit }
  }
  let res: Response
  try {
    res = await fetch(track.downloadUrl)
  } catch {
    throw new AiError('Could not download the track. Check your internet connection.')
  }
  if (!res.ok) throw new AiError(`Download failed (${res.status}). The library may not allow downloading this track; try another.`)
  const item = await saveAudio(projectPath, join('media', 'music'), `${track.title} - ${track.artist}`, Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? '')
  return { ...item, name: `${track.title} — ${track.artist}`, credit: track.credit }
}

const Suggestion = z.object({
  mood: z.string(),
  why: z.string(),
  queries: z.array(z.string()).min(1).max(6),
  aiPrompt: z.string()
})

/** Asks the assistant model what music suits the video. */
export async function suggestMusic(project: Project): Promise<MusicSuggestion> {
  const { assistant } = (await getSettings()).ai
  if (!assistant.model) throw new AiError('Choose an assistant model in Settings → AI.')
  const text = await (await chatProvider(assistant.provider)).chat({
    model: assistant.model,
    system: `You choose background music for videos. Reply with one JSON object only:
{"mood": "<3-6 words>", "why": "<one short sentence>", "queries": ["<3-5 search terms for a Creative Commons music library, 1-3 words each, e.g. 'lofi chill', 'upbeat corporate', 'ambient piano', best first>"], "aiPrompt": "<one detailed prompt for an AI music generator: genre, mood, instruments, tempo in BPM, energy; instrumental, suitable under a voice-over>"}
Music under talking must be calm enough not to fight the voice unless the video is a montage.`,
    messages: [{ role: 'user', content: musicContext(project) }],
    maxTokens: 1500
  })
  try {
    return Suggestion.parse(extractJson(text))
  } catch {
    throw new AiError('The AI reply could not be read. Try again.')
  }
}

/** Composes original music with ElevenLabs and imports it (generated/music). */
export async function generateMusic(projectPath: string, req: { prompt: string; seconds: number; instrumental: boolean }): Promise<MediaItem> {
  const apiKey = await getKey('elevenlabs')
  if (!apiKey) throw new AiError('Add an ElevenLabs API key in Settings → AI to compose music.')
  if (!req.prompt.trim()) throw new AiError('Describe the music first.')
  let res: Response
  try {
    res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        prompt: req.prompt,
        music_length_ms: Math.round(Math.max(10, Math.min(300, req.seconds)) * 1000),
        model_id: 'music_v1',
        force_instrumental: req.instrumental
      })
    })
  } catch {
    throw new AiError('Could not reach ElevenLabs. Check your internet connection.')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: { message?: string } | string }
    const msg = typeof body.detail === 'string' ? body.detail : (body.detail?.message ?? res.statusText)
    if (res.status === 401) throw new AiError('ElevenLabs rejected the API key. Check it in Settings → AI.')
    throw new AiError(`ElevenLabs error ${res.status}: ${msg}`)
  }
  const item = await saveAudio(projectPath, join('generated', 'music'), `ai music ${req.prompt.slice(0, 30)}`, Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? 'audio/mpeg')
  return { ...item, name: `AI music: ${req.prompt.slice(0, 40)}`, credit: 'Original music generated with ElevenLabs.' }
}

/** Settings → Test for ElevenLabs. */
export async function checkElevenLabs(apiKey: string): Promise<void> {
  const res = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': apiKey } })
  if (res.status === 401) throw new AiError('ElevenLabs rejected the API key.')
  // Keys restricted to music only may not read the account (403); that still means the key is valid.
  if (!res.ok && res.status !== 403) throw new AiError(`ElevenLabs error ${res.status}`)
}
