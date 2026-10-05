import {
  clipEnd,
  clipLength,
  isStill,
  newId,
  type Clip,
  type MediaItem,
  type Project,
  type ProjectSettings,
  type Track,
  type TrackKind,
  type Transform,
  type VolumeKey,
  type EnhanceLevel,
  type CaptionStyle,
  type Section,
  type TrashEntry,
  Transform as TransformSchema
} from './project'
import { rippleSections, upsertSection } from './sections'
import type { Scene } from './scene'
import type { Motion } from './motion'
import { Graphic, graphicLabel } from './graphics'
import type { Theme } from './theme'
import { presetTheme } from './modes'
import type { TransformKey } from './animation'
import type { Transcript } from './transcript'
import type { Zoom } from './zoom'

/**
 * Every change to a project is an EditOp: plain JSON, so the UI, text-based editing and the
 * AI assistant all go through the same path and everything is undoable.
 * Placing a clip uses "overwrite" semantics (like Premiere): whatever was underneath is trimmed away.
 */
export type EditOp =
  | { op: 'addMedia'; items: MediaItem[] }
  | { op: 'removeMedia'; mediaId: string }
  | { op: 'addTrack'; kind: TrackKind; name?: string; trackId?: string }
  | { op: 'updateTrack'; trackId: string; patch: Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>> }
  /** `insert`: push everything at `start` later on all unlocked tracks to make room, instead of overwriting. */
  | { op: 'insertClip'; trackId: string; mediaId: string; start: number; in?: number; out?: number; clipId?: string; insert?: boolean }
  | { op: 'moveClip'; clipId: string; start: number; trackId?: string; insert?: boolean }
  /** Shifts several clips by the same amount, each staying on its own track (moving a group). */
  | { op: 'moveClips'; clipIds: string[]; delta: number }
  /**
   * Copies clips (keeping fades, animation, volume points), shifted by `delta`. `trackId` puts a
   * single copy on another track; `insert` makes room instead of overwriting; `newClipIds` name the copies.
   */
  | { op: 'copyClips'; clipIds: string[]; delta: number; trackId?: string; insert?: boolean; newClipIds?: string[] }
  /**
   * Pastes copied clips (full clip data, so it works after the originals are gone) with the
   * earliest one starting at `at`, each on its own track (`trackId`: for a single clip, that track).
   */
  | { op: 'pasteClips'; items: { trackId: string; clip: Clip }[]; at: number; trackId?: string; insert?: boolean; newClipIds?: string[] }
  /** Merges clips into one group (clips already in a group bring their whole group along). */
  | { op: 'groupClips'; clipIds: string[]; groupId?: string }
  /** Splits the groups these clips belong to back into separate clips. */
  | { op: 'ungroupClips'; clipIds: string[] }
  /** `ripple`: later clips on the track move along with the edge (the clip may grow into them). */
  | { op: 'trimClip'; clipId: string; edge: 'start' | 'end'; time: number; ripple?: boolean }
  /** `newClipId` names the right-hand piece so later ops can refer to it. */
  | { op: 'splitClip'; clipId: string; time: number; newClipId?: string }
  /**
   * `clipId`: the clip being edited. If its text/color/animation is shared with other clips (copies),
   * that clip first gets its own copy, so only it changes.
   */
  | { op: 'updateMedia'; mediaId: string; clipId?: string; patch: { name?: string; color?: string; graphic?: Partial<Graphic>; motion?: Motion } }
  /** Keyframe animation of a clip (replaces its keys). */
  | { op: 'setTransformKeys'; clipId: string; keys: TransformKey[] }
  /** Change the theme (a preset name and/or individual values) of the project, or of one part. */
  | { op: 'setTheme'; preset?: string; patch?: Partial<Theme>; sectionId?: string }
  /** The project's editing mode and standing extra instructions (mood, style rules). */
  | { op: 'setMode'; mode?: 'explainer' | 'demo' | 'happening'; extraPrompt?: string }
  /** Adds (or replaces, by id) a part with its own mode and mood; overlapped parts are trimmed. */
  | { op: 'setSection'; section: Pick<Section, 'id' | 'start' | 'end' | 'mode'> & Partial<Section> }
  | { op: 'updateSection'; id: string; patch: Partial<Pick<Section, 'mode' | 'mood'>> }
  | { op: 'removeSection'; id: string }
  | { op: 'splitAt'; time: number; trackIds?: string[] }
  | { op: 'deleteClips'; clipIds: string[]; ripple?: boolean }
  | { op: 'rippleDeleteRange'; start: number; end: number }
  /**
   * Opens `length` seconds of empty space at `at`. Without `trackIds`: on every unlocked track (later
   * clips, markers and parts move along). With `trackIds`: only on those tracks (plus the tracks of
   * clips merged with what moves, so merged clips stay in sync).
   */
  | { op: 'insertGap'; at: number; length: number; trackIds?: string[] }
  | {
      op: 'updateClip'
      clipId: string
      transform?: Partial<Transform>
      volume?: number
      fadeIn?: number
      fadeOut?: number
      crossfadeIn?: number
      muted?: boolean
      enhance?: EnhanceLevel
    }
  | { op: 'setVolumeKeys'; clipId: string; keys: VolumeKey[] }
  /** Replaces a clip's auto zooms (screen recordings). */
  | { op: 'setZooms'; clipId: string; zooms: Zoom[] }
  /** Puts a video clip's sound on an audio track as its own clip (for J/L cuts) and mutes the video clip. */
  | { op: 'detachAudio'; clipId: string; newClipId?: string }
  | { op: 'addMarker'; time: number; label: string }
  | { op: 'setSettings'; patch: Partial<ProjectSettings> }
  | { op: 'setScenes'; scenes: Scene[]; activeSceneId?: string }
  | { op: 'setTranscript'; mediaId: string; transcript: Transcript | null }
  /** Corrects a word's text (captions only; the audio is unchanged). */
  | { op: 'editWord'; mediaId: string; index: number; text: string }
  | { op: 'setCaptionStyle'; patch: Partial<CaptionStyle>; sectionId?: string }
  /** Puts a deleted item back where it was, or at `at` (timeline seconds). */
  | { op: 'restoreTrash'; entryId: string; at?: number }
  /** Forgets deleted items for good. */
  | { op: 'removeTrash'; entryIds: string[] }

