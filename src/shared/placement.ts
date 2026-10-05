import { clipEnd, newId, type MediaItem, type Project } from './project'
import type { EditOp } from './ops'

/**
 * Where a new overlay (text layer, badge, card…) goes: on the lowest video track that is free for
 * [start, end) and above everything already showing then. Adds a track on top if needed.
 */
export function overlayTrack(p: Project, start: number, end: number): { trackId: string; ops: EditOp[] } {
  const video = p.tracks.filter((t) => t.kind === 'video')
  const busy = (i: number): boolean => video[i].clips.some((c) => c.start < end - 1e-6 && clipEnd(c) > start + 1e-6)
  let highestBusy = -1
  video.forEach((_, i) => {
    if (busy(i)) highestBusy = i
  })
  for (let i = highestBusy + 1; i < video.length; i++) {
    if (!busy(i) && !video[i].locked && !video[i].hidden) return { trackId: video[i].id, ops: [] }
  }
  const trackId = `track-${newId().slice(0, 8)}`
  return { trackId, ops: [{ op: 'addTrack', kind: 'video', trackId }] }
}

/** Ops that add a still (graphic/color) media item on top of the video for [start, end). */
export function placeOnTop(p: Project, media: MediaItem, start: number, end: number, clipId = newId()): { ops: EditOp[]; clipId: string } {
  const { trackId, ops } = overlayTrack(p, start, end)
  return {
    clipId,
    ops: [
      { op: 'addMedia', items: [media] },
      ...ops,
      { op: 'insertClip', trackId, mediaId: media.id, start, in: 0, out: Math.max(0.1, end - start), clipId }
    ]
  }
}

/** The first unlocked audio track free for [start, end), or a new one (for background music). */
export function audioTrackFor(p: Project, start: number, end: number): { trackId: string; ops: EditOp[] } {
  const free = p.tracks.find((t) => t.kind === 'audio' && !t.locked && !t.clips.some((c) => c.start < end - 1e-6 && clipEnd(c) > start + 1e-6))
  if (free) return { trackId: free.id, ops: [] }
  const trackId = `track-${newId().slice(0, 8)}`
  return { trackId, ops: [{ op: 'addTrack', kind: 'audio', trackId }] }
}
