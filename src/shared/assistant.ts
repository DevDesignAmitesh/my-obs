import { mergeRanges, timelineWords, type TimelineWord } from './captions'
import { FILLER_WORDS, normWord } from './transcript'
import { sectionFor } from './sections'
import { applyOp, EditError, findClip, type EditOp } from './ops'
import { clipEnd, clipLength, colorMedia, graphicMedia, projectDuration, type Project } from './project'
import { Graphic, graphicLabel, GRAPHIC_TEMPLATES, layoutDefaults, TEMPLATE_INFO, type GraphicTemplate } from './graphics'
import { animateKeys, cornerTransform, type AnimatedValues, type Corner } from './animation'
import { placeOnTop } from './placement'
import type { Theme } from './theme'
import { modeById } from './modes'
import type { Rect } from './scene'

/**
 * The AI editing assistant: what it sees (context), what it may do (edits), and how its
 * proposals are validated and shown to the user. Provider-neutral; used by both the main process
 * (tool loop) and the UI (review + apply).
 */

/** Edits the assistant may propose: a safe subset of EditOp, plus `cutRanges`. */
export type AiEdit =
  /** `userAskedToRemove`: the user explicitly asked to drop this spoken content (not just mistakes). */
  | { op: 'cutRanges'; ranges: [number, number][]; userAskedToRemove?: boolean }
  /** Correct the caption text of the word spoken at `time` (timeline seconds). */
  | { op: 'fixWord'; time: number; text: string }
  /** A solid color layer (background / panel) on a video track from start to end. */
  | { op: 'addColor'; color: string; trackId: string; start: number; end: number; clipId?: string }
  /** A text/card layer on top of the video (track chosen automatically unless given). */
  | ({ op: 'addGraphic'; template: GraphicTemplate; start: number; end: number; clipId?: string; trackId?: string } & Partial<Omit<Graphic, 'template'>>)
  /** Change a text layer's content or look. */
  | { op: 'updateGraphic'; clipId: string; patch: Partial<Graphic> }
  /** Animate a clip from its current state at `time` to `to` (or into a corner) over `duration`. */
  | { op: 'animate'; clipId: string; time: number; duration: number; to?: Partial<AnimatedValues>; corner?: Corner; size?: number; ease?: 'linear' | 'smooth' }
  | { op: 'setTheme'; preset?: string; patch?: Partial<Theme> }
  | Extract<
      EditOp,
      {
        op:
          | 'splitAt'
          | 'splitClip'
          | 'addTrack'
          | 'updateMedia'
          | 'deleteClips'
          | 'moveClip'
          | 'trimClip'
          | 'updateClip'
          | 'setVolumeKeys'
          | 'addMarker'
          | 'setCaptionStyle'
          | 'editWord'
          | 'insertClip'
          | 'detachAudio'
          | 'insertGap'
      }
    >

const ALLOWED = new Set([
  'addGraphic', 'updateGraphic', 'animate', 'setTheme',
  'cutRanges', 'fixWord', 'addColor', 'splitAt', 'splitClip', 'addTrack', 'updateMedia', 'deleteClips', 'moveClip', 'trimClip', 'updateClip', 'setVolumeKeys',
  'addMarker', 'setCaptionStyle', 'editWord', 'insertClip', 'detachAudio', 'insertGap'
])

export interface Selection {
  start: number
  end: number
}

export interface Proposal {
  summary: string
  edits: AiEdit[]
}

/** One message of the assistant chat, as saved in <project>/ai-history.json. */
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** ISO time. */
  time: string
  /** Which AI answered (assistant turns). */
  provider?: string
  model?: string
  /** The In/Out range the request was limited to (user turns). */
  scope?: Selection | null
  proposal?: Proposal
  /** What happened to the proposal. */
  state?: 'pending' | 'applied' | 'discarded'
  /** Which proposed edits were ticked. */
  picked?: boolean[]
  error?: boolean
  /** What kind of message this was (user turns). */
  kind?: 'ask' | 'feedback' | 'generate'
  /** Feedback step 1: how the AI understood the feedback (assistant turns). */
  refined?: { intent: string; instruction: string; remember: string }
}

export const AI_HISTORY_FILE = 'ai-history.json'

const rid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

export interface CompileOptions {
  /** The marked range the request is limited to: edits outside it are rejected. */
  scope?: Selection | null
}

const SCOPE_EPS = 0.05

