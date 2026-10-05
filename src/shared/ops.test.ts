import { describe, expect, it } from 'vitest'
import { createProject, MediaItem, type Project } from './project'
import { applyOp, applyOps, clearRange, closeGapsOps, EditError, withGroupMembers } from './ops'

const video = MediaItem.parse({ id: 'm1', kind: 'video', name: 'a.mp4', path: 'media/a.mp4', duration: 60, hasAudio: true })
const song = MediaItem.parse({ id: 'm2', kind: 'audio', name: 's.mp3', path: 'media/s.mp3', duration: 30 })
const photo = MediaItem.parse({ id: 'm3', kind: 'image', name: 'p.png', path: 'media/p.png', duration: 0 })

function setup(): { p: Project; v1: string; v2: string; a1: string } {
  const base = createProject('test')
  const p = applyOp(base, { op: 'addMedia', items: [video, song, photo] })
  const [v1, v2, a1] = p.tracks.map((t) => t.id)
  return { p, v1, v2, a1 }
}

const clips = (p: Project, trackId: string) =>
  p.tracks.find((t) => t.id === trackId)!.clips.map((c) => [c.start, c.in, c.out])

describe('insertClip', () => {
  it('places a whole video by default', () => {
    const { p, v1 } = setup()
    const r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 2 })
    expect(clips(r, v1)).toEqual([[2, 0, 60]])
  })

  it('gives images a default length and rejects wrong track kinds', () => {
    const { p, v1, a1 } = setup()
    expect(clips(applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 0 }), v1)).toEqual([[0, 0, 5]])
    expect(() => applyOp(p, { op: 'insertClip', trackId: a1, mediaId: 'm3', start: 0 })).toThrow(EditError)
    // A video's sound may go on an audio track.
    expect(() => applyOp(p, { op: 'insertClip', trackId: a1, mediaId: 'm1', start: 0 })).not.toThrow()
    expect(() => applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm2', start: 0 })).toThrow(EditError)
  })

  it('overwrites what is underneath', () => {
    const { p, v1 } = setup()
    const r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, in: 0, out: 20 },
      { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 5 }
    ])
    expect(clips(r, v1)).toEqual([
      [0, 0, 5],
      [5, 0, 5],
      [10, 10, 20]
    ])
  })
})

describe('clearRange', () => {
  it('drops, trims and splits correctly', () => {
    const c = (id: string, start: number, len: number) => ({ ...base, id, start, in: 0, out: len })
    const base = { mediaId: 'm1', fadeIn: 0, fadeOut: 0, crossfadeIn: 0, volumeKeys: [], muted: false, enhance: 'off' as const, keys: [], zooms: [], transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 }, mask: 'none' as const, flipH: false, flipV: false }, volume: 1 }
    const out = clearRange([c('a', 0, 10), c('b', 12, 2), c('d', 20, 10)], 5, 25)
    expect(out.map((x) => [x.id, x.start, x.in, x.out])).toEqual([
      ['a', 0, 0, 5],
      ['d', 25, 5, 10]
    ])
  })
})