export class EditError extends Error {}

/** Media whose content belongs to a clip (text, color, animation): copies get their own. */
export const ownsMedia = (m: Pick<MediaItem, 'kind'>): boolean => m.kind === 'graphic' || m.kind === 'color' || m.kind === 'motion'

/** How many deleted items are kept. */
export const TRASH_LIMIT = 100

/** Default on-timeline length for still images. */
export const IMAGE_DEFAULT_SECONDS = 5
const EPS = 1e-6

export const snap = (t: number, fps: number): number => Math.round(t * fps) / fps

const sortClips = (clips: Clip[]): Clip[] => [...clips].sort((a, b) => a.start - b.start)

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip } {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  throw new EditError(`Clip not found: ${clipId}`)
}

/** The given clips plus every clip that shares a group with one of them. */
export function withGroupMembers(p: Project, clipIds: string[]): string[] {
  const ids = new Set(clipIds)
  const groups = new Set<string>()
  for (const t of p.tracks) for (const c of t.clips) if (ids.has(c.id) && c.groupId) groups.add(c.groupId)
  if (!groups.size) return clipIds
  for (const t of p.tracks) for (const c of t.clips) if (c.groupId && groups.has(c.groupId)) ids.add(c.id)
  return [...ids]
}

const mapClips = (p: Project, ids: Set<string>, fn: (c: Clip) => Clip): Project => ({
  ...p,
  tracks: p.tracks.map((t) => (t.clips.some((c) => ids.has(c.id)) ? { ...t, clips: t.clips.map((c) => (ids.has(c.id) ? fn(c) : c)) } : t))
})

function findTrack(p: Project, trackId: string): Track {
  const t = p.tracks.find((x) => x.id === trackId)
  if (!t) throw new EditError(`Track not found: ${trackId}`)
  return t
}

function findMedia(p: Project, mediaId: string): MediaItem {
  const m = p.media.find((x) => x.id === mediaId)
  if (!m) throw new EditError(`Media not found: ${mediaId}`)
  return m
}

// Video tracks take pictures; audio tracks take sound (audio files, or the sound of a video).
const trackAccepts = (track: Track, media: MediaItem): boolean =>
  track.kind === 'video' ? media.kind !== 'audio' : media.kind === 'audio' || (media.kind === 'video' && media.hasAudio)

function checkTrackAccepts(track: Track, media: MediaItem): void {
  if (!trackAccepts(track, media)) throw new EditError(`${media.kind} can't go on ${track.kind} track ${track.name}`)
}

/** Removes the time range [start, end) from a list of clips, trimming/splitting what overlaps. */
export function clearRange(clips: Clip[], start: number, end: number): Clip[] {
  const out: Clip[] = []
  for (const c of clips) {
    const cs = c.start
    const ce = clipEnd(c)
    if (ce <= start + EPS || cs >= end - EPS) {
      out.push(c) // no overlap
      continue
    }
    if (cs < start - EPS) out.push({ ...c, out: c.in + (start - cs) }) // keep left part
    if (ce > end + EPS) {
      // keep right part (new id if the left part also survived, i.e. the clip was split)
      out.push({ ...c, id: cs < start - EPS ? newId() : c.id, start: end, in: c.in + (end - cs) })
    }
  }
  return sortClips(out)
}

