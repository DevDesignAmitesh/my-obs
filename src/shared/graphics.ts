import { z } from 'zod'
import { Rect } from './scene'

/**
 * Text and card layers ("graphics"). A graphic is laid out inside `box` (normalized to the
 * canvas) and drawn from the project theme. On the timeline it is an ordinary clip, so it can be
 * moved, trimmed, faded, layered and animated like any video.
 */

export const GRAPHIC_TEMPLATES = ['title', 'lowerThird', 'heading', 'text', 'badge', 'stat', 'list', 'code'] as const
export const GraphicTemplate = z.enum(GRAPHIC_TEMPLATES)
export type GraphicTemplate = z.infer<typeof GraphicTemplate>

export const TEMPLATE_INFO: Record<GraphicTemplate, { name: string; use: string }> = {
  title: { name: 'Title card', use: 'video/chapter title. Fields: kicker (small label), title, subtitle' },
  lowerThird: { name: 'Lower third', use: 'key point, name + role, or quote near the bottom. Fields: title, subtitle' },
  heading: { name: 'Section heading', use: 'numbered section label + heading + accent line, e.g. beside a slide. Fields: kicker (e.g. "01 — THE IDEA"), title, subtitle' },
  text: { name: 'Text', use: 'any free text, message, question, quote. Field: body' },
  badge: { name: 'Badge', use: 'small pill tag: NEW, TIP, LIVE DEMO, a date. Field: title' },
  stat: { name: 'Big stat', use: 'one big value with a label, e.g. "~10×" + "faster". Fields: value, body' },
  list: { name: 'List / checklist', use: 'bullets or checklist items that can appear one by one as they are mentioned. Fields: title (optional), items' },
  code: { name: 'Code card', use: 'code in an editor-style card; highlight lines, show +/- diff lines. Fields: code, filename, tag, highlights' }
}

export const ListItem = z.object({
  text: z.string(),
  /** Checklist state: true ✓, false ○, undefined = bullet. */
  done: z.boolean().optional(),
  /** Seconds after the clip starts when this item appears (undefined = with the card). */
  at: z.number().optional()
})
export type ListItem = z.infer<typeof ListItem>

export const CodeHighlight = z.object({
  /** 1-based line numbers. */
  lines: z.array(z.number().int()),
  /** Seconds after the clip starts when the highlight turns on. */
  at: z.number().optional()
})

export const EnterAnimation = z.enum(['none', 'fade', 'rise', 'pop', 'type'])
export type EnterAnimation = z.infer<typeof EnterAnimation>

export const Graphic = z.object({
  template: GraphicTemplate,
  box: Rect,
  align: z.enum(['left', 'center', 'right']).default('left'),
  kicker: z.string().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  /** Stat value, e.g. "10×". */
  value: z.string().optional(),
  items: z.array(ListItem).optional(),
  code: z.string().optional(),
  filename: z.string().optional(),
  /** Small pill in the card header (code) or corner. */
  tag: z.string().optional(),
  highlights: z.array(CodeHighlight).optional(),
  /** Text size multiplier. */
  size: z.number().min(0.3).max(4).default(1),
  enter: EnterAnimation.default('rise'),
  /** Card behind the content. */
  panel: z.boolean().default(false),
  /** Dark gradient behind text over video (titles, lower thirds). */
  scrim: z.boolean().default(false),
  /** Overrides the theme accent for this graphic. */
  accent: z.string().optional(),
  /** Overrides the theme font: an installed font or any Google Fonts family. */
  font: z.string().optional()
})
export type Graphic = z.infer<typeof Graphic>

