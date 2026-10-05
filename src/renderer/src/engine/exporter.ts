import { themeAt } from '@shared/sections'
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  CanvasSource,
  CustomSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  type StreamTargetChunk,
  type VideoSample
} from 'mediabunny'
import { audioSegments, gainAt, visualLayersAt, type AudioSegment } from '@shared/render-plan'
import { projectDuration, type MediaItem, type Project } from '@shared/project'
import { drawTimelineFrame, type LayerImage } from './draw'
import { soundSource } from './player'
import { drawCaptions } from './captions-draw'
import { ensureProjectFonts } from '../fonts'
import { rasterWidth, renderFrame } from './motion-render'

export interface ExportOptions {
  /** Absolute output path (.mp4). */
  path: string
  width: number
  height: number
  fps: number
  videoBitrate: number
}

export interface ExportProgress {
  done: number
  total: number
  /** Frames per second being rendered. */
  speed: number
}

const SAMPLE_RATE = 48000
const CHUNK_S = 10
const AUDIO_BITRATE = 192_000

const absPath = (projectPath: string, p: string): string => (/^[a-zA-Z]:[\\/]/.test(p) ? p : `${projectPath}\\${p}`)

/** Opens media files through the main process (no size limits, no CORS). */
class MediaInputs {
  private inputs = new Map<string, Input>()
  private images = new Map<string, ImageBitmap>()

  constructor(private projectPath: string) {}

  input(media: MediaItem): Input {
    let input = this.inputs.get(media.id)
    if (!input) {
      const path = absPath(this.projectPath, media.path)
      input = new Input({
        formats: ALL_FORMATS,
        source: new CustomSource({
          getSize: () => window.studio.files.size(path),
          read: (start, end) => window.studio.files.read(path, start, end),
          prefetchProfile: 'fileSystem'
        })
      })
      this.inputs.set(media.id, input)
    }
    return input
  }

  async image(media: MediaItem): Promise<ImageBitmap> {
    let img = this.images.get(media.id)
    if (!img) {
      const path = absPath(this.projectPath, media.path)
      const bytes = await window.studio.files.read(path, 0, await window.studio.files.size(path))
      img = await createImageBitmap(new Blob([bytes as BlobPart]))
      this.images.set(media.id, img)
    }
    return img
  }

  dispose(): void {
    for (const i of this.inputs.values()) i.dispose()
    for (const b of this.images.values()) b.close()
  }
}

/** Sequential frame reader for one clip: decodes forward only, like a playhead. */
class FrameCursor {
  private it: AsyncGenerator<VideoSample, void, unknown>
  private current: VideoSample | null = null
  private next: VideoSample | null = null
  private started = false
  private ended = false
  /** Upright copy of the frame for videos with rotation metadata (phone recordings). */
  private upright: OffscreenCanvas | null = null

  constructor(sink: VideoSampleSink, from: number) {
    this.it = sink.samples(Math.max(0, from))
  }

  /** The frame that is showing at source time `ts` (or the last one before it). */
  async at(ts: number): Promise<VideoSample | null> {
    if (!this.started) {
      this.started = true
      await this.pull()
      this.current = this.next
      this.next = null
      await this.pull()
    }
    while (this.next && this.next.timestamp <= ts + 1e-4) {
      this.current?.close()
      this.current = this.next
      this.next = null
      await this.pull()
    }
    return this.current
  }

  /**
   * The frame as the preview's <video> shows it. toCanvasImageSource() ignores rotation/flip
   * metadata, while displayWidth/Height include it, so rotated phone videos come out sideways and
   * squashed unless the rotation is baked in first.
   */
  image(sample: VideoSample): CanvasImageSource {
    if (!sample.rotation && !sample.flip) return sample.toCanvasImageSource()
    const w = sample.displayWidth
    const h = sample.displayHeight
    if (!this.upright || this.upright.width !== w || this.upright.height !== h) this.upright = new OffscreenCanvas(w, h)
    sample.draw(this.upright.getContext('2d')!, 0, 0, w, h)
    return this.upright
  }

  private async pull(): Promise<void> {
    if (this.ended) return
    const r = await this.it.next()
    if (r.done) this.ended = true
    else this.next = r.value
  }

  close(): void {
    this.current?.close()
    this.next?.close()
    void this.it.return(undefined)
  }
}

/**
 * Renders the timeline to an MP4: every frame drawn with the same renderer as the preview,
 * audio mixed with the same gain envelopes. Work is interleaved in 10 s chunks (audio, then that
 * stretch of video) so memory stays flat even for long videos.
 */