describe('split / trim / move / delete', () => {
  it('splits a clip into two continuous pieces', () => {
    const { p, v1 } = setup()
    let r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0 })
    r = applyOp(r, { op: 'splitAt', time: 10 })
    expect(clips(r, v1)).toEqual([
      [0, 0, 10],
      [10, 10, 60]
    ])
    const ids = r.tracks[0].clips.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('split snaps to frames', () => {
    const { p, v1 } = setup()
    let r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0 })
    r = applyOp(r, { op: 'splitAt', time: 1.01 }) // 30fps -> 1.0
    expect(r.tracks[0].clips[0].out).toBeCloseTo(1)
  })

  it('trims within the source and neighbours', () => {
    const { p, v1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, in: 10, out: 20, clipId: 'x' },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 15, in: 0, out: 5 }
    ])
    r = applyOp(r, { op: 'trimClip', clipId: 'x', edge: 'end', time: 100 })
    expect(r.tracks[0].clips[0].out).toBe(25) // stopped by the next clip at 15s
    r = applyOp(r, { op: 'trimClip', clipId: 'x', edge: 'start', time: -50 })
    expect(r.tracks[0].clips[0]).toMatchObject({ start: 0, in: 10 }) // can't go before timeline 0
  })

  it('moves a clip to another track', () => {
    const { p, v1, v2 } = setup()
    let r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 5, clipId: 'x' })
    r = applyOp(r, { op: 'moveClip', clipId: 'x', start: 3, trackId: v2 })
    expect(clips(r, v1)).toEqual([])
    expect(clips(r, v2)).toEqual([[3, 0, 5]])
  })

  it('ripple delete closes the gap', () => {
    const { p, v1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 5, clipId: 'a' },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 5, in: 10, out: 15, clipId: 'b' },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 10, in: 20, out: 25, clipId: 'c' }
    ])
    r = applyOp(r, { op: 'deleteClips', clipIds: ['b'], ripple: true })
    expect(clips(r, v1)).toEqual([
      [0, 0, 5],
      [5, 20, 25]
    ])
  })

  it('rippleDeleteRange cuts a time range from all tracks (text-based editing)', () => {
    const { p, v1, a1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 30 },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0 },
      { op: 'addMarker', time: 20, label: 'later' }
    ])
    r = applyOp(r, { op: 'rippleDeleteRange', start: 4, end: 6 })
    expect(clips(r, v1)).toEqual([
      [0, 0, 4],
      [4, 6, 30]
    ])
    expect(clips(r, a1)).toEqual([
      [0, 0, 4],
      [4, 6, 30]
    ])
    expect(r.markers[0].time).toBe(18)
  })

  it('insertGap pushes everything later on all unlocked tracks', () => {
    const { p, v1, v2, a1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 10 },
      { op: 'insertClip', trackId: v2, mediaId: 'm3', start: 2 },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, out: 10 },
      { op: 'addMarker', time: 3, label: 'm' }
    ])
    const before = r
    // At the start: everything moves.
    r = applyOp(r, { op: 'insertGap', at: 0, length: 5 })
    expect(clips(r, v1)).toEqual([[5, 0, 10]])
    expect(clips(r, v2)).toEqual([[7, 0, 5]])
    expect(clips(r, a1)).toEqual([[5, 0, 10]])
    expect(r.markers[0].time).toBe(8)
    // Undoing with the opposite cut gives the same layout back.
    r = applyOp(r, { op: 'rippleDeleteRange', start: 0, end: 5 })
    for (const t of before.tracks) expect(clips(r, t.id)).toEqual(clips(before, t.id))

    // In the middle: clips crossing the point are split; locked tracks stay put.
    r = applyOps(before, [{ op: 'updateTrack', trackId: v2, patch: { locked: true } }, { op: 'insertGap', at: 4, length: 2 }])
    expect(clips(r, v1)).toEqual([
      [0, 0, 4],
      [6, 4, 10]
    ])
    expect(clips(r, v2)).toEqual([[2, 0, 5]])
    expect(applyOp(r, { op: 'insertGap', at: 4, length: 0 })).toBe(r)
  })

  it('insertClip / moveClip with insert make room instead of overwriting', () => {
    const { p, v1, a1 } = setup()
    const base = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 10, clipId: 'v' },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, out: 10 }
    ])
    // An intro image dropped at 0:00 pushes everything 5 s later on all tracks.
    let r = applyOp(base, { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 0, insert: true })
    expect(clips(r, v1)).toEqual([[0, 0, 5], [5, 0, 10]])
    expect(clips(r, a1)).toEqual([[0, 0, 10]]) // only the track it was dropped on moves
    // Moving the image to 0:08 (inside the video) splits the video there and pushes the rest along.
    const img = r.tracks.find((t) => t.id === v1)!.clips[0].id
    r = applyOp(r, { op: 'moveClip', clipId: img, start: 8, insert: true })
    expect(clips(r, v1)).toEqual([[5, 0, 3], [8, 0, 5], [13, 3, 10]])
    expect(clips(r, a1)).toEqual([[0, 0, 10]])
  })

  it('copyClips duplicates clips (with their settings), optionally inserting', () => {
    const { p, v1, v2, a1 } = setup()
    const base = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 10, clipId: 'v' },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, out: 10, clipId: 'a' },
      { op: 'updateClip', clipId: 'v', fadeIn: 1 },
      { op: 'groupClips', clipIds: ['v', 'a'], groupId: 'g' }
    ])
    // Copy one clip onto another track, after the original.
    let r = applyOp(base, { op: 'copyClips', clipIds: ['v'], delta: 12, trackId: v2, newClipIds: ['v2copy'] })
    expect(clips(r, v1)).toEqual([[0, 0, 10]])
    const copy = r.tracks.find((t) => t.id === v2)!.clips[0]
    expect([copy.id, copy.start, copy.fadeIn, copy.groupId]).toEqual(['v2copy', 12, 1, undefined])
    // A copied group gets its own group id.
    r = applyOp(base, { op: 'copyClips', clipIds: ['v', 'a'], delta: 10, newClipIds: ['vc', 'ac'] })
    const [vc, ac] = ['vc', 'ac'].map((id) => r.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!)
    expect(vc.groupId).toBe(ac.groupId)
    expect(vc.groupId).not.toBe('g')
    // Insert: a copy dropped at 0:00 pushes everything later.
    r = applyOp(base, { op: 'copyClips', clipIds: ['v'], delta: 0, insert: true })
    expect(clips(r, v1)).toEqual([[0, 0, 10], [10, 0, 10]])
    expect(clips(r, a1)).toEqual([[10, 0, 10]])
  })

  it('pasteClips inserts copied clips anywhere, even after the originals are deleted', () => {
    const { p, v1, a1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 10 },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, out: 10 },
      { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 10, clipId: 'img' }
    ])
    const items = [{ trackId: v1, clip: r.tracks.find((t) => t.id === v1)!.clips[1] }]
    r = applyOp(r, { op: 'deleteClips', clipIds: ['img'] })
    // Paste the image at 0:04: the video is split there, everything after moves 5 s later.
    r = applyOp(r, { op: 'pasteClips', items, at: 4, insert: true, newClipIds: ['pasted'] })
    expect(clips(r, v1)).toEqual([[0, 0, 4], [4, 0, 5], [9, 4, 10]])
    expect(clips(r, a1)).toEqual([[0, 0, 10]])
    // A video clip asked onto an audio track falls back to its own track.
    r = applyOp(r, { op: 'pasteClips', items, at: 0, trackId: a1, newClipIds: ['p2'] })
    expect(r.tracks.find((t) => t.id === v1)!.clips.some((c) => c.id === 'p2')).toBe(true)
  })

  it('insertGap with trackIds moves only those tracks (and merged partners)', () => {
    const { p, v1, v2, a1 } = setup()
    const base = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 10, clipId: 'v' },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, out: 10, clipId: 'a' },
      { op: 'insertClip', trackId: v2, mediaId: 'm3', start: 2 },
      { op: 'addMarker', time: 3, label: 'm' }
    ])
    let r = applyOp(base, { op: 'insertGap', at: 0, length: 5, trackIds: [v2] })
    expect(clips(r, v2)).toEqual([[7, 0, 5]])
    expect(clips(r, v1)).toEqual([[0, 0, 10]])
    expect(r.markers[0].time).toBe(3)
    // Merged video + audio stay together.
    r = applyOps(base, [{ op: 'groupClips', clipIds: ['v', 'a'] }, { op: 'insertGap', at: 0, length: 5, trackIds: [v1] }])
    expect(clips(r, v1)).toEqual([[5, 0, 10]])
    expect(clips(r, a1)).toEqual([[5, 0, 10]])
    expect(clips(r, v2)).toEqual([[2, 0, 5]])
  })

  it('copied text layers are independent', () => {
    const { p, v1 } = setup()
    const text = MediaItem.parse({ id: 't', kind: 'graphic', name: 'Hi', path: '', duration: 0, graphic: { template: 'badge', title: 'Hi', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } } })
    let r = applyOps(p, [{ op: 'addMedia', items: [text] }, { op: 'insertClip', trackId: v1, mediaId: 't', start: 0, clipId: 'c1' }])
    // Paste gives the copy its own text.
    r = applyOp(r, { op: 'copyClips', clipIds: ['c1'], delta: 10, newClipIds: ['c2'] })
    const mediaOf = (id: string) => r.media.find((m) => m.id === r.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.mediaId)!
    expect(mediaOf('c2').id).not.toBe('t')
    // Clips that already share text (older copies) split off when one is edited.
    r = applyOp(r, { op: 'insertClip', trackId: v1, mediaId: 't', start: 20, clipId: 'c3' })
    r = applyOp(r, { op: 'updateMedia', mediaId: 't', clipId: 'c3', patch: { graphic: { title: 'Changed' } } })
    expect(mediaOf('c3').graphic!.title).toBe('Changed')
    expect(mediaOf('c1').graphic!.title).toBe('Hi')
  })

  it('closeGapsOps removes time that is empty on every track', () => {
    const { p, v1, a1 } = setup()
    const r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 2, out: 4 }, // 2–6
      { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 10 }, // 10–15
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 8, out: 4 }, // 8–12 covers part of the V gap
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 20, in: 0, out: 1 } // 20–21
    ])
    const closed = applyOps(r, closeGapsOps(r))
    // Gaps 0–2, 6–8 and 15–20 go; the audio keeps its place relative to the video.
    expect(clips(closed, v1)).toEqual([
      [0, 0, 4],
      [6, 0, 5],
      [11, 0, 1]
    ])
    expect(clips(closed, a1)).toEqual([[4, 0, 4]])
    expect(closeGapsOps(closed)).toEqual([])
  })

  it('respects locked tracks', () => {
    const { p, v1 } = setup()
    let r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, clipId: 'x' })
    r = { ...r, tracks: r.tracks.map((t) => (t.id === v1 ? { ...t, locked: true } : t)) }
    expect(() => applyOp(r, { op: 'deleteClips', clipIds: ['x'] })).toThrow(EditError)
  })
})

