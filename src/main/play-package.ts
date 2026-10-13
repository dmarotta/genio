import fs from 'node:fs'
import path from 'node:path'
import { noLinks } from './asset-placement'

/** Explicit Play-screen install only, reusing the world's link/hardlink write guard. */
export function installPlayPackage(appRoot: string, world: string, engineRoot: string): void {
  const relative = path.relative(world, engineRoot).replace(/\\/g, '/')
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unity root escapes this project')
  const manifestRel = [relative, 'Packages/manifest.json'].filter(Boolean).join('/')
  const archiveRel = '.genio/unity/com.genio.play-0.1.0.tgz'
  noLinks(world, manifestRel); noLinks(world, archiveRel)
  const manifestPath = path.join(world, manifestRel)
  const before = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(before)
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) throw new Error('Invalid Unity package manifest')
  const archive = path.join(world, archiveRel)
  const reference = `file:${path.relative(path.dirname(manifestPath), archive).replace(/\\/g, '/')}`
  const existing = manifest.dependencies['com.genio.play']
  if (existing && existing !== reference) throw new Error('A different Genio Play package is already configured; preserve it before upgrading')
  const bytes = fs.readFileSync(path.join(appRoot, 'resources/unity/com.genio.play-0.1.0.tgz'))
  if (fs.existsSync(archive) && !fs.readFileSync(archive).equals(bytes)) throw new Error('Existing Genio Play archive differs; preserve it before upgrading')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  noLinks(world, archiveRel)
  if (!fs.existsSync(archive)) fs.writeFileSync(archive, bytes, { flag: 'wx' })
  if (existing === reference) return
  manifest.dependencies['com.genio.play'] = reference
  noLinks(world, manifestRel)
  if (fs.readFileSync(manifestPath, 'utf8') !== before) throw new Error('Unity manifest changed during installation; retry')
  // Synchronous read/write sequence: preserve every other dependency, including Toolbox.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