/** Id of the part (section) for a scope, so repeated compiles of the same edits agree. */
const scopeSectionId = (scope: Selection): string => `part-${Math.round(scope.start * 100)}-${Math.round(scope.end * 100)}`

/** Ops for one AI edit, given the project as it is at that point in the list. */
function editOps(e: AiEdit, cur: Project, opts: CompileOptions): EditOp[] {
  const { width: W, height: H } = cur.settings
  const scope = opts.scope
  if (scope) {
    const problem = scopeProblem(e, cur, scope)
    if (problem) throw new EditError(`${problem}. Only change things inside the marked part ${fmt(scope.start)}–${fmt(scope.end)}`)
    if (e.op === 'setTheme' || e.op === 'setCaptionStyle') {
      // Inside a marked part, the look changes for that part only.
      const existing = sectionFor(cur, scope.start, scope.end)
      const sectionId = existing?.id ?? scopeSectionId(scope)
      const create: EditOp[] = existing ? [] : [{ op: 'setSection', section: { id: sectionId, start: scope.start, end: scope.end, mode: cur.mode } }]
      return [...create, { ...e, sectionId }]
    }
  }
  switch (e.op) {
    case 'addColor': {
      const clipId = e.clipId ?? rid('color')
      const mediaId = `media-${clipId}`
      return [
        { op: 'addMedia', items: [colorMedia(mediaId, e.color, W, H)] },
        { op: 'insertClip', trackId: e.trackId, mediaId, start: e.start, in: 0, out: Math.max(0.05, e.end - e.start), clipId }
      ]
    }
    case 'addGraphic': {
      const { op: _op, start, end, clipId: cid, trackId, template, ...fields } = e
      if (!GRAPHIC_TEMPLATES.includes(template)) throw new EditError(`Unknown text template "${template}"`)
      const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      // Layout defaults only: no placeholder text the AI didn't ask for.
      const graphic = Graphic.parse({ ...layoutDefaults(template, W, H), ...defined })
      const clipId = cid ?? rid('text')
      const media = graphicMedia(`media-${clipId}`, graphic, W, H)
      if (end <= start) throw new EditError('addGraphic: end must be after start')
      if (trackId) {
        return [{ op: 'addMedia', items: [media] }, { op: 'insertClip', trackId, mediaId: media.id, start, in: 0, out: end - start, clipId }]
      }
      return placeOnTop(cur, media, start, end, clipId).ops
    }
    case 'updateGraphic': {
      const { clip } = findClip(cur, e.clipId)
      return [{ op: 'updateMedia', mediaId: clip.mediaId, clipId: clip.id, patch: { graphic: e.patch } }]
    }
    case 'animate': {
      const { clip } = findClip(cur, e.clipId)
      const media = cur.media.find((m) => m.id === clip.mediaId)
      let to = e.to ?? {}
      if (e.corner) {
        const mw = media?.kind === 'graphic' ? W : (media?.width ?? W)
        const mh = media?.kind === 'graphic' ? H : (media?.height ?? H)
        to = { ...cornerTransform(e.corner, mw, mh, W, H, e.size ?? 0.33), ...e.to }
      }
      if (!Object.keys(to).length) throw new EditError('animate: give "to" values or a "corner"')
      return [{ op: 'setTransformKeys', clipId: clip.id, keys: animateKeys(clip, e.time, e.duration, to, e.ease) }]
    }
    case 'fixWord': {
      const words = timelineWords(cur)
      const w = words.find((x) => Math.abs(x.start - e.time) < 0.06) ?? words.find((x) => e.time >= x.start && e.time < x.end)
      if (!w) throw new EditError(`fixWord: no word starts at ${e.time}`)
      return [{ op: 'editWord', mediaId: w.mediaId, index: w.index, text: e.text }]
    }
    case 'cutRanges': {
      if (!e.userAskedToRemove) {
        const problem = cutProblem(timelineWords(cur), e.ranges)
        if (problem) throw new EditError(problem)
      }
      const ranges = e.ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]).sort((x, y) => x[0] - y[0])
      const merged: [number, number][] = []
      for (const r of ranges) {
        const last = merged[merged.length - 1]
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
        else merged.push(r)
      }
      // Latest first, so earlier ranges keep their positions.
      return merged.reverse().map(([start, end]) => ({ op: 'rippleDeleteRange' as const, start, end }))
    }
    default:
      return [e as EditOp]
  }
}

/**
 * Turns AI edits into editor ops, applying them one by one so later edits can refer to tracks,
 * clips and animation created by earlier ones.
 */
