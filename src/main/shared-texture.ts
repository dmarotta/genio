import * as electron from 'electron'
import type { WebFrameMain } from 'electron'

/** Main's reference to an imported texture; release it once it has been sent. */
export interface ImportedTexture { release(): void }
/** A GPU as Chromium lists it; Microsoft's software adapter is left out. */
export interface GpuDevice { vendorId: number; deviceId: number; active: boolean }
/** What travels with each texture to the preload's receiver. */
export interface TextureMeta { world: string; seq: number; width: number; height: number }

/**
 * Electron's `sharedTexture` module, experimental in Electron 44, behind one small interface: an API change in an
 * Electron upgrade touches this file only. Unavailable (and never touched) outside Windows or when Electron lacks it.
 */
export interface TextureApi {
  readonly available: boolean
  /** Imports an RGBA NT handle valid in this process. `released` runs once main and every renderer let go of it. Throws on a bad handle. */
  importTexture(handle: Buffer, width: number, height: number, released: () => void): ImportedTexture
  /** Sends an imported texture to the frame's preload receiver; resolves once transferred (Electron's timeout is 1 s). */
  send(to: WebFrameMain, texture: ImportedTexture, meta: TextureMeta): Promise<void>
  /** Chromium's hardware GPUs (`app.getGPUInfo('complete')`), read once per run; empty when unknown. */
  gpus(): Promise<GpuDevice[]>
  /** fn runs when Chromium's GPU process exits (device loss, driver update, crash); returns the unsubscribe. */
  onGpuGone(fn: () => void): () => void
}

/** Microsoft Basic Render Driver: always listed, never the GPU a game renders on. */
const SOFTWARE_VENDOR = 0x1414

let api: TextureApi | undefined
export function textureApi(): TextureApi { return api ??= electronTextures() }

function electronTextures(): TextureApi {
  const shared = process.platform === 'win32' ? electron.sharedTexture : undefined
  const imported = new WeakMap<ImportedTexture, Electron.SharedTextureImported>()
  const gone = new Set<() => void>()
  let gpus: Promise<GpuDevice[]> | undefined, listening = false
  return {
    available: typeof shared?.importSharedTexture === 'function' && typeof shared.sendSharedTexture === 'function',
    importTexture(handle, width, height, released) {
      const texture = shared!.importSharedTexture({
        textureInfo: { pixelFormat: 'rgba', codedSize: { width, height }, handle: { ntHandle: handle } },
        allReferencesReleased: released
      })
      const ours = { release: () => texture.release() }
      imported.set(ours, texture)
      return ours
    },
    send(to, texture, meta) {
      const real = imported.get(texture)
      if (!real) return Promise.reject(new Error('Unknown texture'))
      return shared!.sendSharedTexture({ frame: to, importedSharedTexture: real }, meta)
    },
    gpus() {
      return gpus ??= electron.app.getGPUInfo('complete').then(info => {
        const list = (info as { gpuDevice?: { vendorId?: unknown; deviceId?: unknown; active?: unknown }[] }).gpuDevice
        return Array.isArray(list) ? list.filter(d => Number.isInteger(d.vendorId) && Number.isInteger(d.deviceId) && d.vendorId !== SOFTWARE_VENDOR)
          .map(d => ({ vendorId: d.vendorId as number, deviceId: d.deviceId as number, active: d.active === true })) : []
      }, () => [])
    },
    onGpuGone(fn) {
      if (!listening) {
        listening = true
        electron.app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU') for (const f of [...gone]) f() })
      }
      gone.add(fn)
      return () => { gone.delete(fn) }
    }
  }
}
