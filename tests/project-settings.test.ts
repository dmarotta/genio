// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '../src/shared/types'
import { worldList, worldPath, modifiedLabel } from '../src/renderer/src/lib/worlds'
const fixture = vi.hoisted(() => ({ projects: [] as Project[], tasks: [], allies: [], enabled: false, go: vi.fn(), deploy: vi.fn(), projectOpen: vi.fn(), update: vi.fn(), rescan: vi.fn(), push: vi.fn(), sync: vi.fn(), openPath: vi.fn(), remove: vi.fn(async () => ({ ok: false, message: 'Active units prevent removal' })) }))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({ settings: {}, snap: { projects: fixture.projects, tasks: fixture.tasks, allies: fixture.allies, inbox: [] } }),
  PROJECT_WINDOW: 'Zebra', saveSettings: vi.fn(), api: () => ({ homePath: async () => '', projectRemove: fixture.remove, projectOpen: fixture.projectOpen, falWorld: async () => ({ config: {} }), uthanaWorld: async () => ({ config: {} }), projectMetadata: async () => ({}), projectPushStatus: async () => ({ ahead: 2, behind: 0 }), projectUpdate: fixture.update, projectRescan: fixture.rescan, projectPush: fixture.push, projectSync: fixture.sync, openPath: fixture.openPath, playPool: async () => ({ cap: 1, slots: [], queue: [] }), playPoolDisk: async () => ({}) }),
  hasView: () => fixture.enabled, go: fixture.go, openDeploy: fixture.deploy,
  op: async (_: string, fn: () => unknown) => fn(), setState: vi.fn(), toast: vi.fn(), errText: String
}))
import { ThisProjectSettings, type ProjectPageId } from '../src/renderer/src/views/ProjectSettings'
import { Systems, requestSystemsSection } from '../src/renderer/src/views/Systems'
const project = (name: string, engine: Project['engine'] = 'unity'): Project => ({ name, path: `C:/games/${name}`, engine, commands: { run: 'play' }, defaultBranch: 'main', mode: 'local-only', remote: 'origin', forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '' })
let root: Root | undefined
let host: HTMLDivElement
async function mount(page: ProjectPageId = 'project') {
  fixture.projects = [project('Zebra')]
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(React.createElement(ThisProjectSettings, { page })))
}
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim())
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks() })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
describe('Project settings and registry helpers', () => {
  it('opens This project inside Settings and targets only the current project', async () => {
    await mount()
    fixture.projects.push(project('Other'))
    await act(async () => root!.render(React.createElement(Systems)))
    await act(async () => requestSystemsSection('project-delivery'))
    expect(host.querySelector('h1')?.textContent).toBe('Settings')
    expect(host.querySelector('.sys-link.on')?.textContent).toBe('Delivery')
    expect(host.textContent).not.toContain('C:/games/Other')
    expect(host.textContent).toContain('Settings saved with Zebra.')
    const select = (label: string) => [...host.querySelectorAll('label.field')].find(field => field.querySelector('.label')?.textContent === label)!.querySelector('select')!
    await act(async () => { select('Delivery').value = 'direct-PR'; select('Delivery').dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fixture.update).toHaveBeenLastCalledWith('Zebra', { mode: 'direct-PR' })
    await act(async () => { select('Delivery').value = 'auto'; select('Delivery').dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fixture.update).toHaveBeenLastCalledWith('Zebra', { modeSource: 'auto' })
    await act(async () => requestSystemsSection('project'))
    expect(host.querySelector('.sys-link.on')?.textContent).toBe('General')
    await act(async () => { select('Usage mode for this project').value = 'save'; select('Usage mode for this project').dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fixture.update).toHaveBeenLastCalledWith('Zebra', { usageMode: 'save', costDial: undefined })
    // Infer only: no engine picker, no root input.
    expect([...host.querySelectorAll('label.field .label')].map(label => label.textContent)).not.toContain('Engine')
    expect(host.textContent).not.toContain('Engine root')
    await click('Rescan')
    expect(fixture.rescan).toHaveBeenCalledWith('Zebra')
    expect(fixture.update).not.toHaveBeenCalledWith('Zebra', expect.objectContaining({ engine: expect.anything() }))
  })
  it.each([
    ['detected', { engine: 'unity', engineRoot: 'FoundersOfAvalonUnity', detected: { candidates: [{ engine: 'unity', root: 'FoundersOfAvalonUnity', strength: 'strong' }], ambiguous: false, declared: false, version: '6000.0.23f1', scannedAt: '' } },
      ['Detected: Unity 6000.0.23f1 at ./FoundersOfAvalonUnity'], ['Also found', 'set in .genio/project.json', 'Play is not available']],
    ['ambiguous', { engine: 'unity', engineRoot: 'client', detected: { candidates: [{ engine: 'unity', root: 'client', strength: 'strong' }, { engine: 'unity', root: 'editor', strength: 'strong' }], ambiguous: true, declared: false, scannedAt: '' } },
      ['Detected: Unity at ./client', 'Also found: Unity at ./editor. Ask Genio to pin one.'], []],
    ['declared', { engine: 'unity', engineRoot: 'tools/LevelEditor', detected: { candidates: [{ engine: 'unity', root: 'tools/LevelEditor', strength: 'strong' }, { engine: 'unity', root: 'client', strength: 'strong' }], ambiguous: false, declared: true, scannedAt: '' } },
      ['Detected: Unity at ./tools/LevelEditor (set in .genio/project.json)', 'Also found: Unity at ./client.'], ['Ask Genio to pin one']],
    ['no game', { engine: 'other', engineRoot: '', detected: { candidates: [], ambiguous: false, declared: false, scannedAt: '' } },
      ['No game engine detected; Genio treats this as a code project'], ['Detected:', 'Play is not available']],
    ['unsupported engine', { engine: 'bevy', engineRoot: '', detected: { candidates: [{ engine: 'bevy', root: '', strength: 'medium' }], ambiguous: false, declared: false, version: '0.14', scannedAt: '' } },
      ['Detected: Bevy 0.14 at the repository root'], ['Play is not available']],
    ['ignored declaration', { engine: 'unity', engineRoot: 'client', detected: { candidates: [{ engine: 'unity', root: 'client', strength: 'strong' }], ambiguous: false, declared: false, warning: 'Ignored .genio/project.json: no game engine marker in "docs".', scannedAt: '' } },
      ['Ignored .genio/project.json: no game engine marker in "docs".'], []]
  ] as [string, Partial<Project>, string[], string[]][])('shows the %s engine read-only', async (_, patch, shown, hidden) => {
    fixture.projects = [{ ...project('Zebra'), ...patch }]
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(React.createElement(ThisProjectSettings)))
    const engine = host.querySelector('[aria-label="Engine"]')!.textContent!
    for (const text of shown) expect(engine).toContain(text)
    for (const text of hidden) expect(engine).not.toContain(text)
    expect(host.querySelectorAll('[aria-label="Engine"] select, [aria-label="Engine"] input')).toHaveLength(0)
  })
  it('shows a retired manual engine once as a proposal the player can dismiss', async () => {
    fixture.projects = [{ ...project('Zebra'), engine: 'unity', engineRoot: 'client', detected: { candidates: [{ engine: 'unity', root: 'client', strength: 'strong' }, { engine: 'unity', root: 'tools/LevelEditor', strength: 'strong' }], ambiguous: false, declared: false, scannedAt: '' },
      engineProposal: { engine: 'unity', engineRoot: 'tools/LevelEditor', declarable: true, notedAt: '' } }]
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(React.createElement(ThisProjectSettings)))
    expect(host.textContent).toContain('You had set Unity at ./tools/LevelEditor by hand; Genio now infers the engine and uses Unity at ./client. To keep yours, ask Genio to pin it in .genio/project.json { "engineRoot": "tools/LevelEditor" }')
    await click('Dismiss')
    expect(fixture.update).toHaveBeenLastCalledWith('Zebra', { engineProposal: undefined })
  })
  it.each([['project-assets'], ['project']])('deep-links %s with the old generation-settings anchor to Asset generation, scrolled into view and focused', async (id) => {
    const scrolled = vi.fn()
    Object.assign(Element.prototype, { scrollIntoView: scrolled })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    try {
      await mount()
      // As from Inventory: the request is made before Settings mounts.
      requestSystemsSection(id, 'generation-settings')
      await act(async () => root!.render(React.createElement(Systems)))
      await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
      const section = host.querySelector('#generation-settings')!
      expect(host.querySelector('.sys-link.on')?.textContent).toBe('Asset generation')
      expect(section.getAttribute('aria-label')).toBe('Generation settings')
      expect(scrolled).toHaveBeenCalled()
      expect(scrolled.mock.contexts.at(-1)).toBe(section)
      expect(document.activeElement).toBe(section)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('keeps removal typed and delegates to the existing guarded service without deleting owned folders', async () => {
    await mount()
    await click('Remove')
    const confirm = [...document.querySelectorAll('.modal button')].find(button => button.textContent?.trim() === 'Remove project') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(document.querySelector('.modal')!.textContent).toContain('Genio refuses while units are working')
    expect(document.querySelector('.modal')!.textContent).toContain('Genio never deletes it')
    const input = document.querySelector('.modal input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Zebra')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => confirm.click())
    expect(fixture.remove).toHaveBeenCalledWith('Zebra', false)
  })
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
  it('keeps launcher actions out of every project page: Open, Inventory, Deploy and Playtest live elsewhere', async () => {
    for (const page of ['project', 'project-delivery', 'project-commands', 'project-assets', 'project-unity'] as ProjectPageId[]) {
      await mount(page)
      for (const action of ['Open', 'Inventory', 'Deploy', 'Playtest']) expect(buttons(), `${page} ${action}`).not.toContain(action)
      await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    }
  })
  it('splits This project into General and Delivery and keeps their handlers', async () => {
    await mount()
    for (const label of ['Usage mode for this project', 'Engine', 'Rescan', 'Allow OpenRouter models for low-stakes work', 'Description', 'Max units at once', 'Danger zone']) expect(host.textContent).toContain(label)
    for (const label of ['Delivery', 'Auto-loot', 'Branch name prefix', 'Generation', 'Capacity', 'cheap third-party']) expect(host.textContent).not.toContain(label)
    expect(host.querySelector('.world-details')).not.toBeNull()
    await click('Reveal in Explorer'); expect(fixture.openPath).toHaveBeenCalledWith('C:/games/Zebra')
    await click('Remove'); expect(document.body.textContent).toContain('Remove Zebra?')
    await act(async () => root!.unmount()); document.body.innerHTML = ''

    await mount('project-delivery')
    for (const label of ['Delivery', 'Merge finished work automatically', 'Auto-loot', 'Branch name prefix', '2 commits not pushed']) expect(host.textContent).toContain(label)
    expect(host.textContent).not.toContain('Usage mode')
    await click('Sync'); expect(fixture.sync).toHaveBeenCalledWith('Zebra')
    await click('Push'); expect(fixture.push).toHaveBeenCalledWith('Zebra')
    await act(async () => host.querySelector<HTMLInputElement>('.toggle input')!.click())
    expect(document.body.textContent).toContain('Merge finished work automatically in Zebra?')
  })
  it('shows Commands open, without the Playtest-only run row, and keeps a stored run command', async () => {
    await mount('project-commands')
    const labels = [...host.querySelectorAll('.world-cmds .field .label')].map((l) => l.textContent)
    expect(labels).toEqual(['setup', 'build', 'test', 'lint'])
    expect(host.textContent).not.toMatch(/\brun\b|playtest/i)
    const build = host.querySelectorAll<HTMLInputElement>('.world-cmds input')[1]
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(build, 'make')
      build.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { build.dispatchEvent(new FocusEvent('blur')); build.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(fixture.update).toHaveBeenLastCalledWith('Zebra', { commands: { run: 'play', build: 'make' } })
  })
})

