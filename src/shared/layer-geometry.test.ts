import { describe, expect, it } from 'vitest'
import { MediaItem, Transform } from './project'
import { cornerPoint, hitLayer, layerGeometry, placeClip, scaleFromCorner, visibleRect } from './layer-geometry'

const W = 1920
const H = 1080
const logo = MediaItem.parse({ id: 'l', kind: 'image', name: 'logo.png', path: 'x', duration: 0, width: 500, height: 500 })
const tf = (p: Partial<Transform>): Transform => ({ ...Transform.parse({}), ...p })

describe('layer geometry', () => {
  it('fits the source to the canvas like the renderer', () => {
    const g = layerGeometry(logo, tf({ x: 0.5, y: 0.5, scale: 0.5 }), W, H)!
    expect(visibleRect(g)).toEqual({ x: 960 - 270, y: 540 - 270, w: 540, h: 540 })
    expect(hitLayer(g, { x: 960, y: 540 })).toBe(true)
    expect(hitLayer(g, { x: 100, y: 100 })).toBe(false)
  })

  it('uses the box of text layers', () => {
    const card = MediaItem.parse({ id: 'g', kind: 'graphic', name: 't', path: '', duration: 0, graphic: { template: 'badge', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } } })
    const g = layerGeometry(card, tf({}), W, H)!
    expect(visibleRect(g)).toEqual({ x: 192, y: 108, w: 384, h: 108 })
    expect(hitLayer(g, { x: 960, y: 540 })).toBe(false)
  })

  it('scales from a corner keeping the opposite corner still', () => {
    const g = layerGeometry(logo, tf({ scale: 0.5 }), W, H)!
    const fixed = cornerPoint(g, 'nw')
    const r = scaleFromCorner(g, 'se', { x: 690 + 1080, y: 270 + 1080 })
    expect(r.scale).toBeCloseTo(1)
    const g2 = { ...g, cx: r.cx, cy: r.cy, scale: r.scale }
    expect(cornerPoint(g2, 'nw').x).toBeCloseTo(fixed.x)
    expect(cornerPoint(g2, 'nw').y).toBeCloseTo(fixed.y)
  })

  it('keeps the anchor fixed when rotated too', () => {
    const g = layerGeometry(logo, tf({ scale: 0.5, rotation: 30 }), W, H)!
    const fixed = cornerPoint(g, 'sw')
    const r = scaleFromCorner(g, 'ne', { x: 1500, y: 100 })
    const g2 = { ...g, cx: r.cx, cy: r.cy, scale: r.scale }
    expect(cornerPoint(g2, 'sw').x).toBeCloseTo(fixed.x)
    expect(cornerPoint(g2, 'sw').y).toBeCloseTo(fixed.y)
  })

  it('writes keyframed values as a key at the current moment', () => {
    const clip = { keys: [{ t: 0, x: 0.2, ease: 'smooth' as const }, { t: 2, x: 0.8, ease: 'smooth' as const }] }
    const r = placeClip(clip, { x: 0.5, y: 0.3 }, 1, 30)
    expect(r.transform).toEqual({ y: 0.3 })
    expect(r.keys!.map((k) => [k.t, k.x])).toEqual([[0, 0.2], [1, 0.5], [2, 0.8]])
    expect(placeClip(clip, { x: 0.1 }, 2.01, 30).keys![1].x).toBe(0.1)
    expect(placeClip({ keys: [] }, { x: 0.1 }, 0, 30)).toEqual({ transform: { x: 0.1 }, keys: null })
  })
})
