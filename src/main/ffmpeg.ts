import { execFile } from 'child_process'
import { promisify } from 'util'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { FfmpegInfo } from '@shared/api'

const run = promisify(execFile)

// In a packaged app the binaries are unpacked next to the asar archive.
const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

export const ffmpegPath = unpacked(ffmpegStatic as unknown as string)
export const ffprobePath = unpacked(ffprobeStatic.path)

export interface ProbeResult {
  duration: number
  video?: { width: number; height: number; fps: number; codec: string }
  audio?: { codec: string; sampleRate: number; channels: number }
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0
  const [n, d] = rate.split('/').map(Number)
  return d ? n / d : n
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file
  ])
  const data = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<Record<string, string | number | undefined> & { disposition?: { attached_pic?: number }; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }>
  }
  const streams = data.streams ?? []
  // Ignore cover-art "video" streams embedded in audio files.
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const a = streams.find((s) => s.codec_type === 'audio')
  // Phone videos are often stored sideways with a rotation flag; report the size as displayed.
  const rotation = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)
  const sideways = Math.abs(rotation) % 180 === 90
  return {
    duration: Number(data.format?.duration ?? 0) || 0,
    video: v && {
      width: Number(sideways ? v.height : v.width),
      height: Number(sideways ? v.width : v.height),
      fps: parseRate(String(v.avg_frame_rate ?? v.r_frame_rate ?? '')),
      codec: String(v.codec_name)
    },
    audio: a && {
      codec: String(a.codec_name),
      sampleRate: Number(a.sample_rate),
      channels: Number(a.channels)
    }
  }
}

/** Writes a small JPEG thumbnail of `file` at `atSeconds`. */
export async function thumbnail(file: string, out: string, atSeconds: number): Promise<void> {
  await run(ffmpegPath, [
    '-y', '-v', 'error',
    '-ss', String(Math.max(0, atSeconds)),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    out
  ])
}

let infoCache: FfmpegInfo | null = null

export async function ffmpegInfo(): Promise<FfmpegInfo> {
  if (infoCache) return infoCache
  const { stdout: ver } = await run(ffmpegPath, ['-version'])
  // Being compiled in doesn't mean the GPU supports it, so test-encode one frame with each.
  const candidates = ['h264_qsv', 'hevc_qsv', 'h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_mf']
  const works = await Promise.all(
    candidates.map((c) =>
      run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256', '-frames:v', '1', '-c:v', c, '-f', 'null', '-']).then(
        () => true,
        () => false
      )
    )
  )
  const hwEncoders = candidates.filter((_, i) => works[i])
  infoCache = { ffmpegPath, version: ver.split('\n')[0].trim(), hwEncoders }
  return infoCache
}
