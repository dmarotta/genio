// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '../src/shared/types'
import { worldList, worldPath, modifiedLabel } from '../src/renderer/src/lib/worlds'
const fixture = vi.hoisted(() => ({ projects: [] as Project[], tasks: [], allies: [], enabled: false, go: vi.fn(), deploy: vi.fn(), ally: vi.fn(), update: vi.fn(), push: vi.fn(), sync: vi.fn(), openPath: vi.fn(), playtest: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({ snap: { projects: fixture.projects, tasks: fixture.tasks, allies: fixture.allies } }),
  api: () => ({ falWorld: async () => ({ config: {} }), uthanaWorld: async () => ({ config: {} }), projectMetadata: async () => ({}), projectPushStatus: async () => ({ ahead: 2, behind: 0 }), projectUpdate: fixture.update, projectPush: fixture.push, projectSync: fixture.sync, openPath: fixture.openPath, playtest: fixture.playtest }),
  hasView: () => fixture.enabled, go: fixture.go, openDeploy: fixture.deploy, spawnWorldAllyChat: fixture.ally,
  op: async (_: string, fn: () => unknown) => fn(), setState: vi.fn(), toast: vi.fn(), errText: String
}))
import { Worlds } from '../src/renderer/src/views/Worlds'
const project = (name: string, engine: Project['engine'] = 'unity'): Project => ({ name, path: `C:/games/${name}`, engine, commands: { run: 'play' }, defaultBranch: 'main', mode: 'local-only', remote: 'origin', forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '' })
let root: Root | undefined
let host: HTMLDivElement
async function mount(enabled = false) {
  fixture.projects = [project('Zebra')]; fixture.enabled = enabled
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(React.createElement(Worlds)))
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks() })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
describe('Worlds list', () => {
  it('searches names, engine labels and nested roots without mutating the registry', () => {
    const worlds = [project('Zebra'), { ...project('Alpha', 'godot'), engineRoot: 'nested/game' }]
    expect(worldList(worlds, 'GODOT', 'name').map((p) => p.name)).toEqual(['Alpha'])
    expect(worldList(worlds, 'nested/game', 'name')).toHaveLength(1)
    expect(worldList(worlds, ' missing ', 'name')).toEqual([])
    expect(worldPath(worlds[1])).toBe('C:/games/Alpha/nested/game')
    expect(worldList(worlds, '', 'name').map((p) => p.name)).toEqual(['Alpha', 'Zebra'])
    expect(worlds[0].name).toBe('Zebra')
  })
  it('sorts engines and newest commits, placing unknown timestamps last', () => {
    const worlds = [project('Zebra'), project('Alpha', 'godot'), project('Beta')]
    expect(worldList(worlds, '', 'engine').map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Zebra'])
    expect(worldList(worlds, '', 'modified', { Zebra: { lastCommitAt: '2026-10-13' }, Alpha: { lastCommitAt: '2026-10-12' } }).map((p) => p.name)).toEqual(['Zebra', 'Alpha', 'Beta'])
    expect(modifiedLabel('2026-10-12', Date.parse('2026-10-13'))).toBe('1 day ago')
    expect(modifiedLabel()).toBe('No commit yet')
  })
  it('keeps Inventory disabled until registered, then passes the world to navigation', async () => {
    await mount()
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Inventory'))!
    expect(button.disabled).toBe(true)
    expect(button.parentElement?.title).toBe('Inventory coming soon')
    fixture.enabled = true
    await act(async () => root!.render(React.createElement(Worlds)))
    await click('Inventory')
    expect(fixture.go).toHaveBeenCalledWith('inventory', { world: 'Zebra' })
  })
  it('opens settings from both the row and menu and preserves action handlers', async () => {
    await mount()
    await click('Settings')
    for (const label of ['Delivery', 'Auto-loot', 'Capacity', 'Branch prefix', 'Cost dial', 'Allow cheap third-party models', 'Description', 'Generation']) expect(host.textContent).toContain(label)
    const commands = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Commands'))!
    await act(async () => commands.click())
    expect(host.querySelectorAll('.world-cmds input')).toHaveLength(5)
    await click('Close')
    expect(host.querySelector('.world-details')).toBeNull()
    await act(async () => (host.querySelector('.world-identity') as HTMLButtonElement).click())
    expect(host.querySelector('.world-details')).not.toBeNull()
    await click('Deploy'); expect(fixture.deploy).toHaveBeenCalledWith({ project: 'Zebra' })
    await click('Ally'); expect(fixture.ally).toHaveBeenCalledWith('Zebra')
    await click('Sync'); expect(fixture.sync).toHaveBeenCalledWith('Zebra')
    await click('Push'); expect(fixture.push).toHaveBeenCalledWith('Zebra')
    await click('Reveal in Explorer'); expect(fixture.openPath).toHaveBeenCalledWith('C:/games/Zebra')
    await click('Playtest'); expect(fixture.playtest).toHaveBeenCalledWith({ project: 'Zebra' })
    await click('Remove'); expect(document.body.textContent).toContain('Remove Zebra?')
  })
})
