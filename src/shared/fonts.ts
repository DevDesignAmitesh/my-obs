import type { Project } from './project'

/** Fonts for text layers and captions: installed Windows fonts plus every Google Fonts family. */

export interface FontInfo {
  family: string
  /** "Sans Serif", "Serif", "Display", "Handwriting" or "Monospace". */
  category: string
  /** Rank on Google Fonts (1 = most used). */
  popularity: number
  /** Upright weights available. */
  weights: number[]
}

/** One file of a downloaded font (woff2 bytes), as `FontFace` descriptors want it. */
export interface FontFaceData {
  weight: string
  style: string
  unicodeRange?: string
  data: Uint8Array<ArrayBuffer>
}

/** Fonts that come with Windows, so they need no download. */
export const SYSTEM_FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Cascadia Mono', 'Constantia', 'Corbel', 'Georgia', 'Impact', 'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana']

export const FONT_CATEGORIES = ['Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace'] as const

/** Every font family the project draws with (text layers, themes, captions). */
export function projectFonts(p: Project): string[] {
  const fonts = new Set<string>()
  const theme = (t?: { font: string; monoFont: string }): void => {
    if (t) fonts.add(t.font).add(t.monoFont)
  }
  theme(p.theme)
  fonts.add(p.captionStyle.font)
  for (const s of p.sections) {
    theme(s.theme)
    if (s.captions) fonts.add(s.captions.font)
  }
  for (const m of p.media) if (m.graphic?.font) fonts.add(m.graphic.font)
  return [...fonts].filter((f) => f && !SYSTEM_FONTS.includes(f))
}
