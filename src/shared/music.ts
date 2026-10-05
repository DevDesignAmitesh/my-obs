import { modeById } from './modes'
import { projectDuration, type Project } from './project'

/** Background music: free Creative Commons libraries, YouTube (search) and AI-composed music (optional). */

export type MusicSource = 'openverse' | 'jamendo' | 'youtube'

export interface MusicTrack {
  id: string
  source: MusicSource
  title: string
  artist: string
  /** Seconds (0 if unknown). */
  duration: number
  /** Streamable URL for listening before adding (empty for YouTube: resolved on demand). */
  previewUrl: string
  downloadUrl: string
  /** Short licence name, e.g. "CC BY 4.0". */
  license: string
  licenseUrl: string
  /** Page of the track on the library's website. */
  pageUrl: string
  /** Attribution text to put in the video description. */
  credit: string
  tags: string[]
  /** Licence allows commercial use and putting it in a video (CC BY, BY-SA, CC0, public domain). */
  monetizable: boolean
}

export interface MusicSuggestion {
  /** e.g. "calm, focused, slightly upbeat" */
  mood: string
  /** One sentence on why this fits the video. */
  why: string
  /** Short library search terms, best first. */
  queries: string[]
  /** A prompt for AI-composed music. */
  aiPrompt: string
}

/** Creative Commons licence code ("by-nc-sa", "cc0", …) from a licence URL or code. */
export function licenseCode(urlOrCode: string): string {
  const s = urlOrCode.toLowerCase()
  if (/publicdomain\/zero|(^|\/)cc0/.test(s)) return 'cc0'
  if (/publicdomain\/mark|(^|\/)pdm/.test(s)) return 'pdm'
  const m = /licenses\/([a-z-]+)\//.exec(s) ?? /^([a-z+-]+)$/.exec(s)
  return m ? m[1] : s
}

/** Commercial use and adaptations (syncing music to video counts as one) are allowed. */
export const isMonetizable = (code: string): boolean => ['by', 'by-sa', 'cc0', 'pdm'].includes(code)

export function licenseName(code: string, version?: string): string {
  if (code === 'cc0') return 'CC0 (public domain)'
  if (code === 'pdm') return 'Public domain'
  return `CC ${code.toUpperCase()}${version ? ` ${version}` : ''}`
}

/** What the AI needs to pick music that suits this video. */
export function musicContext(p: Project): string {
  const mode = modeById(p.mode)
  const used = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)))
  const words = Object.entries(p.transcripts)
    .filter(([id]) => used.has(id))
    .flatMap(([, t]) => t.words.map((w) => w.text))
  const parts = [
    `Video: "${p.name}", ${Math.round(projectDuration(p))} s long, ${p.settings.width}x${p.settings.height}.`,
    `Video type: ${mode.name}.`,
    p.extraPrompt.trim() && `Creator's style notes: ${p.extraPrompt.trim()}`,
    p.sections.length > 0 && `Parts: ${p.sections.map((s) => `${Math.round(s.start)}-${Math.round(s.end)} s ${modeById(s.mode).name}${s.mood ? ` (${s.mood})` : ''}`).join('; ')}`,
    words.length > 0 && `What is said (start): ${words.slice(0, 300).join(' ')}`,
    !words.length && 'No transcript yet: judge from the title and type.'
  ]
  return parts.filter(Boolean).join('\n')
}
