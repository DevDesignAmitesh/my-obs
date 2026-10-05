import { projectFonts, type FontInfo } from '@shared/fonts'
import type { Project } from '@shared/project'

/** Loads Google fonts into the document so canvases (preview and export) can draw with them. */

const loaded = new Map<string, Promise<boolean>>()

/** Makes `family` usable by canvas text. Resolves true if a Google font was added; installed fonts are a no-op. Throws if the download fails. */
export function loadFont(family: string): Promise<boolean> {
  let job = loaded.get(family)
  if (!job) {
    job = (async () => {
      const faces = await window.studio.fonts.faces(family)
      await Promise.all(
        faces.map(async (f) => {
          const face = new FontFace(family, f.data, { weight: f.weight, style: f.style, unicodeRange: f.unicodeRange })
          document.fonts.add(await face.load())
        })
      )
      return faces.length > 0
    })().catch((e) => {
      loaded.delete(family) // try again next time (e.g. was offline)
      throw e
    })
    loaded.set(family, job)
  }
  return job
}

/** Loads every font the project uses. Resolves true if any was newly added (time to redraw). */
export async function ensureProjectFonts(p: Project): Promise<boolean> {
  const results = await Promise.all(
    projectFonts(p).map((f) => {
      const fresh = !loaded.has(f)
      return loadFont(f).then(
        (added) => fresh && added,
        (e) => (console.warn(`Font ${f} could not be loaded`, e), false) // falls back to Segoe UI
      )
    })
  )
  return results.some(Boolean)
}

let catalog: Promise<FontInfo[]> | null = null
export function fontCatalog(): Promise<FontInfo[]> {
  catalog ??= window.studio.fonts.catalog().catch((e) => {
    catalog = null
    throw e
  })
  return catalog
}

const previews = new Map<string, Promise<string>>()

/** CSS font-family that shows `family`'s name in its own look (a tiny download per family). */
export function previewFamily(family: string): Promise<string> {
  let job = previews.get(family)
  if (!job) {
    const name = `preview ${family}`
    job = window.studio.fonts
      .preview(family)
      .then(async (data) => {
        document.fonts.add(await new FontFace(name, data).load())
        return `"${name}"`
      })
      .catch(() => 'inherit')
    previews.set(family, job)
  }
  return job
}
