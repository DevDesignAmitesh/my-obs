import {
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  type StreamTargetChunk
} from 'mediabunny'
import type { FinishedStream, TakeStream } from '@shared/api'
import { FramePump } from './frame-pump'

/** Bitrate caps (bits/s). Hardware encoders overshoot badly on noisy webcam images without them. */
export const VIDEO_BITRATE = { screen: 8_000_000, camera: 4_000_000, program: 8_000_000 }

export type TakeTrack =
  | { label: string; kind: 'video'; track: MediaStreamVideoTrack; role: keyof typeof VIDEO_BITRATE; name?: string }
  | { label: string; kind: 'audio'; track: MediaStreamAudioTrack }

/**
 * Records all tracks of a take into ONE fragmented MP4 that is streamed to disk as it grows:
 * tracks stay in sync (same clock) and a crash leaves a playable file. On stop, the main process
 * splits it into one file per source.
 */
export class TakeRecorder {
  private sources: (MediaStreamVideoTrackSource | MediaStreamAudioTrackSource)[] = []
  private pumps: FramePump[] = []
  private startedAt = 0
  private pausedAt = 0
  private pausedTotal = 0
  /** Wall-clock start and pauses (epoch ms), to place clicks/typing on the take's time. */
  private startedEpoch = 0
  private pauses: { from: number; to: number }[] = []
  readonly takeFile: string

  private constructor(
    private projectPath: string,
    private output: Output,
    private handle: number,
    private streams: TakeStream[],
    takeFile: string
  ) {
    this.takeFile = takeFile
  }

  static async start(projectPath: string, tracks: TakeTrack[], fps: number, onError: (e: Error) => void): Promise<TakeRecorder> {
    if (!tracks.length) throw new Error('Nothing to record: add a source or enable the microphone')

    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: 1920, height: 1080 })
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'])
    if (!videoCodec && tracks.some((t) => t.kind === 'video')) throw new Error('No video encoder available')
    if (!audioCodec && tracks.some((t) => t.kind === 'audio')) throw new Error('No audio encoder available')

    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    const takeFile = `${projectPath}\\recordings\\Take ${stamp}\\take.partial.mp4`
    const handle = await window.studio.recording.open(takeFile)

    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => window.studio.recording.write(handle, chunk.position, chunk.data)
    })
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 })
    })

    // Readable, unique file names: "Camera", "Screen", "Camera 2"…
    const used = new Map<string, number>()
    const streams = tracks.map((t) => {
      const base = ('name' in t && t.name) || t.label
      const n = (used.get(base) ?? 0) + 1
      used.set(base, n)
      return { label: t.label, kind: t.kind, name: n > 1 ? `${base} ${n}` : base }
    })
    const rec = new TakeRecorder(projectPath, output, handle, streams, takeFile)
    for (const t of tracks) {
      if (t.kind === 'video') {
        // Screens only send frames on change; the pump keeps a static screen recording.
        let track = t.track
        if (t.role === 'screen') {
          const pump = new FramePump(t.track)
          rec.pumps.push(pump)
          track = pump.track
        }
        const src = new MediaStreamVideoTrackSource(
          track,
          {
            codec: videoCodec!,
            bitrate: VIDEO_BITRATE[t.role],
            bitrateMode: 'variable',
            keyFrameInterval: 2,
            latencyMode: 'realtime',
            hardwareAcceleration: 'prefer-hardware',
            // Windows can be resized mid-recording; keep the first frame's size.
            sizeChangeBehavior: 'contain',
            contentHint: t.role === 'screen' ? 'detail' : 'motion'
          },
          { frameRate: fps }
        )
        output.addVideoTrack(src, { frameRate: fps })
        rec.sources.push(src)
      } else {
        const src = new MediaStreamAudioTrackSource(t.track, { codec: audioCodec!, quality: QUALITY_HIGH })
        output.addAudioTrack(src)
        rec.sources.push(src)
      }
    }
    for (const s of rec.sources) s.errorPromise.catch((e: Error) => onError(e))

    await output.start()
    rec.startedAt = performance.now()
    rec.startedEpoch = Date.now()
    return rec
  }

  get paused(): boolean {
    return this.pausedAt > 0
  }

  /** Recorded seconds, excluding pauses. */
  get elapsed(): number {
    if (!this.startedAt) return 0
    const now = this.pausedAt || performance.now()
    return (now - this.startedAt - this.pausedTotal) / 1000
  }

  pause(): void {
    if (this.paused) return
    for (const s of this.sources) s.pause()
    this.pausedAt = performance.now()
    this.pauses.push({ from: Date.now(), to: Infinity })
  }

  resume(): void {
    if (!this.paused) return
    for (const s of this.sources) s.resume()
    this.pausedTotal += performance.now() - this.pausedAt
    this.pausedAt = 0
    this.pauses[this.pauses.length - 1].to = Date.now()
  }

  /** Take seconds at a wall-clock time (epoch ms), or null if it was before the start or while paused. */
  takeTime(epochMs: number): number | null {
    if (!this.startedEpoch || epochMs < this.startedEpoch) return null
    let paused = 0
    for (const p of this.pauses) {
      if (epochMs >= p.from && epochMs < p.to) return null
      if (epochMs >= p.to) paused += p.to - p.from
    }
    return (epochMs - this.startedEpoch - paused) / 1000
  }

  /** Finalizes the file, splits it per source and returns the imported media. */
  async stop(): Promise<FinishedStream[]> {
    // Make sure a static screen still has a frame right at the end of the take.
    for (const p of this.pumps) p.repeatLast()
    await new Promise((r) => setTimeout(r, 100))
    try {
      await this.output.finalize()
    } finally {
      for (const p of this.pumps) p.close()
      await window.studio.recording.close(this.handle)
    }
    return window.studio.recording.finish(this.projectPath, this.takeFile, this.streams)
  }

  async cancel(): Promise<void> {
    await this.output.cancel().catch(() => undefined)
    for (const p of this.pumps) p.close()
    await window.studio.recording.close(this.handle)
  }
}
