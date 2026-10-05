import { sourceKey, type Scene, type SceneItem } from '@shared/scene'
import type { Project } from '@shared/project'
import type { Drawable } from './compositor'

/**
 * Keeps the live capture streams needed by all scenes (screens/windows, cameras, images), plus the
 * microphone and system audio. Each distinct source is captured once, even if several scene items
 * show it, and stays live across scenes so switching scenes (even while recording) is instant.
 */

interface Live {
  key: string
  stream?: MediaStream
  el: HTMLVideoElement | HTMLImageElement
}

// getDisplayMedia calls must not overlap: each one uses the source prepared just before it.
let displayQueue: Promise<unknown> = Promise.resolve()

function captureDisplay(sourceId: string | undefined, fps: number, audio: boolean): Promise<MediaStream> {
  const next = displayQueue.then(async () => {
    await window.studio.capture.prepare(sourceId, audio)
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio
    })
  })
  displayQueue = next.catch(() => undefined)
  return next
}

function videoElementFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.srcObject = stream
  // Kept in the DOM (invisible) so Chromium never suspends it while the window is minimized.
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
  document.body.appendChild(v)
  v.play().catch(() => undefined)
  return v
}

function stopLive(l: Live): void {
  l.stream?.getTracks().forEach((t) => t.stop())
  if (l.el instanceof HTMLVideoElement) l.el.srcObject = null
  l.el.remove()
}

export class LiveSources {
  private live = new Map<string, Live>()
  private pending = new Map<string, Promise<void>>()
  private mic?: MediaStream
  private system?: MediaStream
  errors = new Map<string, string>()
  onChange?: () => void

  constructor(private fps: number) {}

  /** Starts captures the scenes need and stops the ones no scene uses any more. */
  async syncScenes(scenes: Scene[], project: Project, projectPath: string): Promise<void> {
    const wanted = new Map<string, SceneItem>()
    for (const scene of scenes) for (const i of scene.items) if (i.visible && !wanted.has(sourceKey(i))) wanted.set(sourceKey(i), i)
    for (const [key, l] of this.live) {
      if (!wanted.has(key)) {
        stopLive(l)
        this.live.delete(key)
      }
    }
    // Displays are started one at a time: each getDisplayMedia call relies on the prepared source.
    for (const [key, item] of wanted) {
      if (this.live.has(key)) continue
      if (!this.pending.has(key)) this.pending.set(key, this.start(key, item, project, projectPath))
      await this.pending.get(key)
      this.pending.delete(key)
    }
  }

  private async start(key: string, item: SceneItem, project: Project, projectPath: string): Promise<void> {
    const s = item.source
    try {
      let live: Live
      if (s.type === 'display') {
        const stream = await captureDisplay(s.sourceId, this.fps, false)
        live = { key, stream, el: videoElementFor(stream) }
      } else if (s.type === 'camera') {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: s.deviceId ? { exact: s.deviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }
        })
        live = { key, stream, el: videoElementFor(stream) }
      } else {
        const media = project.media.find((m) => m.id === s.mediaId)
        if (!media) throw new Error('Pick an image')
        const img = new Image()
        img.crossOrigin = 'anonymous' // keeps the canvas recordable
        img.src = window.studio.media.url(projectPath, media.path)
        await img.decode()
        live = { key, el: img }
      }
      // Stream ended from outside (window closed, camera unplugged).
      live.stream?.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.live.get(key) === live) {
          this.live.delete(key)
          this.errors.set(key, `${item.name} stopped`)
          this.onChange?.()
        }
      })
      this.live.set(key, live)
      this.errors.delete(key)
    } catch (e) {
      this.errors.set(key, `${item.name}: ${(e as Error).message}`)
    }
    this.onChange?.()
  }

  /** Stops and re-captures one scene item's source (after its source was changed). */
  restart(item: SceneItem): void {
    const key = sourceKey(item)
    const l = this.live.get(key)
    if (l) stopLive(l)
    this.live.delete(key)
  }

  drawable(item: SceneItem): Drawable | null {
    const l = this.live.get(sourceKey(item))
    if (!l) return null
    if (l.el instanceof HTMLVideoElement) {
      return l.el.readyState >= 2 ? { el: l.el, width: l.el.videoWidth, height: l.el.videoHeight } : null
    }
    return { el: l.el, width: l.el.naturalWidth, height: l.el.naturalHeight }
  }

  videoTrack(item: SceneItem): MediaStreamVideoTrack | null {
    return (this.live.get(sourceKey(item))?.stream?.getVideoTracks()[0] as MediaStreamVideoTrack) ?? null
  }

  error(item: SceneItem): string | undefined {
    return this.errors.get(sourceKey(item))
  }

  async setMic(enabled: boolean, deviceId?: string, autoGain = true): Promise<MediaStream | undefined> {
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic = undefined
    if (!enabled) return undefined
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          // Noise cleanup happens in the editor; automatic gain keeps quiet mics at a usable level.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: autoGain,
          channelCount: 1
        }
      })
      this.errors.delete('mic')
    } catch (e) {
      this.errors.set('mic', `Microphone: ${(e as Error).message}`)
    }
    this.onChange?.()
    return this.mic
  }

  /** Windows system audio via loopback. getDisplayMedia needs a video track too; we drop it. */
  async setSystemAudio(enabled: boolean): Promise<void> {
    this.system?.getTracks().forEach((t) => t.stop())
    this.system = undefined
    if (!enabled) return
    try {
      const stream = await captureDisplay(undefined, 1, true)
      stream.getVideoTracks().forEach((t) => {
        t.stop()
        stream.removeTrack(t)
      })
      this.system = stream
      this.errors.delete('system')
    } catch (e) {
      this.errors.set('system', `System audio: ${(e as Error).message}`)
    }
    this.onChange?.()
  }

  get micStream(): MediaStream | undefined {
    return this.mic
  }
  get micTrack(): MediaStreamAudioTrack | null {
    return (this.mic?.getAudioTracks()[0] as MediaStreamAudioTrack) ?? null
  }
  get systemTrack(): MediaStreamAudioTrack | null {
    return (this.system?.getAudioTracks()[0] as MediaStreamAudioTrack) ?? null
  }

  dispose(): void {
    for (const l of this.live.values()) stopLive(l)
    this.live.clear()
    this.mic?.getTracks().forEach((t) => t.stop())
    this.system?.getTracks().forEach((t) => t.stop())
  }
}
