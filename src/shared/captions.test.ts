import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem, type Project } from './project'
import { buildCues, cueAt, fillerRanges, pauseRanges, timelineWords, toSrt, wordDeleteRange } from './captions'
import type { Word } from './transcript'

/** "hello@0-0.4 world@0.5-1" → words */
const words = (spec: string): Word[] =>
  spec.split(' ').map((s) => {
    const [text, times] = s.split('@')
    const [start, end] = times.split('-').map(Number)
    return { text, start, end }
  })

function project(): Project {
  const p = createProject('p')
  const mic = MediaItem.parse({ id: 'mic', kind: 'audio', name: 'mic', path: 'mic', duration: 20, hasAudio: true })
  return applyOps(p, [
    { op: 'addMedia', items: [mic] },
    { op: 'insertClip', trackId: p.tracks[2].id, mediaId: 'mic', start: 0, clipId: 'M' },
    {
      op: 'setTranscript',
      mediaId: 'mic',
      transcript: {
        provider: 'test',
        model: 't',
        createdAt: '',
        words: words('So@0.5-0.8 um@0.9-1.2 today@1.3-1.7 we@1.8-1.9 build@2-2.3 things.@2.4-2.9 Next@5-5.3 part@5.4-5.8')
      }
    }
  ])
}

describe('timelineWords', () => {
  it('maps transcript words to the timeline and follows cuts', () => {
    let p = project()
    expect(timelineWords(p).map((w) => w.text).join(' ')).toBe('So um today we build things. Next part')
    // Cut 0.85..1.25 ("um"): later words shift left by 0.4 s and "um" disappears.
    p = applyOps(p, [{ op: 'rippleDeleteRange', start: 0.85, end: 1.25 }])
    const w = timelineWords(p)
    expect(w.map((x) => x.text)).not.toContain('um')
    expect(w.find((x) => x.text === 'today')!.start).toBeCloseTo(1.3 - 0.4, 1)
  })

  it('ignores muted clips', () => {
    const p = applyOps(project(), [{ op: 'updateClip', clipId: 'M', muted: true }])
    expect(timelineWords(p)).toEqual([])
  })
})

describe('buildCues', () => {
  it('breaks on pauses, sentence ends and length', () => {
    const cues = buildCues(timelineWords(project()), { maxChars: 32, maxLines: 2 })
    expect(cues.map((c) => c.words.map((w) => w.text).join(' '))).toEqual(['So um today we build things.', 'Next part'])
    expect(cueAt(cues, 2)!.words[0].text).toBe('So')
    expect(cueAt(cues, 4)).toBeNull()
    const short = buildCues(timelineWords(project()), { maxChars: 10, maxLines: 1 })
    expect(short.every((c) => c.words.map((w) => w.text).join(' ').length <= 10)).toBe(true)
    // Two lines of 12: never more than two lines per caption.
    const two = buildCues(timelineWords(project()), { maxChars: 12, maxLines: 2 })
    expect(two.map((c) => c.words.map((w) => w.text).join(' '))).toEqual(['So um today we build', 'things.', 'Next part'])
  })

  it('exports SRT', () => {
    const srt = toSrt(buildCues(timelineWords(project()), { maxChars: 32, maxLines: 2 }))
    expect(srt).toContain('1\n00:00:00,500 --> 00:00:03,300\nSo um today we build things.')
  })
})

describe('text-based editing', () => {
  it('computes cut ranges that do not clip neighbours', () => {
    const w = timelineWords(project())
    const [a, b] = wordDeleteRange(w, 1, 1) // "um" 0.9–1.2 between So (…0.8) and today (1.3…)
    expect(a).toBeCloseTo(0.82)
    expect(b).toBeCloseTo(1.28)
    expect(fillerRanges(w)).toHaveLength(1)
  })

  it('shortens long pauses', () => {
    const r = pauseRanges(timelineWords(project()), 1, 0.4)
    expect(r).toHaveLength(1)
    expect(r[0][0]).toBeCloseTo(3.1)
    expect(r[0][1]).toBeCloseTo(4.8)
  })

  it('corrects words through an undoable op', () => {
    const p = applyOps(project(), [{ op: 'editWord', mediaId: 'mic', index: 2, text: 'Today' }])
    expect(timelineWords(p)[2].text).toBe('Today')
  })
})
