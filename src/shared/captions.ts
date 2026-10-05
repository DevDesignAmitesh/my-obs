import { clipEnd, type CaptionStyle, type Project } from './project'
import { endsSentence, FILLER_WORDS, normWord } from './transcript'
import { sectionAt } from './sections'

/**
 * Captions are derived from transcripts on the fly: each transcribed clip's words are mapped
 * through the clip's in/out onto the timeline. So cutting video automatically updates captions,
 * and there is nothing to keep in sync.
 */

export interface TimelineWord {
  text: string
  /** Timeline seconds. */
  start: number
  end: number
  mediaId: string
  /** Index into the media's transcript (for corrections). */
  index: number
  clipId: string
  /** The sentence ends after this word (from punctuation, or a pause before a capitalised word). */
  sentenceEnd?: boolean
}

export function timelineWords(p: Project): TimelineWord[] {
  const out: TimelineWord[] = []
  for (const track of p.tracks) {
    if (track.muted) continue
    for (const c of track.clips) {
      const t = p.transcripts[c.mediaId]
      if (!t || c.muted) continue
      const media = p.media.find((m) => m.id === c.mediaId)
      if (!media || media.kind === 'image' || !media.hasAudio) continue
      const end = clipEnd(c)
      t.words.forEach((w, index) => {
        // A word belongs to the clip if most of it is inside the clip's source range.
        const mid = (w.start + w.end) / 2
        if (mid < c.in || mid >= c.out || !w.text.trim()) return
        const ts = c.start + (w.start - c.in)
        const te = c.start + (w.end - c.in)
        out.push({
          text: w.text.trim(),
          start: Math.max(c.start, ts),
          end: Math.min(end, te),
          mediaId: c.mediaId,
          index,
          clipId: c.id,
          sentenceEnd: endsSentence(w, t.words[index + 1])
        })
      })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

export interface Cue {
  start: number
  end: number
  words: TimelineWord[]
}

const PAUSE_BREAK_S = 0.7
const MAX_CUE_S = 5
/** Captions stay up briefly after the last word unless the next one starts. */
const LINGER_S = 0.4

/** Lines needed to show these words with greedy wrapping at `maxChars` per line. */
export function linesNeeded(texts: string[], maxChars: number): number {
  let lines = 1
  let chars = 0
  for (const t of texts) {
    if (chars && chars + 1 + t.length > maxChars) {
      lines++
      chars = t.length
    } else chars += (chars ? 1 : 0) + t.length
  }
  return lines
}

export function buildCues(words: TimelineWord[], style: Pick<CaptionStyle, 'maxChars' | 'maxLines'>): Cue[] {
  const cues: Cue[] = []
  let cur: TimelineWord[] = []
  const flush = (): void => {
    if (cur.length) cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur })
    cur = []
  }
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1]
      const tooLong = linesNeeded([...cur.map((x) => x.text), w.text], style.maxChars) > style.maxLines
      // A new sentence starts a new caption (unless the last one would be a single stray word).
      const sentenceEnd = (prev.sentenceEnd || /[.!?]$/.test(prev.text)) && cur.length >= 2
      if (w.start - prev.end > PAUSE_BREAK_S || tooLong || w.end - cur[0].start > MAX_CUE_S || sentenceEnd) flush()
    }
    cur.push(w)
  }
  flush()
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]
    cues[i].end = Math.min(cues[i].end + LINGER_S, next ? next.start : Infinity)
  }
  return cues
}

/**
 * All caption cues of a project. Parts with their own caption style (sections) are laid out with
 * that style, and no caption runs across a part's edge.
 */
export function projectCues(p: Project): Cue[] {
  const words = timelineWords(p)
  const groups: { style: CaptionStyle; words: TimelineWord[]; until: number }[] = []
  let key: string | undefined
  for (const w of words) {
    const s = sectionAt(p, w.start)
    const k = s?.id ?? ''
    if (k !== key || !groups.length) {
      // A group's captions end where its part ends (or where the next part begins).
      const until = s ? s.end : (p.sections.find((x) => x.start > w.start)?.start ?? Infinity)
      groups.push({ style: s?.captions ?? p.captionStyle, words: [], until })
    }
    key = k
    groups[groups.length - 1].words.push(w)
  }
  const cues = groups.flatMap((g) => buildCues(g.words, g.style).map((c) => ({ ...c, end: Math.min(c.end, Math.max(c.start + 0.05, g.until)) })))
  // Lingering must not overlap the next group's first cue.
  for (let i = 0; i + 1 < cues.length; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start)
  return cues
}

export function cueAt(cues: Cue[], t: number): Cue | null {
  // Binary search: cues are sorted and don't overlap.
  let lo = 0
  let hi = cues.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t < cues[mid].start) hi = mid - 1
    else if (t >= cues[mid].end) lo = mid + 1
    else return cues[mid]
  }
  return null
}

const srtTime = (t: number): string => {
  const ms = Math.round(t * 1000)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.words.map((w) => w.text).join(' ')}\n`).join('\n')
}

// ---- text-based editing ----------------------------------------------------------------------

/** Small margin kept around cuts so word edges aren't clipped. */
const EDGE = 0.08

/** Timeline range that removes words i..j, cutting into the silence on either side. */
export function wordDeleteRange(words: TimelineWord[], i: number, j: number): [number, number] {
  const lo = Math.min(i, j)
  const hi = Math.max(i, j)
  const first = words[lo]
  const last = words[hi]
  const prev = words[lo - 1]
  const next = words[hi + 1]
  const start = Math.max(prev ? prev.end : 0, first.start - EDGE)
  const end = next ? Math.min(next.start, last.end + EDGE) : last.end + EDGE
  return [start, end]
}

/** Ranges that cut filler words ("um", "uh", …). */
export function fillerRanges(words: TimelineWord[]): [number, number][] {
  const out: [number, number][] = []
  words.forEach((w, i) => {
    if (FILLER_WORDS.has(normWord(w.text))) out.push(wordDeleteRange(words, i, i))
  })
  return mergeRanges(out)
}

/** Ranges that shorten silences longer than `minGap` down to `keep` seconds. */
export function pauseRanges(words: TimelineWord[], minGap = 1, keep = 0.35): [number, number][] {
  const out: [number, number][] = []
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap > minGap) out.push([words[i - 1].end + keep / 2, words[i].start - keep / 2])
  }
  return out
}

export function mergeRanges(r: [number, number][]): [number, number][] {
  const sorted = [...r].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}
