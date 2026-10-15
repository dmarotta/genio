// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'

const f = vi.hoisted(() => {
  const calls: string[] = []
  const known: Record<string, (...args: unknown[]) => unknown> = {
    homePath: async () => 'C:/genio-base',
    accounts: async () => [],
    apiKeys: async () => [],
    accountUsage: async () => ({ tools: [] }),
    toolchain: async () => [],
    explorerStatus: async () => ({ available: true, installed: false, present: false }),
    checkUpdate: async () => ({ isGitCheckout: true, branch: 'main', behind: 0, ahead: 0, dirty: false, canFastForward: true, incoming: [] }),
    sessionCleanupProgress: async () => ({ running: false }),
    dispatchScores: async () => null,
    playerInstanceStatus: async () => ({ state: 'idle', project: 'Zebra' }),
    playerInstanceMachine: async () => ({ settings: { idleMinutes: 10, maxEditors: 2 }, playerEditors: 0, unitEditors: 0, batchEditors: 0, totalEditors: 0, workingSetBytes: 0, freeBytes: 0, totalBytes: 0 }),
    playPool: async () => ({ cap: 1, slots: [], queue: [] }),
    playPoolDisk: async () => ({}),
    falWorld: async () => ({ engine: 'unity', engineRoot: '', config: {} }),
    uthanaWorld: async () => ({ folder: 'Assets/Animations', config: {} }),
    projectMetadata: async () => ({}),
    projectPushStatus: async () => ({ ahead: 0, behind: 0 })
  }
  const api = new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => { calls.push(key); return (known[key] ?? (async () => ({})))(...args) } })
  return { calls, api, projects: [] as Project[], window: 'Zebra' as string, settings: undefined as unknown }
})
vi.mock('../src/renderer/src/store', () => ({
  get PROJECT_WINDOW() { return f.window },
  api: () => f.api,
  errText: String,
  toast: vi.fn(),
  saveSettings: vi.fn(),
  setState: vi.fn(),
  go: vi.fn(),
  op: async (_: string, fn: () => Promise<unknown>) => { try { return await fn() } catch { return undefined } },
  useStore: (selector: (s: unknown) => unknown) => selector({ settings: f.settings, terminals: {}, snap: { projects: f.projects, tasks: [], allies: [], inbox: [{ id: 'n1', ts: '', from: 'phone', text: 'hi' }] } })
}))
vi.mock('../src/renderer/src/components/Terminal', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/Memory', () => ({ Memory: () => React.createElement('h2', { className: 'sys-title' }, 'Memory') }))
vi.mock('../src/renderer/src/components/PlanMeter', () => ({ PlanMeter: () => React.createElement('div', { className: 'plan-meter-marker' }), useUsagePolicyState: () => ({ view: null, error: '' }) }))
vi.mock('../src/renderer/src/components/ModelPicker', () => ({ ModelPicker: () => null, useModelCatalogue: () => ({ routes: [] }) }))

import { SETTINGS_ALIASES, SETTINGS_PAGES, resolveSettingsPage, settingsPage, settingsPath } from '../src/shared/settings-pages'
import { defaultSettings } from '../src/main/settings'
import { Systems, readAdvanced, requestSystemsSection, visiblePages } from '../src/renderer/src/views/Systems'

const project = (name: string, engine: Project['engine']): Project => ({ name, path: `C:/games/${name}`, engine, commands: {}, defaultBranch: 'main', mode: 'local-only', forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '' })
/** Every section id Settings has used, with the page it opens now. */
const OLD_IDS: Record<string, string> = {
  project: 'project', profile: 'general', genio: 'units', units: 'units', overwatch: 'overwatch', gauntlet: 'gauntlet', comms: 'notifications', alerts: 'notifications',
  mail: 'inbox', memory: 'memory', harnesses: 'harnesses', dispatch: 'dispatch', triggers: 'inbox', toolchain: 'system', accounts: 'accounts', patch: 'system', usage: 'usage', explorer: 'system'
}

let root: Root
let host: HTMLDivElement
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => {
  f.calls.length = 0
  f.settings = defaultSettings()
  f.projects = [project('Zebra', 'unity')]
  f.window = 'Zebra'
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  Object.assign(Element.prototype, { scrollIntoView: vi.fn() })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
async function mount() { await act(async () => root.render(React.createElement(Systems))); await settle() }
async function open(id: string, anchor?: string) { await act(async () => requestSystemsSection(id, anchor)); await settle() }
const active = () => host.querySelector('.sys-link.on')?.textContent
const navLabels = () => [...host.querySelectorAll('.sys-link')].map((b) => b.textContent)
const groups = () => [...host.querySelectorAll('.sys-group')].map((g) => g.textContent)
const toggleAdvanced = () => act(async () => host.querySelector<HTMLInputElement>('.sys-advanced input')!.click())

describe('page registry', () => {
  it('resolves every old section id, and every alias anchor names a page that exists', () => {
    for (const [old, page] of Object.entries(OLD_IDS)) expect(resolveSettingsPage(old).page, old).toBe(page)
    for (const alias of Object.values(SETTINGS_ALIASES)) expect(SETTINGS_PAGES.some((p) => p.id === alias.page)).toBe(true)
    expect(resolveSettingsPage('project', 'generation-settings')).toEqual({ page: 'project-assets', anchor: 'generation-settings' })
    expect(resolveSettingsPage('project', 'unity-slots')).toEqual({ page: 'project-unity', anchor: 'unity-slots' })
    expect(resolveSettingsPage('patch')).toEqual({ page: 'system', anchor: 'settings-updates' })
    expect(resolveSettingsPage('no-such-page').page).toBe('general')
  })

  it('uses plain names with the game term kept as a hint, and keeps old names findable', () => {
    expect(['gauntlet', 'overwatch', 'harnesses', 'dispatch'].map((id) => { const p = settingsPage(id as never); return `${p.label} (${p.term})` }))
      .toEqual(['Checks & review (Gauntlet)', 'Timing (Overwatch)', 'Agent tools (Harnesses)', 'Model routing (Dispatch)'])
    const findable = SETTINGS_PAGES.flatMap((p) => [p.label, ...(p.synonyms ?? [])])
    for (const old of ['Overwatch', 'Gauntlet', 'Triggers', 'Loadout', 'Patch', 'Harnesses', 'Mail & replay', 'Comms & FX', 'Auto-loot', 'Clean HUD', 'Housekeeping']) expect(findable, old).toContain(old)
  })

  it('names Settings paths in one place for the main process', () => {
    expect(settingsPath('accounts')).toBe('Settings → Accounts & keys')
    expect(settingsPath('usage')).toBe('Settings → Usage & limits')
    expect(settingsPath('dispatch')).toBe('Settings → Advanced → Model routing')
    expect(settingsPath('project-delivery')).toBe('Settings → This project → Delivery')
    expect(settingsPath('patch', 'Updates')).toBe('Settings → System → Updates')
  })

  it('shows project pages per engine and Unity & Play only while a Unity project is registered', () => {
    const ids = (opts: Parameters<typeof visiblePages>[0]) => visiblePages(opts).map((p) => p.id)
    const unity = project('Zebra', 'unity'), godot = project('Alpha', 'godot')
    expect(ids({ project: unity, projects: [unity], advanced: false })).toEqual(['project', 'project-delivery', 'project-commands', 'project-assets', 'project-unity', 'general', 'notifications', 'usage', 'accounts', 'memory', 'units', 'play', 'inbox', 'system'])
    expect(ids({ project: godot, projects: [godot], advanced: false })).not.toContain('project-unity')
    expect(ids({ project: godot, projects: [godot], advanced: false })).not.toContain('play')
    // A Unity project elsewhere still lists the global Play page, but not this project's slots.
    expect(ids({ project: godot, projects: [godot, unity], advanced: false })).toEqual(expect.arrayContaining(['play']))
    expect(ids({ project: godot, projects: [godot, unity], advanced: false })).not.toContain('project-unity')
    expect(ids({ projects: [], advanced: false }).some((id) => id.startsWith('project'))).toBe(false)
    expect(ids({ projects: [], advanced: true }).slice(-5)).toEqual(['dispatch', 'harnesses', 'gauntlet', 'overwatch', 'maintenance'])
    expect(ids({ projects: [], advanced: false, current: 'gauntlet' })).toContain('gauntlet')
  })
})

describe('Settings navigation', () => {
  it('shows two labelled scopes, and the expert pages only behind the advanced switch', async () => {
    await mount()
    expect(groups()).toEqual(['This project · Zebra', 'Genio · all projects'])
    expect(navLabels()).toEqual(['General', 'Delivery', 'Commands', 'Asset generation', 'Unity slots', 'General', 'Notifications', 'Usage & limits', 'Accounts & keys', 'Memory', 'Units', 'Unity & Play', 'Inbox & automation1', 'System'])
    expect(active()).toBe('General')
    expect(host.textContent).toContain('Saved with Zebra.')
    await toggleAdvanced()
    expect(groups()).toEqual(['This project · Zebra', 'Genio · all projects', 'Advanced'])
    expect(navLabels().slice(-5)).toEqual(['Model routing', 'Agent tools', 'Checks & review', 'Timing', 'Maintenance'])
    expect(host.querySelector('.sys-link[title="Gauntlet"]')?.textContent).toBe('Checks & review')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.sys-link')].find((b) => b.textContent === 'Checks & review')!.click())
    expect(host.querySelector('.sys-title')?.textContent).toBe('Checks & review(Gauntlet)')
  })

  it('hides Unity pages for a project without Unity and This project when no project is open', async () => {
    f.projects = [project('Zebra', 'godot')]
    await mount()
    expect(navLabels()).not.toContain('Unity slots')
    expect(navLabels()).not.toContain('Unity & Play')
    await act(async () => root.unmount())
    f.window = ''
    root = createRoot(host)
    await mount()
    expect(groups()).toEqual(['Genio · all projects'])
    expect(active()).toBe('General')
  })

  it('remembers the advanced switch per viewer and seeds it once from the old Usage › Advanced choice', async () => {
    localStorage.setItem('genio.usage.advanced', '1')
    expect(readAdvanced()).toBe(true)
    await mount()
    expect(groups()).toContain('Advanced')
    await toggleAdvanced()
    expect(localStorage.getItem('genio.settings.advanced')).toBe('0')
    expect(groups()).not.toContain('Advanced')
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount()
    // The new key wins over the legacy one from now on.
    expect(groups()).not.toContain('Advanced')
    await toggleAdvanced()
    expect(localStorage.getItem('genio.settings.advanced')).toBe('1')
    expect(readAdvanced()).toBe(true)
  })

  it('opens every old section id and anchor on its new page', async () => {
    await mount()
    for (const [old, page] of Object.entries(OLD_IDS)) {
      await open(old)
      expect(active()?.replace(/\d+$/, ''), old).toBe(settingsPage(page as never).label)
      const anchor = SETTINGS_ALIASES[old]?.anchor
      if (anchor) expect(host.querySelector(`#${anchor}`), `${old} → #${anchor}`).not.toBeNull()
    }
    for (const [id, anchor, label] of [['project', 'generation-settings', 'Asset generation'], ['project', 'unity-slots', 'Unity slots'], ['play', 'player-instance', 'Unity & Play']]) {
      await open(id, anchor)
      expect(active()).toBe(label)
      const el = host.querySelector(`#${anchor}`)
      expect(el, anchor).not.toBeNull()
      expect(document.activeElement).toBe(el)
    }
  })

  it('removes the display-only rows and keeps one plan meter, in Usage & limits', async () => {
    await mount()
    await open('units')
    expect(host.textContent).not.toContain('Automatic respawns')
    expect(host.textContent).toContain('Commit attribution')
    await open('genio')
    expect(host.textContent).not.toContain('Model and effort')
    await open('usage')
    expect(host.textContent).not.toContain('Bot model')
    expect(host.querySelectorAll('.plan-meter-marker')).toHaveLength(1)
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Advanced')).toBe(false)
    expect(host.querySelectorAll('.usage-projects select, .usage-projects input')).toHaveLength(0)
    await open('accounts')
    expect(host.querySelectorAll('.plan-meter-marker')).toHaveLength(0)
    expect(host.textContent).not.toContain('Housekeeping')
    expect(host.textContent).not.toContain("Hide Genio's past sessions")
    await open('overwatch')
    expect(host.textContent).not.toContain('Heartbeat')
    await open('maintenance')
    expect(host.textContent).toContain("Hide Genio's past sessions from the Codex and Claude apps")
  })

  it('moves the Play editor settings off the project page and checks for updates only on a click', async () => {
    await mount()
    await open('project-unity')
    expect(host.querySelector('[aria-label="Player idle minutes"]')).toBeNull()
    await open('play')
    expect(host.querySelector('[aria-label="Player idle minutes"]')).not.toBeNull()
    await open('system')
    for (const part of ['Installed tools(Loadout)', 'Windows integration', 'Updates(Patch)', 'Genio data folder']) expect([...host.querySelectorAll('.sys-subtitle')].map((h) => h.textContent)).toContain(part)
    expect(host.textContent).toContain('C:/genio-base')
    expect(f.calls).not.toContain('checkUpdate')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Check for patch'))!.click())
    expect(f.calls).toContain('checkUpdate')
  })
})
