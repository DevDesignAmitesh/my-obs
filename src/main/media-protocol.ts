import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'

/**
 * studio-media://local/<encoded absolute path>
 * Serves local media to the renderer with HTTP Range support so <video> can seek.
 */
export const MEDIA_SCHEME = 'studio-media'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.weba': 'audio/webm',
  '.flac': 'audio/flac', '.mpeg': 'audio/mpeg', '.mpga': 'audio/mpeg', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
}

/**
 * Media is drawn onto canvases that get recorded/exported; without CORS the canvas becomes
 * "tainted" and Chromium silently refuses to capture it.
 */
const CORS = { 'Access-Control-Allow-Origin': '*' }

/** Must run before app `ready`. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const file = decodeURIComponent(new URL(request.url).pathname.slice(1))
    // Unknown extensions (e.g. WhatsApp's MP3-in-".mpeg") still play: Chromium sniffs the actual format.
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'

    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
    if (!range) {
      const body = Readable.toWeb(createReadStream(file)) as ReadableStream
      return new Response(body, {
        headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
      })
    }
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: {
        ...CORS,
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  })
}