describe('audio ops', () => {
  it('detaches a video clip\'s sound onto a free audio track', () => {
    const { p, v1, a1 } = setup()
    let r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 2, in: 5, out: 15, clipId: 'x' })
    r = applyOp(r, { op: 'detachAudio', clipId: 'x', newClipId: 'xa' })
    expect(r.tracks.find((t) => t.id === v1)!.clips[0].muted).toBe(true)
    expect(r.tracks.find((t) => t.id === a1)!.clips[0]).toMatchObject({ id: 'xa', mediaId: 'm1', start: 2, in: 5, out: 15, muted: false })
    // The detached sound can be trimmed on its own (J/L cut).
    r = applyOp(r, { op: 'trimClip', clipId: 'xa', edge: 'start', time: 1 })
    expect(r.tracks.find((t) => t.id === a1)!.clips[0]).toMatchObject({ start: 1, in: 4 })
  })

  it('adds an audio track when the existing ones are busy', () => {
    const { p, v1, a1 } = setup()
    const tracksBefore = p.tracks.length
    let r = applyOps(p, [
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0 },
      { op: 'insertClip', trackId: p.tracks[3].id, mediaId: 'm2', start: 0 },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 5, clipId: 'x' }
    ])
    r = applyOp(r, { op: 'detachAudio', clipId: 'x' })
    expect(r.tracks.length).toBe(tracksBefore + 1)
  })

  it('refuses to detach sound from images or silent video', () => {
    const { p, v1 } = setup()
    const r = applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 0, clipId: 'img' })
    expect(() => applyOp(r, { op: 'detachAudio', clipId: 'img' })).toThrow(EditError)
  })

  it('stores volume keys sorted and clamped', () => {
    const { p, a1 } = setup()
    let r = applyOp(p, { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, clipId: 's' })
    r = applyOp(r, { op: 'setVolumeKeys', clipId: 's', keys: [{ t: 5, v: 9 }, { t: 1, v: 0.5 }] })
    expect(r.tracks.find((t) => t.id === a1)!.clips[0].volumeKeys).toEqual([{ t: 1, v: 0.5 }, { t: 5, v: 4 }])
  })
})

