import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem, projectDuration, type Project } from './project'
import { buildContext, describeEdit, expandEdits, FULL_TRANSCRIPT_WORDS, validateEdits } from './assistant'

function project(words = 'Hello@1-1.4 and@1.5-1.7 welcome@1.8-2.3 back@2.4-2.8', duration = 20): Project {
  const p = createProject('p')
  const vid = MediaItem.parse({ id: 'cam', kind: 'video', name: 'cam.mp4', path: 'cam.mp4', duration, width: 1280, height: 720, hasAudio: true })
  return applyOps(p, [
    { op: 'addMedia', items: [vid] },
    { op: 'insertClip', trackId: p.tracks[0].id, mediaId: 'cam', start: 0, clipId: 'C' },
    {
      op: 'setTranscript',
      mediaId: 'cam',
      transcript: {
        provider: 't',
        model: 't',
        createdAt: '',
        words: words.split(' ').map((s) => {
          const [text, t] = s.split('@')
          const [start, end] = t.split('-').map(Number)
          return { text, start, end }
        })
      }
    }
  ])
}

describe('expandEdits', () => {
  it('merges cut ranges and applies them latest-first', () => {
    const ops = expandEdits([{ op: 'cutRanges', ranges: [[2.4, 3], [8, 5], [2.5, 4]] }], project())
    expect(ops).toEqual([
      { op: 'rippleDeleteRange', start: 5, end: 8 },
      { op: 'rippleDeleteRange', start: 2.4, end: 4 }
    ])
    // Applying them removes exactly 4.6 s.
    const p = project()
    expect(projectDuration(applyOps(p, ops))).toBeCloseTo(15.4)
  })
})

describe('validateEdits', () => {
  it('accepts valid edits and returns the result', () => {
    const r = validateEdits(project(), [{ op: 'cutRanges', ranges: [[1.45, 1.75]] }, { op: 'setCaptionStyle', patch: { enabled: true } }])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.after.captionStyle.enabled).toBe(true)
  })

  it('explains mistakes so the AI can fix them', () => {
    expect(validateEdits(project(), [{ op: 'deleteClips', clipIds: ['nope'] }])).toEqual({ ok: true, after: expect.anything() })
    expect(validateEdits(project(), [{ op: 'moveClip', clipId: 'nope', start: 1 }])).toEqual({ ok: false, error: 'Clip not found: nope' })
    expect(validateEdits(project(), [{ op: 'removeMedia', mediaId: 'cam' }])).toMatchObject({ ok: false, error: expect.stringContaining('unsupported op') })
    expect(validateEdits(project(), [])).toMatchObject({ ok: false })
  })
})

describe('fixWord', () => {
  it('finds the word by its time', () => {
    const p = project()
    const r = validateEdits(p, [{ op: 'fixWord', time: 1.8, text: 'Welcome' }])
    expect(r.ok && r.after.transcripts.cam.words[2].text).toBe('Welcome')
    expect(validateEdits(p, [{ op: 'fixWord', time: 9, text: 'x' }])).toMatchObject({ ok: false })
  })
})

describe('describeEdit', () => {
  it('describes edits in plain language', () => {
    const p = project()
    expect(describeEdit({ op: 'cutRanges', ranges: [[61, 63.5]] }, p)).toBe('Cut 1 section (2.5 s): 1:01.0–1:03.5')
    expect(describeEdit({ op: 'updateClip', clipId: 'C', volume: 0.5, fadeIn: 1 }, p)).toBe('Change “cam.mp4” on V1: volume 50%, fade in 1s')
  })
})

describe('buildContext', () => {
  it('lists media, clips with ids, selection and the transcript with timings', () => {
    const ctx = buildContext(project(), { start: 1, end: 3 }, 1.2)
    expect(ctx).toContain('cam | cam.mp4 | video | 20.00 s | 1280x720 has-audio transcribed')
    expect(ctx).toContain('clip C "cam.mp4" timeline 0.00–20.00 source 0.00–20.00')
    expect(ctx).toContain('EDIT SCOPE: the user marked 1.00–3.00 s')
    expect(ctx).toContain('Hello@1.00-1.40 and@1.50-1.70 welcome@1.80-2.30 back@2.40-2.80')
  })

  it('sends only an excerpt of very long transcripts', () => {
    const many = Array.from({ length: FULL_TRANSCRIPT_WORDS + 10 }, (_, i) => `w${i}@${i * 0.5}-${i * 0.5 + 0.3}`).join(' ')
    const ctx = buildContext(project(many, 800), { start: 5, end: 6 }, 5)
    expect(ctx).toContain('call get_transcript')
    expect(ctx).not.toContain('w100@')
  })
})
