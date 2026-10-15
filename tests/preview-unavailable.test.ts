import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InventoryInfo } from '../src/shared/inventory'
import { modelTooLarge, previewKind, unavailablePreview } from '../src/renderer/src/lib/inventory'

const asset = (name: string, extra: Partial<InventoryInfo> = {}): InventoryInfo => {
  const ext = name.split('.').pop()!
  const kind = ['glb', 'gltf', 'fbx', 'blend', 'obj'].includes(ext) ? 'model' : ext === 'anim' ? 'animation' : ext === 'mat' ? 'material' : ['wav', 'aiff'].includes(ext) ? 'audio' : 'image'
  return { path: `Assets/${name}`, folder: 'Assets', name, ext, kind, size: 40_000, mtimeMs: 1, tracked: true, lfs: false, vendor: false, generated: false, tags: [], mediaUrl: `genio-media://world/zoo/Assets/${name}`, ...extra }
}

describe('assets Inventory cannot preview', () => {
  it('sends glTF and GLB to the 3D viewer and keeps big models out of it', () => {
    expect(['robot.glb', 'robot.gltf', 'robot.fbx', 'robot.blend', 'stone.png'].map(n => previewKind(asset(n)))).toEqual(['model', 'model', 'none', 'none', 'image'])
    expect(previewKind(asset('robot.glb', { lfs: true }))).toBe('none')
    expect(modelTooLarge(asset('scan.glb', { size: 64 * 1024 * 1024 }))).toBeUndefined()
    expect(modelTooLarge(asset('scan.glb', { size: 70 * 1024 * 1024 }))?.title).toBe('Too large to preview: 70.0 MB (limit 64.0 MB)')
  })

  it('names the file type and the real reason, never a promise of later support', () => {
    expect(unavailablePreview(asset('robot.blend')).title).toBe('This file type can\'t be previewed here: .blend needs Blender')
    expect(unavailablePreview(asset('robot.fbx'))).toEqual({ title: 'This file type can\'t be previewed here: .fbx', reason: 'Genio\'s 3D preview reads glTF and GLB. Open it in your 3D app, or export it as glTF or GLB to preview it here.' })
    expect(unavailablePreview(asset('Wave.anim')).title).toBe('This file type can\'t be previewed here: .anim is a Unity animation clip')
    expect(unavailablePreview(asset('Crate.mat')).title).toBe('This file type can\'t be previewed here: .mat is an engine material')
    expect(unavailablePreview(asset('stone.psd')).reason).toContain('PNG, JPEG, WebP, GIF, BMP, AVIF and SVG')
    expect(unavailablePreview(asset('loop.aiff')).reason).toContain('WAV, MP3, OGG, FLAC, M4A, AAC, OPUS')
    expect(unavailablePreview(asset('robot.glb', { lfs: true })).title).toBe('Git LFS file not pulled')
  })

  it('has no coming-later or coming-soon wording anywhere in the renderer', () => {
    const files: string[] = []
    const walk = (dir: string): void => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|html|css)$/.test(e.name) && files.push(path.join(dir, e.name)) }
    walk(path.resolve('src/renderer'))
    expect(files.filter(file => /coming (later|soon)|preview later|later preview/i.test(fs.readFileSync(file, 'utf8')))).toEqual([])
  })
})
