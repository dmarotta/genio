import type { InventoryAsset } from './inventory'
import type { ChatImage } from './chat-images'

export const MAX_CONTEXT_SELECTION = 20
export const MAX_SCREEN_FACTS = 8
export type ContextChip = 'screen' | 'folder' | 'preview' | 'selection'
export type ContextAsset = Pick<InventoryAsset, 'path' | 'kind' | 'size' | 'mtimeMs' | 'generated'> & {
  provenance?: Pick<NonNullable<InventoryAsset['provenance']>, 'provider' | 'endpoint' | 'by' | 'created'>
}
/** What the current screen shows: its id plus a few short label/value facts (selected unit, quest, section…). */
export interface ScreenState {
  id: string
  label: string
  facts?: { label: string; value: string }[]
}
/** A snapshot of the visible chips: the screen, plus Inventory's folder/preview/selection. No absolute paths or full provenance inputs. */
export interface InventoryContext {
  world: string
  screen?: ScreenState
  engine?: string
  engineRoot?: string
  folder?: string
  preview?: ContextAsset
  selection?: ContextAsset[]
}
export interface InventoryContextReceipt extends InventoryContext {
  thumbnail?: { status: 'attached' | 'reused' | 'unavailable' | 'attachment-limit'; digest?: string; image?: ChatImage }
}
export function contextAsset(a: InventoryAsset): ContextAsset {
  const p = a.provenance
  return { path: a.path, kind: a.kind, size: a.lfsSize ?? a.size, mtimeMs: a.mtimeMs, generated: a.generated,
    ...(p ? { provenance: { provider: p.provider, endpoint: p.endpoint, by: p.by, created: p.created } } : {}) }
}
/** Dismissals apply to that chip's value; browsing to another value restores it. */
export function chipKey(c: InventoryContext, chip: ContextChip): string {
  return JSON.stringify([c.world, chip === 'screen' ? c.screen : chip === 'folder' ? c.folder : chip === 'preview' ? c.preview?.path : c.selection?.map(a => a.path).sort()])
}
export function visibleContext(c: InventoryContext, dismissed: Partial<Record<ContextChip, string>>): InventoryContext | undefined {
  const next = { ...c }
  for (const chip of ['screen', 'folder', 'preview', 'selection'] as const) if (dismissed[chip] === chipKey(c, chip)) delete next[chip]
  return next.screen || next.folder !== undefined || next.preview || next.selection?.length ? next : undefined
}
/** Inventory chips (as opposed to a screen-only context). */
export const hasInventoryChips = (c?: InventoryContext): boolean => !!c && (c.folder !== undefined || !!c.preview || !!c.selection?.length)
export function toggleSelection(assets: InventoryAsset[], asset: InventoryAsset, multiple: boolean): InventoryAsset[] {
  if (!multiple) return [asset]
  return assets.some(a => a.path === asset.path) ? assets.filter(a => a.path !== asset.path)
    : assets.length < MAX_CONTEXT_SELECTION ? [...assets, asset] : assets
}
/** JSON keeps filenames and provenance data from impersonating envelope fields. */
export function inventoryContextBlock(c?: InventoryContextReceipt): string {
  return c ? `\n\n[screen: ${JSON.stringify(c)}]` : ''
}
/** Runtime boundary: reject oversized or malformed snapshots instead of silently changing visible chips. */
export function validateInventoryContext(c: InventoryContext): InventoryContext {
  const str = (s: unknown): s is string => typeof s === 'string' && s.length <= 2048 && !/[\u0000-\u001f]/.test(s)
  const relative = (s: unknown): s is string => str(s) && !/^[\\/]|^[a-z]:/i.test(s) && !s.split(/[\\/]/).includes('..')
  const asset = (a: ContextAsset): boolean => !!a && relative(a.path) && !!a.path && ['image', 'audio', 'video', 'model', 'animation', 'material'].includes(a.kind)
    && Number.isFinite(a.size) && a.size >= 0 && Number.isFinite(a.mtimeMs)
    && (!a.provenance || [a.provenance.provider, a.provenance.endpoint, a.provenance.by, a.provenance.created].every(str))
  const short = (s: unknown, max: number): s is string => str(s) && !!s && s.length <= max
  const screen = (s: ScreenState): boolean => !!s && typeof s.id === 'string' && /^[a-z][a-z-]{0,31}$/.test(s.id) && short(s.label, 64)
    && (s.facts === undefined || (Array.isArray(s.facts) && s.facts.length <= MAX_SCREEN_FACTS && s.facts.every(f => !!f && short(f.label, 40) && short(f.value, 300))))
  if (!c || !str(c.world) || !c.world || (c.screen !== undefined && !screen(c.screen)) || (c.engine !== undefined && !str(c.engine)) || (c.engineRoot !== undefined && !relative(c.engineRoot))
    || (c.folder !== undefined && !relative(c.folder)) || (c.preview !== undefined && !asset(c.preview))
    || (c.selection !== undefined && (!Array.isArray(c.selection) || c.selection.length > MAX_CONTEXT_SELECTION || !c.selection.every(asset)))) throw new Error('Invalid screen context')
  const clean = (a: ContextAsset): ContextAsset => ({ path: a.path, kind: a.kind, size: a.size, mtimeMs: a.mtimeMs, generated: !!a.generated,
    ...(a.provenance ? { provenance: { provider: a.provenance.provider, endpoint: a.provenance.endpoint, by: a.provenance.by, created: a.provenance.created } } : {}) })
  const view = c.screen && { id: c.screen.id, label: c.screen.label, ...(c.screen.facts?.length ? { facts: c.screen.facts.map(f => ({ label: f.label, value: f.value })) } : {}) }
  return { world: c.world, screen: view, engine: c.engine, engineRoot: c.engineRoot, folder: c.folder, preview: c.preview && clean(c.preview), selection: c.selection?.map(clean) }
}
