import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem, type Project } from './project'
import { audioSegments, gainAt, visualLayersAt } from './render-plan'
import { placeInRect, placementToTransform, transformToPlacement } from './scene'

const vid = (id: string, duration = 60) =>
  MediaItem.parse({ id, kind: 'video', name: id, path: id, duration, width: 1920, height: 1080, hasAudio: true })

function twoClips(): Project {
  const p = createProject('p')
  const v1 = p.tracks[0].id
  return applyOps(p, [
    { op: 'addMedia', items: [vid('a'), vid('b')] },
    { op: 'insertClip', trackId: v1, mediaId: 'a', start: 0, in: 10, out: 20, clipId: 'A' },
    { op: 'insertClip', trackId: v1, mediaId: 'b', start: 10, in: 5, out: 15, clipId: 'B' }
  ])
}

describe('visualLayersAt', () => {
  it('shows the clip under the playhead with the right source time', () => {
    const p = twoClips()
    expect(visualLayersAt(p, 3).map((l) => [l.key, l.sourceTime, l.alpha])).toEqual([['A', 13, 1]])
    expect(visualLayersAt(p, 10).map((l) => [l.key, l.sourceTime])).toEqual([['B', 5]])
    expect(visualLayersAt(p, 25)).toEqual([])
  })

  it('applies fades', () => {
    const p = applyOps(twoClips(), [{ op: 'updateClip', clipId: 'A', fadeIn: 2, fadeOut: 1 }])
    expect(visualLayersAt(p, 1)[0].alpha).toBeCloseTo(0.5)
    expect(visualLayersAt(p, 9.5)[0].alpha).toBeCloseTo(0.5)
    expect(visualLayersAt(p, 5)[0].alpha).toBe(1)
  })

  it('crossfades using extra source on both sides of the cut', () => {
    const p = applyOps(twoClips(), [{ op: 'updateClip', clipId: 'B', crossfadeIn: 2 }])
    // Window is 9..11. At 9.5: A underneath (source 19.5), B fading in from source 4.5.
    const l = visualLayersAt(p, 9.5)
    expect(l.map((x) => x.key)).toEqual(['A', 'B'])
    expect(l[1].sourceTime).toBeCloseTo(4.5)
    expect(l[1].alpha).toBeCloseTo(0.25)
    // At 10.5 A continues past its out point (source 20.5).
    const m = visualLayersAt(p, 10.5)
    expect(m[0].sourceTime).toBeCloseTo(20.5)
    expect(m[1].alpha).toBeCloseTo(0.75)
    expect(visualLayersAt(p, 11.5).map((x) => x.key)).toEqual(['B'])
  })

  it('shortens the crossfade when there is no extra source', () => {
    const p0 = createProject('p')
    const v1 = p0.tracks[0].id
    const p = applyOps(p0, [
      { op: 'addMedia', items: [vid('a', 10), vid('b')] },
      { op: 'insertClip', trackId: v1, mediaId: 'a', start: 0, in: 0, out: 9.5, clipId: 'A' }, // 0.5 s handle
      { op: 'insertClip', trackId: v1, mediaId: 'b', start: 9.5, in: 5, out: 15, clipId: 'B', },
      { op: 'updateClip', clipId: 'B', crossfadeIn: 4 }
    ])
    expect(visualLayersAt(p, 8.9).map((x) => x.key)).toEqual(['A']) // window is only 9..10
    expect(visualLayersAt(p, 9.2).map((x) => x.key)).toEqual(['A', 'B'])
  })

  it('stacks tracks bottom to top and skips hidden tracks', () => {
    let p = twoClips()
    p = applyOps(p, [{ op: 'insertClip', trackId: p.tracks[1].id, mediaId: 'b', start: 0, out: 5, clipId: 'TOP' }])
    expect(visualLayersAt(p, 1).map((l) => l.key)).toEqual(['A', 'TOP'])
    p = applyOps(p, [{ op: 'updateTrack', trackId: p.tracks[1].id, patch: { hidden: true } }])
    expect(visualLayersAt(p, 1).map((l) => l.key)).toEqual(['A'])
  })
})

describe('audioSegments', () => {
  it('builds crossfade gain ramps for both clips', () => {
    const p = applyOps(twoClips(), [{ op: 'updateClip', clipId: 'B', crossfadeIn: 2 }])
    const [a, b] = audioSegments(p)
    expect([a.start, a.duration, a.in]).toEqual([0, 11, 10])
    expect([b.start, b.duration, b.in]).toEqual([9, 11, 4])
    expect(gainAt(a, 5)).toBe(1)
    expect(gainAt(a, 10)).toBeCloseTo(0.5)
    expect(gainAt(b, 10)).toBeCloseTo(0.5)
    expect(gainAt(b, 12)).toBe(1)
  })

  it('applies fades and volume, and skips muted tracks', () => {
    let p = applyOps(twoClips(), [{ op: 'updateClip', clipId: 'A', fadeOut: 2, volume: 0.5 }])
    const [a] = audioSegments(p)
    expect(gainAt(a, 5)).toBe(0.5)
    expect(gainAt(a, 9)).toBeCloseTo(0.25)
    p = applyOps(p, [{ op: 'updateTrack', trackId: p.tracks[0].id, patch: { muted: true } }])
    expect(audioSegments(p)).toEqual([])
  })
})

describe('transformToPlacement', () => {
  it('is the inverse of placementToTransform', () => {
    const src = placeInRect(1280, 720, { x: 1500, y: 700, w: 345.6, h: 345.6 }, 'cover')
    const t = placementToTransform(src, 1280, 720, 1920, 1080)
    const back = transformToPlacement(t, 1280, 720, 1920, 1080)
    for (const k of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh'] as const) expect(back[k]).toBeCloseTo(src[k])
  })
})

describe('audio automation', () => {
  it('multiplies volume keys (anchored to source time) with volume and fades', () => {
    let p = twoClips()
    // A plays source 10..20 at timeline 0..10. Keys at source 12 (full) → 14 (quarter).
    p = applyOps(p, [
      { op: 'updateClip', clipId: 'A', volume: 0.5 },
      { op: 'setVolumeKeys', clipId: 'A', keys: [{ t: 12, v: 1 }, { t: 14, v: 0.25 }] }
    ])
    const [a] = audioSegments(p)
    expect(gainAt(a, 1)).toBeCloseTo(0.5) // before first key: first key's value
    expect(gainAt(a, 3)).toBeCloseTo(0.5 * 0.625) // halfway down the ramp
    expect(gainAt(a, 6)).toBeCloseTo(0.125)
    // Trimming the start keeps keys on the same content.
    p = applyOps(p, [{ op: 'trimClip', clipId: 'A', edge: 'start', time: 2 }])
    const [a2] = audioSegments(p)
    expect(gainAt(a2, 3)).toBeCloseTo(0.5 * 0.625)
  })

  it('skips muted clips and uses the enhanced file when voice cleanup is on', () => {
    let p = applyOps(twoClips(), [{ op: 'updateClip', clipId: 'A', muted: true }, { op: 'updateClip', clipId: 'B', enhance: 'medium' }])
    const segs = audioSegments(p)
    expect(segs.map((s) => s.key)).toEqual(['B'])
    expect(segs[0].audioPath).toBe('cache/audio/b-voice-medium.flac')
  })
})
