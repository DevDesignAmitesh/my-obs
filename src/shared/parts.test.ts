import { describe, expect, it } from 'vitest'
import { compileEdits, cutProblem, scopeSplits, validateEdits, type AiEdit } from './assistant'
import { projectCues, timelineWords } from './captions'
import { buildModeRequest, fillHints } from './modes'
import { applyOps } from './ops'
import { createProject, MediaItem, type Project } from './project'
import { captionStyleAt, sectionAt, themeAt, upsertSection } from './sections'
import { punctuateWords, type Word } from './transcript'

/** Unpunctuated words like Whisper returns them; "|" marks a pause of 0.8 s. */
function words(text: string, t0 = 0.5): Word[] {
  const out: Word[] = []
  let t = t0
  for (const tok of text.split(' ')) {
    if (tok === '|') {
      t += 0.8
      continue
    }
    out.push({ text: tok, start: t, end: t + 0.3 })
    t += 0.35
  }
  return out
}

const STORY =
  'So hello my name is Sam and I build tools | A few days ago I posted a video | Two friends said my setup looks bad | ' +
  'I wanted something easy fast and free | So I built my own tool | This is how I used to record | ' +
  'and this is how I record now | Try it out and let me know what you think | Try it out and let me know what you think | Bye bye'

function project(text = STORY, size: [number, number] = [1658, 1080]): Project {
  const p = createProject('p')
  const ws = words(text)
  const duration = ws[ws.length - 1].end + 1
  const cam = MediaItem.parse({ id: 'cam', kind: 'video', name: 'cam.mp4', path: 'cam.mp4', duration, width: size[0], height: size[1], hasAudio: true })
  return applyOps(p, [
    { op: 'addMedia', items: [cam] },
    { op: 'insertClip', trackId: p.tracks[0].id, mediaId: 'cam', start: 0, clipId: 'C' },
    { op: 'setTranscript', mediaId: 'cam', transcript: { provider: 't', model: 't', createdAt: '', words: ws } }
  ])
}

const at = (p: Project, text: string): { start: number; end: number } => {
  const w = timelineWords(p)
  const first = text.split(' ')[0]
  const i = w.findIndex((x, k) => x.text === first && text.split(' ').every((t, j) => w[k + j]?.text === t))
  const n = text.split(' ').length
  return { start: w[i].start, end: w[i + n - 1].end }
}

