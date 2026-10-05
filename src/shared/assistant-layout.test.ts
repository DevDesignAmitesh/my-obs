import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem, type Project } from './project'
import { buildContext, describeEdit, validateEdits, type AiEdit } from './assistant'
import { visualLayersAt } from './render-plan'
import { buildCues, timelineWords } from './captions'

/** Mirrors the user's test1 project: a camera recording on V1, the mic on A1, plus program.mp4 in the bin. */
function test1(): Project {
  const p = createProject('test1')
  const [v1, , a1] = p.tracks.map((t) => t.id)
  const cam = MediaItem.parse({ id: 'cam', kind: 'video', name: 'Camera.mp4', path: 'recordings/t/Camera.mp4', duration: 52.87, width: 1280, height: 720 })
  const mic = MediaItem.parse({ id: 'mic', kind: 'audio', name: 'mic.m4a', path: 'recordings/t/mic.m4a', duration: 52.95, hasAudio: true })
  const prog = MediaItem.parse({ id: 'prog', kind: 'video', name: 'program.mp4', path: 'recordings/t/program.mp4', duration: 52.87, width: 1920, height: 1080 })
  const words = 'Now what I want is I will ask AI to do some changes'.split(' ').map((text, i) => ({ text, start: 4 + i * 0.4, end: 4.3 + i * 0.4 }))
  return applyOps(p, [
    { op: 'addMedia', items: [cam, mic, prog] },
    { op: 'insertClip', trackId: v1, mediaId: 'cam', start: 0, clipId: 'C' },
    { op: 'insertClip', trackId: a1, mediaId: 'mic', start: 0, clipId: 'M' },
    { op: 'setTranscript', mediaId: 'mic', transcript: { provider: 't', model: 't', createdAt: '', words } }
  ])
}

describe('the test1 request: "after 5 s, camera bottom-left rectangle over a full canvas that shows my captions on the right"', () => {
  it('can now be expressed with the new edits and gives the intended layout', () => {
    const p = test1()
    const [v1, v2] = p.tracks.map((t) => t.id)
    const edits: AiEdit[] = [
      { op: 'splitClip', clipId: 'C', time: 5, newClipId: 'cam_after' },
      { op: 'moveClip', clipId: 'cam_after', start: 5, trackId: v2 },
      { op: 'updateClip', clipId: 'cam_after', transform: { x: 0.2, y: 0.78, scale: 0.33, mask: 'none', flipH: true } },
      { op: 'addColor', color: '#101828', trackId: v1, start: 5, end: 52.87, clipId: 'panel' },
      { op: 'setCaptionStyle', patch: { enabled: true, x: 0.72, width: 0.5, y: 0.45 } }
    ]
    const r = validateEdits(p, edits)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const after = r.after

    // 0–5 s: the camera full-screen, nothing else.
    expect(visualLayersAt(after, 2).map((l) => l.key)).toEqual(['C'])
    // After 5 s: the color panel underneath, the mirrored camera rectangle on top.
    const layers = visualLayersAt(after, 10)
    expect(layers.map((l) => l.key)).toEqual(['panel', 'cam_after'])
    expect(layers[0].media).toMatchObject({ kind: 'color', color: '#101828' })
    expect(layers[1].clip.transform).toMatchObject({ x: 0.2, y: 0.78, scale: 0.33, flipH: true })
    // The camera stays in sync with the audio (source time = timeline time).
    expect(layers[1].sourceTime).toBeCloseTo(10)
    // program.mp4 is not used.
    expect(after.tracks.flatMap((t) => t.clips).some((c) => c.mediaId === 'prog')).toBe(false)
    // Captions render in the right half.
    expect(after.captionStyle).toMatchObject({ x: 0.72, width: 0.5 })
    expect(buildCues(timelineWords(after), after.captionStyle).length).toBeGreaterThan(0)

    expect(edits.map((e) => describeEdit(e, p))).toEqual([
      'Split “Camera.mp4” on V1 at 0:05.0',
      'Move a clip to 0:05.0',
      'Change a clip: layout (x, y, scale, mask), mirror',
      'Add a #101828 color layer 0:05.0–0:52.9',
      'Captions: enabled = true, x = 0.72, width = 0.5, y = 0.45'
    ])
  })

  it('rejects reusing an id', () => {
    expect(validateEdits(test1(), [{ op: 'splitClip', clipId: 'C', time: 5, newClipId: 'M' }])).toMatchObject({ ok: false, error: 'Clip id M is already used' })
    const p = test1()
    expect(validateEdits(p, [{ op: 'addTrack', kind: 'video', trackId: p.tracks[0].id }])).toMatchObject({ ok: false, error: expect.stringContaining('already used') })
  })

  it('tells the AI what program.mp4 is', () => {
    expect(buildContext(test1(), null, 0)).toContain('program.mp4 | video | 52.87 s | 1920x1080 NOTE: the recorder')
  })
})
