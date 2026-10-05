import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem } from './project'
import { createScene, SCENE_PRESETS, sourceKey } from './scene'
import { micGainFor, MIC_LABEL, PROGRAM_LABEL, SYSTEM_LABEL, takeToOps } from './take'

const media = (id: string, kind: 'video' | 'audio', duration: number, w?: number, h?: number) =>
  MediaItem.parse({ id, kind, name: id, path: `recordings/t/${id}`, duration, width: w, height: h })

describe('takeToOps', () => {
  it('lays out a screen + camera take on the timeline, keeping sync offsets', () => {
    const project = createProject('p')
    const scene = createScene('Main', SCENE_PRESETS[0], 1920, 1080)
    const [screen, cam] = scene.items
    const finished = [
      { label: sourceKey(screen), item: media('screen', 'video', 10, 1920, 1080), offset: 0 },
      { label: sourceKey(cam), item: media('cam', 'video', 9.9, 1280, 720), offset: 0.1 },
      { label: MIC_LABEL, item: media('mic', 'audio', 10), offset: 0 },
      { label: SYSTEM_LABEL, item: media('sys', 'audio', 10), offset: 0 },
      { label: PROGRAM_LABEL, item: media('program', 'video', 10, 1920, 1080), offset: 0 }
    ]
    const p = applyOps(project, takeToOps(project, scene, finished))

    expect(p.media).toHaveLength(5)
    const [v1, v2, a1, a2] = p.tracks
    expect(v1.clips[0]).toMatchObject({ mediaId: 'screen', start: 0, out: 10 })
    expect(v1.clips[0].transform.scale).toBeCloseTo(1)
    expect(v2.clips[0]).toMatchObject({ mediaId: 'cam', start: 0.1 })
    expect(v2.clips[0].transform.mask).toBe('circle')
    expect(v2.clips[0].transform.scale).toBeCloseTo(0.32)
    expect(a1.clips[0].mediaId).toBe('mic')
    expect(a2.clips[0].mediaId).toBe('sys')
    // The program video is in the media bin but not on the timeline.
    expect(p.tracks.flatMap((t) => t.clips).some((c) => c.mediaId === 'program')).toBe(false)
  })

  it('appends a second take after the first and adds tracks when needed', () => {
    const project = createProject('p')
    const scene = createScene('Main', SCENE_PRESETS[0], 1920, 1080)
    const take = (n: number) => [
      { label: scene.items[0].id, item: media(`s${n}`, 'video', 5, 1920, 1080), offset: 0 },
      { label: scene.items[1].id, item: media(`c${n}`, 'video', 5, 1280, 720), offset: 0 }
    ]
    let p = applyOps(project, takeToOps(project, scene, take(1)))
    p = applyOps(p, takeToOps(p, scene, take(2)))
    expect(p.tracks[0].clips.map((c) => c.start)).toEqual([0, 5])

    // A 3-layer scene on a project with only 2 video tracks gets a third track.
    const three = { ...scene, items: [...scene.items, { ...scene.items[1], id: 'cam2' }] }
    const p3 = applyOps(project, takeToOps(project, three, [...take(1), { label: 'cam2', item: media('c3', 'video', 5, 640, 480), offset: 0 }]))
    expect(p3.tracks.filter((t) => t.kind === 'video')).toHaveLength(3)
  })
})

describe('switching scenes while recording', () => {
  it('gives each stretch of the take the layout of the scene shown then', () => {
    const project = createProject('p')
    const bubble = createScene('Bubble', SCENE_PRESETS[0], 1920, 1080)
    const [screen, cam] = bubble.items
    // Same sources, other layout: camera full screen and the screen hidden.
    const camFull = { ...bubble, id: 'cam-full', items: [{ ...screen, visible: false }, { ...cam, rect: { x: 0, y: 0, w: 1, h: 1 }, mask: 'none' as const }] }
    const finished = [
      { label: sourceKey(screen), item: media('screen', 'video', 10, 1920, 1080), offset: 0 },
      { label: sourceKey(cam), item: media('cam', 'video', 10, 1280, 720), offset: 0 },
      { label: MIC_LABEL, item: media('mic', 'audio', 10), offset: 0 }
    ]
    const p = applyOps(project, takeToOps(project, [{ at: 0, scene: bubble }, { at: 4, scene: camFull }, { at: 7, scene: bubble }], finished))
    const clips = p.tracks.flatMap((t) => t.clips.map((c) => ({ track: t.name, media: c.mediaId, start: c.start, in: c.in, out: c.out, scale: c.transform.scale })))
    const cams = clips.filter((c) => c.media === 'cam').sort((a, b) => a.start - b.start)
    expect(cams.map((c) => [c.start, c.in, c.out])).toEqual([[0, 0, 4], [4, 4, 7], [7, 7, 10]])
    // Bubble → full screen → bubble.
    expect(cams[0].scale).toBeCloseTo(0.32)
    expect(cams[1].scale).toBeCloseTo(1)
    // The screen is only on the timeline while a scene shows it.
    expect(clips.filter((c) => c.media === 'screen').map((c) => [c.start, c.out])).toEqual([[0, 4], [7, 10]])
    // The mic is one continuous clip.
    expect(clips.filter((c) => c.media === 'mic')).toHaveLength(1)
  })
})

describe('quiet mic', () => {
  it('raises a quiet mic clip so its peak reaches -3 dB, capped at 4x', () => {
    expect(micGainFor(-6)).toBe(1)
    expect(micGainFor(undefined)).toBe(1)
    expect(micGainFor(-15)).toBeCloseTo(3.98, 1)
    expect(micGainFor(-18.2)).toBe(4) // the test6 recording: needs +15 dB, capped at +12 dB
    const project = createProject('p')
    const scene = createScene('Main', SCENE_PRESETS[2], 1920, 1080)
    const finished = [
      { label: scene.items[0].id, item: media('cam', 'video', 5, 1280, 720), offset: 0 },
      { label: MIC_LABEL, item: media('mic', 'audio', 5), offset: 0, peakDb: -20 }
    ]
    const p = applyOps(project, takeToOps(project, scene, finished))
    expect(p.tracks.find((t) => t.kind === 'audio')!.clips[0].volume).toBe(4)
  })
})
