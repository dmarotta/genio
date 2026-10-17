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
    mcpServers: async () => [],
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
import { SETTINGS_INDEX, searchSettings, settingAnchor } from '../src/shared/settings-index'
import type { Settings } from '../src/shared/types'
import { Systems, readAdvanced, requestSystemsSection, startPage, visiblePages } from '../src/renderer/src/views/Systems'
import { isSettingsShortcut, listKey, openSettings, readLastPage } from '../src/renderer/src/lib/settings-nav'
import { go, saveSettings } from '../src/renderer/src/store'

// Main-process code is outside the web typecheck, so its defaults load untyped by path. They never
// need the Claude SDK that the usage probe imports lazily.
vi.mock('../src/main/claude-usage-probe', () => ({}))
const { defaultSettings } = await vi.importActual<{ defaultSettings: () => Settings }>('../src/main/settings')

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
    expect(settingsPath('dispatch')).toBe('Settings → Advanced → Model routing (Dispatch)')
    expect(settingsPath('project-delivery')).toBe('Settings → This project → Delivery')
    expect(settingsPath('patch')).toBe('Settings → System → Updates (Patch)')
    expect(settingsPath('project-delivery', 'Merge finished work automatically')).toBe('Settings → This project → Delivery → Merge finished work automatically')
  })

  it('gives every page an intro, and every renamed field its old label as a search synonym', () => {
    for (const p of SETTINGS_PAGES.filter((p) => p.id !== 'project')) expect(p.intro, p.id).toBeTruthy()
    const renamed: Record<string, string> = {
      'Auto-loot': 'Merge finished work automatically', Capacity: 'Max units at once', 'Default harness': 'Default agent tool',
      'Brief additions': 'Instructions for every unit', 'Clean HUD': 'Clean chat', 'Branch prefix': 'Branch name prefix',
      'Allow cheap third-party models': 'Allow OpenRouter models for low-stakes work', 'Claude permission posture': 'Claude unit permissions',
      'Auto-dispatch queued quests': 'Start queued quests automatically', 'Strip AI commit trailers': 'Remove AI co-author lines from commits',
      'Co-authored by Genio': 'Credit Genio as co-author', 'Genio trailer identity': 'Genio co-author name', 'Visual FX': 'Scanlines and grid',
      Voice: 'Read replies aloud', 'Replay onboarding': 'Replay the intro', 'Sound effects': 'Sounds', 'Webhook URL': 'Send away alerts to',
      'Webhook kind': 'Send away alerts to', Alarm: "If you don't respond", 'Alarm after (min)': 'Raise the alarm after',
      'AFK digest window (s)': 'Bundle away alerts for', 'Paid spend on cheap models': 'Allow paid OpenRouter spend',
      'Memory budget (tokens)': 'Memory size limit', 'Mail HTTP intake': 'Accept notes from scripts and your phone', 'Replay log': 'Keep an activity log file',
      Base: 'Data folder', 'Reviewer model': 'Review model', 'Poll every (s)': 'Check units every', 'Lagging after (s)': 'Call a unit lagging after',
      'Lag escalations': 'Lag warnings before a deep check', 'Paused resurface (h)': 'Bring paused units back after', 'PR poll (min)': 'Check pull requests every',
      'Ping re-ring (s)': 'Re-send a ping after', 'Ping rings before escalating': 'Re-sends before escalating', 'Maximum slots': 'Unity slots for units',
      'Quit after idle': 'Your Play editor', 'Maximum player editors': 'Your Play editor', 'Check for patch': 'Updates'
    }
    for (const [old, now] of Object.entries(renamed)) {
      const row = SETTINGS_INDEX.find((e) => e.label === now)
      expect(row, now).toBeDefined()
      expect(row!.synonyms, `${now} answers to ${old}`).toContain(old)
      expect(searchSettings(old).map((h) => h.label), old).toContain(now)
    }
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
    expect(host.textContent).toContain('Settings saved with Zebra.')
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
    expect(host.querySelector('[aria-label="Close your Play editor after (minutes)"]')).toBeNull()
    await open('play')
    expect(host.querySelector('[aria-label="Close your Play editor after (minutes)"]')).not.toBeNull()
    await open('system')
    for (const part of ['Installed tools(Loadout)', 'Windows integration', 'Updates(Patch)', 'Genio data folder']) expect([...host.querySelectorAll('.sys-subtitle')].map((h) => h.textContent)).toContain(part)
    expect(host.textContent).toContain('C:/genio-base')
    expect(f.calls).not.toContain('checkUpdate')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Check for updates'))!.click())
    expect(f.calls).toContain('checkUpdate')
  })
})

