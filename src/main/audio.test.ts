import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaItem } from '@shared/project'
import { ffmpegPath, probe } from './ffmpeg'
import { enhance, measureLoudness, normalizeLoudness, PEAKS_PER_SECOND, speech, speechFromSilence, waveform } from './audio'

const dir = mkdtempSync(join(tmpdir(), 'studio-audio-'))
const ff = (...args: string[]): string => execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args]).toString()

/** Mean volume (dB) of a section of a file. */
function meanDb(file: string, from: number, len: number): number {
  const r = spawnSync(ffmpegPath, ['-v', 'info', '-ss', String(from), '-t', String(len), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
  return Number(/mean_volume: (-?[\d.]+)/.exec(r.stderr.toString())![1])
}

// "Voice": tone 0–1 s, silence 1–2 s, tone 2–3.5 s, plus quiet background hiss throughout.
const voice = join(dir, 'voice.wav')
const media = MediaItem.parse({ id: 'voice', kind: 'audio', name: 'voice.wav', path: voice, duration: 3.5, hasAudio: true })

beforeAll(() => {
  ff(
    '-f', 'lavfi', '-i', 'sine=f=300:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=1.5',
    '-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.01:d=3.5:r=44100',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[v];[v][3]amix=inputs=2:normalize=0[out]', '-map', '[out]', '-ac', '1', voice
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('audio tools', () => {
  it('parses silencedetect output into speech intervals', () => {
    const log = 'silence_start: 1.0\nsilence_end: 2.0 | silence_duration: 1\nsilence_start: 5\nsilence_end: 6 | x'
    expect(speechFromSilence(log, 8)).toEqual([[0, 1], [2, 5], [6, 8]])
    expect(speechFromSilence('', 4)).toEqual([[0, 4]])
  })

  it('finds speech in real audio', async () => {
    const s = await speech(dir, media)
    expect(s).toHaveLength(2)
    expect(s[0][0]).toBeCloseTo(0, 0)
    expect(s[0][1]).toBeCloseTo(1, 0)
    expect(s[1][0]).toBeCloseTo(2, 0)
    expect(s[1][1]).toBeCloseTo(3.5, 0)
    expect(existsSync(join(dir, 'cache', 'speech', 'voice.json'))).toBe(true)
  })

  it('builds waveform peaks', async () => {
    const peaks = await waveform(dir, media)
    expect(peaks.length).toBeCloseTo(3.5 * PEAKS_PER_SECOND, -1)
    const at = (t: number): number => peaks[Math.round(t * PEAKS_PER_SECOND)]
    // FFmpeg's test tone is 1/8 of full scale (≈32/255); the hiss is far quieter.
    expect(at(0.5)).toBeGreaterThan(25)
    expect(at(0.5)).toBeGreaterThan(5 * at(1.5))
    // Second call comes from the cache.
    expect(await waveform(dir, media)).toEqual(peaks)
  })

  it('reduces background noise with "Enhance voice"', async () => {
    const rel = await enhance(dir, media, 'strong')
    const out = join(dir, rel)
    expect(existsSync(out)).toBe(true)
    expect((await probe(out)).duration).toBeCloseTo(3.5, 1)
    const hissBefore = meanDb(voice, 1.2, 0.6)
    const hissAfter = meanDb(out, 1.2, 0.6)
    expect(hissAfter).toBeLessThan(hissBefore - 6)
    // The voice itself is kept.
    expect(meanDb(out, 2.3, 1)).toBeGreaterThan(meanDb(voice, 2.3, 1) - 3)
  }, 30000)

  it('normalizes an export to the target loudness and keeps the video', async () => {
    const file = join(dir, 'export.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
      '-af', 'volume=0.05', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file)
    const before = await measureLoudness(file)
    expect(before).toBeLessThan(-25)
    const r = await normalizeLoudness(file, -14)
    expect(r.before).toBeCloseTo(before, 0)
    expect(await measureLoudness(file)).toBeCloseTo(-14, 0)
    const p = await probe(file)
    expect(p.video?.codec).toBe('h264')
    expect(p.duration).toBeCloseTo(6, 0)
  }, 30000)

  it('leaves an export without any sound alone (e.g. a screen recording with no audio)', async () => {
    const file = join(dir, 'silent-export.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file)
    expect(await normalizeLoudness(file, -14)).toEqual({ before: null, after: -14 })
    expect((await probe(file)).video?.codec).toBe('h264')
  }, 30000)
})