describe('merged clips (groups)', () => {
  function grouped() {
    const { p, v1, a1 } = setup()
    const r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 5, clipId: 'a' },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 5, in: 10, out: 15, clipId: 'b' },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0, out: 10, clipId: 'c' },
      { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 20, clipId: 'd' },
      { op: 'groupClips', clipIds: ['a', 'b', 'c'], groupId: 'g' }
    ])
    return { r, v1, a1 }
  }

  it('selecting one member finds the whole group', () => {
    const { r } = grouped()
    expect(withGroupMembers(r, ['b']).sort()).toEqual(['a', 'b', 'c'])
    expect(withGroupMembers(r, ['d'])).toEqual(['d'])
  })

  it('moves the group without members on one track overwriting each other', () => {
    const { r, v1, a1 } = grouped()
    const m = applyOp(r, { op: 'moveClips', clipIds: ['a', 'b', 'c'], delta: 3 })
    expect(clips(m, v1)).toEqual([
      [3, 0, 5],
      [8, 10, 15],
      [20, 0, 5]
    ])
    expect(clips(m, a1)).toEqual([[3, 0, 10]])
    // Can't go before 0:00: the whole group stops there together.
    const back = applyOp(m, { op: 'moveClips', clipIds: ['a', 'b', 'c'], delta: -10 })
    expect(clips(back, v1).slice(0, 2)).toEqual([
      [0, 0, 5],
      [5, 10, 15]
    ])
  })

  it('cut pieces stay in the group; ungroup separates all of them', () => {
    const { r } = grouped()
    const cut = applyOp(r, { op: 'splitClip', clipId: 'c', time: 2, newClipId: 'c2' })
    expect(withGroupMembers(cut, ['a']).sort()).toEqual(['a', 'b', 'c', 'c2'])
    const free = applyOp(cut, { op: 'ungroupClips', clipIds: ['b'] })
    expect(free.tracks.flatMap((t) => t.clips).every((c) => !c.groupId)).toBe(true)
  })

  it('needs two clips to merge', () => {
    const { r } = grouped()
    expect(() => applyOp(r, { op: 'groupClips', clipIds: ['d'] })).toThrow(EditError)
  })
})