/** A sensible starting graphic for a template, for a landscape or portrait canvas. */
export function defaultGraphic(template: GraphicTemplate, W = 1920, H = 1080): Graphic {
  const portrait = H > W
  const box = (land: Rect, port: Rect): Rect => (portrait ? port : land)
  const g = (partial: Partial<Graphic> & { box: Rect }): Graphic => Graphic.parse({ template, ...partial })
  switch (template) {
    case 'title':
      return g({ box: box({ x: 0.055, y: 0.6, w: 0.62, h: 0.32 }, { x: 0.07, y: 0.62, w: 0.86, h: 0.26 }), kicker: 'CHAPTER 1', title: 'Your title here', subtitle: 'Subtitle · your name', scrim: true })
    case 'lowerThird':
      return g({ box: box({ x: 0.055, y: 0.8, w: 0.6, h: 0.1 }, { x: 0.07, y: 0.72, w: 0.86, h: 0.1 }), title: 'Key point goes here', enter: 'fade', scrim: true })
    case 'heading':
      return g({ box: box({ x: 0.64, y: 0.13, w: 0.33, h: 0.3 }, { x: 0.07, y: 0.08, w: 0.86, h: 0.18 }), kicker: '01 — SECTION', title: 'Section heading' })
    case 'text':
      return g({ box: box({ x: 0.1, y: 0.38, w: 0.8, h: 0.24 }, { x: 0.08, y: 0.4, w: 0.84, h: 0.2 }), body: 'Your text', align: 'center', enter: 'fade' })
    case 'badge':
      return g({ box: box({ x: 0.055, y: 0.07, w: 0.3, h: 0.065 }, { x: 0.07, y: 0.06, w: 0.5, h: 0.045 }), title: 'NEW', enter: 'pop' })
    case 'stat':
      return g({ box: box({ x: 0.05, y: 0.16, w: 0.55, h: 0.62 }, { x: 0.07, y: 0.28, w: 0.86, h: 0.34 }), value: '10×', body: 'faster', align: 'center', panel: true, enter: 'pop' })
    case 'list':
      return g({
        box: box({ x: 0.05, y: 0.16, w: 0.55, h: 0.66 }, { x: 0.07, y: 0.28, w: 0.86, h: 0.44 }),
        items: [{ text: 'First point', done: true }, { text: 'Second point', done: true }, { text: 'Next step', done: false }],
        panel: true
      })
    case 'code':
      return g({
        box: box({ x: 0.05, y: 0.14, w: 0.56, h: 0.72 }, { x: 0.05, y: 0.26, w: 0.9, h: 0.46 }),
        filename: 'main.cpp',
        code: 'int main() {\n    // your code here\n    return 0;\n}',
        panel: true,
        enter: 'fade'
      })
  }
}

/**
 * The text a template shows as its main line. Falls back to other text fields, so a layer never
 * comes out blank just because its text was put in a neighbouring field (e.g. a badge's "tag").
 */
export function mainText(g: Graphic): string {
  switch (g.template) {
    case 'text':
      return g.body ?? g.title ?? g.subtitle ?? ''
    case 'badge':
      return g.title ?? g.tag ?? g.body ?? g.kicker ?? ''
    case 'stat':
      return g.value ?? g.title ?? ''
    case 'code':
      return g.code ?? g.body ?? ''
    default:
      return g.title ?? g.body ?? ''
  }
}

const CONTENT_FIELDS =['kicker', 'title', 'subtitle', 'body', 'value', 'items', 'code', 'filename', 'tag', 'highlights'] as const

/**
 * A template's layout defaults (box, alignment, entrance, card…) WITHOUT its placeholder text,
 * for layers created from data (e.g. by the AI) where only the given text should appear.
 */
export function layoutDefaults(template: GraphicTemplate, W = 1920, H = 1080): Graphic {
  const g: Graphic = { ...defaultGraphic(template, W, H) }
  for (const f of CONTENT_FIELDS) delete g[f]
  return g
}

/** One-line description of a graphic's text (for the timeline and the AI context). */
export function graphicLabel(g: Graphic): string {
  const text =
    g.template === 'list' ? (g.title ?? g.items?.map((i) => i.text).join(' · ') ?? '')
    : g.template === 'code' ? (g.filename ?? mainText(g).split('\n')[0])
    : mainText(g)
  return `${TEMPLATE_INFO[g.template].name}: ${text}`.slice(0, 80)
}
