import { useStudio } from './store'
import { closeGapsOps, withGroupMembers } from '@shared/ops'
import { fmt } from '@shared/assistant'
import { clipEnd, newId, type Clip, type Project } from '@shared/project'

/** Editing actions shared by keyboard shortcuts and toolbar buttons. */

/** Splits the selected clips at the playhead, or every track if nothing is selected. */
export function splitAtPlayhead(): void {
  const s = useStudio.getState()
  if (s.selectedClipIds.length) {
    const ids = withGroupMembers(s.project!, s.selectedClipIds)
    s.dispatch(ids.map((clipId) => ({ op: 'splitClip' as const, clipId, time: s.playhead })))
  }
  else s.dispatch({ op: 'splitAt', time: s.playhead })
}

/** Removes the In–Out section from video and audio (all unlocked tracks) and closes the gap. */
export function cutMarkedRange(): boolean {
  const s = useStudio.getState()
  const r = s.markedRange()
  if (!r) {
    s.showToast('Set an In point (I) and an Out point (O) first.')
    return false
  }
  if (!s.dispatch({ op: 'rippleDeleteRange', start: r.start, end: r.end })) return false
  s.setMarks(null, null)
  s.setPlayhead(r.start)
  s.showToast(`Cut ${(r.end - r.start).toFixed(1)} s`)
  return true
}

export function markIn(): void {
  const s = useStudio.getState()
  s.setMarks(s.playhead, s.markOut !== null && s.markOut <= s.playhead ? null : s.markOut)
}

export function markOut(): void {
  const s = useStudio.getState()
  s.setMarks(s.markIn !== null && s.markIn >= s.playhead ? null : s.markIn, s.playhead)
}

/** Removes the empty time where no track has anything (including before the first clip). */
export function closeGaps(): void {
  const s = useStudio.getState()
  const ops = closeGapsOps(s.project!)
  if (!ops.length) return s.showToast('No gaps to close.')
  const removed = ops.reduce((sum, op) => sum + (op.op === 'rippleDeleteRange' ? op.end - op.start : 0), 0)
  if (s.dispatch(ops)) s.showToast(`Closed ${ops.length} gap${ops.length > 1 ? 's' : ''} (${removed.toFixed(1)} s)`)
}

/** Merges the selected clips into one group that moves, cuts, trims and deletes together. */
export function mergeSelected(): void {
  const s = useStudio.getState()
  if (s.selectedClipIds.length < 2) return s.showToast('Select two or more clips (Ctrl+click) to merge them.')
  if (s.dispatch({ op: 'groupClips', clipIds: s.selectedClipIds })) s.showToast('Merged. Ctrl+Shift+G to unmerge.')
}

/** Splits the selected clips' groups back into separate clips. */
export function ungroupSelected(): void {
  const s = useStudio.getState()
  if (s.selectedClipIds.length) s.dispatch({ op: 'ungroupClips', clipIds: s.selectedClipIds })
}

/** Makes `seconds` of room at `at`: only on `trackIds` (and clips merged with them), or on every track. */
export function insertSpace(at: number, seconds: number, trackIds?: string[]): void {
  const s = useStudio.getState()
  if (!(seconds > 0)) return s.showToast('Enter how many seconds of space to add.')
  if (s.dispatch({ op: 'insertGap', at, length: seconds, trackIds }))
    s.showToast(`Added ${seconds.toFixed(1)} s at ${fmt(at)}; ${trackIds ? 'later clips on this track' : 'everything after'} moved along.`)
}

/** Selects every clip (on unlocked tracks) that starts at or after `time`, ready to drag together. */
export function selectFrom(time: number): void {
  const s = useStudio.getState()
  const ids = s.project!.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.filter((c) => c.start >= time - 1e-6).map((c) => c.id))
  s.selectClips(ids)
  s.showToast(ids.length ? `Selected ${ids.length} clip${ids.length > 1 ? 's' : ''}. Drag one to move them all.` : 'No clips after this point.')
}

