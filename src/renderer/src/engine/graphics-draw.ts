import { mainText, type Graphic } from '@shared/graphics'
import type { Theme } from '@shared/theme'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * Draws a text/card layer ("graphic") in canvas pixels (WÃ—H), styled by the theme.
 * `t` is seconds since the clip started (entrance animation, items/highlights appearing).
 */
export function drawGraphic(ctx: Ctx2D, g: Graphic, theme: Theme, W: number, H: number, t: number): void {
  let bx = g.box.x * W
  let by = g.box.y * H
  let bw = g.box.w * W
  let bh = g.box.h * H
  const accent = g.accent ?? theme.accent
  const u = H / 1080 // design unit: sizes below are "pixels at 1080p"
  const k = u * g.size

  // ---- entrance animation
  const e = g.enter === 'none' ? 1 : clamp01(t / 0.45)
  const eased = 1 - (1 - e) ** 3
  ctx.save()
  if (g.enter !== 'none' && g.enter !== 'type') ctx.globalAlpha *= eased
  if (g.enter === 'rise') ctx.translate(0, (1 - eased) * 28 * u)
  if (g.enter === 'pop') {
    const s = 0.88 + 0.12 * eased
    ctx.translate(bx + bw / 2, by + bh / 2)
    ctx.scale(s, s)
    ctx.translate(-(bx + bw / 2), -(by + bh / 2))
  }
  /** Characters shown so far for the typewriter entrance. */
  const typed = (s: string): string => (g.enter === 'type' ? s.slice(0, Math.floor(t * 38)) : s)

  if (g.scrim) {
    // Soft darkening behind text that sits on top of video.
    const top = Math.max(0, by - bh * 0.6)
    const grad = ctx.createLinearGradient(0, top, 0, Math.min(H, by + bh * 1.4))
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.62)')
    ctx.fillStyle = grad
    ctx.fillRect(0, top, W, Math.min(H, by + bh * 1.4) - top)
  }
  // A badge is its own pill; other text on a card gets inner padding so it never touches the edge.
  if (g.panel && g.template !== 'badge') {
    panel(ctx, bx, by, bw, bh, theme, H)
    if (g.template !== 'list' && g.template !== 'code') {
      const padX = 30 * u
      const padY = 24 * u
      bx += padX
      by += padY
      bw -= padX * 2
      bh -= padY * 2
    }
  }

  const font = (weight: number, px: number, mono = false): string =>
    `${weight} ${px}px "${mono ? theme.monoFont : (g.font ?? theme.font)}", ${mono ? 'Consolas, monospace' : '"Segoe UI", sans-serif'}`
  const xFor = (w: number, left: number, width: number): number => (g.align === 'center' ? left + (width - w) / 2 : g.align === 'right' ? left + width - w : left)
  ctx.textBaseline = 'top'

  /** Writes wrapped text; returns the y below it. */
  const block = (text: string, y: number, px: number, weight: number, color: string, opts: { mono?: boolean; maxLines?: number; left?: number; width?: number; spacing?: number } = {}): number => {
    const left = opts.left ?? bx
    const width = opts.width ?? bw
    ctx.font = font(weight, px, opts.mono)
    ctx.fillStyle = color
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${opts.spacing ?? 0}px`
    const lines = wrap(ctx, text, width).slice(0, opts.maxLines ?? 6)
    for (const line of lines) {
      ctx.fillText(line, xFor(ctx.measureText(line).width, left, width), y)
      y += px * 1.18
    }
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = '0px'
    return y
  }
  const rule = (y: number): number => {
    const w = 64 * u
    ctx.fillStyle = accent
    ctx.fillRect(xFor(w, bx, bw), y, w, 3.5 * u)
    return y + 3.5 * u
  }

  switch (g.template) {
    case 'title': {
      // Anchored to the bottom of the box so long titles grow upward.
      const titlePx = 64 * k
      ctx.font = font(700, titlePx)
      const titleLines = wrap(ctx, mainText(g), bw).slice(0, 3).length
      const total = (g.kicker ? 30 * k : 0) + titleLines * titlePx * 1.18 + 26 * k + (g.subtitle ? 44 * k : 0)
      let y = by + bh - total
      if (g.kicker) y = block(g.kicker.toUpperCase(), y, 18 * k, 500, theme.accent2, { mono: true, spacing: 3 * k }) + 12 * k
      y = block(typed(mainText(g)), y, titlePx, 700, theme.text, { maxLines: 3 }) + 12 * k
      y = rule(y) + 18 * k
      if (g.subtitle) block(g.subtitle, y, 24 * k, 400, theme.muted)
      break
    }
    case 'lowerThird': {
      const px = 38 * k
      ctx.font = font(700, px)
      const lines = wrap(ctx, mainText(g), bw - 26 * u).slice(0, 2)
      const h = lines.length * px * 1.18 + (g.subtitle ? 34 * k : 0)
      const y0 = by + bh - h
      ctx.fillStyle = accent
      ctx.fillRect(bx, y0 + 4 * u, 5 * u, h - 8 * u)
      let y = block(typed(mainText(g)), y0, px, 700, theme.text, { left: bx + 22 * u, width: bw - 26 * u, maxLines: 2 })
      if (g.subtitle) block(g.subtitle, y + 4 * k, 24 * k, 400, theme.muted, { left: bx + 22 * u, width: bw - 26 * u })
      break
    }
    case 'heading': {
      let y = by
      if (g.kicker) y = block(g.kicker.toUpperCase(), y, 18 * k, 500, theme.accent2, { mono: true, spacing: 3 * k }) + 14 * k
      y = block(typed(mainText(g)), y, 40 * k, 700, theme.text, { maxLines: 3 }) + 14 * k
      y = rule(y) + 18 * k
      if (g.subtitle) block(g.subtitle, y, 24 * k, 400, theme.muted)
      break
    }
    case 'text': {
      const px = 48 * k
      const text = mainText(g)
      ctx.font = font(700, px)
      const lines = wrap(ctx, text, bw * 0.94).length
      block(typed(text), by + Math.max(0, (bh - lines * px * 1.18) / 2), px, 700, theme.text, { left: bx + bw * 0.03, width: bw * 0.94 })
      break
    }
    case 'badge': {
      const px = 20 * k
      ctx.font = font(700, px, true)
      const label = mainText(g).toUpperCase()
      const w = ctx.measureText(label).width + 30 * k
      const h = px + 18 * k
      const x = xFor(w, bx, bw)
      ctx.fillStyle = hexAlpha(accent, 0.16)
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5 * u
      ctx.beginPath()
      ctx.roundRect(x, by, w, h, h / 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = accent
      ctx.fillText(label, x + 15 * k, by + 9 * k)
      break
    }
    case 'stat': {
      const valuePx = 150 * k
      const total = valuePx + (g.body ? 60 * k : 0)
      let y = by + (bh - total) / 2
      y = block(typed(mainText(g)), y, valuePx, 800, accent, { maxLines: 1 })
      if (g.body) block(g.body, y - 6 * k, 34 * k, 500, theme.muted)
      break
    }
    case 'list': {
      const px = 28 * k
      const pad = g.panel ? 34 * u : 0
      let y = by + pad
      if (g.title) y = block(g.title, y, 32 * k, 700, theme.text, { left: bx + pad, width: bw - pad * 2 }) + 14 * k
      for (const item of g.items ?? []) {
        if (item.at !== undefined && t < item.at) continue // not said yet
        const appear = item.at !== undefined ? clamp01((t - item.at) / 0.35) : 1
        ctx.save()
        ctx.globalAlpha *= appear
        const rowH = px * 1.9
        const iconX = bx + pad
        const cy = y + rowH / 2
        if (item.done === true) {
          ctx.fillStyle = hexAlpha(accent, 0.2)
          roundRect(ctx, iconX, cy - px * 0.55, px * 1.1, px * 1.1, px * 0.25)
          ctx.strokeStyle = accent
          ctx.lineWidth = 3 * u
          ctx.beginPath()
          ctx.moveTo(iconX + px * 0.28, cy)
          ctx.lineTo(iconX + px * 0.5, cy + px * 0.22)
          ctx.lineTo(iconX + px * 0.85, cy - px * 0.25)
          ctx.stroke()
        } else if (item.done === false) {
          ctx.strokeStyle = theme.muted
          ctx.lineWidth = 2 * u
          ctx.beginPath()
          ctx.arc(iconX + px * 0.55, cy, px * 0.42, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          ctx.fillStyle = accent
          ctx.beginPath()
          ctx.arc(iconX + px * 0.55, cy, px * 0.18, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.font = font(item.done === false ? 400 : 600, px)
        ctx.fillStyle = item.done === false ? theme.muted : theme.text
        ctx.textBaseline = 'middle'
        ctx.fillText(ellipsize(ctx, item.text, bw - pad * 2 - px * 1.8), iconX + px * 1.7, cy)
        ctx.textBaseline = 'top'
        ctx.restore()
        y += rowH
      }
      break
    }
    case 'code':
      drawCode(ctx, g, theme, bx, by, bw, bh, t, u, k, accent, font)
      break
  }
  ctx.restore()
}

function drawCode(
  ctx: Ctx2D, g: Graphic, theme: Theme, bx: number, by: number, bw: number, bh: number, t: number, u: number, k: number, accent: string,
  font: (w: number, px: number, mono?: boolean) => string
): void {
  // Window chrome: three dots, file name, optional tag.
  const headH = 46 * u
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = theme.muted
    ctx.globalAlpha *= 0.55
    ctx.beginPath()
    ctx.arc(bx + 24 * u + i * 16 * u, by + headH / 2, 5 * u, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha /= 0.55
  }
  ctx.textBaseline = 'middle'
  if (g.filename) {
    ctx.font = font(400, 17 * u, true)
    ctx.fillStyle = theme.muted
    ctx.fillText(g.filename, bx + 90 * u, by + headH / 2)
  }
  if (g.tag) {
    ctx.font = font(600, 15 * u)
    const w = ctx.measureText(g.tag).width + 22 * u
    ctx.fillStyle = hexAlpha(accent, 0.18)
    roundRect(ctx, bx + bw - w - 18 * u, by + headH / 2 - 13 * u, w, 26 * u, 13 * u)
    ctx.fillStyle = accent
    ctx.fillText(g.tag, bx + bw - w - 7 * u, by + headH / 2)
  }
  ctx.strokeStyle = theme.panelBorder
  ctx.lineWidth = 1 * u
  ctx.beginPath()
  ctx.moveTo(bx, by + headH)
  ctx.lineTo(bx + bw, by + headH)
  ctx.stroke()

  // Code lines, shrunk to fit the card.
  const lines = (g.code ?? '').replace(/\t/g, '    ').split('\n')
  const longest = Math.max(1, ...lines.map((l) => l.length))
  let px = 19 * k
  px = Math.min(px, (bw - 50 * u) / (longest * 0.6), (bh - headH - 36 * u) / (lines.length * 1.55))
  const lineH = px * 1.55
  ctx.font = font(400, px, true)
  const charW = ctx.measureText('M').width
  const lit = new Set<number>()
  for (const h of g.highlights ?? []) if (h.at === undefined || t >= h.at) for (const n of h.lines) lit.add(n)
  const pal = codePalette(theme)
  let y = by + headH + 18 * u
  lines.forEach((raw, i) => {
    const diff = raw.startsWith('+ ') ? '+' : raw.startsWith('- ') ? '-' : ''
    const line = diff ? raw.slice(2) : raw
    if (diff || lit.has(i + 1)) {
      ctx.fillStyle = diff === '+' ? 'rgba(46,160,67,0.22)' : diff === '-' ? 'rgba(248,81,73,0.22)' : hexAlpha(accent, 0.2)
      ctx.fillRect(bx + 8 * u, y - lineH * 0.18, bw - 16 * u, lineH)
      if (lit.has(i + 1)) {
        ctx.fillStyle = accent
        ctx.fillRect(bx + 8 * u, y - lineH * 0.18, 3 * u, lineH)
      }
    }
    let x = bx + 28 * u
    if (diff) {
      ctx.fillStyle = diff === '+' ? '#3fb950' : '#f85149'
      ctx.fillText(diff, bx + 14 * u, y + lineH * 0.32)
    }
    for (const tok of tokenize(line)) {
      ctx.fillStyle = pal[tok.kind]
      ctx.fillText(tok.text, x, y + lineH * 0.32)
      x += tok.text.length * charW
    }
    y += lineH
  })
  ctx.textBaseline = 'top'
}

// ---- small helpers -----------------------------------------------------------------------------

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

function panel(ctx: Ctx2D, x: number, y: number, w: number, h: number, theme: Theme, H: number): void {
  ctx.save()
  ctx.fillStyle = theme.panel
  ctx.strokeStyle = theme.panelBorder
  ctx.lineWidth = Math.max(1, H / 1080)
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, theme.radius * H)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

/** Greedy word wrap; explicit newlines are kept. */
export function wrap(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}

function ellipsize(ctx: Ctx2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let s = text
  while (s.length > 1 && ctx.measureText(`${s}â€¦`).width > maxWidth) s = s.slice(0, -1)
  return `${s}â€¦`
}

export function hexAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// ---- tiny syntax highlighter (C-like, JS/TS, Python, Go, Rust, Java) --------------------------

type TokKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'func' | 'type'

const KEYWORDS = new Set(
  ('if else for while do return break continue switch case default class struct enum union interface extends implements new delete this self super ' +
    'public private protected static const let var function def fn func lambda async await yield import from export package use using namespace try catch ' +
    'finally throw throws raise with as in is not and or true false null nullptr None True False void int long short char bool boolean float double auto ' +
    'unsigned signed string vector typedef template typename virtual override inline constexpr mut impl pub match loop where type go chan defer select ' +
    'include define pragma elif pass assert').split(' ')
)

export function tokenize(line: string): { text: string; kind: TokKind }[] {
  const out: { text: string; kind: TokKind }[] = []
  const re = /(\/\/.*|#(?!include|define|pragma).*$|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?|\b\d[\d._]*[a-zA-Z]*\b|\b[A-Za-z_][\w]*\b|\s+|.)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    const s = m[0]
    let kind: TokKind = 'plain'
    if (s.startsWith('//') || (s.startsWith('#') && s.length > 1 && !/^#(include|define|pragma)/.test(s))) kind = 'comment'
    else if (/^["'`]/.test(s)) kind = 'string'
    else if (/^\d/.test(s)) kind = 'number'
    else if (/^[A-Za-z_]/.test(s)) {
      if (KEYWORDS.has(s)) kind = 'keyword'
      else if (line[m.index + s.length] === '(') kind = 'func'
      else if (/^[A-Z]/.test(s)) kind = 'type'
    }
    out.push({ text: s, kind })
  }
  return out
}

function codePalette(theme: Theme): Record<TokKind, string> {
  return theme.light
    ? { plain: '#24292f', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', comment: '#6e7781', func: '#8250df', type: '#953800' }
    : { plain: '#e6edf3', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', comment: '#8b949e', func: '#d2a8ff', type: '#ffa657' }
}