/** Every place outside Settings that links into it, read from the source so a new link cannot skip this test. */
const SOURCES = import.meta.glob<string>('../src/renderer/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })
function deepLinks(): { file: string; page: string; anchor?: string }[] {
  const consts: Record<string, string> = { GENERATION_ANCHOR: 'generation-settings', PLAYER_INSTANCE_ANCHOR: 'player-instance', UNITY_SLOTS_ANCHOR: 'unity-slots' }
  const arg = (a?: string): string | undefined => a === undefined ? undefined : /^'.*'$/.test(a) ? a.slice(1, -1) : consts[a]
  const out: { file: string; page: string; anchor?: string }[] = []
  for (const [file, text] of Object.entries(SOURCES)) {
    for (const m of text.matchAll(/(?:openSettings|requestSystemsSection)\(('[^']*'|\w+)(?:, ('[^']*'|\w+))?\)/g)) {
      const page = arg(m[1])
      // Variables (the palette's index entries, a page id passed through) are covered by the index tests.
      if (page !== undefined && (m[2] === undefined || arg(m[2]) !== undefined)) out.push({ file: file.split('/').pop()!, page, anchor: arg(m[2]) })
    }
  }
  return out
}

describe('search index', () => {
  it('finds every old page name and game term on its new page, saying which name matched', () => {
    const old: Record<string, string> = {
      Gauntlet: 'gauntlet', Overwatch: 'overwatch', Harnesses: 'harnesses', Dispatch: 'dispatch', Loadout: 'system', Patch: 'system', Explorer: 'system', Triggers: 'inbox',
      'Mail & replay': 'inbox', 'Comms & FX': 'general', Profile: 'general', Alerts: 'notifications', 'Auto-loot': 'project-delivery', 'Clean HUD': 'general', Housekeeping: 'maintenance',
      'Your Play instance': 'play', Genio: 'units', Generation: 'project-assets'
    }
    for (const [name, page] of Object.entries(old)) expect(searchSettings(name)[0]?.page, name).toBe(page)
    expect(searchSettings('gauntlet')[0]).toMatchObject({ label: 'Checks & review', via: 'Gauntlet', scope: 'Advanced' })
    expect(searchSettings('loadout').map((h) => h.label)).toEqual(expect.arrayContaining(['System', 'Installed tools']))
    expect(searchSettings('auto-loot')[1]).toMatchObject({ label: 'Merge finished work automatically', anchor: settingAnchor('Merge finished work automatically'), scope: 'This project' })
  })

  it('searches rows across both scopes with a scope chip, and only the pages a window offers', () => {
    expect(searchSettings('webhook url')[0]).toMatchObject({ page: 'notifications', anchor: 'setting-send-away-alerts-to', path: 'Notifications › Send away alerts to', scope: 'All projects', via: 'Webhook URL' })
    const usage = searchSettings('usage mode')
    expect(usage.slice(0, 2).map((h) => [h.page, h.scope])).toEqual([['project', 'This project'], ['usage', 'All projects']])
    expect(searchSettings('reviewer')[0].scope).toBe('Advanced')
    const hub = (id: string) => !id.startsWith('project')
    expect(searchSettings('delivery', hub)).toEqual([])
    expect(searchSettings('branch', hub)).toEqual([])
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('no such setting anywhere')).toEqual([])
  })

  it('keeps every index anchor rendering on its page, so the index cannot drift from the screens', async () => {
    await mount()
    const anchors = SETTINGS_INDEX.filter((e) => e.anchor)
    expect(anchors.length).toBeGreaterThan(60)
    for (const e of anchors) {
      await open(e.page, e.anchor)
      expect(active()?.replace(/\d+$/, ''), e.label).toBe(settingsPage(e.page).label)
      expect(host.querySelector(`#${e.anchor}`), `${e.page} › ${e.label} (#${e.anchor})`).not.toBeNull()
    }
    // Each page is in the index once, under its own name.
    expect(SETTINGS_PAGES.every((p) => SETTINGS_INDEX.filter((e) => !e.anchor && e.page === p.id).length === 1)).toBe(true)
  })

  it('shows a help text under every field on every page', async () => {
    f.settings = { ...defaultSettings(), eventSources: [{ id: 't', name: 'Nightly', command: 'git log -1', intervalSec: 3600, trigger: 'match', enabled: true }],
      dispatchRules: [{ id: 'r', match: 'shader', kind: 'any', candidates: [{ harness: 'claude', spendPriority: 0 }] }] }
    await mount()
    for (const page of SETTINGS_PAGES) {
      await open(page.id)
      const fields = [...host.querySelectorAll('.sys-body .sys-row, .sys-body .field')]
      expect(fields.length, page.id).toBeGreaterThan(page.id === 'accounts' ? -1 : 0)
      for (const el of fields) {
        const label = el.querySelector('.sys-row-title, .label')?.textContent
        expect(el.querySelector('.sys-row-hint, .field-hint'), `${page.label} › ${label}`).not.toBeNull()
      }
    }
  })

  it('shows the alarm as a choice plus a command box, saving the same stored string', async () => {
    f.settings = { ...defaultSettings(), alarm: 'command:notify.cmd' }
    await mount()
    await open('notifications')
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Alarm"]')!
    expect(select.value).toBe('command')
    expect(host.querySelector<HTMLInputElement>('#setting-if-you-don-t-respond input')!.value).toBe('notify.cmd')
    vi.mocked(saveSettings).mockClear()
    await act(async () => { select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(saveSettings).toHaveBeenLastCalledWith({ alarm: 'off' })
    expect(host.querySelector('#setting-if-you-don-t-respond input')).toBeNull()
    await act(async () => { select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(saveSettings).toHaveBeenLastCalledWith({ alarm: 'auto' })
  })
})

describe('deep links', () => {
  it('opens every link into Settings on an existing page, with its anchor shown and focused', async () => {
    const links = deepLinks()
    const files = new Set(links.map((l) => l.file))
    for (const f of ['PlanMeter.tsx', 'Inventory.tsx', 'Play.tsx', 'UnitySlots.tsx', 'ProjectNotice.tsx', 'Comms.tsx', 'CommandPalette.tsx', 'Systems.tsx']) expect(files, f).toContain(f)
    await mount()
    for (const link of links) {
      vi.mocked(go).mockClear()
      await act(async () => openSettings(link.page, link.anchor))
      await settle()
      if (link.file !== 'Systems.tsx') expect(go, `${link.file} → ${link.page}`).toHaveBeenCalledWith('systems')
      const page = resolveSettingsPage(link.page, link.anchor).page
      expect(active()?.replace(/\d+$/, ''), `${link.file} → ${link.page}`).toBe(settingsPage(page).label)
      if (link.anchor) {
        const el = host.querySelector(`#${link.anchor}`)
        expect(el, `${link.file} → #${link.anchor}`).not.toBeNull()
        expect(document.activeElement, `${link.file} → #${link.anchor} focused`).toBe(el)
      }
    }
    expect(links).toEqual(expect.arrayContaining([
      { file: 'PlanMeter.tsx', page: 'usage' },
      { file: 'Comms.tsx', page: 'accounts' },
      { file: 'ProjectNotice.tsx', page: 'project', anchor: 'settings-engine' },
      { file: 'Play.tsx', page: 'play', anchor: 'player-instance' },
      { file: 'Inventory.tsx', page: 'project-assets', anchor: 'generation-settings' }
    ]))
  })

  it('asks for the page before switching screens, so Settings mounts on it', async () => {
    openSettings('patch')
    expect(go).toHaveBeenLastCalledWith('systems')
    await mount()
    expect(active()).toBe('System')
    expect(host.querySelector('#settings-updates')).not.toBeNull()
  })
})

describe('keyboard and memory', () => {
  const search = () => host.querySelector<HTMLInputElement>('.sys-search input')!
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), text)
      search().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = (el: Element | Window, key: string, init: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  const links = () => [...host.querySelectorAll<HTMLButtonElement>('.sys-link')]

  it('moves through the page list with arrow keys, Home and End, keeping one tab stop', async () => {
    await mount()
    expect(links().filter((b) => b.tabIndex === 0).map((b) => b.textContent)).toEqual(['General'])
    links()[0].focus()
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Delivery')
    expect(links().filter((b) => b.tabIndex === 0).map((b) => b.textContent)).toEqual(['Delivery'])
    await press(document.activeElement!, 'End')
    expect(document.activeElement?.textContent).toBe('System')
    await press(document.activeElement!, 'Home')
    expect(document.activeElement?.textContent).toBe('General')
    await press(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(search())
    await press(search(), 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('General')
    expect(listKey('ArrowDown', 2, 3)).toBe(2)
    expect(listKey('ArrowUp', 0, 3)).toBe(0)
    expect(listKey('Tab', 0, 3)).toBeNull()
  })

  it('searches with Ctrl+F or /, picks a result with the arrows and Enter, and clears with Esc', async () => {
    await mount()
    await press(window, 'f', { ctrlKey: true })
    expect(document.activeElement).toBe(search())
    await type('gauntlet')
    expect(host.querySelectorAll('.sys-link')).toHaveLength(0)
    const first = host.querySelector('.sys-result')!
    expect(first.textContent).toContain('Checks & review')
    expect(first.textContent).toContain('Advanced')
    expect(first.textContent).toContain('“Gauntlet”')
    await press(search(), 'Enter')
    await settle()
    expect(active()).toBe('Checks & review')
    expect(search().value).toBe('')
    search().blur()
    await press(document.body, '/')
    expect(document.activeElement).toBe(search())
    await type('webhook')
    expect([...host.querySelectorAll('.sys-result')].map((r) => r.querySelector('.sys-result-label')?.textContent)).toEqual(['Notifications', 'Send away alerts to'])
    await press(search(), 'ArrowDown')
    expect(host.querySelector('.sys-result.on .sys-result-label')?.textContent).toBe('Send away alerts to')
    expect(search().getAttribute('aria-activedescendant')).toBe('sys-result-1')
    await press(search(), 'Enter')
    await settle()
    expect(active()).toBe('Notifications')
    expect(document.activeElement).toBe(host.querySelector('#setting-send-away-alerts-to'))
    await type('zzz')
    expect(host.textContent).toContain('No settings match “zzz”.')
    await press(search(), 'Escape')
    expect(search().value).toBe('')
    expect(links().length).toBeGreaterThan(0)
  })

  it('reopens on the last page viewed, but never on a page this window does not offer', async () => {
    await mount()
    await open('memory')
    expect(readLastPage()).toBe('memory')
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount()
    expect(active()).toBe('Memory')
    const zebra = project('Zebra', 'unity')
    expect(startPage({ projects: [], last: 'project-delivery' })).toBe('general')
    expect(startPage({ projects: [], requested: 'project-assets' })).toBe('general')
    expect(startPage({ project: zebra, projects: [zebra], last: 'gauntlet' })).toBe('gauntlet')
    expect(startPage({ project: project('Alpha', 'godot'), projects: [], last: 'project-unity' })).toBe('project')
    expect(isSettingsShortcut({ key: ',', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true)
    expect(isSettingsShortcut({ key: ',', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false)
  })
})