function findSection(p: Project, id: string): Section {
  const s = p.sections.find((x) => x.id === id)
  if (!s) throw new EditError(`Part not found: ${id}`)
  return s
}

const withSection = (p: Project, s: Section): Project => ({ ...p, sections: p.sections.map((x) => (x.id === s.id ? s : x)) })

const mapTrack = (p: Project, trackId: string, fn: (t: Track) => Track): Project => ({
  ...p,
  tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t))
})

function assertUnlocked(t: Track): void {
  if (t.locked) throw new EditError(`Track ${t.name} is locked`)
}

const mmss = (t: number): string => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

function addTrash(p: Project, entry: Omit<TrashEntry, 'id' | 'time'>): Project {
  if (!entry.clips.length && !entry.media.length) return p
  return { ...p, trash: [...p.trash, { id: newId(), time: new Date().toISOString(), ...entry }].slice(-TRASH_LIMIT) }
}

/** Pushes everything at or after `at` later by `len` (clips spanning `at` are split). */
function openGap(clips: Clip[], at: number, len: number): Clip[] {
  const out: Clip[] = []
  for (const c of clips) {
    if (clipEnd(c) <= at + EPS) out.push(c)
    else if (c.start >= at - EPS) out.push({ ...c, start: c.start + len })
    else out.push({ ...c, out: c.in + (at - c.start) }, { ...c, id: newId(), start: at + len, in: c.in + (at - c.start) })
  }
  return sortClips(out)
}

/** Moves deleted items' positions along with a timeline change (t → map(t)). */
const mapTrash = (list: TrashEntry[], map: (t: number) => number): TrashEntry[] =>
  list.map((e) => ({ ...e, start: map(e.start), end: map(e.end), clips: e.clips.map((x) => ({ ...x, clip: { ...x.clip, start: map(x.clip.start) } })) }))

