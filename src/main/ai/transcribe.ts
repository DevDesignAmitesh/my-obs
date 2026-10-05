import { execFile } from 'child_process'
import { mkdir, rm } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { promisify } from 'util'
import type { MediaItem } from '@shared/project'
import type { Transcript, Word } from '@shared/transcript'
import { ffmpegPath } from '../ffmpeg'
import { speech } from '../audio'
import { getSettings } from '../settings'
import { transcriptionProvider } from './index'

const run = promisify(execFile)

/** Chunk length: ~10 min keeps each upload small (~1.8 MB) and gives useful progress. */
const TARGET_S = 600
const MAX_S = 900

/** Prompting with fillers makes Whisper keep "um"/"uh" instead of silently cleaning them up. */
const FILLER_PROMPT = 'Umm, let me think like, hmm... Okay, here is what I am, uh, like, thinking.'

/**
 * Splits [0, duration] into chunks of about `target` seconds, cutting in the middle of the pause
 * in speech nearest each target so no word is split between two uploads.
 */
export function planChunks(duration: number, speechIntervals: [number, number][], target = TARGET_S, max = MAX_S): [number, number][] {
  const gaps: number[] = [] // midpoints of silences
  for (let i = 1; i < speechIntervals.length; i++) gaps.push((speechIntervals[i - 1][1] + speechIntervals[i][0]) / 2)
  const chunks: [number, number][] = []
  let start = 0
  while (duration - start > max) {
    const ideal = start + target
    const candidates = gaps.filter((g) => g > start + target / 2 && g < start + max)
    const cut = candidates.length ? candidates.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a)) : ideal
    chunks.push([start, cut])
    start = cut
  }
  chunks.push([start, duration])
  return chunks
}

export async function transcribeMedia(
  projectPath: string,
  media: MediaItem,
  onProgress: (done: number, total: number) => void
): Promise<Transcript> {
  const { ai } = await getSettings()
  const provider = await transcriptionProvider(ai.transcription.provider)
  const src = isAbsolute(media.path) ? media.path : join(projectPath, media.path)
  const chunks: [number, number][] =
    media.duration > MAX_S ? planChunks(media.duration, await speech(projectPath, media)) : [[0, media.duration]]

  const tmpDir = join(projectPath, 'cache', 'transcribe-tmp')
  await mkdir(tmpDir, { recursive: true })
  const words: Word[] = []
  let language: string | undefined
  try {
    onProgress(0, chunks.length)
    for (let i = 0; i < chunks.length; i++) {
      const [a, b] = chunks[i]
      const part = join(tmpDir, `${media.id}-${i}.ogg`)
      // Mono 16 kHz Opus at 24 kbps: ~11 MB per hour, far under the 25 MB upload limit.
      await run(ffmpegPath, ['-y', '-v', 'error', '-ss', String(a), '-t', String(b - a), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', part])
      const r = await provider.transcribe(part, {
        model: ai.transcription.model,
        language: ai.transcription.language === 'auto' ? undefined : ai.transcription.language,
        prompt: ai.transcription.keepFillers ? FILLER_PROMPT : undefined
      })
      language ??= r.language
      for (const w of r.words) words.push({ text: w.text, start: w.start + a, end: w.end + a })
      await rm(part, { force: true })
      onProgress(i + 1, chunks.length)
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
  return {
    provider: ai.transcription.provider,
    model: ai.transcription.model,
    language,
    createdAt: new Date().toISOString(),
    words: words.sort((x, y) => x.start - y.start)
  }
}
