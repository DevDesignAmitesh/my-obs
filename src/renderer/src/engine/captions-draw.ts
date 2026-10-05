import { cueAt, projectCues, type Cue } from '@shared/captions'
import { captionStyleAt } from '@shared/sections'
import type { CaptionStyle, Project } from '@shared/project'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Cues are rebuilt only when the project changes (edits create a new project object). */
const cache = new WeakMap<Project, Cue[]>()
export function cuesFor(p: Project): Cue[] {
  let cues = cache.get(p)
  if (!cues) {
    cues = projectCues(p)
    cache.set(p, cues)
  }
  return cues
}

/** Draws the caption showing at time `t` (if captions are on). Canvas is in project pixels. */
export function drawCaptions(ctx: Ctx2D, project: Project, t: number, W: number, H: number): void {
  const style = captionStyleAt(project, t)
  if (!style.enabled) return
  const cue = cueAt(cuesFor(project), t)
  if (cue) drawCue(ctx, cue, t, style, W, H)
}

interface Placed {
  text: string
  x: number
  width: number
  line: number
  start: number
  next: number
}

export function drawCue(ctx: Ctx2D, cue: Cue, t: number, style: CaptionStyle, W: number, H: number): void {
  const texts = cue.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text))
  const maxWidth = W * style.width * 0.94
  let size = (style.size / 100) * H
  let lines: Placed[][] = []

  // Wrap greedily; shrink the font until it fits in maxLines.
  for (let attempt = 0; attempt < 6; attempt++) {
    ctx.font = `800 ${size}px "${style.font}", "Segoe UI", sans-serif`
    const space = ctx.measureText(' ').width
    lines = [[]]
    let x = 0
    let chars = 0
    texts.forEach((text, i) => {
      const width = ctx.measureText(text).width
      // New line when it would be too wide, or longer than the style's characters per line.
      if (x > 0 && (x + space + width > maxWidth || chars + 1 + text.length > style.maxChars)) {
        lines.push([])
        x = 0
        chars = 0
      }
      chars += (chars ? 1 : 0) + text.length
      if (x > 0) x += space
      lines[lines.length - 1].push({ text, x, width, line: lines.length - 1, start: cue.words[i].start, next: cue.words[i + 1]?.start ?? cue.end })
      x += width
    })
    if (lines.length <= style.maxLines) break
    size *= 0.88
  }

  const lineH = size * 1.22
  const top = style.y * H - (lines.length * lineH) / 2
  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  lines.forEach((line, li) => {
    const lineW = line.length ? line[line.length - 1].x + line[line.length - 1].width : 0
    const left = style.x * W - lineW / 2
    const cy = top + li * lineH + lineH / 2
    if (style.background) {
      const pad = size * 0.3
      ctx.fillStyle = 'rgba(0,0,0,0.62)'
      ctx.beginPath()
      ctx.roundRect(left - pad, cy - lineH / 2, lineW + pad * 2, lineH, size * 0.2)
      ctx.fill()
    }
    for (const w of line) {
      const spoken = t >= w.start
      const current = spoken && t < w.next
      const lit = style.highlight === 'karaoke' ? spoken : style.highlight === 'word' ? current : false
      ctx.save()
      // A tiny "pop" on the word being said.
      if (current && style.highlight === 'word') {
        const cx = left + w.x + w.width / 2
        ctx.translate(cx, cy)
        ctx.scale(1.08, 1.08)
        ctx.translate(-cx, -cy)
      }
      if (style.outline) {
        ctx.strokeStyle = 'rgba(0,0,0,0.9)'
        ctx.lineWidth = size * 0.16
        ctx.strokeText(w.text, left + w.x, cy)
      }
      ctx.fillStyle = lit ? style.highlightColor : style.color
      ctx.fillText(w.text, left + w.x, cy)
      ctx.restore()
    }
  })
  ctx.restore()
}