export async function exportProject(
  project: Project,
  projectPath: string,
  opts: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const { width: W, height: H, fps } = opts
  const duration = projectDuration(project)
  if (duration <= 0) throw new Error('The timeline is empty')
  await ensureProjectFonts(project)
  const totalFrames = Math.max(1, Math.round(duration * fps))

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: W, height: H })
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'])
  if (!videoCodec) throw new Error('No video encoder available')

  const handle = await window.studio.recording.open(opts.path)
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (c) => window.studio.recording.write(handle, c.position, c.data) }), {
      chunked: true,
      chunkSize: 8 * 1024 * 1024
    })
  })

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })!
  const video = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: opts.videoBitrate,
    bitrateMode: 'variable',
    keyFrameInterval: 2,
    hardwareAcceleration: 'prefer-hardware'
  })
  output.addVideoTrack(video, { frameRate: fps })
  const segments = audioSegments(project)
  const audio = audioCodec && segments.length ? new AudioBufferSource({ codec: audioCodec, bitrate: AUDIO_BITRATE }) : null
  if (audio) output.addAudioTrack(audio)

  const inputs = new MediaInputs(projectPath)
  const cursors = new Map<string, FrameCursor>()
  const sinks = new Map<string, VideoSampleSink | null>()
  const videoSink = async (media: MediaItem): Promise<VideoSampleSink | null> => {
    if (!sinks.has(media.id)) {
      const track = await inputs.input(media).getPrimaryVideoTrack()
      sinks.set(media.id, track ? new VideoSampleSink(track) : null)
    }
    return sinks.get(media.id)!
  }

  const started = performance.now()
  let ok = false
  try {
    await output.start()
    for (let chunkStart = 0; chunkStart < duration; chunkStart += CHUNK_S) {
      const chunkEnd = Math.min(duration, chunkStart + CHUNK_S)
      if (audio) await audio.add(await mixAudio(segments, inputs, chunkStart, chunkEnd))

      const firstFrame = Math.round(chunkStart * fps)
      const lastFrame = Math.min(totalFrames, Math.round(chunkEnd * fps))
      for (let f = firstFrame; f < lastFrame; f++) {
        if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
        const t = f / fps
        const layers = visualLayersAt(project, t)
        const images: LayerImage[] = []
        const used = new Set<string>()
        for (const layer of layers) {
          used.add(layer.key)
          const motion = layer.media.motion
          if (layer.media.kind === 'motion' && motion) {
            const img = await renderFrame(motion, layer.sourceTime, rasterWidth(motion, W, H, layer.transform.scale))
            images.push({ layer, image: img, width: img.naturalWidth, height: img.naturalHeight })
            continue
          }
          if (layer.media.kind === 'color' || layer.media.kind === 'graphic') {
            images.push({ layer, image: null, width: project.settings.width, height: project.settings.height })
            continue
          }
          if (layer.media.kind === 'image') {
            const img = await inputs.image(layer.media)
            images.push({ layer, image: img, width: img.width, height: img.height })
            continue
          }
          let cursor = cursors.get(layer.key)
          if (!cursor) {
            const sink = await videoSink(layer.media)
            if (!sink) continue
            cursor = new FrameCursor(sink, layer.sourceTime)
            cursors.set(layer.key, cursor)
          }
          const sample = await cursor.at(layer.sourceTime)
          if (sample) {
            images.push({ layer, image: cursor.image(sample), width: sample.displayWidth, height: sample.displayHeight })
          }
        }
        // Clips that ended free their decoders.
        for (const [key, c] of cursors) {
          if (!used.has(key)) {
            c.close()
            cursors.delete(key)
          }
        }
        // Captions are laid out for the project size; scale them to the export size.
        const sw = W / project.settings.width
        drawTimelineFrame(ctx, W, H, images, {
          theme: themeAt(project, t),
          overlay: (c) => {
            c.save()
            c.scale(sw, H / project.settings.height)
            drawCaptions(c, project, t, project.settings.width, project.settings.height)
            c.restore()
          }
        })
        await video.add(t, 1 / fps)
        if (f % 5 === 0) onProgress({ done: f, total: totalFrames, speed: f / ((performance.now() - started) / 1000) })
      }
    }
    await output.finalize()
    ok = true
    onProgress({ done: totalFrames, total: totalFrames, speed: totalFrames / ((performance.now() - started) / 1000) })
  } finally {
    for (const c of cursors.values()) c.close()
    inputs.dispose()
    if (!ok) await output.cancel().catch(() => undefined)
    await window.studio.recording.close(handle)
  }
}

/** Mixes all audio of [from, to) into one stereo buffer, applying volume/fade envelopes. */
async function mixAudio(segments: AudioSegment[], inputs: MediaInputs, from: number, to: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round((to - from) * SAMPLE_RATE))
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE)
  for (const seg of segments) {
    const segEnd = seg.start + seg.duration
    if (segEnd <= from || seg.start >= to) continue
    const track = await inputs.input(soundSource(seg).media).getPrimaryAudioTrack()
    if (!track) continue

    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    // Envelope points are in timeline time; the context clock starts at `from`.
    gain.gain.setValueAtTime(gainAt(seg, from), 0)
    for (const [t, g] of seg.envelope) if (t > from) gain.gain.linearRampToValueAtTime(g, t - from)

    const localStart = Math.max(from, seg.start)
    const localEnd = Math.min(to, segEnd)
    // The part of this chunk where the segment is audible, on the chunk's clock.
    const winStart = localStart - from
    const winEnd = localEnd - from
    const srcFrom = seg.in + (localStart - seg.start)
    const srcTo = seg.in + (localEnd - seg.start)
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(srcFrom, srcTo)) {
      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.connect(gain)
      // Where this decoded buffer's first sample lands on the chunk's clock.
      const at = seg.start + (timestamp - seg.in) - from
      // Decoded buffers can start before the clip's in-point: skip that part.
      if (at < winStart) node.start(winStart, winStart - at)
      else node.start(at)
      node.stop(winEnd)
    }
  }
  return ctx.startRendering()
}