export const selectFromPlayhead = (): void => selectFrom(useStudio.getState().playhead)

/**
 * The empty stretch around `time` on a track: between the clip before it and the clip after it
 * (null if `time` is on a clip or after the last one). `allTracks`: every unlocked track is empty
 * there too, so it can be removed without cutting anything.
 */
export function emptySpaceAt(p: Project, trackId: string, time: number): { start: number; end: number; allTracks: boolean } | null {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track || track.locked) return null
  const before = track.clips.filter((c) => clipEnd(c) <= time + 1e-6)
  const after = track.clips.filter((c) => c.start >= time - 1e-6)
  if (!after.length || before.length + after.length < track.clips.length) return null
  const start = Math.max(0, ...before.map(clipEnd))
  const end = Math.min(...after.map((c) => c.start))
  if (end - start < 1e-3) return null
  const allTracks = p.tracks.every((t) => t.locked || t.clips.every((c) => clipEnd(c) <= start + 1e-6 || c.start >= end - 1e-6))
  return { start, end, allTracks }
}

/** Removes empty time from every track, pulling everything after it earlier (tracks stay in sync). */
export function removeSpace(start: number, end: number): void {
  const s = useStudio.getState()
  if (s.dispatch({ op: 'rippleDeleteRange', start, end })) s.showToast(`Removed ${(end - start).toFixed(1)} s of empty space.`)
}

/** Pulls the clips after a gap on one track earlier (other tracks are busy there, so they stay put). */
export function closeTrackGap(trackId: string, start: number, end: number): void {
  const s = useStudio.getState()
  const track = s.project!.tracks.find((t) => t.id === trackId)!
  const ids = withGroupMembers(s.project!, track.clips.filter((c) => c.start >= end - 1e-6).map((c) => c.id))
  if (s.dispatch({ op: 'moveClips', clipIds: ids, delta: start - end })) s.showToast(`Closed ${(end - start).toFixed(1)} s on ${track.name}; other tracks did not move.`)
}

/** Clips copied with Ctrl+C / Ctrl+X (kept in full, so pasting works even after the originals are deleted). */
let clipboard: { trackId: string; clip: Clip }[] = []

/** The track the mouse was last over (or clicked): where Ctrl+V pastes. */
let pasteTrackId: string | undefined
export const setPasteTrack = (trackId: string): void => void (pasteTrackId = trackId)

export const hasClipboard = (): boolean => clipboard.length > 0

/** Copies the selected clips (with their merged groups). `cut` also deletes them. */
export function copySelected(cut = false): void {
  const s = useStudio.getState()
  const ids = new Set(withGroupMembers(s.project!, s.selectedClipIds))
  if (!ids.size) return s.showToast('Select a clip to copy first.')
  clipboard = s.project!.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((clip) => ({ trackId: t.id, clip })))
  const what = `${clipboard.length} clip${clipboard.length > 1 ? 's' : ''}`
  if (cut) {
    if (s.dispatch({ op: 'deleteClips', clipIds: [...ids] })) s.selectClips([])
    s.showToast(`Cut ${what}. Click where it should go and press Ctrl+V.`)
  } else s.showToast(`Copied ${what}. Click where it should go and press Ctrl+V (or right-click → Paste here).`)
}

/**
 * Pastes the copied clips at `at` (default: the playhead) on `trackId` (default: the track the mouse
 * is over), making room there: later clips on that track move along; other tracks stay put.
 */
export function paste(at?: number, trackId = pasteTrackId): void {
  const s = useStudio.getState()
  if (!clipboard.length) return s.showToast('Nothing copied yet. Select a clip and press Ctrl+C.')
  const time = at ?? s.playhead
  const newClipIds = clipboard.map(() => newId())
  if (s.dispatch({ op: 'pasteClips', items: clipboard, at: time, trackId, insert: true, newClipIds })) {
    s.selectClips(newClipIds)
    s.showToast(`Pasted at ${fmt(time)}; later clips on that track moved along.`)
  }
}
