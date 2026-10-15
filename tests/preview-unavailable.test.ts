import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InventoryInfo } from '../src/shared/inventory'
import { modelTooLarge, previewKind, unavailablePreview } from '../src/renderer/src/lib/inventory'

const asset = (name: string, extra: Partial<InventoryInfo> = {}): InventoryInfo => {
  const ext = name.split('.').pop()!
  const kind = ['glb', 'gltf', 'fbx', 'blend', 'obj', 'stl', 'ply', 'dae', 'usd', 'usda', 'usdc', 'usdz', '3ds', 'max'].includes(ext) ? 'model' : ['anim', 'bvh'].includes(ext) ? 'animation' : ext === 'mat' ? 'material' : ['wav', 'aiff'].includes(ext) ? 'audio' : 'image'
  return { path: `Assets/${name}`, folder: 'Assets', name, ext, kind, size: 40_000, mtimeMs: 1, tracked: true, lfs: false, vendor: false, generated: false, tags: [], mediaUrl: `genio-media://world/zoo/Assets/${name}`, ...extra }
}

describe('assets Inventory cannot preview', () => {
  it('sends every format three reads to the 3D viewer and keeps big models out of it', () => {
    const viewer = ['robot.glb', 'robot.gltf', 'robot.fbx', 'crate.obj', 'crate.stl', 'crate.ply', 'robot.dae', 'wave.bvh', 'robot.usda', 'robot.usd', 'crate.3ds']
    expect(viewer.map(n => previewKind(asset(n)))).toEqual(viewer.map(() => 'model'))
    expect(['robot.blend', 'robot.usdz', 'robot.usdc', 'robot.max', 'stone.png'].map(n => previewKind(asset(n)))).toEqual(['none', 'none', 'none', 'none', 'image'])
    expect(previewKind(asset('robot.glb', { lfs: true }))).toBe('none')
    expect(modelTooLarge(asset('scan.glb', { size: 64 * 1024 * 1024 }))).toBeUndefined()
    expect(modelTooLarge(asset('scan.glb', { size: 70 * 1024 * 1024 }))?.title).toBe('Too large to preview: 70.0 MB (limit 64.0 MB)')
  })

  it('names the file type and the real reason, never a promise of later support', () => {
    expect(unavailablePreview(asset('robot.blend'))).toEqual({ title: 'This file type can\'t be previewed here: .blend needs Blender', reason: 'Genio does not run Blender to read .blend files. Open it in Blender, or export it as glTF, GLB or FBX to preview it here.' })
    expect(unavailablePreview(asset('robot.usdz'))).toEqual({ title: 'This file type can\'t be previewed here: .usdz is binary USD', reason: 'Genio\'s 3D viewer reads USD only as text (USDA): its binary USD reader fails on USDZ packages. Open it in your 3D app, or export it as USDA, glTF or FBX to preview it here.' })
    expect(unavailablePreview(asset('robot.usdc')).reason).toContain('fails on USDC files')
    expect(unavailablePreview(asset('robot.max'))).toEqual({ title: 'This file type can\'t be previewed here: .max', reason: 'Genio\'s 3D preview reads glTF, GLB, FBX, OBJ, STL, PLY, Collada (.dae), BVH, USDA and 3DS. Open it in your 3D app, or export it as one of those to preview it here.' })
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
    expect(files.filter(file => /coming (later|soon)|preview later|later preview|not yet supported|in a future/i.test(fs.readFileSync(file, 'utf8')))).toEqual([])
  })
})
