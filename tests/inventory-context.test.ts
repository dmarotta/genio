import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { chipKey, contextAsset, inventoryContextBlock, MAX_CONTEXT_SELECTION, toggleSelection, validateInventoryContext, visibleContext, type InventoryContext } from '../src/shared/inventory-context'
import type { InventoryAsset } from '../src/shared/inventory'
import type { ChatMessage } from '../src/shared/types'
import { prepareInventoryContext } from '../src/main/inventory-context'
import { clampFloatingChat } from '../src/renderer/src/lib/inventory-chat'
import { ACHIEVEMENTS } from '../src/main/stats'

const asset = (name = 'tree.png'): InventoryAsset => ({ path: `Assets/${name}`, name, folder: 'Assets', kind: 'image', size: 128, mtimeMs: 42, ext: 'png', tracked: true, lfs: false, vendor: false, generated: false, tags: [] })
const context = (): InventoryContext => ({ world: 'forest', engine: 'unity', engineRoot: '', folder: 'Assets', preview: contextAsset(asset()), selection: [contextAsset(asset()), contextAsset(asset('rock.png'))] })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-context-'))
const thumb = path.join(dir, 'thumb.webp')
fs.writeFileSync(thumb, 'RIFF0000WEBPthumbnail')
afterEach(() => vi.restoreAllMocks())
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('visible Inventory chips', () => {
  it('dismisses only the matching chip value, restoring it on browsing or world change', () => {
    const c = context(), dismissed = { preview: chipKey(c, 'preview') }
    expect(visibleContext(c, dismissed)?.preview).toBeUndefined()
    expect(visibleContext(c, dismissed)?.selection).toHaveLength(2)
    expect(visibleContext({ ...c, preview: contextAsset(asset('other.png')) }, dismissed)?.preview?.path).toContain('other')
    expect(visibleContext({ ...c, world: 'another' }, dismissed)?.preview).toBeDefined()
    expect(visibleContext(c, { folder: chipKey(c, 'folder'), preview: chipKey(c, 'preview'), selection: chipKey(c, 'selection') })).toBeUndefined()
  })
  it('keeps multi-selection unique, toggles items and caps visible selection at 20', () => {
    let selected = toggleSelection([], asset(), false)
    selected = toggleSelection(selected, asset('rock.png'), true)
    expect(selected).toHaveLength(2)
    expect(toggleSelection(selected, asset(), true)).toEqual([asset('rock.png')])
    for (let i = 0; i < 30; i++) selected = toggleSelection(selected, asset(`${i}.png`), true)
    expect(selected).toHaveLength(MAX_CONTEXT_SELECTION)
    expect(toggleSelection(selected, asset(), false)).toEqual([asset()])
  })
  it('builds a compact snapshot with provenance and without hidden or bulky metadata', () => {
    const a = asset()
    a.provenance = { schema: 'genio.provenance.v1', sha256: 'hash', path: a.path, provider: 'fal', endpoint: 'flux', by: 'Genio', created: 'today', input: { prompt: 'bulky' } }
    const c = context(); c.preview = contextAsset(a)
    const snap = validateInventoryContext(c)
    c.preview.path = 'changed.png'
    const block = inventoryContextBlock(snap)
    expect(block).toContain('Assets/tree.png')
    expect(block).toContain('"size":128')
    expect(block).toContain('"provider":"fal"')
    expect(block).not.toContain('bulky')
    expect(inventoryContextBlock(visibleContext(c, { preview: chipKey(c, 'preview') }))).not.toContain('"preview"')
    expect(() => validateInventoryContext({ ...c, folder: '../escape' })).toThrow()
    expect(() => validateInventoryContext({ ...c, selection: Array(21).fill(c.preview) })).toThrow()
  })
})

describe('preview thumbnail payload', () => {
  it('attaches one small preview, then reuses identical delivered bytes even at another path', async () => {
    const thumbnail = vi.fn(async () => thumb)
    const first = await prepareInventoryContext(context(), [], thumbnail, () => [])
    expect(first.images).toHaveLength(1)
    expect(first.context?.thumbnail?.status).toBe('attached')
    const ref = { file: 'saved.webp', mediaType: 'image/webp' as const }
    first.context!.thumbnail!.image = ref
    const history: ChatMessage[] = [{ id: '1', wksp: 'main', role: 'player', text: 'this', ts: 'now', context: first.context }]
    const next = context(); next.preview!.path = 'identical.png'
    const again = await prepareInventoryContext(next, [], thumbnail, () => history)
    expect(again.images).toHaveLength(0)
    expect(again.context?.thumbnail).toMatchObject({ status: 'reused', image: ref })
    for (const queue of ['queued', 'unsent', 'cancelled'] as const) {
      history[0].queue = queue
      expect((await prepareInventoryContext(next, [], thumbnail, () => history)).images).toHaveLength(1)
    }
  })
  it('does not fetch a removed preview, reports failures honestly and respects attachment limits', async () => {
    const thumbnail = vi.fn(async () => undefined)
    const c = visibleContext(context(), { preview: chipKey(context(), 'preview') })
    const noPreview = await prepareInventoryContext(c, [], thumbnail, () => [])
    expect(thumbnail).not.toHaveBeenCalled()
    expect(noPreview.context?.thumbnail).toBeUndefined()
    expect((await prepareInventoryContext(context(), [], thumbnail, () => [])).context?.thumbnail?.status).toBe('unavailable')
    const pasted = Array.from({ length: 10 }, () => ({ data: 'abc', mediaType: 'image/png' as const }))
    const limited = await prepareInventoryContext(context(), pasted, async () => thumb, () => [])
    expect(limited.images).toHaveLength(10)
    expect(limited.context?.thumbnail?.status).toBe('attachment-limit')
  })
})

it('keeps floating geometry reachable after resizing the window and covers the feature achievement', () => {
  const s = clampFloatingChat({ x: 900, y: 900, width: 700, height: 600, collapsed: false, snapped: false }, 600, 450)
  expect(s).toMatchObject({ x: 0, y: 0, width: 600, height: 450 })
  expect(ACHIEVEMENTS.find(a => a.id === 'inventory-chat')?.feature).toBe('inventory-chat')
})