export function applyOp(p: Project, op: EditOp): Project {
  const fps = p.settings.fps
  switch (op.op) {
    case 'addMedia':
      return { ...p, media: [...p.media, ...op.items] }

    case 'removeMedia': {
      const media = findMedia(p, op.mediaId)
      const gone = p.tracks.flatMap((t) => t.clips.filter((c) => c.mediaId === op.mediaId).map((clip) => ({ trackId: t.id, clip })))
      const next = {
        ...p,
        media: p.media.filter((m) => m.id !== op.mediaId),
        tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== op.mediaId) }))
      }
      const start = gone.length ? Math.min(...gone.map((g) => g.clip.start)) : 0
      return addTrash(next, { label: `Media: ${media.name}`, start, end: Math.max(start, ...gone.map((g) => clipEnd(g.clip))), gap: 'none', clips: gone, media: [media] })
    }

    case 'addTrack': {
      if (op.trackId && p.tracks.some((t) => t.id === op.trackId)) throw new EditError(`Track id ${op.trackId} is already used`)
      const n = p.tracks.filter((t) => t.kind === op.kind).length + 1
      const track: Track = {
        id: op.trackId ?? newId(),
        kind: op.kind,
        name: op.name ?? `${op.kind === 'video' ? 'V' : 'A'}${n}`,
        muted: false,
        hidden: false,
        locked: false,
        clips: []
      }
      // New video tracks go on top of the other video tracks; audio tracks go at the end.
      const lastVideo = p.tracks.map((t) => t.kind).lastIndexOf('video')
      const tracks = [...p.tracks]
      tracks.splice(op.kind === 'video' ? lastVideo + 1 : tracks.length, 0, track)
      return { ...p, tracks }
    }

    case 'updateTrack':
      findTrack(p, op.trackId)
      return mapTrack(p, op.trackId, (t) => ({ ...t, ...op.patch }))

    case 'insertClip': {
      const track = findTrack(p, op.trackId)
      const media = findMedia(p, op.mediaId)
      assertUnlocked(track)
      checkTrackAccepts(track, media)
      const maxOut = isStill(media) ? Infinity : media.duration
      const inPt = Math.max(0, op.in ?? 0)
      const outPt = Math.min(maxOut, op.out ?? (isStill(media) ? IMAGE_DEFAULT_SECONDS : media.duration))
      if (outPt - inPt <= EPS) throw new EditError('Clip would be empty')
      const start = Math.max(0, snap(op.start, fps))
      if (op.clipId && p.tracks.some((tr) => tr.clips.some((c) => c.id === op.clipId))) throw new EditError(`Clip id ${op.clipId} is already used`)
      if (op.insert) p = applyOp(p, { op: 'insertGap', at: start, length: outPt - inPt, trackIds: [track.id] })
      const clip: Clip = {
        id: op.clipId ?? newId(),
        mediaId: media.id,
        start,
        in: inPt,
        out: outPt,
        transform: TransformSchema.parse({}),
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        crossfadeIn: 0,
        volumeKeys: [],
        muted: false,
        enhance: 'off',
        keys: [],
        zooms: []
      }
      return mapTrack(p, track.id, (t) => ({
        ...t,
        clips: sortClips([...clearRange(t.clips, start, start + outPt - inPt), clip])
      }))
    }

    case 'moveClip': {
      const { track: from, clip } = findClip(p, op.clipId)
      const to = findTrack(p, op.trackId ?? from.id)
      assertUnlocked(from)
      assertUnlocked(to)
      checkTrackAccepts(to, findMedia(p, clip.mediaId))
      const moved = { ...clip, start: Math.max(0, snap(op.start, fps)) }
      let removed = mapTrack(p, from.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clip.id) }))
      if (op.insert) removed = applyOp(removed, { op: 'insertGap', at: moved.start, length: clipLength(moved), trackIds: [to.id] })
      return mapTrack(removed, to.id, (t) => ({
        ...t,
        clips: sortClips([...clearRange(t.clips, moved.start, clipEnd(moved)), moved])
      }))
    }

    case 'moveClips': {
      const ids = new Set(op.clipIds)
      const moving = p.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((c) => ({ track: t, clip: c })))
      if (!moving.length) return p
      for (const { track } of moving) assertUnlocked(track)
      // Never push a clip before 0:00.
      const delta = Math.max(snap(op.delta, fps), -Math.min(...moving.map((m) => m.clip.start)))
      // Lift all of them first, so members on the same track don't overwrite each other.
      const lifted = { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !ids.has(c.id)) })) }
      return moving.reduce((acc, { track, clip }) => {
        const moved = { ...clip, start: Math.max(0, clip.start + delta) }
        return mapTrack(acc, track.id, (t) => ({ ...t, clips: sortClips([...clearRange(t.clips, moved.start, clipEnd(moved)), moved]) }))
      }, lifted)
    }

    case 'copyClips': {
      const ids = new Set(op.clipIds)
      const items = p.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((clip) => ({ trackId: t.id, clip })))
      if (!items.length) return p
      const at = Math.min(...items.map((x) => x.clip.start)) + op.delta
      return applyOp(p, { op: 'pasteClips', items, at, trackId: items.length === 1 ? op.trackId : undefined, insert: op.insert, newClipIds: op.newClipIds })
    }

    case 'pasteClips': {
      if (!op.items.length) return p
      const first = Math.min(...op.items.map((x) => x.clip.start))
      const delta = Math.max(0, snap(op.at, fps)) - first
      // `trackId` applies when everything copied came from one track.
      const single = new Set(op.items.map((x) => x.trackId)).size === 1
      const ownMedia: MediaItem[] = []
      // Copies of a merged group form a new group of their own (a lone copy is ungrouped).
      const groups = new Map<string, string>()
      const counts = new Map<string, number>()
      for (const { clip } of op.items) if (clip.groupId) counts.set(clip.groupId, (counts.get(clip.groupId) ?? 0) + 1)
      const used = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)))
      const copies = op.items.map(({ trackId, clip }, i) => {
        const media = findMedia(p, clip.mediaId)
        // The asked-for track (one clip), else the original track, else the first free track of the right kind.
        const wanted = [single ? op.trackId : undefined, trackId].map((id) => p.tracks.find((t) => t.id === id))
        const track =
          wanted.find((t) => t && !t.locked && trackAccepts(t, media)) ??
          p.tracks.find((t) => !t.locked && t.kind === (media.kind === 'audio' ? 'audio' : 'video'))
        if (!track) throw new EditError('No unlocked track to paste onto')
        const { groupId: g, ...rest } = clip
        const oldGroup = g && (counts.get(g) ?? 0) > 1 ? g : undefined
        if (oldGroup && !groups.has(oldGroup)) groups.set(oldGroup, newId())
        const id = op.newClipIds?.[i] ?? newId()
        if (used.has(id)) throw new EditError(`Clip id ${id} is already used`)
        used.add(id)
        // Text, color and animation layers get their own content, so editing the copy leaves the original alone.
        let mediaId = clip.mediaId
        if (ownsMedia(media)) {
          mediaId = newId()
          ownMedia.push({ ...media, id: mediaId })
        }
        const copy: Clip = { ...rest, id, mediaId, start: Math.max(0, clip.start + delta), ...(oldGroup ? { groupId: groups.get(oldGroup) } : {}) }
        return { trackId: track.id, clip: copy }
      })
      let next: Project = ownMedia.length ? { ...p, media: [...p.media, ...ownMedia] } : p
      if (op.insert) {
        const from = Math.min(...copies.map((c) => c.clip.start))
        const trackIds = [...new Set(copies.map((c) => c.trackId))]
        next = applyOp(next, { op: 'insertGap', at: from, length: Math.max(...copies.map((c) => clipEnd(c.clip))) - from, trackIds })
      }
      for (const { trackId, clip } of copies) {
        next = mapTrack(next, trackId, (t) => ({ ...t, clips: sortClips([...clearRange(t.clips, clip.start, clipEnd(clip)), clip]) }))
      }
      return next
    }

    case 'groupClips': {
      const ids = new Set(withGroupMembers(p, op.clipIds))
      if (ids.size < 2) throw new EditError('Select at least two clips to merge')
      const groupId = op.groupId ?? newId()
      return mapClips(p, ids, (c) => ({ ...c, groupId }))
    }

    case 'ungroupClips': {
      const ids = new Set(withGroupMembers(p, op.clipIds))
      return mapClips(p, ids, ({ groupId: _, ...c }) => c)
    }

    case 'trimClip': {
      const { track, clip } = findClip(p, op.clipId)
      assertUnlocked(track)
      const media = findMedia(p, clip.mediaId)
      const idx = track.clips.findIndex((c) => c.id === clip.id)
      const prevEnd = idx > 0 ? clipEnd(track.clips[idx - 1]) : 0
      const nextStart = idx < track.clips.length - 1 ? track.clips[idx + 1].start : Infinity
      const minLen = 1 / fps
      let t = snap(op.time, fps)
      let next: Clip
      if (op.ripple) {
        // The clip keeps its start; later clips on the track follow its end.
        const maxOut = isStill(media) ? Infinity : media.duration
        let inPt = clip.in
        let outPt = clip.out
        if (op.edge === 'start') inPt = Math.min(Math.max(0, clip.in + (t - clip.start)), clip.out - minLen)
        else outPt = Math.max(Math.min(maxOut, clip.in + (t - clip.start)), clip.in + minLen)
        next = { ...clip, in: inPt, out: outPt }
        const delta = clipLength(next) - clipLength(clip)
        const oldEnd = clipEnd(clip)
        return mapTrack(p, track.id, (tr) => ({
          ...tr,
          clips: tr.clips.map((c) => (c.id === clip.id ? next : c.start >= oldEnd - EPS ? { ...c, start: c.start + delta } : c))
        }))
      }
      if (op.edge === 'start') {
        // Can't extend before the source start, into the previous clip, or past the end.
        t = Math.max(t, clip.start - clip.in, prevEnd)
        t = Math.min(t, clipEnd(clip) - minLen)
        next = { ...clip, start: t, in: clip.in + (t - clip.start) }
      } else {
        const maxOut = isStill(media) ? Infinity : media.duration
        t = Math.min(t, nextStart, clip.start + (maxOut - clip.in))
        t = Math.max(t, clip.start + minLen)
        next = { ...clip, out: clip.in + (t - clip.start) }
      }
      return mapTrack(p, track.id, (tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === clip.id ? next : c)) }))
    }

    case 'splitClip': {
      const { track, clip } = findClip(p, op.clipId)
      assertUnlocked(track)
      const t = snap(op.time, fps)
      if (t <= clip.start + EPS || t >= clipEnd(clip) - EPS) return p // not inside the clip
      const left: Clip = { ...clip, out: clip.in + (t - clip.start) }
      if (op.newClipId && p.tracks.some((tr) => tr.clips.some((c) => c.id === op.newClipId))) throw new EditError(`Clip id ${op.newClipId} is already used`)
      const right: Clip = { ...clip, id: op.newClipId ?? newId(), start: t, in: left.out }
      return mapTrack(p, track.id, (tr) => ({
        ...tr,
        clips: sortClips(tr.clips.flatMap((c) => (c.id === clip.id ? [left, right] : [c])))
      }))
    }

    case 'splitAt': {
      let next = p
      for (const track of p.tracks) {
        if (track.locked || (op.trackIds && !op.trackIds.includes(track.id))) continue
        for (const c of track.clips) next = applyOp(next, { op: 'splitClip', clipId: c.id, time: op.time })
      }
      return next
    }

    case 'deleteClips': {
      const ids = new Set(op.clipIds)
      const gone = p.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((clip) => ({ trackId: t.id, clip })))
      const names = [...new Set(gone.map((g) => p.media.find((m) => m.id === g.clip.mediaId)?.name ?? 'clip'))]
      const next: Project = {
        ...p,
        tracks: p.tracks.map((t) => {
          const doomed = t.clips.filter((c) => ids.has(c.id))
          if (!doomed.length) return t
          assertUnlocked(t)
          let clips = t.clips.filter((c) => !ids.has(c.id))
          if (op.ripple) {
            // Close each gap: shift later clips left by the deleted clip's length (latest first).
            for (const d of [...doomed].sort((a, b) => b.start - a.start)) {
              const len = clipLength(d)
              clips = clips.map((c) => (c.start >= clipEnd(d) - EPS ? { ...c, start: c.start - len } : c))
            }
          }
          return { ...t, clips: sortClips(clips) }
        })
      }
      if (!gone.length) return next
      return addTrash(next, {
        label: `${gone.length > 1 ? `${gone.length} clips` : 'Clip'}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
        start: Math.min(...gone.map((g) => g.clip.start)),
        end: Math.max(...gone.map((g) => clipEnd(g.clip))),
        gap: op.ripple ? 'track' : 'none',
        clips: gone,
        media: []
      })
    }

    case 'rippleDeleteRange': {
      const start = snap(Math.max(0, Math.min(op.start, op.end)), fps)
      const end = snap(Math.max(op.start, op.end), fps)
      const len = end - start
      if (len <= EPS) return p
      const shift = (t: number): number => (t >= end - EPS ? t - len : t)
      // The pieces of clips inside the range, kept so the cut can be undone from the Deleted list.
      const pieces = p.tracks.flatMap((t) =>
        t.locked
          ? []
          : t.clips
              .filter((c) => clipEnd(c) > start + EPS && c.start < end - EPS)
              .map((c) => {
                const s = Math.max(c.start, start)
                return { trackId: t.id, clip: { ...c, id: newId(), start: s, in: c.in + (s - c.start), out: c.in + (Math.min(clipEnd(c), end) - c.start) } }
              })
      )
      const next: Project = {
        ...p,
        tracks: p.tracks.map((t) =>
          t.locked ? t : { ...t, clips: clearRange(t.clips, start, end).map((c) => ({ ...c, start: shift(c.start) })) }
        ),
        markers: p.markers
          .filter((m) => m.time < start || m.time >= end)
          .map((m) => ({ ...m, time: shift(m.time) })),
        sections: rippleSections(p.sections, start, end),
        trash: mapTrash(p.trash, (t) => (t <= start ? t : t >= end ? t - len : start))
      }
      return addTrash(next, { label: `Cut ${mmss(start)}–${mmss(end)}`, start, end, gap: 'all', clips: pieces, media: [] })
    }

    case 'insertGap': {
      const at = Math.max(0, snap(op.at, fps))
      const len = snap(op.length, fps)
      if (len <= EPS) return p
      const later = (t: number): number => (t >= at - EPS ? t + len : t)
      if (op.trackIds) {
        // Only these tracks, plus the tracks of clips merged with anything that moves.
        const tracks = new Set(op.trackIds)
        const moving = p.tracks.filter((t) => tracks.has(t.id)).flatMap((t) => t.clips.filter((c) => clipEnd(c) > at + EPS).map((c) => c.id))
        const partners = new Set(withGroupMembers(p, moving))
        for (const t of p.tracks) if (t.clips.some((c) => partners.has(c.id))) tracks.add(t.id)
        return { ...p, tracks: p.tracks.map((t) => (t.locked || !tracks.has(t.id) ? t : { ...t, clips: openGap(t.clips, at, len) })) }
      }
      return {
        ...p,
        tracks: p.tracks.map((t) => (t.locked ? t : { ...t, clips: openGap(t.clips, at, len) })),
        markers: p.markers.map((m) => ({ ...m, time: later(m.time) })),
        sections: p.sections.map((s) => ({ ...s, start: later(s.start), end: s.end > at + EPS ? s.end + len : s.end })),
        trash: mapTrash(p.trash, later)
      }
    }

    case 'restoreTrash': {
      const entry = p.trash.find((e) => e.id === op.entryId)
      if (!entry) throw new EditError('That deleted item is gone')
      const shift = op.at === undefined ? 0 : Math.max(0, snap(op.at, fps)) - entry.start
      const len = entry.end - entry.start
      let next: Project = {
        ...p,
        trash: p.trash.filter((e) => e.id !== entry.id),
        media: [...p.media, ...entry.media.filter((m) => !p.media.some((x) => x.id === m.id))]
      }
      if (entry.gap === 'all' && len > EPS) {
        // Re-open the cut on every track (and move markers, parts and other deleted items along).
        const at = entry.start + shift
        const later = (t: number): number => (t >= at - EPS ? t + len : t)
        next = {
          ...next,
          tracks: next.tracks.map((t) => (t.locked ? t : { ...t, clips: openGap(t.clips, at, len) })),
          markers: next.markers.map((m) => ({ ...m, time: later(m.time) })),
          sections: next.sections.map((s) => ({ ...s, start: later(s.start), end: s.end > at + EPS ? s.end + len : s.end })),
          trash: mapTrash(next.trash, later)
        }
      }
      const used = new Set(next.tracks.flatMap((t) => t.clips.map((c) => c.id)))
      for (const { trackId, clip } of [...entry.clips].sort((a, b) => a.clip.start - b.clip.start)) {
        const media = findMedia(next, clip.mediaId)
        // The original track, or (if it was removed) the first track of the right kind.
        const track = next.tracks.find((t) => t.id === trackId) ?? next.tracks.find((t) => t.kind === (media.kind === 'audio' ? 'audio' : 'video') && !t.locked)
        if (!track) throw new EditError('No track to put it back on')
        assertUnlocked(track)
        const placed: Clip = { ...clip, id: used.has(clip.id) ? newId() : clip.id, start: Math.max(0, snap(clip.start + shift, fps)) }
        used.add(placed.id)
        next = mapTrack(next, track.id, (t) => {
          const clips = entry.gap === 'track' ? openGap(t.clips, placed.start, clipLength(placed)) : t.clips
          return { ...t, clips: sortClips([...clearRange(clips, placed.start, clipEnd(placed)), placed]) }
        })
      }
      return next
    }

    case 'removeTrash': {
      const ids = new Set(op.entryIds)
      return { ...p, trash: p.trash.filter((e) => !ids.has(e.id)) }
    }

    case 'updateClip': {
      const { track, clip } = findClip(p, op.clipId)
      const len = clipLength(clip)
      const next: Clip = {
        ...clip,
        transform: op.transform ? { ...clip.transform, ...op.transform } : clip.transform,
        volume: op.volume ?? clip.volume,
        fadeIn: Math.min(len, op.fadeIn ?? clip.fadeIn),
        fadeOut: Math.min(len, op.fadeOut ?? clip.fadeOut),
        crossfadeIn: Math.min(len, op.crossfadeIn ?? clip.crossfadeIn),
        muted: op.muted ?? clip.muted,
        enhance: op.enhance ?? clip.enhance
      }
      return mapTrack(p, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? next : c)) }))
    }

    case 'setVolumeKeys': {
      const { track, clip } = findClip(p, op.clipId)
      const keys = [...op.keys].map((k) => ({ t: k.t, v: Math.max(0, Math.min(4, k.v)) })).sort((a, b) => a.t - b.t)
      return mapTrack(p, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, volumeKeys: keys } : c)) }))
    }

    case 'detachAudio': {
      const { track, clip } = findClip(p, op.clipId)
      const media = findMedia(p, clip.mediaId)
      if (track.kind !== 'video' || media.kind !== 'video' || !media.hasAudio) throw new EditError('This clip has no sound to detach')
      const start = clip.start
      const end = clipEnd(clip)
      // First unlocked audio track that is free for the clip's time range, or a new one.
      let target = p.tracks.find((t) => t.kind === 'audio' && !t.locked && t.clips.every((c) => clipEnd(c) <= start + EPS || c.start >= end - EPS))
      let next = p
      if (!target) {
        const trackId = newId()
        next = applyOp(next, { op: 'addTrack', kind: 'audio', trackId })
        target = next.tracks.find((t) => t.id === trackId)!
      }
      const audioClip: Clip = {
        ...clip,
        id: op.newClipId ?? newId(),
        transform: TransformSchema.parse({}),
        muted: false
      }
      next = mapTrack(next, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, audioClip]) }))
      return mapTrack(next, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, muted: true } : c)) }))
    }

    case 'updateMedia': {
      let media = findMedia(p, op.mediaId)
      if (op.clipId && ownsMedia(media)) {
        const shared = p.tracks.flatMap((t) => t.clips).filter((c) => c.mediaId === media.id)
        if (shared.length > 1 && shared.some((c) => c.id === op.clipId)) {
          // Copied layers used to share their content: give this clip its own before changing it.
          const own = { ...media, id: newId() }
          p = { ...mapClips(p, new Set([op.clipId]), (c) => ({ ...c, mediaId: own.id })), media: [...p.media, own] }
          media = own
        }
      }
      const { graphic, motion, ...rest } = op.patch
      let next = { ...media, ...rest }
      if (motion) {
        if (media.kind !== 'motion') throw new EditError(`${media.name} is not an animation`)
        next = { ...next, motion, duration: motion.duration, width: motion.width, height: motion.height }
      }
      if (graphic) {
        if (!media.graphic) throw new EditError(`${media.name} is not a text layer`)
        const merged = Graphic.parse({ ...media.graphic, ...graphic })
        next = { ...next, graphic: merged, name: graphicLabel(merged) }
      }
      return { ...p, media: p.media.map((m) => (m.id === media.id ? next : m)) }
    }

    case 'setZooms': {
      const { track, clip } = findClip(p, op.clipId)
      const zooms = op.zooms
        .map((z) => ({ ...z, scale: Math.min(4, Math.max(1, z.scale)), points: [...z.points].sort((a, b) => a.t - b.t) }))
        .filter((z) => z.end > z.start)
        .sort((a, b) => a.start - b.start)
      return mapTrack(p, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, zooms } : c)) }))
    }

    case 'setTransformKeys': {
      const { track, clip } = findClip(p, op.clipId)
      const keys = [...op.keys].sort((a, b) => a.t - b.t)
      return mapTrack(p, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, keys } : c)) }))
    }

    case 'setMode':
      return { ...p, mode: op.mode ?? p.mode, extraPrompt: op.extraPrompt ?? p.extraPrompt }

    case 'setTheme': {
      const section = op.sectionId ? findSection(p, op.sectionId) : undefined
      const base = op.preset ? presetTheme(op.preset) : (section?.theme ?? p.theme)
      if (!base) throw new EditError(`Unknown theme "${op.preset}"`)
      const theme = { ...base, ...op.patch }
      return section ? withSection(p, { ...section, theme }) : { ...p, theme }
    }

    case 'setSection': {
      const { start, end } = op.section
      if (!(end - start > 0.01)) throw new EditError('A part must be longer than 0')
      const old = p.sections.find((s) => s.id === op.section.id)
      const section: Section = { mood: '', ...old, ...op.section, start: Math.max(0, start) }
      return { ...p, sections: upsertSection(p.sections, section) }
    }

    case 'updateSection':
      return withSection(p, { ...findSection(p, op.id), ...op.patch })

    case 'removeSection':
      return { ...p, sections: p.sections.filter((s) => s.id !== op.id) }

    case 'addMarker':
      return {
        ...p,
        markers: [...p.markers, { id: newId(), time: snap(op.time, fps), label: op.label }].sort((a, b) => a.time - b.time)
      }

    case 'setSettings':
      return { ...p, settings: { ...p.settings, ...op.patch } }

    case 'setTranscript': {
      const transcripts = { ...p.transcripts }
      if (op.transcript) transcripts[op.mediaId] = op.transcript
      else delete transcripts[op.mediaId]
      return { ...p, transcripts }
    }

    case 'editWord': {
      const t = p.transcripts[op.mediaId]
      if (!t || !t.words[op.index]) throw new EditError('Word not found')
      const words = t.words.map((w, i) => (i === op.index ? { ...w, text: op.text } : w))
      return { ...p, transcripts: { ...p.transcripts, [op.mediaId]: { ...t, words } } }
    }

    case 'setCaptionStyle': {
      if (!op.sectionId) return { ...p, captionStyle: { ...p.captionStyle, ...op.patch } }
      const section = findSection(p, op.sectionId)
      return withSection(p, { ...section, captions: { ...(section.captions ?? p.captionStyle), ...op.patch } })
    }

    case 'setScenes':
      return { ...p, scenes: op.scenes, activeSceneId: op.activeSceneId ?? p.activeSceneId }
  }
}

export const applyOps = (p: Project, ops: EditOp[]): Project => ops.reduce(applyOp, p)

/**
 * Ops that remove every stretch of time where no track has a clip (including before the first
 * clip), so all tracks stay in sync. Latest gap first, so earlier times stay valid.
 */
export function closeGapsOps(p: Project): EditOp[] {
  const spans = p.tracks
    .flatMap((t) => t.clips.map((c) => [c.start, clipEnd(c)] as const))
    .sort((a, b) => a[0] - b[0])
  const ops: EditOp[] = []
  let covered = 0
  for (const [start, end] of spans) {
    if (start > covered + EPS) ops.push({ op: 'rippleDeleteRange', start: covered, end: start })
    covered = Math.max(covered, end)
  }
  return ops.reverse()
}
