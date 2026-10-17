import { net, protocol } from 'electron'
import { MEDIA_SCHEME, mediaResponse } from './fal-service'
import { artBibleRefPath } from './art-bible'
import { installModelViewer } from './model-viewer'
import { VIEWER_SCHEME } from '@shared/model-viewer'
import { chatImageDir, chatImagePath } from './chat-images'
import type { AppCtx } from './services'

export interface MediaOptions {
  /** the built renderer folder (viewer3d.html and its assets) */
  rendererDir: string
  /** the dev server, in development only */
  devUrl?: string
  /** three's decoder libs, served beside the dev viewer */
  decoderLibs?: string
}

/**
 * genio-media://fal/<run>/<file>: FAL outputs from Genio's data dir (streamable, seekable); genio-media://uthana/<run>/<file>: Animation
 * previews and exports; genio-media://chat/<wksp>/<file>: chat images; genio-media://art-bible/<world>/<path>: Art Bible reference
 * images (art-bible.ts). genio-viewer://app and genio-media://model/<token>/<file>:
 * Inventory's sandboxed 3D viewer and the one model it was granted (model-viewer.ts)
 */
export function registerMedia(getCtx: () => AppCtx, opts: MediaOptions): void {
  const viewer = installModelViewer({
    projectRoot: world => getCtx().projects.get(world)?.path,
    rendererDir: opts.rendererDir,
    decoderLibs: opts.decoderLibs,
    devUrl: opts.devUrl,
    fetch: url => net.fetch(url)
  })
  protocol.handle(VIEWER_SCHEME, req => viewer.handle(req))
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      if (u.hostname === 'model') return await viewer.handle(req)
      if (u.hostname === 'world' || u.hostname === 'thumb' || u.hostname === 'art-bible') {
        if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
        const [world, ...parts] = u.pathname.slice(1).split('/').map(decodeURIComponent)
        const asset = parts.join('/')
        if (u.hostname === 'art-bible') {
          const root = getCtx().projects.get(world)?.path
          const ref = root && await artBibleRefPath(root, asset)
          if (!ref) return new Response('not found', { status: 404 })
          const response = mediaResponse(ref, req.headers.get('range'))
          response.headers.set('X-Content-Type-Options', 'nosniff')
          response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
          return response
        }
        const thumb = u.hostname === 'thumb' ? await getCtx().inventory.thumbnailResult(world, asset, req.signal) : undefined
        // A model that cannot be drawn answers why, for the grid tile's placeholder.
        if (thumb?.failure) return new Response(JSON.stringify(thumb.failure), { status: 422, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
        const p = thumb ? thumb.file : await getCtx().inventory.mediaPath(world, asset)
        if (!p) return new Response('not found', { status: 404 })
        const response = mediaResponse(p, req.headers.get('range'))
        response.headers.set('X-Content-Type-Options', 'nosniff')
        response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
        return response
      }
      const [id, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const p =
        !id || !file
          ? undefined
          : u.hostname === 'fal'
            ? getCtx().fal.mediaPath(id, file)
            : u.hostname === 'uthana'
              ? getCtx().uthana.mediaPath(id, file)
              : u.hostname === 'chat'
                ? chatMediaPath(getCtx, id, file)
                : undefined
      if (!p) return new Response('not found', { status: 404 })
      return mediaResponse(p, req.headers.get('range'))
    } catch { return new Response('not found', { status: 404 }) }
  })
}

/** genio-media://chat/<wksp>/<file>: an image attached in that chat */
function chatMediaPath(getCtx: () => AppCtx, wksp: string, file: string): string | undefined {
  try {
    return chatImagePath(chatImageDir(getCtx().home(wksp).home.data), file)
  } catch {
    return undefined
  }
}