describe('cuts never delete the story', () => {
  it('rejects cutting the whole intro to reach a "hook" (what broke the test5 demo export)', () => {
    const p = project()
    const hook = at(p, 'So I built my own tool')
    const v = validateEdits(p, [{ op: 'cutRanges', ranges: [[0, hook.start - 0.1]] }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/would delete \d+ spoken words that are not said again \("So hello my name is Sam/)
  })

  it('allows cutting a repeated take, pauses and filler', () => {
    const p = project()
    const w = timelineWords(p)
    const firstTry = w.findIndex((x) => x.text === 'Try')
    const secondTry = w.findIndex((x, i) => i > firstTry && x.text === 'Try')
    // The first of the two identical takes, from its first word to the start of the second.
    expect(cutProblem(w, [[w[firstTry].start - 0.05, w[secondTry].start - 0.05]])).toBeNull()
    // A pause between sentences.
    const tool = w.find((x) => x.text === 'tool' && x.start > 5)!
    expect(cutProblem(w, [[tool.end + 0.1, tool.end + 0.6]])).toBeNull()
  })

  it('rejects a cut edge inside a word', () => {
    const w = timelineWords(project())
    const think = w.find((x) => x.text === 'think')!
    expect(cutProblem(w, [[think.start + 0.15, think.end + 0.5]])).toMatch(/inside the word "think"/)
  })

  it('lets the user drop content on purpose, and says so in the review', () => {
    const p = project()
    const edit: AiEdit = { op: 'cutRanges', ranges: [[0, at(p, 'So I built my own tool').start - 0.1]], userAskedToRemove: true }
    expect(validateEdits(p, [edit]).ok).toBe(true)
  })
})

describe('captions break at sentences', () => {
  it('copies Whisper punctuation onto the timed words', () => {
    const ws = punctuateWords(words('so I built my own tool this is how'), 'So, I built my own tool. This is how')
    expect(ws.map((w) => w.text).join(' ')).toBe('So, I built my own tool. This is how')
  })

  it('starts a new caption at a new sentence even without punctuation', () => {
    const p = applyOps(project(), [{ op: 'setCaptionStyle', patch: { enabled: true, maxChars: 34, maxLines: 1 } }])
    const cues = projectCues(p).map((c) => c.words.map((w) => w.text).join(' '))
    expect(cues).toContain('So I built my own tool')
    expect(cues.some((c) => /tool This/.test(c))).toBe(false)
  })
})

describe('parts with their own mode and mood', () => {
  const scope = { start: 10, end: 20 }

  it('splits clips at the edges of the marked part, so edits stay inside', () => {
    const p = project()
    const pre = scopeSplits(p, scope)
    expect(pre).toEqual([
      { op: 'splitClip', clipId: 'C', time: 10, newClipId: 'C~1000' },
      { op: 'splitClip', clipId: 'C~1000', time: 20, newClipId: 'C~1000~2000' }
    ])
    const inside: AiEdit[] = [...pre, { op: 'updateClip', clipId: 'C~1000', transform: { scale: 1.3 } }]
    const v = validateEdits(p, inside, { scope })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.after.tracks[0].clips.map((c) => c.transform.scale)).toEqual([1, 1.3, 1])
  })

  it('rejects edits outside the marked part', () => {
    const p = project()
    const outside = validateEdits(p, [{ op: 'addGraphic', template: 'title', start: 2, end: 5, title: 'Hi' }], { scope })
    expect(outside).toMatchObject({ ok: false, error: expect.stringContaining('outside the marked part') })
    expect(validateEdits(p, [{ op: 'updateClip', clipId: 'C', transform: { scale: 2 } }], { scope }).ok).toBe(false)
    expect(validateEdits(p, [{ op: 'cutRanges', ranges: [[1, 2]] }], { scope }).ok).toBe(false)
  })

  it("changes the look only inside the part, and cuts shrink the part", () => {
    const p = project()
    const edits: AiEdit[] = [
      { op: 'setTheme', patch: { accent: '#ff8fab', font: 'Georgia' } },
      { op: 'setCaptionStyle', patch: { enabled: true, uppercase: true } }
    ]
    const { after } = compileEdits(p, edits, { scope })
    expect(after.sections).toHaveLength(1)
    expect(themeAt(after, 15).accent).toBe('#ff8fab')
    expect(themeAt(after, 5).accent).toBe(p.theme.accent)
    expect(captionStyleAt(after, 15)).toMatchObject({ enabled: true, uppercase: true })
    expect(captionStyleAt(after, 25).enabled).toBe(false)
    // Captions are drawn only where the style enables them; cues never cross the part's edge.
    expect(projectCues(after).every((c) => !(c.start < 10 && c.end > 10.05))).toBe(true)

    const cut = applyOps(after, [{ op: 'rippleDeleteRange', start: 12, end: 14 }, { op: 'rippleDeleteRange', start: 2, end: 3 }])
    expect(cut.sections[0]).toMatchObject({ start: 9, end: 17 })
    expect(sectionAt(cut, 16.9)).toBeDefined()
  })

  it('a new part trims the parts it overlaps', () => {
    const a = { id: 'a', start: 0, end: 30, mode: 'demo' as const, mood: '' }
    const list = upsertSection([a], { id: 'b', start: 10, end: 20, mode: 'happening', mood: 'warm' })
    expect(list.map((s) => [s.id, s.start, s.end])).toEqual([
      ['a', 0, 10],
      ['b', 10, 20],
      ['a-b', 20, 30]
    ])
  })

  it('builds a generate request for just the part, with the part’s mood and framing hints', () => {
    const p = project()
    const req = buildModeRequest('happening', 'warm and playful', { scope, project: p })
    expect(req).toContain('Edit ONLY the marked part 10.00–20.00 s in "Happening" mode')
    expect(req).toContain('Do NOT copy the reference look')
    expect(req).toContain('FRAMING: clip C ("cam.mp4", 1658x1080) shows black bars')
    expect(fillHints(project(STORY, [1920, 1080]), null)).toEqual([])
    // A mood in the project-wide instructions also replaces the default look.
    expect(buildModeRequest('demo', '', { standing: 'dark and premium' })).toContain('Do NOT copy the reference look')
  })
})
