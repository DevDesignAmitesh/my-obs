import type { EnhanceLevel, MediaItem, Project } from './project'
import type { AiSettings, ProviderId, ProviderStatus, TestResult } from './ai'
import type { Transcript } from './transcript'
import type { ChatTurn, Focus, Proposal, Selection } from './assistant'
import type { RefinedFeedback } from './modes'
import type { Motion, MotionKind } from './motion'
import type { MusicSource, MusicSuggestion, MusicTrack } from './music'
import type { FontFaceData, FontInfo } from './fonts'
import type { Theme } from './theme'

export interface ImageRequest {
  prompt: string
  style: 'logo' | 'icon' | 'illustration' | 'photo' | 'thumbnail' | 'none'
  shape: 'square' | 'wide' | 'tall'
  transparent: boolean
  quality: 'low' | 'medium' | 'high'
}

export interface MotionRequest {
  prompt: string
  kind: MotionKind
  canvas: { width: number; height: number }
  theme: Theme
  /** Seconds (a hint; the AI may adjust). */
  duration?: number
  /** Change this piece instead of making a new one. */
  current?: Motion
}

/** Everything the renderer may ask the main process to do (exposed as window.studio). */

export interface RecorderSettings {
  micDeviceId?: string
  micEnabled: boolean
  /** Let Chromium even out the mic level while recording. */
  micAutoGain: boolean
  systemAudio: boolean
  fps: 30 | 60
  /** Also record the composed scene as one ready-to-upload video. */
  recordProgram: boolean
  /** Keep the Studio window out of screen recordings (off: Studio can be recorded like any app). */
  hideStudio: boolean
  minimizeOnRecord: boolean
  countdownSeconds: number
  /** Zoom screen recordings in where you click or type. */
  autoZoom: boolean
  /** How close auto zoom goes (2 = twice as close). */
  autoZoomScale: number
}

/** A click or keystroke while recording: epoch ms, and 0..1 of the recorded screen. */
export interface InputEvent {
  at: number
  kind: 'click' | 'key'
  x: number
  y: number
}

export interface AppSettings {
  /** Root folder that holds all project folders. */
  projectsRoot: string
  recorder: RecorderSettings
  ai: AiSettings
}

export type SettingsPatch = Partial<Omit<AppSettings, 'recorder' | 'ai'>> & {
  recorder?: Partial<RecorderSettings>
  ai?: {
    transcription?: Partial<AiSettings['transcription']>
    assistant?: Partial<AiSettings['assistant']>
    image?: Partial<AiSettings['image']>
    baseUrls?: AiSettings['baseUrls']
  }
}

export interface DisplaySource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** data: URL preview */
  thumbnail: string
}

/** `scene-N`: switch to the Nth scene (works while recording). */
export type Hotkey = 'toggle-record' | 'toggle-pause' | `scene-${number}`

/** One track of a take, in the order it was added to the recording (per kind). */
export interface TakeStream {
  label: string
  kind: 'video' | 'audio'
  /** File name (without extension) for this source, e.g. "Camera". Defaults to the label. */
  name?: string
}

export interface FinishedStream {
  label: string
  item: MediaItem
  /** Seconds after the take's first sample at which this stream starts. */
  offset: number
  /** Loudest audio peak in dB (audio streams only). */
  peakDb?: number
}

export interface ProjectSummary {
  name: string
  path: string
  updatedAt: string
}

export interface OpenedProject {
  path: string
  project: Project
}

export interface FfmpegInfo {
  ffmpegPath: string
  version: string
  /** Hardware H.264 encoders found, e.g. h264_qsv, h264_nvenc, h264_amf. */
  hwEncoders: string[]
}

