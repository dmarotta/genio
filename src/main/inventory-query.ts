import path from 'node:path'
import { matchScore } from '@shared/fal'
import type { AssetKind, InventoryAsset, InventoryFolder, InventoryQuery } from '@shared/inventory'

const KINDS: Record<AssetKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'psd', 'tga', 'tif', 'tiff', 'exr', 'hdr'],
  audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'aif', 'aiff'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
  model: ['glb', 'gltf', 'fbx', 'obj', 'blend', 'ply', 'stl', 'dae'],
  animation: ['anim', 'bvh'],
  material: ['mat', 'material', 'tres']
}
export function assetKind(p: string): AssetKind | undefined {
  const ext = path.posix.extname(p).slice(1).toLowerCase()
  return (Object.keys(KINDS) as AssetKind[]).find(k => KINDS[k].includes(ext))
}
/** Applied before stat or sidecar IO; also excludes accidentally tracked engine caches. */
export function ignoredAssetPath(p: string): boolean {
  return p.split('/').some(s => /^(?:\.git|\.godot|\.import|Library|Temp|Logs|obj|Build|Builds|BuildOutput|UserSettings|Intermediate|Saved|DerivedDataCache|Binaries|node_modules)$/i.test(s))
}
export function under(p: string, folder: string): boolean { return p === folder || p.startsWith(folder + '/') }
export function vendorPath(p: string, extra: string[] = []): boolean {
  return /(?:^|\/)(?:third[-_ ]?party|plugins|textmesh pro|microsplatdata|addons)(?:\/|$)/i.test(p) || extra.some(f => under(p.toLowerCase(), f.toLowerCase()))
}
export function assetTags(p: string, kind: AssetKind): string[] {
  if (kind !== 'audio') return []
  return /(?:^|\/)(?:music)(?:\/|$)/i.test(p) ? ['music']
    : /(?:^|\/)(?:vo|voice|dialogue)(?:\/|$)/i.test(p) ? ['voice']
      : /(?:^|\/)(?:sfx|sound effects)(?:\/|$)/i.test(p) ? ['sfx'] : []
}
export function queryInventory(assets: InventoryAsset[], q: InventoryQuery): { items: InventoryAsset[]; total: number; folders: InventoryFolder[] } {
  const folder = (q.folder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const tokens = (q.query ?? '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map(t => t.replace(/"/g, '').toLowerCase()) ?? []
  const matches = assets.filter(a => {
    if (folder && !under(a.path, folder)) return false
    if ((q.scope ?? 'ours') === 'ours' && a.vendor || q.scope === 'vendor' && !a.vendor) return false
    if (q.kinds?.length && !q.kinds.includes(a.kind)) return false
    if (q.generated !== undefined && q.generated !== a.generated) return false
    const tags = a.tags.map(t => t.toLowerCase())
    if (q.tags?.some(t => !tags.includes(t.toLowerCase()))) return false
    return tokens.every(t => {
      const colon = t.indexOf(':'), key = t.slice(0, colon), value = t.slice(colon + 1)
      if (colon > 0) {
        if (key === 't') return (value === '3d' ? 'model' : value === 'anim' ? 'animation' : value) === a.kind || tags.includes(value)
        if (key === 'ext') return a.ext === value.replace(/^\./, '')
        if (key === 'in') return a.folder.toLowerCase().includes(value)
        if (key === 'l') return tags.includes(value)
        if (key === 'by') return a.provenance?.by?.split(':')[0] === value
        if (key === 'via') return a.provenance?.provider === value
        if (key === 'lfs') return value === 'missing' && a.lfs
        if (key === 'new' && /^\d+d$/.test(value)) return a.mtimeMs >= Date.now() - parseInt(value) * 86400000
      }
      const size = /^size([<>])(\d+(?:\.\d+)?)(kb|mb|gb|b)?$/.exec(t)
      if (size) {
        const n = Number(size[2]) * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[size[3] ?? 'b'] ?? 1)
        return size[1] === '>' ? a.size > n : a.size < n
      }
      return matchScore(t, a.path) >= 0
    })
  })
  const folders = new Map<string, InventoryFolder>()
  const prefix = folder ? folder + '/' : ''
  for (const a of matches) {
    const rest = a.path.slice(prefix.length), name = rest.split('/')[0]
    if (!rest.includes('/')) continue
    const p = prefix + name, f = folders.get(p)
    if (f) { f.count++; f.vendor &&= a.vendor } else folders.set(p, { path: p, name, count: 1, vendor: a.vendor })
  }
  const items = q.recursive === false ? matches.filter(a => a.folder === folder) : matches
  items.sort((a, b) => {
    const n = q.sort === 'size' ? a.size - b.size : q.sort === 'modified' ? a.mtimeMs - b.mtimeMs
      : q.sort === 'type' ? a.kind.localeCompare(b.kind) : a.name.localeCompare(b.name)
    return (n || a.path.localeCompare(b.path)) * (q.descending ? -1 : 1)
  })
  const offset = Math.max(0, Math.floor(q.offset ?? 0)), limit = Math.min(1000, Math.max(1, Math.floor(q.limit ?? 200)))
  return { items: items.slice(offset, offset + limit), total: items.length, folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}
