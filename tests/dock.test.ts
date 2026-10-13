import { describe, expect, it, vi } from 'vitest'
import type { Ally } from '@shared/types'
import type { AllyCreateRequest } from '@shared/api'
import {
  MAIN_PANEL, allyForWorld, allyNameForWorld, closePanel, defaultDock, groupOf, groups, hasUnread, isOpen, markSeen,
  movePanel, openPanel, openPanels, parseDock, reconcileDock, resizeSplit, serializeDock, spawnWorldAlly, visiblePanels,
  type DockState
} from '../src/renderer/src/lib/dock'

const ally = (name: string, extra: Partial<Ally> = {}): Ally => ({
  name, scope: `scope of ${name}`, charter: '', projects: [], home: `/wksps/${name}`, createdAt: '2026-10-01T00:00:00.000Z', ...extra
})

const NOW = '2026-10-13T10:00:00.000Z'

/** main + art + audio, with audio docked to the right of the main group */
function splitLayout(): DockState {
  let d = reconcileDock(defaultDock(), [ally('art'), ally('audio')], NOW)
  d = movePanel(d, 'audio', groupOf(d.root, MAIN_PANEL)!.id, 'right')
  return d
}

describe('dock layout', () => {
  it('starts with only the main chat', () => {
    const d = defaultDock()
    expect(openPanels(d.root)).toEqual([MAIN_PANEL])
  })

  it('never closes the main chat', () => {
    const d = reconcileDock(defaultDock(), [ally('art')], NOW)
    expect(closePanel(d, MAIN_PANEL)).toBe(d)
    const split = splitLayout()
    expect(isOpen(closePanel(split, MAIN_PANEL), MAIN_PANEL)).toBe(true)
  })

  it('opens newly met allies as background tabs next to the main chat', () => {
    const d = reconcileDock(defaultDock(), [ally('art'), ally('old', { retiredAt: NOW })], NOW)
    expect(groupOf(d.root, MAIN_PANEL)!.tabs).toEqual([MAIN_PANEL, 'art'])
    expect(groupOf(d.root, MAIN_PANEL)!.active).toBe(MAIN_PANEL)
    expect(isOpen(d, 'old')).toBe(false)
  })

  it('keeps a closed ally closed (only hidden) across reconciles', () => {
    let d = reconcileDock(defaultDock(), [ally('art')], NOW)
    d = closePanel(d, 'art')
    expect(isOpen(d, 'art')).toBe(false)
    d = reconcileDock(d, [ally('art')], NOW)
    expect(isOpen(d, 'art')).toBe(false)
    d = openPanel(d, 'art')
    expect(isOpen(d, 'art')).toBe(true)
    expect(d.focused).toBe('art')
  })

  it('splits a group by docking a tab on an edge and collapses it when emptied', () => {
    const d = splitLayout()
    expect(d.root.type).toBe('split')
    expect(groups(d.root).map((g) => g.tabs)).toEqual([[MAIN_PANEL, 'art'], ['audio']])
    expect(visiblePanels(d.root)).toEqual([MAIN_PANEL, 'audio'])
    const back = closePanel(d, 'audio')
    expect(back.root.type).toBe('group')
    expect(openPanels(back.root)).toEqual([MAIN_PANEL, 'art'])
  })

  it('reorders tabs and moves tabs between groups', () => {
    let d = splitLayout()
    const main = groupOf(d.root, MAIN_PANEL)!
    d = movePanel(d, 'art', main.id, 'center', 0)
    expect(groupOf(d.root, MAIN_PANEL)!.tabs).toEqual(['art', MAIN_PANEL])
    d = movePanel(d, MAIN_PANEL, groupOf(d.root, 'audio')!.id, 'center')
    expect(groups(d.root).map((g) => g.tabs)).toEqual([['art'], ['audio', MAIN_PANEL]])
  })

  it('does not split a group by its only tab', () => {
    const d = splitLayout()
    expect(movePanel(d, 'audio', groupOf(d.root, 'audio')!.id, 'left')).toBe(d)
  })

  it('resizes splits with a floor', () => {
    const d = splitLayout()
    const r = resizeSplit(d, d.root.id, [0.99, 0.01])
    expect(r.root.type === 'split' && r.root.sizes[1]).toBeGreaterThan(0.07)
  })
})

