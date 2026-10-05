import { execFile } from 'child_process'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import OpenAI from 'openai'
import { providerInfo, type ImageProviderId } from '@shared/ai'
import type { ImageRequest } from '@shared/api'
import type { MediaItem } from '@shared/project'
import { getKey } from '../secrets'
import { getSettings } from '../settings'
import { ffmpegPath } from '../ffmpeg'
import { importMedia, safeName, uniquePath } from '../project-store'
import { AiError } from './types'

const run = promisify(execFile)

/** Gemini can't paint transparency, so it paints this color and Studio keys it out. */
const KEY_COLOR = '00FF00'

const STYLE_PROMPTS: Record<ImageRequest['style'], string> = {
  logo: 'A clean, modern, professional logo. Flat vector style, simple bold shapes, balanced and centered, plenty of empty space around it, no mockup, no photo, no extra words beyond any text requested.',
  icon: 'A single simple icon, flat vector style, bold clean shapes, centered, no text.',
  illustration: 'A polished digital illustration, clean shapes, cohesive colors.',
  photo: 'A realistic, high quality photograph, natural lighting, sharp focus.',
  thumbnail: 'An eye-catching YouTube thumbnail background: bold, high contrast, clear focal point, leave room for a big title.',
  none: ''
}

export function buildImagePrompt(req: ImageRequest, transparentVia: 'native' | 'key-color' | 'none'): string {
  const parts = [STYLE_PROMPTS[req.style], req.prompt.trim()]
  if (transparentVia === 'native') parts.push('Transparent background.')
  if (transparentVia === 'key-color') parts.push(`Place it on a perfectly flat, solid pure green (#${KEY_COLOR}) background with no shadows, gradients or green in the subject itself.`)
  return parts.filter(Boolean).join('\n\n')
}

const OPENAI_SIZES = { square: '1024x1024', wide: '1536x1024', tall: '1024x1536' } as const
const GEMINI_RATIOS = { square: '1:1', wide: '16:9', tall: '9:16' } as const

async function key(id: ImageProviderId): Promise<string> {
  const k = await getKey(id)
  if (!k) throw new AiError(`No ${providerInfo(id).name} API key yet. Add one in Settings → AI.`)
  return k
}

/** Tries the chosen model, or each preferred model in turn until one is available to the key. */
async function withModels<T>(id: ImageProviderId, chosen: string, fn: (model: string) => Promise<T>): Promise<T> {
  const models = chosen ? [chosen] : (providerInfo(id).preferredImageModels ?? [])
  let last: unknown
  for (const model of models) {
    try {
      return await fn(model)
    } catch (e) {
      last = e
      const status = (e as { status?: number }).status
      // Model missing / not allowed for this key: try the next one. Anything else is a real error.
      if (chosen || (status !== 404 && status !== 403 && status !== 400)) throw e
    }
  }
  throw last
}

async function openaiImage(req: ImageRequest, model: string): Promise<Buffer> {
  const client = new OpenAI({ apiKey: await key('openai'), baseURL: (await getSettings()).ai.baseUrls.openai || undefined, timeout: 5 * 60 * 1000 })
  try {
    return await withModels('openai', model, async (m) => {
      const r = await client.images.generate({
        model: m,
        prompt: buildImagePrompt(req, req.transparent ? 'native' : 'none'),
        size: OPENAI_SIZES[req.shape],
        quality: req.quality,
        background: req.transparent ? 'transparent' : 'auto',
        output_format: 'png',
        n: 1
      })
      const b64 = r.data?.[0]?.b64_json
      if (!b64) throw new AiError('OpenAI returned no image.')
      return Buffer.from(b64, 'base64')
    })
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) throw new AiError('OpenAI rejected the API key. Check it in Settings → AI.')
    if (e instanceof OpenAI.RateLimitError) throw new AiError('OpenAI rate limit or quota reached. Check your OpenAI billing, then try again.')
    if (e instanceof OpenAI.APIError && /verif/i.test(e.message)) throw new AiError(`OpenAI: ${e.message} (image models need a verified organization)`)
    if (e instanceof OpenAI.APIError) throw new AiError(`OpenAI image error ${e.status ?? ''}: ${e.message}`)
    throw e
  }
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'

async function geminiImage(req: ImageRequest, model: string): Promise<Buffer> {
  const apiKey = await key('google')
  return withModels('google', model, async (m) => {
    const res = await fetch(`${GEMINI}/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildImagePrompt(req, req.transparent ? 'key-color' : 'none') }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: GEMINI_RATIOS[req.shape] } }
      })
    })
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
      candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] }; finishReason?: string }[]
    }
    if (!res.ok) {
      const err = new AiError(res.status === 400 && /API key/i.test(body.error?.message ?? '') ? 'Google rejected the API key. Check it in Settings → AI.' : `Gemini error ${res.status}: ${body.error?.message ?? res.statusText}`)
      ;(err as { status?: number }).status = res.status
      throw err
    }
    const data = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data
    if (!data) throw new AiError(`Gemini returned no image (${body.candidates?.[0]?.finishReason ?? 'no reason given'}). Try rewording the prompt.`)
    return Buffer.from(data, 'base64')
  })
}

/** Image models the Google key can use (for Settings → Test). */
export async function geminiImageModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } })
  const body = (await res.json().catch(() => ({}))) as { models?: { name: string }[]; error?: { message?: string } }
  if (!res.ok) throw new AiError(`Google: ${body.error?.message ?? res.statusText}`)
  return (body.models ?? []).map((m) => m.name.replace(/^models\//, '')).filter((n) => /image/.test(n))
}

/** Makes an image from the prompt, saves it in the project's generated/ folder and imports it. */
export async function generateImage(projectPath: string, req: ImageRequest): Promise<MediaItem> {
  if (!req.prompt.trim()) throw new AiError('Describe the image first.')
  const { provider, model } = (await getSettings()).ai.image
  const png = provider === 'google' ? await geminiImage(req, model) : await openaiImage(req, model)

  const dir = join(projectPath, 'generated', 'images')
  await mkdir(dir, { recursive: true })
  const base = safeName(`${req.style === 'none' ? 'image' : req.style} ${req.prompt}`.slice(0, 40)) || 'image'
  const file = await uniquePath(dir, `${base}.png`)
  if (provider === 'google' && req.transparent) {
    // Key out the green background into real transparency.
    const raw = `${file}.raw.png`
    await writeFile(raw, png)
    try {
      await run(ffmpegPath, ['-y', '-v', 'error', '-i', raw, '-vf', `colorkey=0x${KEY_COLOR}:0.3:0.08,despill=type=green`, '-pix_fmt', 'rgba', file])
    } finally {
      await rm(raw, { force: true })
    }
  } else await writeFile(file, png)

  const [item] = await importMedia(projectPath, [file], 'in-place')
  return { ...item, name: req.prompt.trim().slice(0, 60) }
}