describe('deleted items (trash)', () => {
  it('keeps deleted clips and puts them back, re-opening a ripple gap', () => {
    const { p, v1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 5, clipId: 'a' },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 5, in: 10, out: 15, clipId: 'b' },
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 10, in: 20, out: 25, clipId: 'c' }
    ])
    const before = clips(r, v1)
    r = applyOp(r, { op: 'deleteClips', clipIds: ['b'], ripple: true })
    expect(r.trash).toHaveLength(1)
    expect(r.trash[0]).toMatchObject({ gap: 'track', start: 5, end: 10 })
    r = applyOp(r, { op: 'restoreTrash', entryId: r.trash[0].id })
    expect(clips(r, v1)).toEqual(before)
    expect(r.trash).toEqual([])
  })

  it('restores at another time, overwriting what is there', () => {
    const { p, v1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 0, clipId: 'a' },
      { op: 'deleteClips', clipIds: ['a'] }
    ])
    r = applyOp(r, { op: 'restoreTrash', entryId: r.trash[0].id, at: 12 })
    expect(clips(r, v1)).toEqual([[12, 0, 5]])
  })

  it('undoes a range cut on every track, even after later cuts', () => {
    const { p, v1, a1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 30 },
      { op: 'insertClip', trackId: a1, mediaId: 'm2', start: 0 }
    ])
    r = applyOp(r, { op: 'rippleDeleteRange', start: 10, end: 12 })
    const cut = r.trash[0]
    expect(cut.clips).toHaveLength(2)
    // An earlier cut moves the deleted item's position along with the timeline.
    r = applyOp(r, { op: 'rippleDeleteRange', start: 2, end: 3 })
    expect(r.trash.find((e) => e.id === cut.id)!.start).toBe(9)
    r = applyOp(r, { op: 'restoreTrash', entryId: cut.id })
    // Source time 12.. plays right after source 10–12 again.
    expect(clips(r, v1)).toEqual([
      [0, 0, 2],
      [2, 3, 10],
      [9, 10, 12],
      [11, 12, 30]
    ])
    expect(projectEnd(r)).toBe(29)
  })

  it('records nothing for cuts of empty time', () => {
    const { p, v1 } = setup()
    const r = applyOps(p, [{ op: 'insertClip', trackId: v1, mediaId: 'm3', start: 4 }, ...closeGapsOps(applyOp(p, { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 4 }))])
    expect(r.trash).toEqual([])
  })
})

describe('ripple trim', () => {
  it('grows a clip into the next one, pushing it later', () => {
    const { p, v1 } = setup()
    let r = applyOps(p, [
      { op: 'insertClip', trackId: v1, mediaId: 'm1', start: 0, out: 5, clipId: 'a' },
      { op: 'insertClip', trackId: v1, mediaId: 'm3', start: 5, clipId: 'b' }
    ])
    expect(clips(applyOp(r, { op: 'trimClip', clipId: 'a', edge: 'end', time: 8 }), v1)[0]).toEqual([0, 0, 5]) // blocked by b
    r = applyOp(r, { op: 'trimClip', clipId: 'a', edge: 'end', time: 8, ripple: true })
    expect(clips(r, v1)).toEqual([
      [0, 0, 8],
      [8, 0, 5]
    ])
    r = applyOp(r, { op: 'trimClip', clipId: 'a', edge: 'start', time: 2, ripple: true })
    expect(clips(r, v1)).toEqual([
      [0, 2, 8],
      [6, 0, 5]
    ])
  })
})

const projectEnd = (p: Project): number => Math.max(...p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.out - c.in)))
