import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createProject, MediaItem } from './project'
import { duckKeys, mergeIntervals, timelineSpeech } from './ducking'
import { audioSegments, gainAt } from './render-plan'

const audio = (id: string, duration: number) => MediaItem.parse({ id, kind: 'audio', name: id, path: id, duration, hasAudio: true })

describe('ducking', () => {
  it('merges close intervals', () => {
    expect(mergeIntervals([[5, 6], [0, 1], [1.5, 2]], 0.6)).toEqual([[0, 2], [5, 6]])
  })

  it('lowers music under speech with ramps, ignoring short pauses', () => {
    const p0 = createProject('p')
    const [, , a1, a2] = p0.tracks.map((t) => t.id)
    let p = applyOps(p0, [
      { op: 'addMedia', items: [audio('voice', 30), audio('music', 60)] },
      // Voice starts at timeline 2 from source 0.
      { op: 'insertClip', trackId: a1, mediaId: 'voice', start: 2, clipId: 'V' },
      // Music runs 0..20 from source 10.
      { op: 'insertClip', trackId: a2, mediaId: 'music', start: 0, in: 10, out: 30, clipId: 'M' }
    ])
    // Voice speaks at source 1..4 and 4.5..6 (short pause) → timeline 3..6, 6.5..8.
    const speech = timelineSpeech(p, 'M', new Map([['voice', [[1, 4], [4.5, 6]]]]))
    expect(speech).toEqual([[3, 6], [6.5, 8]])

    const music = p.tracks.find((t) => t.id === a2)!.clips[0]
    const keys = duckKeys(music, speech)
    p = applyOps(p, [{ op: 'setVolumeKeys', clipId: 'M', keys }])
    const seg = audioSegments(p).find((s) => s.key === 'M')!
    expect(gainAt(seg, 1)).toBeCloseTo(1)
    expect(gainAt(seg, 2.85)).toBeCloseTo(0.625) // halfway through the 0.3 s fade down
    expect(gainAt(seg, 4)).toBeCloseTo(0.25)
    expect(gainAt(seg, 6.25)).toBeCloseTo(0.25) // the 0.5 s pause stays ducked
    expect(gainAt(seg, 8.4)).toBeCloseTo(0.625) // halfway through the 0.8 s release
    expect(gainAt(seg, 12)).toBeCloseTo(1)
  })

  it('clamps at the clip edges', () => {
    const clip = { id: 'M', mediaId: 'm', start: 5, in: 0, out: 10 } as never
    const keys = duckKeys(clip, [[0, 7], [14.5, 20]])
    expect(keys[0]).toEqual({ t: 0, v: 0.25 }) // already ducked at the clip start
    expect(keys[keys.length - 1]).toEqual({ t: 10, v: 0.25 })
  })
})
