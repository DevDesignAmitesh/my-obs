import type { CaptionStyle, Project, Section } from './project'
import type { Theme } from './theme'

/**
 * Parts of the timeline with their own mode, mood and look (see Section in project.ts).
 */

const EPS = 1e-6

/** The part playing at timeline time t, if any. */
export const sectionAt = (p: Project, t: number): Section | undefined =>
  p.sections.find((s) => t >= s.start - EPS && t < s.end - EPS)

/** The part that covers exactly this range (within ~a frame), if any. */
export const sectionFor = (p: Project, start: number, end: number): Section | undefined =>
  p.sections.find((s) => Math.abs(s.start - start) < 0.05 && Math.abs(s.end - end) < 0.05)

/** Theme used for text layers at time t. */
export const themeAt = (p: Project, t: number): Theme => sectionAt(p, t)?.theme ?? p.theme

/** Caption style at time t. */
export const captionStyleAt = (p: Project, t: number): CaptionStyle => sectionAt(p, t)?.captions ?? p.captionStyle

/**
 * Adds or replaces a part. Parts never overlap: a new part trims or removes the ones it covers,
 * so marking a range inside an existing part re-styles just that range.
 */
export function upsertSection(list: Section[], s: Section): Section[] {
  const out: Section[] = []
  for (const o of list) {
    if (o.id === s.id) continue
    if (o.end <= s.start + EPS || o.start >= s.end - EPS) {
      out.push(o)
      continue
    }
    if (o.start < s.start - EPS) out.push({ ...o, end: s.start })
    if (o.end > s.end + EPS) out.push({ ...o, id: o.start < s.start - EPS ? `${o.id}-b` : o.id, start: s.end })
  }
  return [...out, s].sort((a, b) => a.start - b.start)
}

/** Parts after removing [start, end) from the timeline (ripple): later parts move left, covered ones shrink. */
export function rippleSections(list: Section[], start: number, end: number): Section[] {
  const len = end - start
  const map = (t: number): number => (t <= start ? t : t >= end ? t - len : start)
  return list.map((s) => ({ ...s, start: map(s.start), end: map(s.end) })).filter((s) => s.end - s.start > 0.05)
}
