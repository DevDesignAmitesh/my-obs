import { describe, expect, it } from 'vitest'
import { placeInRect, placementToTransform, rectToPixels, SCENE_PRESETS } from './scene'

describe('placeInRect', () => {
  it('contains a 16:9 source in a square with letterboxing', () => {
    const p = placeInRect(1920, 1080, { x: 0, y: 0, w: 100, h: 100 }, 'contain')
    expect(p).toMatchObject({ sx: 0, sw: 1920, dx: 0, dw: 100, dh: 56.25 })
    expect(p.dy).toBeCloseTo(21.875)
  })

  it('covers a square with a centered crop of a 16:9 source', () => {
    const p = placeInRect(1280, 720, { x: 10, y: 20, w: 300, h: 300 }, 'cover')
    expect(p).toMatchObject({ sx: 280, sy: 0, sw: 720, sh: 720, dx: 10, dy: 20, dw: 300, dh: 300 })
  })
})

describe('placementToTransform', () => {
  it('full-screen contain is the identity transform', () => {
    const t = placementToTransform(placeInRect(1920, 1080, { x: 0, y: 0, w: 1920, h: 1080 }, 'contain'), 1920, 1080, 1920, 1080)
    expect(t).toEqual({ x: 0.5, y: 0.5, scale: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } })
  })

  it('camera bubble maps to a cropped, scaled, offset clip', () => {
    const W = 1920
    const H = 1080
    const [, cam] = SCENE_PRESETS[0].build(W, H)
    const p = placeInRect(1280, 720, rectToPixels(cam.rect, W, H), cam.fit)
    const t = placementToTransform(p, 1280, 720, W, H)
    // Square crop of a 16:9 camera: 21.875% off each side.
    expect(t.crop.left).toBeCloseTo(0.21875)
    expect(t.crop.right).toBeCloseTo(0.21875)
    // 720px square contain-fitted to 1080 tall = 1080px; bubble is 345.6px → scale 0.32.
    expect(t.scale).toBeCloseTo(0.32)
    expect(t.x).toBeGreaterThan(0.8)
    expect(t.y).toBeGreaterThan(0.7)
  })
})
