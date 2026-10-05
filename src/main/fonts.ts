import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { FontFaceData, FontInfo } from '@shared/fonts'
import { AiError } from './ai/types'

/**
 * Google Fonts: the catalog (all families, no API key) and the font files themselves. Files are
 * cached in userData/fonts, so a font picked once works offline and exports exactly as previewed.
 */

const CATALOG_URL = 'https://fonts.google.com/metadata/fonts'
const CATALOG_MAX_AGE = 7 * 24 * 3600 * 1000
// css2 picks the file format from the user agent; Chrome's gets woff2 split by script (unicode-range).
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
/** Weights text layers and captions draw with. */
const WANTED = [400, 500, 600, 700, 800, 900]

const root = (): string => join(app.getPath('userData'), 'fonts')
const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16)

async function fetchOk(url: string, what: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': CHROME_UA } })
  } catch {
    throw new AiError(`Could not download ${what}. Check your internet connection.`)
  }
  if (!res.ok) throw new AiError(`Could not download ${what} (${res.status}).`)
  return res
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await writeFile(`${file}.tmp`, data)
  await rename(`${file}.tmp`, file)
}

interface RawFamily {
  family: string
  category: string
  popularity: number
  fonts: Record<string, unknown>
}

let catalog: Promise<FontInfo[]> | null = null

/** All Google Fonts families, most popular first. Cached for a week; a stale copy is used offline. */
export function fontCatalog(): Promise<FontInfo[]> {
  catalog ??= loadCatalog().catch((e) => {
    catalog = null
    throw e
  })
  return catalog
}

async function loadCatalog(): Promise<FontInfo[]> {
  const file = join(root(), 'catalog.json')
  const cached = async (): Promise<FontInfo[] | null> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as FontInfo[]
    } catch {
      return null
    }
  }
  const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => Infinity)
  if (age < CATALOG_MAX_AGE) {
    const c = await cached()
    if (c) return c
  }
  try {
    const res = await fetchOk(CATALOG_URL, 'the Google Fonts list')
    const data = (await res.json()) as { familyMetadataList: RawFamily[] }
    const list: FontInfo[] = data.familyMetadataList
      .map((f) => ({
        family: f.family,
        category: f.category,
        popularity: f.popularity,
        weights: Object.keys(f.fonts).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b)
      }))
      .filter((f) => f.weights.length > 0)
      .sort((a, b) => a.popularity - b.popularity)
    await mkdir(root(), { recursive: true })
    await writeAtomic(file, JSON.stringify(list))
    return list
  } catch (e) {
    const c = await cached()
    if (c) return c
    throw e
  }
}

/** Weights to download: the drawing weights the family has, or its closest one to 400. */
function pickWeights(available: number[]): number[] {
  const w = WANTED.filter((x) => available.includes(x))
  return w.length ? w : [available.reduce((a, b) => (Math.abs(b - 400) < Math.abs(a - 400) ? b : a))]
}

const familyParam = (family: string): string => encodeURIComponent(family).replace(/%20/g, '+')

interface FaceEntry {
  weight: string
  style: string
  unicodeRange?: string
  file: string
}

/** Parses css2 @font-face rules. */
function parseCss(css: string): { weight: string; style: string; unicodeRange?: string; url: string }[] {
  const faces = []
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = m[1]
    const prop = (name: string): string | undefined => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim()
    const url = /url\(([^)]+)\)/.exec(body)?.[1].replace(/['"]/g, '')
    if (url) faces.push({ weight: prop('font-weight') ?? '400', style: prop('font-style') ?? 'normal', unicodeRange: prop('unicode-range'), url })
  }
  return faces
}

const downloading = new Map<string, Promise<FaceEntry[]>>()

/** Downloads (once) the files of a Google font. Empty for fonts that aren't on Google Fonts. */
async function ensureFamily(family: string): Promise<FaceEntry[]> {
  const info = (await fontCatalog()).find((f) => f.family === family)
  if (!info) return []
  const dir = join(root(), hash(family))
  const index = join(dir, 'faces.json')
  try {
    return JSON.parse(await readFile(index, 'utf8')) as FaceEntry[]
  } catch {
    // not downloaded yet
  }
  let job = downloading.get(family)
  if (!job) {
    job = (async () => {
      const weights = pickWeights(info.weights)
      const css = await (await fetchOk(`https://fonts.googleapis.com/css2?family=${familyParam(family)}:wght@${weights.join(';')}`, `the font ${family}`)).text()
      await mkdir(dir, { recursive: true })
      const faces: FaceEntry[] = []
      for (const f of parseCss(css)) {
        const file = `${hash(f.url)}.woff2`
        await writeAtomic(join(dir, file), Buffer.from(await (await fetchOk(f.url, `the font ${family}`)).arrayBuffer()))
        faces.push({ weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, file })
      }
      if (!faces.length) throw new AiError(`Google Fonts returned no files for ${family}.`)
      await writeAtomic(index, JSON.stringify(faces))
      return faces
    })().finally(() => downloading.delete(family))
    downloading.set(family, job)
  }
  return job
}

/** The font's files, ready for `new FontFace(...)` in the renderer. */
export async function fontFaces(family: string): Promise<FontFaceData[]> {
  const faces = await ensureFamily(family)
  const dir = join(root(), hash(family))
  return Promise.all(faces.map(async (f) => ({ weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, data: new Uint8Array(await readFile(join(dir, f.file))) })))
}

/** A tiny font with just the letters of the family's name, for showing names in their own font. */
export async function fontPreview(family: string): Promise<Uint8Array<ArrayBuffer>> {
  const dir = join(root(), 'previews')
  const file = join(dir, `${hash(family)}.woff2`)
  try {
    return new Uint8Array(await readFile(file))
  } catch {
    // not cached yet
  }
  const css = await (await fetchOk(`https://fonts.googleapis.com/css2?family=${familyParam(family)}&text=${encodeURIComponent(family)}`, `the font ${family}`)).text()
  const url = parseCss(css)[0]?.url
  if (!url) throw new AiError(`No preview for ${family}.`)
  const bytes = Buffer.from(await (await fetchOk(url, `the font ${family}`)).arrayBuffer())
  await mkdir(dir, { recursive: true })
  await writeAtomic(file, bytes)
  return new Uint8Array(bytes)
}
