/**
 * Windows screen capture only delivers a frame when something on screen changes, so a static
 * screen would produce a video that ends early. The pump passes frames through unchanged and,
 * when the source goes quiet, re-emits the last frame (no pixel copy) so the track keeps flowing.
 */

// Insertable Streams (Chromium). Not yet in TypeScript's DOM lib.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<VideoFrame>
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' })
  readonly writable: WritableStream<VideoFrame>
}

const IDLE_MS = 200

export class FramePump {
  readonly track: MediaStreamVideoTrack
  private writer: WritableStreamDefaultWriter<VideoFrame>
  private last: VideoFrame | null = null
  private lastArrival = 0
  private timer: ReturnType<typeof setInterval>
  private closed = false
  private writing: Promise<void> = Promise.resolve()

  constructor(source: MediaStreamVideoTrack) {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })
    this.track = generator as unknown as MediaStreamVideoTrack
    this.writer = generator.writable.getWriter()
    void this.pull(new MediaStreamTrackProcessor({ track: source }).readable.getReader())
    this.timer = setInterval(() => {
      if (performance.now() - this.lastArrival >= IDLE_MS) this.repeatLast()
    }, IDLE_MS / 2)
  }

  private async pull(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
    while (!this.closed) {
      const { value: frame, done } = await reader.read()
      if (done || !frame) break
      this.last?.close()
      this.last = frame.clone()
      this.lastArrival = performance.now()
      this.write(frame)
    }
    reader.releaseLock()
  }

  private write(frame: VideoFrame): void {
    this.writing = this.writing.then(() => this.writer.write(frame)).catch(() => frame.close())
  }

  /** Emits the last frame again, timestamped as if it were captured now. */
  repeatLast(): void {
    if (!this.last || this.closed) return
    const now = performance.now()
    const timestamp = this.last.timestamp + Math.round((now - this.lastArrival) * 1000)
    const copy = new VideoFrame(this.last, { timestamp })
    this.last.close()
    this.last = copy.clone()
    this.lastArrival = now
    this.write(copy)
  }

  close(): void {
    this.closed = true
    clearInterval(this.timer)
    this.last?.close()
    this.last = null
    this.writer.close().catch(() => undefined)
  }
}