describe('dock persistence', () => {
  it('restores a saved layout', () => {
    const d = splitLayout()
    const back = parseDock(serializeDock(d))
    expect(back).toEqual(d)
    expect(reconcileDock(back, [ally('art'), ally('audio')], NOW).root).toEqual(d.root)
  })

  it('drops a retired ally from a saved layout gracefully', () => {
    const saved = serializeDock(splitLayout())
    const d = reconcileDock(parseDock(saved), [ally('art'), ally('audio', { retiredAt: NOW })], NOW)
    expect(openPanels(d.root)).toEqual([MAIN_PANEL, 'art'])
    expect(d.root.type).toBe('group')
    expect(d.seen).toEqual(['art'])
  })

  it('drops a missing ally and restores the main chat if a layout lost it', () => {
    const raw = JSON.stringify({ v: 1, root: { type: 'group', id: 'g1', tabs: ['ghost'], active: 'ghost' }, focused: 'ghost', seen: ['ghost'], lastSeen: {} })
    const d = reconcileDock(parseDock(raw), [], NOW)
    expect(openPanels(d.root)).toEqual([MAIN_PANEL])
    expect(d.focused).toBe(MAIN_PANEL)
  })

  it('falls back to the default layout on garbage', () => {
    for (const raw of [null, '', '{', '{"v":2}', '{"v":1,"root":{"type":"split","id":"s","dir":"row","children":[],"sizes":[1]}}']) {
      expect(openPanels(parseDock(raw).root)).toEqual([MAIN_PANEL])
    }
  })
})

describe('unread on closed allies', () => {
  it('flags non-player messages newer than what was seen', () => {
    let d = reconcileDock(defaultDock(), [ally('art')], NOW)
    d = closePanel(d, 'art')
    expect(hasUnread(d, 'art', [{ role: 'genio', ts: '2026-10-13T09:00:00.000Z' }])).toBe(false)
    const fresh = [{ role: 'genio', ts: '2026-10-13T11:00:00.000Z' }]
    expect(hasUnread(d, 'art', fresh)).toBe(true)
    d = markSeen(d, 'art', fresh[0].ts)
    expect(hasUnread(d, 'art', fresh)).toBe(false)
  })
})

describe('spawn ally per world', () => {
  it('names the ally after the world within the ally name rules', () => {
    expect(allyNameForWorld('Space Goblins')).toBe('space-goblins')
    expect(allyNameForWorld('main')).toBe('main-world')
    expect(allyNameForWorld('x')).toBe('world-x')
    expect(allyNameForWorld('My_Game.v2')).toBe('my-game-v2')
  })

  it('creates the ally once, then only reopens it', async () => {
    let allies: Ally[] = []
    const create = vi.fn(async (req: AllyCreateRequest) => {
      const a = ally(req.name, { scope: req.scope, projects: req.projects, model: req.model })
      allies = [...allies, a]
      return a
    })
    const open = vi.fn()
    const deps = { allies: () => allies, create, open }
    const [a, b] = await Promise.all([spawnWorldAlly('Space Goblins', deps), spawnWorldAlly('Space Goblins', deps)])
    const c = await spawnWorldAlly('Space Goblins', deps)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toEqual({ name: 'space-goblins', scope: 'All work in Space Goblins', charter: '', projects: ['Space Goblins'], model: undefined })
    expect(a.name).toBe('space-goblins')
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('reuses an existing ally scoped to just that world, and ignores retired ones', async () => {
    const create = vi.fn(async (req: AllyCreateRequest) => ally(req.name))
    const open = vi.fn()
    const mine = ally('goblin-crew', { projects: ['goblins'] })
    expect(allyForWorld([mine], 'goblins')).toBe(mine)
    await spawnWorldAlly('goblins', { allies: () => [mine], create, open })
    expect(create).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith(mine)
    await spawnWorldAlly('goblins', { allies: () => [ally('goblins', { retiredAt: NOW })], create, open })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