export function compileEdits(p: Project, edits: AiEdit[], opts: CompileOptions = {}): { ops: EditOp[]; after: Project } {
  const ops: EditOp[] = []
  let cur = p
  for (const e of edits) {
    for (const op of editOps(e, cur, opts)) {
      cur = applyOp(cur, op)
      ops.push(op)
    }
  }
  return { ops, after: cur }
}

/** Editor ops for AI edits (see compileEdits). */
export function expandEdits(edits: AiEdit[], p: Project, opts: CompileOptions = {}): EditOp[] {
  return compileEdits(p, edits, opts).ops
}

/**
 * Why removing these ranges would hurt the video, or null if it is fine. Cuts may remove pauses,
 * filler words and repeated takes; a stretch of words that is not said again nearby is part of the
 * story. Cut edges must also fall between words, never inside one.
 */
export function cutProblem(words: TimelineWord[], ranges: [number, number][]): string | null {
  const sorted = mergeRanges(ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]))
  const mid = (w: TimelineWord): number => (w.start + w.end) / 2
  const cut = (t: number): boolean => sorted.some(([a, b]) => t > a && t < b)
  for (const [a, b] of sorted) {
    for (const edge of [a, b]) {
      const w = words.find((x) => edge > x.start + 0.06 && edge < x.end - 0.06)
      if (w) return `the cut edge ${edge.toFixed(2)} is inside the word "${w.text}" (${w.start.toFixed(2)}–${w.end.toFixed(2)}); cut in the gap before or after the word`
    }
    const removed = words.filter((w) => mid(w) > a && mid(w) < b && !FILLER_WORDS.has(normWord(w.text)))
    if (removed.length < 5) continue
    // A repeated take: most of its words are said again just before or after it.
    const kept = words.filter((w) => !cut(mid(w)))
    const near = [...kept.filter((w) => w.end <= a).slice(-(removed.length + 15)), ...kept.filter((w) => w.start >= b).slice(0, removed.length + 15)]
    const bag = new Map<string, number>()
    for (const w of near) bag.set(normWord(w.text), (bag.get(normWord(w.text)) ?? 0) + 1)
    let repeated = 0
    for (const w of removed) {
      const n = bag.get(normWord(w.text)) ?? 0
      if (n > 0) {
        repeated++
        bag.set(normWord(w.text), n - 1)
      }
    }
    if (repeated / removed.length < 0.6) {
      const quote = removed.slice(0, 14).map((w) => w.text).join(' ') + (removed.length > 14 ? ' …' : '')
      return (
        `cutting ${fmt(a)}–${fmt(b)} would delete ${removed.length} spoken words that are not said again ("${quote}"). ` +
        'That is part of the story, not a mistake: cut only pauses, filler words and repeated takes, and keep the story in order. ' +
        'Only if the user explicitly asked to remove or shorten this content, add "userAskedToRemove": true to that cutRanges edit'
      )
    }
  }
  return null
}

const inScope = (t: number, s: Selection): boolean => t >= s.start - SCOPE_EPS && t <= s.end + SCOPE_EPS

/** Why an edit reaches outside the marked part, or null. */
function scopeProblem(e: AiEdit, cur: Project, s: Selection): string | null {
  const clipInside = (id: string): string | null => {
    const { clip } = findClip(cur, id)
    return inScope(clip.start, s) && inScope(clipEnd(clip), s) ? null : `clip ${id} (${fmt(clip.start)}–${fmt(clipEnd(clip))}) is outside the marked part`
  }
  switch (e.op) {
    case 'cutRanges': {
      const bad = e.ranges.find(([a, b]) => !inScope(a, s) || !inScope(b, s))
      return bad ? `cut ${fmt(bad[0])}–${fmt(bad[1])} is outside the marked part` : null
    }
    case 'addGraphic':
    case 'addColor':
      return inScope(e.start, s) && inScope(e.end, s) ? null : `${e.op} ${fmt(e.start)}–${fmt(e.end)} is outside the marked part`
    case 'insertClip': {
      const len = (e.out ?? 0) - (e.in ?? 0)
      return inScope(e.start, s) && (len <= 0 || inScope(e.start + len, s)) ? null : `insertClip at ${fmt(e.start)} is outside the marked part`
    }
    case 'insertGap':
      return inScope(e.at, s) ? null : `insertGap at ${fmt(e.at)} is outside the marked part`
    case 'splitAt':
    case 'splitClip':
    case 'fixWord':
    case 'addMarker':
      return inScope(e.time, s) ? null : `${e.op} at ${fmt(e.time)} is outside the marked part`
    case 'animate':
      return inScope(e.time, s) ? clipInside(e.clipId) : `animate at ${fmt(e.time)} is outside the marked part`
    case 'moveClip': {
      const { clip } = findClip(cur, e.clipId)
      return clipInside(e.clipId) ?? (inScope(e.start, s) && inScope(e.start + clipLength(clip), s) ? null : `moving clip ${e.clipId} to ${fmt(e.start)} leaves the marked part`)
    }
    case 'trimClip':
      return clipInside(e.clipId) ?? (inScope(e.time, s) ? null : `trim to ${fmt(e.time)} is outside the marked part`)
    case 'updateClip':
    case 'updateGraphic':
    case 'setVolumeKeys':
    case 'detachAudio':
      return clipInside(e.clipId)
    case 'deleteClips':
      return e.clipIds.map(clipInside).find(Boolean) ?? null
    case 'updateMedia': {
      const users = cur.tracks.flatMap((t) => t.clips).filter((c) => c.mediaId === e.mediaId)
      return users.map((c) => clipInside(c.id)).find(Boolean) ?? null
    }
    default:
      return null
  }
}

