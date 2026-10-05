import { execFile, spawn } from 'child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'
import { promisify } from 'util'
import { ENHANCE_FILTER, enhancedAudioPath } from '@shared/audio'
import type { EnhanceLevel, MediaItem } from '@shared/project'
import { ffmpegPath, probe } from './ffmpeg'

const run = promisify(execFile)

/** Waveform resolution: peaks per second of audio. */
export const PEAKS_PER_SECOND = 100
const PEAK_RATE = 8000

const absMedia = (projectPath: string, m: MediaItem): string => (isAbsolute(m.path) ? m.path : join(projectPath, m.path))

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Runs each distinct job once even if requested several times concurrently. */
const inflight = new Map<string, Promise<unknown>>()
function once<T>(key: string, job: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined
  if (!p) {
    p = job().finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

/** Writes via a temp file so a half-finished file never looks complete. */
async function ffmpegTo(out: string, args: string[]): Promise<void> {
  await mkdir(dirname(out), { recursive: true })
  const tmp = `${out}.part${out.slice(out.lastIndexOf('.'))}`
  try {
    await run(ffmpegPath, ['-y', '-v', 'error', ...args, tmp], { maxBuffer: 1 << 26 })
    await rename(tmp, out)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/**
 * Waveform peaks (0..255, one per 1/100 s) for a media item's sound, cached in cache/waveforms.
 * Streamed from FFmpeg so hour-long recordings don't need much memory.
 */
export function waveform(projectPath: string, media: MediaItem): Promise<Uint8Array> {
  const cacheFile = join(projectPath, 'cache', 'waveforms', `${media.id}.bin`)
  return once(cacheFile, async () => {
    if (await exists(cacheFile)) return new Uint8Array(await readFile(cacheFile))
    const perPeak = PEAK_RATE / PEAKS_PER_SECOND
    const peaks: number[] = []
    let count = 0
    let max = 0
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-v', 'error', '-i', absMedia(projectPath, media), '-vn', '-ac', '1', '-ar', String(PEAK_RATE), '-f', 's16le', '-'])
      let carry: Buffer | null = null
      ff.stdout.on('data', (chunk: Buffer) => {
        const buf = carry ? Buffer.concat([carry, chunk]) : chunk
        const usable = buf.length - (buf.length % 2)
        for (let i = 0; i < usable; i += 2) {
          const v = Math.abs(buf.readInt16LE(i))
          if (v > max) max = v
          if (++count === perPeak) {
            peaks.push(Math.min(255, Math.round((max / 32768) * 255)))
            count = 0
            max = 0
          }
        }
        carry = usable < buf.length ? buf.subarray(usable) : null
      })
      ff.on('error', reject)
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Waveform failed for ${media.name}`))))
    })
    if (count) peaks.push(Math.min(255, Math.round((max / 32768) * 255)))
    const data = Uint8Array.from(peaks)
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, data)
    return data
  })
}

/** "Enhance voice" (see ENHANCE_FILTER). Output is lossless FLAC in cache/audio; returns its project-relative path. */
export function enhance(projectPath: string, media: MediaItem, level: Exclude<EnhanceLevel, 'off'>): Promise<string> {
  const rel = enhancedAudioPath(media.id, level)
  const out = join(projectPath, rel)
  return once(out, async () => {
    if (!(await exists(out))) {
      await ffmpegTo(out, [
        '-i', absMedia(projectPath, media),
        '-vn',
        '-af', ENHANCE_FILTER[level],
        '-c:a', 'flac'
      ])
    }
    return rel
  })
}

/** Silence threshold used to find speech. */
const SPEECH_DB = -38
const MIN_SILENCE_S = 0.35

/** Parses FFmpeg silencedetect output into speech intervals (the gaps between silences). */
export function speechFromSilence(log: string, duration: number): [number, number][] {
  const speech: [number, number][] = []
  let cursor = 0
  for (const m of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]))
    if (m[1] === 'start') {
      if (t - cursor > 0.15) speech.push([cursor, t])
    } else cursor = t
  }
  // Ends while talking (no final silence_start after the last silence_end).
  const lastStart = log.lastIndexOf('silence_start')
  const lastEnd = log.lastIndexOf('silence_end')
  if ((lastStart < lastEnd || lastStart === -1) && duration - cursor > 0.15) speech.push([cursor, duration])
  return speech
}

/** Where someone is talking in a media item (source seconds), cached in cache/speech. */
export function speech(projectPath: string, media: MediaItem): Promise<[number, number][]> {
  const cacheFile = join(projectPath, 'cache', 'speech', `${media.id}.json`)
  return once(cacheFile, async () => {
    if (await exists(cacheFile)) return JSON.parse(await readFile(cacheFile, 'utf8'))
    const { stderr } = await run(
      ffmpegPath,
      ['-v', 'info', '-i', absMedia(projectPath, media), '-vn', '-af', `silencedetect=noise=${SPEECH_DB}dB:d=${MIN_SILENCE_S}`, '-f', 'null', '-'],
      { maxBuffer: 1 << 26 }
    )
    const result = speechFromSilence(stderr, media.duration)
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(result))
    return result
  })
}

export interface LoudnessResult {
  /** Integrated loudness before, LUFS (null if silent). */
  before: number | null
  after: number
}

/**
 * Two-pass EBU R128 loudness normalization of a finished export, in place. Only the audio is
 * re-encoded; the video stream is copied untouched.
 */
export async function normalizeLoudness(file: string, targetLufs: number): Promise<LoudnessResult> {
  // A video without any sound (e.g. a screen recording with no mic or computer audio): nothing to balance.
  if (!(await probe(file)).audio) return { before: null, after: targetLufs }
  const filter = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`
  const { stderr } = await run(ffmpegPath, ['-v', 'info', '-i', file, '-vn', '-af', `${filter}:print_format=json`, '-f', 'null', '-'], {
    maxBuffer: 1 << 26
  })
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)
  const m = JSON.parse(json) as Record<string, string>
  const before = Number(m.input_i)
  if (!Number.isFinite(before)) return { before: null, after: targetLufs } // silent: nothing to do

  const tmp = `${file}.loudnorm.mp4`
  try {
    await run(ffmpegPath, [
      '-y', '-v', 'error',
      '-i', file,
      '-map', '0',
      '-c:v', 'copy',
      '-af', `${filter}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      tmp
    ])
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  return { before, after: targetLufs }
}

/** Integrated loudness of a file in LUFS (used by tests and the export report). */
export async function measureLoudness(file: string): Promise<number> {
  const { stderr } = await run(ffmpegPath, ['-v', 'info', '-i', file, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { maxBuffer: 1 << 26 })
  return Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)).input_i)
}
