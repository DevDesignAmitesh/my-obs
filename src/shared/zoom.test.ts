import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem } from './project'
import { visualLayersAt } from './render-plan'
import { createScene, SCENE_PRESETS, sourceKey } from './scene'
import { takeToOps } from './take'
import { zoomAt, zoomCrop, zoomsFromInput, type InputMark } from './zoom'

const click = (t: number, x = 0.8, y = 0.2): InputMark => ({ t, kind: 'click', x, y })
const key = (t: number): InputMark => ({ t, kind: 'key', x: 0.3, y: 0.7 })

describe('auto zoom', () => {
  it('zooms around clicks and typing, joining ones that are close together', () => {
    const zooms = zoomsFromInput([click(5), click(5.8, 0.6, 0.4), ...[10, 10.3, 10.6, 11].map(key), click(30)], 2, 31)
    expect(zooms).toHaveLength(3)
    // Two quick clicks: one zoom that pans from the first to the second.
    expect(zooms[0]).toMatchObject({ start: 4.5, scale: 2 })
    expect(zooms[0].end).toBeCloseTo(7.4)
    expect(zooms[0].points).toHaveLength(2)
    // Typing: from just before the first key until a second after the last.
    expect(zooms[1].start).toBeCloseTo(9.7)
    expect(zooms[1].end).toBeCloseTo(12)
    // Clipped to the recording's end.
    expect(zooms[2].end).toBe(31)
  })

  it('eases in, holds and eases out, staying inside the picture', () => {
    const [z] = zoomsFromInput([click(5, 0.95, 0.05)], 2, 20)
    expect(zoomAt([z], 3)).toBeNull()
    expect(zoomAt([z], 4.5)!.scale).toBeCloseTo(1)
    expect(zoomAt([z], 5.5)!.scale).toBeCloseTo(2)
    const crop = zoomCrop({ left: 0, top: 0, right: 0, bottom: 0 }, zoomAt([z], 5.5)!)
    // Half the picture, pushed against the top-right corner (never past the edge).
    expect(crop.left).toBeCloseTo(0.5)
    expect(crop.right).toBeCloseTo(0)
    expect(crop.top).toBeCloseTo(0)
    expect(crop.bottom).toBeCloseTo(0.5)
  })

  it('a recorded take gets zooms on its screen clip, and the preview/export uses them', () => {
    const project = createProject('p')
    const scene = createScene('Main', SCENE_PRESETS[0], 1920, 1080)
    const [screen] = scene.items
    const media = MediaItem.parse({ id: 'screen', kind: 'video', name: 's', path: 'r/s.mp4', duration: 10, width: 1920, height: 1080 })
    const finished = [{ label: sourceKey(screen), item: media, offset: 0 }]
    const p = applyOps(project, takeToOps(project, scene, finished, { marks: { [sourceKey(screen)]: [click(4, 0.5, 0.5)] }, scale: 2 }))
    const clip = p.tracks[0].clips[0]
    expect(clip.zooms).toHaveLength(1)
    const layer = visualLayersAt(p, 4.5).find((l) => l.clip.id === clip.id)!
    expect(layer.transform.crop.left).toBeCloseTo(0.25)
    // The stored transform itself is unchanged.
    expect(clip.transform.crop.left).toBe(0)
  })
})