/**
 * Splits every clip that crosses the edges of the marked part, so the AI can change what is inside
 * without touching what is outside. Returned as edits (they become part of the proposal).
 */
export function scopeSplits(p: Project, s: Selection): AiEdit[] {
  const edits: AiEdit[] = []
  const used = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)))
  let cur = p
  for (const time of [s.start, s.end]) {
    for (const track of cur.tracks) {
      if (track.locked) continue
      for (const c of track.clips) {
        if (c.start < time - SCOPE_EPS && clipEnd(c) > time + SCOPE_EPS) {
          let newClipId = `${c.id}~${Math.round(time * 100)}`
          while (used.has(newClipId)) newClipId += '+'
          used.add(newClipId)
          edits.push({ op: 'splitClip', clipId: c.id, time, newClipId })
        }
      }
    }
    cur = compileEdits(p, edits).after
  }
  return edits
}

export type Validation = { ok: true; after: Project } | { ok: false; error: string }

/** Test-applies edits to a copy of the project. Errors are phrased for the AI to fix. */
export function validateEdits(p: Project, edits: unknown, opts: CompileOptions = {}): Validation {
  if (!Array.isArray(edits) || !edits.length) return { ok: false, error: 'edits must be a non-empty array' }
  for (const [i, e] of edits.entries()) {
    if (!e || typeof e !== 'object' || !ALLOWED.has((e as { op: string }).op)) {
      return { ok: false, error: `edit #${i + 1}: unknown or unsupported op "${(e as { op?: string })?.op}"` }
    }
  }
  try {
    return { ok: true, after: compileEdits(p, edits as AiEdit[], opts).after }
  } catch (err) {
    return { ok: false, error: err instanceof EditError ? err.message : `invalid edit: ${(err as Error).message}` }
  }
}

// ---- human-readable descriptions ------------------------------------------------------------