export interface StudioApi {
  settings: {
    get(): Promise<AppSettings>
    set(patch: SettingsPatch): Promise<AppSettings>
  }
  dialog: {
    pickFolder(): Promise<string | null>
    pickMediaFiles(): Promise<string[]>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    create(name: string): Promise<OpenedProject>
    open(path: string): Promise<OpenedProject>
    save(path: string, project: Project): Promise<void>
    reveal(path: string): Promise<void>
  }
  media: {
    /** Copies (or links) files into the project and probes them. */
    import(projectPath: string, files: string[], link?: boolean): Promise<MediaItem[]>
    /** The given project-relative or absolute paths that no longer exist on disk. */
    missing(projectPath: string, paths: string[]): Promise<string[]>
    /** URL the renderer can use in <video>/<img> for a project-relative or absolute path. */
    url(projectPath: string, relOrAbsPath: string): string
    /** Absolute path of a File dropped from Explorer. */
    pathForFile(file: File): string
  }
  system: {
    ffmpegInfo(): Promise<FfmpegInfo>
    /** Dev only: reports the result of `--selftest-record`. */
    selftestDone(result: unknown): void
  }
  capture: {
    sources(): Promise<DisplaySource[]>
    /** Call right before getDisplayMedia() to choose what it captures. */
    prepare(sourceId: string | undefined, audio: boolean): Promise<void>
  }
  /** Clicks/typing during a recording (for auto zoom). */
  input: {
    /** Starts listening; false if no screen can be followed or the input hook is unavailable. */
    start(sources: { label: string; sourceId?: string }[]): Promise<boolean>
    /** Stops and returns the events per screen label. */
    stop(): Promise<Record<string, InputEvent[]>>
  }
  recording: {
    open(path: string): Promise<number>
    write(handle: number, position: number, data: Uint8Array): Promise<void>
    close(handle: number): Promise<void>
    finish(projectPath: string, takeFile: string, streams: TakeStream[]): Promise<FinishedStream[]>
  }
  files: {
    size(path: string): Promise<number>
    /** Bytes [start, end) of a file (used by the decoder during export). */
    read(path: string, start: number, end: number): Promise<Uint8Array>
    /** A not-yet-existing path like <project>\exports\<name>.mp4 (adds " (2)" etc. if needed). */
    exportPath(projectPath: string, name: string): Promise<string>
    /** Writes a text file into the project's exports folder (unique name); returns its path. */
    saveText(projectPath: string, fileName: string, text: string): Promise<string>
    /** Opens Explorer with the file selected. */
    showInFolder(path: string): Promise<void>
  }
  audio: {
    /** Waveform peaks, 0..255, 100 per second. */
    waveform(projectPath: string, media: MediaItem): Promise<Uint8Array>
    /** Creates (or reuses) the cleaned-up voice file; returns its project-relative path. */
    enhance(projectPath: string, media: MediaItem, level: Exclude<EnhanceLevel, 'off'>): Promise<string>
    /** Speech intervals in source seconds. */
    speech(projectPath: string, media: MediaItem): Promise<[number, number][]>
    /** Two-pass loudness normalization of a finished export (audio re-encoded, video copied). */
    normalize(file: string, targetLufs: number): Promise<{ before: number | null; after: number }>
  }
  ai: {
    status(): Promise<{ providers: ProviderStatus[]; settings: AiSettings }>
    /** Stores (encrypted) or removes (null) a provider's API key. */
    setKey(id: ProviderId, key: string | null): Promise<void>
    test(id: ProviderId): Promise<TestResult>
    transcribe(projectPath: string, media: MediaItem): Promise<Transcript>
    onProgress(cb: (p: { mediaId: string; done: number; total: number }) => void): () => void
    chat(system: string, messages: { role: 'user' | 'assistant'; content: string }[]): Promise<string>
    /** Asks the editing assistant; returns its reply and (maybe) a proposal to review. */
    assist(req: {
      project: Project
      selection: Selection | null
      playhead: number
      prompt: string
      history: { role: 'user' | 'assistant'; content: string }[]
      images: string[]
      focus?: Focus | null
    }): Promise<{ reply: string; proposal: Proposal | null }>
    onAssistStatus(cb: (text: string) => void): () => void
    /** Feedback step 1: turns the user's feedback into a precise editing instruction. */
    refine(req: {
      project: Project
      feedback: string
      history: { role: 'user' | 'assistant'; text: string }[]
      focus?: Focus | null
      selection?: Selection | null
      playhead: number
    }): Promise<RefinedFeedback>
    /** The project's saved assistant chat. */
    historyLoad(projectPath: string): Promise<ChatTurn[]>
    historySave(projectPath: string, turns: ChatTurn[]): Promise<void>
  }
  /** Generating images, SVG art/animations and music. */
  create: {
    /** Makes an image with the provider chosen in Settings and imports it into the project. */
    image(projectPath: string, req: ImageRequest): Promise<MediaItem>
    motion(req: MotionRequest): Promise<{ name: string; motion: Motion }>
    musicSearch(query: string, source: MusicSource, safe: boolean): Promise<MusicTrack[]>
    musicSuggest(project: Project): Promise<MusicSuggestion>
    /** Direct audio URL for previewing a YouTube result (expires after a few hours). */
    musicStreamUrl(pageUrl: string): Promise<string>
    /** Downloads a library track into the project. */
    musicDownload(projectPath: string, track: MusicTrack): Promise<MediaItem>
    /** Composes music with ElevenLabs. */
    musicGenerate(projectPath: string, req: { prompt: string; seconds: number; instrumental: boolean }): Promise<MediaItem>
  }
  /** Google Fonts (downloaded once, cached in userData/fonts). */
  fonts: {
    /** Every Google Fonts family, most popular first. */
    catalog(): Promise<FontInfo[]>
    /** A family's files; empty if it isn't a Google font (e.g. an installed Windows font). */
    faces(family: string): Promise<FontFaceData[]>
    /** A tiny font containing just the family's name, for the picker. */
    preview(family: string): Promise<Uint8Array<ArrayBuffer>>
  }
  /** Dev-only switches passed through environment variables. */
  dev: { mode?: string; /** Project folder for `--cli export`. */ project?: string }
  window: {
    hideFromCapture(hide: boolean): Promise<void>
    minimize(): Promise<void>
    restore(): Promise<void>
    /** Global hotkeys (work while minimized). Returns an unsubscribe function. */
    onHotkey(cb: (key: Hotkey) => void): () => void
  }
}
