import { describe, expect, it } from 'vitest'
import { animateKeys, cornerTransform, transformAt } from './animation'
import { buildContext, compileEdits, describeEdit, sentenceEndAfter, validateEdits, type AiEdit } from './assistant'
import { timelineWords } from './captions'
import { defaultGraphic, graphicLabel, mainText } from './graphics'
import { applyOps } from './ops'
import { overlayTrack } from './placement'
import { createProject, MediaItem, type Project } from './project'
import { visualLayersAt } from './render-plan'
import { MODES } from './modes'

function talk(): Project {
  const p = createProject('talk')
  const [v1, , a1] = p.tracks.map((t) => t.id)
  const cam = MediaItem.parse({ id: 'cam', kind: 'video', name: 'Camera.mp4', path: 'c.mp4', duration: 60, width: 1280, height: 720, hasAudio: false })
  const mic = MediaItem.parse({ id: 'mic', kind: 'audio', name: 'mic.m4a', path: 'm.m4a', duration: 60, hasAudio: true })
  const text = 'So I built an inference engine. The hot loop is the forward function. Flattening the weights made it ten times faster.'
  const words = text.split(' ').map((w, i) => ({ text: w, start: 1 + i * 0.45 + (i > 5 ? 1 : 0), end: 1.35 + i * 0.45 + (i > 5 ? 1 : 0) }))
  return applyOps(p, [
    { op: 'addMedia', items: [cam, mic] },
    { op: 'insertClip', trackId: v1, mediaId: 'cam', start: 0, clipId: 'C' },
    { op: 'insertClip', trackId: a1, mediaId: 'mic', start: 0, clipId: 'M' },
    { op: 'setTranscript', mediaId: 'mic', transcript: { provider: 't', model: 't', createdAt: '', words } }
  ])
}

describe('keyframe animation', () => {
  it('interpolates smoothly between keys and holds before/after', () => {
    const clip = { transform: talk().tracks[0].clips[0].transform, keys: [{ t: 10, x: 0.5, scale: 1, ease: 'smooth' as const }, { t: 11, x: 0.8, scale: 0.3, ease: 'smooth' as const }] }
    expect(transformAt(clip, 5).x).toBe(0.5)
    expect(transformAt(clip, 10.5).x).toBeCloseTo(0.65)
    expect(transformAt(clip, 10.25).scale).toBeGreaterThan(0.8) // smooth start
    expect(transformAt(clip, 20)).toMatchObject({ x: 0.8, scale: 0.3 })
  })

  it('puts media into a corner with a margin', () => {
    const t = cornerTransform('bottom-right', 1280, 720, 1920, 1080, 0.33)
    const halfW = (1920 * 0.33) / 2 / 1920
    expect(t.x).toBeCloseTo(1 - 0.035 - halfW)
    expect(t.scale).toBeCloseTo(0.33)
    expect(t.y).toBeGreaterThan(0.75)
    expect(cornerTransform('full', 1280, 720, 1920, 1080)).toMatchObject({ x: 0.5, y: 0.5, scale: 1 })
  })

  it('animateKeys starts from the current state and replaces keys in the window', () => {
    const clip = { ...talk().tracks[0].clips[0], keys: [{ t: 12.3, x: 0.1, ease: 'smooth' as const }] }
    const keys = animateKeys(clip, 12, 0.6, { x: 0.8, scale: 0.3 })
    expect(keys.map((k) => k.t)).toEqual([12, 12.6])
    expect(keys[0]).toMatchObject({ x: 0.1, scale: 1 })
  })
})

describe('graphics', () => {
  it('has a default for every template, portrait included', () => {
    for (const t of ['title', 'lowerThird', 'heading', 'text', 'badge', 'stat', 'list', 'code'] as const) {
      const g = defaultGraphic(t)
      expect(g.box.w).toBeGreaterThan(0)
      expect(defaultGraphic(t, 1080, 1920).box.x + defaultGraphic(t, 1080, 1920).box.w).toBeLessThanOrEqual(1)
    }
    expect(graphicLabel(defaultGraphic('stat'))).toBe('Big stat: 10×')
  })

  it('offers one default look per video mode', () => {
    expect(MODES.map((m) => m.id)).toEqual(['explainer', 'demo', 'happening'])
  })

  it('places overlays above whatever is showing, adding a track when needed', () => {
    const p = talk()
    // V1 busy (camera), V2 free → V2.
    expect(overlayTrack(p, 2, 4)).toEqual({ trackId: p.tracks[1].id, ops: [] })
    const busy = applyOps(p, [{ op: 'insertClip', trackId: p.tracks[1].id, mediaId: 'cam', start: 0, out: 10 }])
    const r = overlayTrack(busy, 2, 4)
    expect(r.ops).toHaveLength(1)
    expect(r.ops[0]).toMatchObject({ op: 'addTrack', kind: 'video' })
  })
})