export const fmt = (t: number): string => {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function describeEdit(e: AiEdit, p: Project): string {
  const clipName = (id: string): string => {
    for (const t of p.tracks) {
      const c = t.clips.find((x) => x.id === id)
      if (c) return `“${p.media.find((m) => m.id === c.mediaId)?.name ?? 'clip'}” on ${t.name}`
    }
    return 'a clip'
  }
  switch (e.op) {
    case 'cutRanges': {
      const total = e.ranges.reduce((n, [a, b]) => n + Math.abs(b - a), 0)
      const list = e.ranges.slice(0, 4).map(([a, b]) => `${fmt(Math.min(a, b))}–${fmt(Math.max(a, b))}`).join(', ')
      return `Cut ${e.ranges.length} section${e.ranges.length > 1 ? 's' : ''} (${total.toFixed(1)} s): ${list}${e.ranges.length > 4 ? ', …' : ''}${e.userAskedToRemove ? ' ⚠ removes spoken content you asked to drop' : ''}`
    }
    case 'splitAt':
      return `Split at ${fmt(e.time)}`
    case 'splitClip':
      return `Split ${clipName(e.clipId)} at ${fmt(e.time)}`
    case 'addTrack':
      return `Add a ${e.kind} track`
    case 'updateMedia':
      return e.patch.color ? `Change color layer to ${e.patch.color}` : 'Change a text layer'
    case 'addColor':
      return `Add a ${e.color} color layer ${fmt(e.start)}–${fmt(e.end)}`
    case 'addGraphic': {
      const g = Graphic.safeParse({ ...layoutDefaults(e.template), ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) })
      return `Add ${g.success ? graphicLabel(g.data) : TEMPLATE_INFO[e.template]?.name ?? 'text'} (${fmt(e.start)}–${fmt(e.end)})`
    }
    case 'updateGraphic':
      return `Change ${clipName(e.clipId)}: ${Object.keys(e.patch).join(', ')}`
    case 'animate':
      return `Animate ${clipName(e.clipId)} ${e.corner ? `to the ${e.corner === 'full' ? 'full screen' : `${e.corner} corner`}` : `(${Object.keys(e.to ?? {}).join(', ')})`} at ${fmt(e.time)} over ${e.duration}s`
    case 'setTheme':
      return `Style: ${e.preset ? `${e.preset} theme` : ''}${e.patch ? ` ${Object.entries(e.patch).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`.trim()
    case 'deleteClips':
      return `${e.ripple ? 'Ripple-delete' : 'Delete'} ${e.clipIds.map(clipName).join(', ')}`
    case 'moveClip':
      return `Move ${clipName(e.clipId)} to ${fmt(e.start)}`
    case 'trimClip':
      return `Trim the ${e.edge} of ${clipName(e.clipId)} to ${fmt(e.time)}`
    case 'updateClip': {
      const parts: string[] = []
      if (e.transform) {
        const { flipH, flipV, ...layout } = e.transform
        if (Object.keys(layout).length) parts.push(`layout (${Object.keys(layout).join(', ')})`)
        if (flipH !== undefined) parts.push(flipH ? 'mirror' : 'unmirror')
        if (flipV !== undefined) parts.push(flipV ? 'flip upside down' : 'flip back')
      }
      if (e.volume !== undefined) parts.push(`volume ${Math.round(e.volume * 100)}%`)
      if (e.fadeIn !== undefined) parts.push(`fade in ${e.fadeIn}s`)
      if (e.fadeOut !== undefined) parts.push(`fade out ${e.fadeOut}s`)
      if (e.crossfadeIn !== undefined) parts.push(`crossfade ${e.crossfadeIn}s`)
      if (e.muted !== undefined) parts.push(e.muted ? 'mute' : 'unmute')
      if (e.enhance !== undefined) parts.push(`enhance voice: ${e.enhance}`)
      return `Change ${clipName(e.clipId)}: ${parts.join(', ')}`
    }
    case 'setVolumeKeys':
      return `Set ${e.keys.length} volume points on ${clipName(e.clipId)}`
    case 'addMarker':
      return `Add marker “${e.label}” at ${fmt(e.time)}`
    case 'setCaptionStyle':
      return `Captions: ${Object.entries(e.patch).map(([k, v]) => `${k} = ${v}`).join(', ')}`
    case 'editWord':
      return `Correct a caption word to “${e.text}”`
    case 'fixWord':
      return `Correct the word at ${fmt(e.time)} to “${e.text}”`
    case 'insertClip':
      return `Add “${p.media.find((m) => m.id === e.mediaId)?.name ?? 'media'}” at ${fmt(e.start)}`
    case 'detachAudio':
      return `Detach the sound of ${clipName(e.clipId)}`
    case 'insertGap':
      return `Make ${e.length.toFixed(1)} s of room at ${fmt(e.at)} (everything after moves later)`
  }
}

// ---- what the assistant sees ------------------------------------------------------------------

/** Words as "text@start-end" (timeline seconds), one sentence per line (long ones wrapped at 16 words). */
export function transcriptText(words: TimelineWord[], from = 0, to = Infinity): string {
  const sel = words.filter((w) => w.end > from && w.start < to)
  const lines: string[] = []
  let line: string[] = []
  sel.forEach((w, i) => {
    // Sentence ends found from pauses get a full stop, so the AI sees where sentences end.
    const text = w.sentenceEnd && !/[.!?]$/.test(w.text) ? `${w.text}.` : w.text
    line.push(`${text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`)
    if (w.sentenceEnd || line.length >= 16 || i === sel.length - 1) {
      lines.push(line.join(' '))
      line = []
    }
  })
  return lines.join('\n')
}

/** What the user pointed at with "Ask about this frame". */
export interface Focus {
  time: number
  /** Area drawn on the frame (normalized), or null for the whole frame. */
  box: Rect | null
}

/**
 * Default end for something added at `time`: the end of the sentence being spoken then
 * (or a pause), capped to a few seconds; 4 s when there is no transcript.
 */
export function sentenceEndAfter(words: TimelineWord[], time: number): number {
  const i = words.findIndex((w) => w.end > time)
  if (i < 0) return time + 4
  for (let j = i; j < words.length; j++) {
    const w = words[j]
    const next = words[j + 1]
    if (/[.!?]$/.test(w.text) || !next || next.start - w.end > 0.8) return Math.min(Math.max(w.end + 0.4, time + 1.5), time + 10)
  }
  return time + 4
}

/** Include the whole transcript up to this many words; otherwise only around the selection. */
export const FULL_TRANSCRIPT_WORDS = 1500

export function buildContext(p: Project, selection: Selection | null, playhead: number, focus: Focus | null = null): string {
  const r = (n: number): string => n.toFixed(2)
  const lines: string[] = []
  const { width, height, fps } = p.settings
  lines.push(`Canvas ${width}x${height} at ${fps} fps. Timeline duration ${r(projectDuration(p))} s. Playhead at ${r(playhead)} s.`)
  lines.push(
    selection
      ? `EDIT SCOPE: the user marked ${r(selection.start)}–${r(selection.end)} s. Change ONLY what is inside it: cuts, new layers and changed clips must lie inside it (clips crossing its edges are already split there). Everything outside is off-limits and will be rejected. Theme and caption changes apply to this part only.`
      : 'No range is marked: the request applies to the whole video.'
  )

  lines.push('', 'MEDIA (id | name | kind | duration | details)')
  for (const m of p.media) {
    if (m.kind === 'graphic') continue // listed with their clips below
    const note =
      m.kind === 'color' ? ` color ${m.color}`
      : m.kind === 'motion' ? ` generated SVG ${m.motion?.tracks.length ? 'animation' : 'art'} (${m.motion?.prompt.slice(0, 80)})`
      : /^program( \(\d+\))?\.mp4$/.test(m.name) ? ' NOTE: the recorder\'s pre-composed copy of the whole scene; do not stack it with the individual camera/screen recordings'
      : ''
    lines.push(`${m.id} | ${m.name} | ${m.kind} | ${r(m.duration)} s | ${m.width ? `${m.width}x${m.height}` : ''}${m.hasAudio ? ' has-audio' : ''}${p.transcripts[m.id] ? ' transcribed' : ''}${note}`)
  }

  lines.push('', 'TRACKS (video tracks listed bottom layer first)')
  for (const t of p.tracks) {
    const flags = [t.muted && 'muted', t.hidden && 'hidden', t.locked && 'locked'].filter(Boolean).join(',')
    lines.push(`${t.name} [${t.id}] ${t.kind}${flags ? ` (${flags})` : ''}`)
    for (const c of t.clips) {
      const media = p.media.find((m) => m.id === c.mediaId)
      const extra = [
        c.volume !== 1 && `volume ${c.volume}`,
        c.muted && 'muted',
        c.fadeIn && `fadeIn ${c.fadeIn}`,
        c.fadeOut && `fadeOut ${c.fadeOut}`,
        c.crossfadeIn && `crossfade ${c.crossfadeIn}`,
        c.enhance !== 'off' && `enhance ${c.enhance}`,
        c.volumeKeys.length && `${c.volumeKeys.length} volume keys`,
        (c.transform.scale !== 1 || c.transform.x !== 0.5 || c.transform.y !== 0.5) && `pos ${r(c.transform.x)},${r(c.transform.y)} scale ${r(c.transform.scale)}`,
        c.transform.mask !== 'none' && `mask ${c.transform.mask}`,
        c.transform.flipH && 'mirrored'
      ].filter(Boolean)
      if (c.keys.length) extra.push(`animated (${c.keys.length} keys)`)
      const what = media?.graphic ? `text layer ${JSON.stringify({ ...media.graphic, box: undefined })} box ${JSON.stringify(media.graphic.box)}` : `"${media?.name}"`
      lines.push(`  clip ${c.id} ${what} timeline ${r(c.start)}–${r(clipEnd(c))} source ${r(c.in)}–${r(c.out)}${extra.length ? ` · ${extra.join(', ')}` : ''}`)
    }
  }
  if (p.markers.length) lines.push('', `MARKERS: ${p.markers.map((m) => `${m.label}@${r(m.time)}`).join(', ')}`)
  lines.push('', `CAPTIONS: ${p.captionStyle.enabled ? 'shown' : 'hidden'}; style ${JSON.stringify(p.captionStyle)}`)
  lines.push('', `THEME (styles every text layer): ${JSON.stringify(p.theme)}`)
  const mode = modeById(p.mode)
  lines.push(`VIDEO MODE: ${mode.name} — ${mode.tagline}. Keep every change consistent with this mode's style.`)
  lines.push(p.extraPrompt.trim() ? `USER'S STANDING INSTRUCTIONS (mood, style rules; always follow): ${p.extraPrompt.trim()}` : 'No standing instructions from the user.')
  if (p.sections.length) {
    lines.push('', 'PARTS WITH THEIR OWN MODE AND MOOD (inside a part, its mode, mood and look win over the project-wide ones):')
    for (const s of p.sections) {
      const look = [s.theme && `theme ${JSON.stringify(s.theme)}`, s.captions && `captions ${JSON.stringify(s.captions)}`].filter(Boolean).join('; ')
      lines.push(`  ${r(s.start)}–${r(s.end)} s: ${modeById(s.mode).name} mode${s.mood.trim() ? `, mood/instructions: "${s.mood.trim()}"` : ''}${look ? `; ${look}` : ''}`)
    }
  }

  const words = timelineWords(p)
  if (focus) {
    const end = sentenceEndAfter(words, focus.time)
    const said = transcriptText(words, focus.time - 3, end + 1)
    lines.push(
      '',
      `FOCUS: the user paused at ${r(focus.time)} s and ${focus.box ? `drew a box on the frame at ${JSON.stringify(focus.box)} (normalized x,y,w,h)` : 'pointed at the whole frame'}.`,
      `Apply the request HERE ONLY: things you add start at ${r(focus.time)} s and last until ${r(end)} s (end of what is being said) unless the user gives a duration${focus.box ? ', and they must sit inside that box (use it as the graphic "box", or place/scale the clip into it)' : ''}.`,
      'The attached image is that frame' + (focus.box ? ', with the box outlined in magenta.' : '.'),
      said ? `Said around then: ${said}` : ''
    )
  }
  if (!words.length) lines.push('', 'TRANSCRIPT: none (the user has not transcribed any clip).')
  else if (words.length <= FULL_TRANSCRIPT_WORDS) lines.push('', 'TRANSCRIPT (word@start-end, timeline seconds):', transcriptText(words))
  else {
    const from = selection ? selection.start - 30 : playhead - 60
    const to = selection ? selection.end + 30 : playhead + 60
    lines.push('', `TRANSCRIPT excerpt ${r(Math.max(0, from))}–${r(to)} s of ${words.length} words (call get_transcript for other ranges):`, transcriptText(words, from, to))
  }
  return lines.join('\n')
}

const TEMPLATE_LINES = GRAPHIC_TEMPLATES.map((t) => `  - ${t}: ${TEMPLATE_INFO[t].use}`).join('\n')

export const ASSISTANT_SYSTEM = `You are the editing assistant inside "Studio", a desktop video editor used for many kinds of videos (tutorials, explainers, dev logs, Shorts/Reels, podcasts, vlogs, product demos). The user describes an edit; you propose concrete changes to their timeline, which they review before anything is applied. Match the style to the kind of video and the user's taste.

How the editor works:
- Times are seconds on the timeline unless a field says "source". Clips have timeline start/end and source in/out.
- Video tracks stack: tracks listed later draw on top of earlier ones. A clip transform has x/y = center of the clip (0..1 of the canvas), scale (1 = fit the whole canvas), crop fractions (0..1 per edge), mask none|rounded|circle, rotation, opacity, flipH (mirror) and flipV.
  Example: a camera at the bottom-left, a third of the canvas wide: x 0.2, y 0.78, scale 0.33.
- The transcript lists spoken words with timeline times. Use it to find what was said and to time things to the words.

What Studio CAN do (use only these):
- Cut, split, trim, move, delete clips; remove time ranges (cutRanges); make room by pushing everything later (insertGap).
- Position/scale/crop/rotate/mirror/fade/crossfade clips; round or circle masks.
- Text layers and cards with addGraphic (they go on top of the video automatically). Templates:
${TEMPLATE_LINES}
  Fields: kicker (small label), title, subtitle, body, value, items [{text, done?, at?}], code, filename, tag, highlights [{lines:[n], at?}], box {x,y,w,h} (normalized area the graphic is laid out in), align left|center|right, size (text size ×), enter none|fade|rise|pop|type, panel (card behind), scrim (dark gradient for text over video), accent (#color).
  "at" values are seconds after the graphic starts: use them to reveal list items / code highlights exactly when the words are said.
  Code lines starting with "+ " / "- " show as added/removed (diff).
- Keyframe animation with animate: move/scale/fade a clip over time. {"op":"animate","clipId":…,"time":…,"duration":0.6,"corner":"bottom-right","size":0.3} moves a camera into a corner box; "corner":"full" brings it back to full screen; or give "to":{x,y,scale,opacity}.
- addColor: solid color layers (backgrounds, side panels). Use the theme background color for slide backgrounds.
- The theme (setTheme with a patch of colours/fonts, or a mode's default look via "preset": "explainer" | "demo" | "happening") restyles every text layer. When the user describes a mood ("warm", "premium", "playful", "dark and serious"…), translate it into concrete colours and fonts rather than copying a reference look.
- Captions of the spoken words (one caption area): font, size, colors, word highlight, outline, box, uppercase, and its area x/width/y.
- Volume, volume points, mute, voice cleanup (enhance), detach audio, markers, extra tracks.

What Studio CANNOT do yet (say so instead of faking it): images or video the user doesn't have, drawings/diagrams other than text cards, lists, stats and code, speed changes, color grading, filters/effects, blur, stickers/emoji art.

Common patterns:
- Change something from a time onwards: split the clip there with {"op":"splitClip","clipId":…,"time":…,"newClipId":"cam_after"} and change "cam_after" (you choose new, unique ids).
- Explainer / slide section, IN THIS ORDER: (1) splitClip the camera at the section start and end, (2) addTrack a video track and moveClip the middle camera piece onto it, (3) addColor the theme background on the camera's original track for the section (it is free now), (4) animate the moved camera piece into a corner at the section start, (5) addGraphic cards (heading on one side + code/list/stat card) timed to the words. Adding something on a track where a clip already is overwrites that part of the clip, so free the track first.
- Point highlighted by the speaker: lowerThird with the key phrase for a few seconds.
- Shorts: big centered text, bold theme, captions near the middle.

How to respond:
- To change anything, call propose_edits ONCE with every edit, in order, and a short plain-language summary. Use only ids from the context or ids you created earlier in the same list.
- To remove content (mistakes, repeated takes, filler, silences) use {"op":"cutRanges","ranges":[[start,end],...]} in timeline seconds of the CURRENT timeline; it cuts all tracks and closes the gaps. Cut from the end of the last kept word to the start of the next kept word so no word is clipped.
- When the user repeats a sentence, keep the last (usually best) take unless they say otherwise.
- NEVER cut the story. The speaker's sentences are the content: keep every sentence that says something new, in its original order (introductions, the problem, the context, the result, the call to action). A "hook" never means deleting what comes before it. Cuts are for pauses, filler words, false starts and repeated takes only; a cut that deletes words not said again is rejected unless you set "userAskedToRemove": true, which is allowed only when the user's request or standing instructions explicitly ask to drop or shorten content.
- Cut edges go in the gaps between words (end of one word → start of the next), never inside a word, and never between the last words of a sentence and its end.
- Prefer small, targeted changes. Don't change things the user didn't ask for. Never reuse the recorder's pre-composed "program" video as a background or extra layer.
- Keep text short and readable: titles under ~8 words, lower thirds under ~10.
- If the context has a FOCUS section, act only at that moment and inside that box.
- If the context has an EDIT SCOPE, every edit must stay inside it (the rest of the video is finished work). Apply the mode and mood of that part.
- Edits are applied in order. Put cutRanges LAST and give its ranges in the original times from the context: the cut then removes that time from every track and shifts everything after it, including layers you added.
- A clip whose shape differs from the canvas (e.g. 3:2 video on a 16:9 canvas) shows black side bars at scale 1. Full-screen footage must fill the frame: use scale = (canvasW/canvasH) / (mediaW/mediaH) when that is > 1 (or its inverse when < 1). Punch-in zooms multiply that fill scale (e.g. 1.15 × 1.3), never go below it.
- End cards start AFTER the last spoken word (add the colour layer after the end of the video if needed) and last at least 2 s, with large readable text. Text layers must be readable: titles size ≥ 1, badges with real words; no tiny decorations.
- A text layer must match what is being said at that moment; don't keep a card about something that was cut.
- If part of a request is impossible, do the possible part and clearly say which part you could not do and why. If nothing is possible, don't propose edits.
- If propose_edits returns an error, fix the edits and call it again.
- After proposing, reply with one or two sentences; the user sees the list of changes separately.`
