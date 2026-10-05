import type { FinishedStream } from './api'
import { newId, projectDuration, type MediaItem, type Project } from './project'
import { placeInRect, placementToTransform, rectToPixels, sourceKey, type Scene, type SceneItem } from './scene'
import { snap, type EditOp } from './ops'
import { zoomsFromInput, type InputMark } from './zoom'

/** Labels used for the audio streams of a take. Video streams are labelled by scene item id. */
export const MIC_LABEL = 'mic'
export const SYSTEM_LABEL = 'system-audio'
export const PROGRAM_LABEL = 'program'

/** A mic take whose loudest peak is below this gets its clip volume raised... */
const QUIET_MIC_DB = -12
/** ...so that its peak lands here (capped at the 4x clip volume limit). */
const TARGET_PEAK_DB = -3

/** Clip volume that brings a quiet recording's peak up to TARGET_PEAK_DB (1 if it is loud enough). */
export function micGainFor(peakDb: number | undefined): number {
  if (peakDb === undefined || !Number.isFinite(peakDb) || peakDb >= QUIET_MIC_DB) return 1
  return Math.min(4, Math.round(10 ** ((TARGET_PEAK_DB - peakDb) / 20) * 100) / 100)
}

/** The scene shown from `at` seconds into the take (until the next switch). */
export interface SceneSwitch {
  at: number
  scene: Scene
}

/**
 * Turns a finished take into edit ops: every recorded source becomes clips at the end of the
 * timeline, laid out like it was in the scene, so the layout stays editable after recording.
 * Video streams are labelled by sourceKey. When the scene was switched during the take, each
 * stretch gets the layout of the scene shown then (one clip per source per stretch).
 * The composed "program" video is only added to the media bin.
 */
export function takeToOps(
  project: Project,
  switches: SceneSwitch[] | Scene,
  finished: FinishedStream[],
  /** Clicks and typing per screen (by stream label, take seconds), for auto zoom. */
  input?: { marks: Record<string, InputMark[]>; scale: number }
): EditOp[] {
  const { width: W, height: H, fps } = project.settings
  const ops: EditOp[] = [{ op: 'addMedia', items: finished.map((f) => f.item) }]
  const byLabel = new Map(finished.map((f) => [f.label, f]))
  const t0 = snap(projectDuration(project), fps)
  const takeLength = Math.max(0, ...finished.map((f) => f.offset + f.item.duration))
  const list = (Array.isArray(switches) ? switches : [{ at: 0, scene: switches }]).filter((s, i, a) => i === 0 || s.scene.id !== a[i - 1].scene.id)

  const visibleLayers = (scene: Scene): SceneItem[] => scene.items.filter((i) => i.visible)
  const ensureTracks = (kind: 'video' | 'audio', count: number): string[] => {
    const ids = project.tracks.filter((t) => t.kind === kind).map((t) => t.id)
    while (ids.length < count) {
      const trackId = newId()
      ops.push({ op: 'addTrack', kind, trackId })
      ids.push(trackId)
    }
    return ids
  }
  const videoTracks = ensureTracks('video', Math.max(0, ...list.map((s) => visibleLayers(s.scene).length)))

  list.forEach(({ at, scene }, n) => {
    const from = n === 0 ? 0 : at
    const to = n + 1 < list.length ? list[n + 1].at : takeLength
    if (to - from < 1 / fps) return
    // Video layers, back to front, each with the media that fills it during [from, to).
    visibleLayers(scene).forEach((item, k) => {
      let media: MediaItem | undefined
      let offset = 0
      if (item.source.type === 'image') media = project.media.find((m) => m.id === (item.source as { mediaId?: string }).mediaId)
      else {
        const f = byLabel.get(sourceKey(item)) ?? byLabel.get(item.id)
        media = f?.item
        offset = f?.offset ?? 0
      }
      if (!media) return
      const still = media.kind === 'image'
      const inPt = still ? 0 : Math.max(0, from - offset)
      const outPt = still ? to - from : Math.min(media.duration, to - offset)
      if (outPt - inPt < 1 / fps) return
      const clipId = newId()
      ops.push({ op: 'insertClip', trackId: videoTracks[k], mediaId: media.id, start: t0 + Math.max(from, still ? from : offset), in: inPt, out: outPt, clipId })
      // Screens zoom in where you clicked or typed (marks are take time; zooms are source time).
      const marks = input?.marks[sourceKey(item)]
      if (marks?.length && !still) {
        const zooms = zoomsFromInput(marks.map((m) => ({ ...m, t: m.t - offset })), input!.scale, media.duration)
        if (zooms.length) ops.push({ op: 'setZooms', clipId, zooms })
      }
      if (media.width && media.height) {
        const placement = placeInRect(media.width, media.height, rectToPixels(item.rect, W, H), item.fit)
        ops.push({
          op: 'updateClip',
          clipId,
          transform: { ...placementToTransform(placement, media.width, media.height, W, H), mask: item.mask, flipH: item.flipH }
        })
      }
    })
  })

  const audio = [byLabel.get(MIC_LABEL), byLabel.get(SYSTEM_LABEL)].filter((f): f is FinishedStream => !!f)
  const audioTracks = ensureTracks('audio', audio.length)
  audio.forEach((f, k) => {
    const clipId = newId()
    ops.push({ op: 'insertClip', trackId: audioTracks[k], mediaId: f.item.id, start: t0 + f.offset, in: 0, out: f.item.duration, clipId })
    const gain = f.label === MIC_LABEL ? micGainFor(f.peakDb) : 1
    if (gain !== 1) ops.push({ op: 'updateClip', clipId, volume: gain })
  })
  return ops
}