describe('an explainer section proposed by the AI', () => {
  const edits = (p: Project): AiEdit[] => [
    { op: 'splitClip', clipId: 'C', time: 20, newClipId: 'cam_b' },
    { op: 'splitClip', clipId: 'cam_b', time: 40, newClipId: 'cam_c' },
    { op: 'addTrack', kind: 'video', trackId: 'v_cam' },
    { op: 'moveClip', clipId: 'cam_b', start: 20, trackId: 'v_cam' },
    { op: 'addColor', color: p.theme.background, trackId: p.tracks[0].id, start: 20, end: 40, clipId: 'bg' },
    { op: 'animate', clipId: 'cam_b', time: 20, duration: 0.6, corner: 'bottom-right', size: 0.33 },
    { op: 'addGraphic', template: 'heading', start: 20.4, end: 40, kicker: '01 — THE HOT LOOP', title: 'forward() is the inference', clipId: 'h1' },
    { op: 'addGraphic', template: 'code', start: 20.4, end: 40, code: 'for (i...)\n  out[i] += w[i] * x[i];', filename: 'net.cc', highlights: [{ lines: [2], at: 3 }], clipId: 'code1' },
    { op: 'addGraphic', template: 'lowerThird', start: 41, end: 45, title: 'Inference = execute the math, fast', clipId: 'lt' },
    { op: 'setTheme', preset: 'explainer' }
  ]

  it('validates and produces the intended layers', () => {
    const p = talk()
    const r = validateEdits(p, edits(p))
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    // Before the section: camera only.
    expect(visualLayersAt(r.after, 10).map((l) => l.key)).toEqual(['C'])
    // Inside: background, camera in the corner, heading + code card on top.
    const inside = visualLayersAt(r.after, 30)
    expect(inside.map((l) => l.key)).toEqual(['bg', 'cam_b', 'h1', 'code1'])
    const cam = inside[1]
    expect(cam.transform.scale).toBeCloseTo(0.33)
    expect(cam.transform.x).toBeGreaterThan(0.75)
    // Mid-animation the camera is between full screen and the corner.
    const mid = visualLayersAt(r.after, 20.3).find((l) => l.key === 'cam_b')!
    expect(mid.transform.scale).toBeGreaterThan(0.33)
    expect(mid.transform.scale).toBeLessThan(1)
    // Text layers know how long they've been on screen (for their entrance animation).
    expect(inside[2].localTime).toBeCloseTo(9.6)
    expect(inside[3].media.graphic).toMatchObject({ template: 'code', filename: 'net.cc', panel: true })
    // After: camera full screen again (the third piece was never moved), lower third on top.
    expect(visualLayersAt(r.after, 42).map((l) => l.key)).toEqual(['cam_c', 'lt'])
  })

  it('describes the changes in plain language', () => {
    const p = talk()
    const d = edits(p).map((e) => describeEdit(e, p))
    expect(d[5]).toBe('Animate a clip to the bottom-right corner at 0:20.0 over 0.6s')
    expect(d[6]).toBe('Add Section heading: forward() is the inference (0:20.4–0:40.0)')
    expect(d[9]).toBe('Style: explainer theme')
  })

  it('never shows template placeholder text the AI did not write', () => {
    const { after } = compileEdits(talk(), [{ op: 'addGraphic', template: 'title', start: 1, end: 3, title: 'Only this', clipId: 't' }])
    const g = visualLayersAt(after, 2).find((l) => l.key === 't')!.media.graphic!
    expect(g).toMatchObject({ title: 'Only this', scrim: true })
    expect(g.subtitle).toBeUndefined()
    expect(g.kicker).toBeUndefined()
  })

  it('shows text given in a neighbouring field instead of a blank layer', () => {
    const { after } = compileEdits(talk(), [
      { op: 'addGraphic', template: 'badge', start: 1, end: 3, tag: 'LIVE DEMO', clipId: 'b' },
      { op: 'addGraphic', template: 'text', start: 1, end: 3, title: 'text in → text out', clipId: 'x' }
    ])
    const layers = visualLayersAt(after, 2)
    expect(mainText(layers.find((l) => l.key === 'b')!.media.graphic!)).toBe('LIVE DEMO')
    expect(mainText(layers.find((l) => l.key === 'x')!.media.graphic!)).toBe('text in → text out')
  })

  it('rejects unknown templates and missing animation targets', () => {
    const p = talk()
    expect(validateEdits(p, [{ op: 'addGraphic', template: 'sticker', start: 1, end: 2 }])).toMatchObject({ ok: false })
    expect(validateEdits(p, [{ op: 'animate', clipId: 'C', time: 1, duration: 1 }])).toMatchObject({ ok: false, error: expect.stringContaining('corner') })
  })

  it('lets later edits refer to layers created earlier in the same proposal', () => {
    const p = talk()
    const { after } = compileEdits(p, [
      { op: 'addGraphic', template: 'badge', start: 1, end: 3, title: 'NEW', clipId: 'b' },
      { op: 'updateGraphic', clipId: 'b', patch: { title: 'TIP' } },
      { op: 'animate', clipId: 'b', time: 2, duration: 0.5, to: { opacity: 0 } }
    ])
    const b = visualLayersAt(after, 1.5).find((l) => l.key === 'b')!
    expect(b.media.graphic?.title).toBe('TIP')
    // Faded out completely: not drawn at all.
    expect(visualLayersAt(after, 2.25).find((l) => l.key === 'b')!.alpha).toBeCloseTo(0.5, 1)
    expect(visualLayersAt(after, 2.6).find((l) => l.key === 'b')).toBeUndefined()
  })
})

describe('Ask about this frame', () => {
  it('defaults to the end of the sentence being spoken', () => {
    const words = timelineWords(talk())
    // "So I built an inference engine." ends at word 5 (end 1 + 5*0.45 + 0.35 = 3.6)
    expect(sentenceEndAfter(words, 2)).toBeCloseTo(4.0)
    expect(sentenceEndAfter([], 7)).toBe(11)
  })

  it('tells the AI where and when to act', () => {
    const ctx = buildContext(talk(), null, 2, { time: 2, box: { x: 0.6, y: 0.1, w: 0.35, h: 0.2 } })
    expect(ctx).toContain('FOCUS: the user paused at 2.00 s and drew a box on the frame at {"x":0.6,"y":0.1,"w":0.35,"h":0.2}')
    expect(ctx).toContain('last until 4.00 s')
    expect(ctx).toContain('Said around then: So@1.00-1.35')
  })
})
