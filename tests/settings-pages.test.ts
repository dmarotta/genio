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
    dispatchScores: async () => null,
    playerInstanceStatus: async () => ({ state: 'idle', project: 'Zebra' }),
    playerInstanceMachine: async () => ({ settings: { idleMinutes: 10, maxEditors: 2 }, playerEditors: 0, unitEditors: 0, batchEditors: 0, totalEditors: 0, workingSetBytes: 0, freeBytes: 0, totalBytes: 0 }),
    playPool: async () => ({ cap: 1, slots: [], queue: [] }),
    playPoolDisk: async () => ({}),
    falWorld: async () => ({ engine: 'unity', engineRoot: '', config: {} }),
    uthanaWorld: async () => ({ folder: 'Assets/Animations', config: {} }),
    projectMetadata: async () => ({}),
    projectPushStatus: async () => ({ ahead: 0, behind: 0 }),
    voiceOutputStatus: async () => ({ state: f.voiceState, declined: false, received: 0, total: 328_520_409 }),
    // Like main: progress events, then the end; a failure publishes its reason and rejects.
    voiceOutputInstall: async () => {
      f.emit({ type: 'voice-output-install', state: 'downloading', received: 164_260_204, total: 328_520_409 })
      await new Promise<void>((resolve) => { f.finishInstall = resolve })
      f.emit({ type: 'voice-output-install', state: 'missing', received: 0, total: 328_520_409, error: 'offline' })
      throw new Error('offline')
    }
  }
  const api = new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => { calls.push(key); return (known[key] ?? (async () => ({})))(...args) } })
  const listeners = new Set<(e: unknown) => void>()
  return {
    calls, api, projects: [] as Project[], window: 'Zebra' as string, settings: undefined as unknown, usage: null as import('../src/shared/usage-mode').UsagePolicyView | null, voiceState: 'missing' as string,
    listeners, emit: (e: unknown) => { for (const fn of listeners) fn(e) }, finishInstall: () => undefined as void
  }
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
vi.mock('../src/renderer/src/components/PlanMeter', () => ({ PlanMeter: () => React.createElement('div', { className: 'plan-meter-marker' }), useUsagePolicyState: () => ({ view: f.usage, error: '' }) }))
vi.mock('../src/renderer/src/components/ModelPicker', () => ({ ModelPicker: () => null, useModelCatalogue: () => ({ routes: [] }) }))

import { SETTINGS_ALIASES, SETTINGS_PAGES, resolveSettingsPage, settingsPage, settingsPath } from '../src/shared/settings-pages'
import { SETTINGS_INDEX, searchSettings, settingAnchor } from '../src/shared/settings-index'
import type { Settings } from '../src/shared/types'
import { Systems, requestSystemsSection, startPage, visiblePages } from '../src/renderer/src/views/Systems'
import { isSettingsShortcut, listKey, openSettings, readLastPage } from '../src/renderer/src/lib/settings-nav'
import { go, saveSettings } from '../src/renderer/src/store'
import { VOICE_SAMPLE } from '../src/renderer/src/lib/voice'

// Main-process code is outside the web typecheck, so its defaults load untyped by path. They never
// need the Claude SDK that the usage probe imports lazily.
vi.mock('../src/main/claude-usage-probe', () => ({}))
const { defaultSettings } = await vi.importActual<{ defaultSettings: () => Settings }>('../src/main/settings')

const project = (name: string, engine: Project['engine']): Project => ({ name, path: `C:/games/${name}`, engine, commands: {}, defaultBranch: 'main', mode: 'local-only', forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '' })
/** Every section id Settings has used, with the page it opens now. */
const OLD_IDS: Record<string, string> = {
  project: 'project', profile: 'general', genio: 'units', units: 'units', overwatch: 'units', gauntlet: 'project-delivery', comms: 'general', alerts: 'general',
  notifications: 'general', mail: 'inbox', memory: 'memory', harnesses: 'harnesses', dispatch: 'dispatch', triggers: 'inbox', toolchain: 'system', accounts: 'accounts',
  patch: 'system', usage: 'usage', explorer: 'system', 'project-commands': 'project'
}

let root: Root
let host: HTMLDivElement
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => {
  f.calls.length = 0
  f.settings = defaultSettings()
  f.usage = null
  f.projects = [project('Zebra', 'unity')]
  f.window = 'Zebra'
  f.voiceState = 'missing'
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

it('changes Units at once separately from Usage mode with one plain control', async () => {
  await mount()
  await open('usage')
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Units at once"]')!
  expect(select.value).toBe('8')
  expect(select.options.length).toBe(32)
  expect(host.querySelectorAll('#setting-units-at-once')).toHaveLength(1)
  expect(host.querySelector('.usage-summary')?.textContent).not.toContain('units')
  vi.mocked(saveSettings).mockClear()
  await act(async () => {
    select.value = '3'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(saveSettings).toHaveBeenLastCalledWith({ unitsAtOnce: 3 })
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.trim() === 'Max')!.click())
  expect(saveSettings).toHaveBeenLastCalledWith({ usageMode: 'max' })
  expect(select.value).toBe('8')
})

describe('page registry', () => {
  it('resolves every old section id, and every alias anchor names a page that exists', () => {
    for (const [old, page] of Object.entries(OLD_IDS)) expect(resolveSettingsPage(old).page, old).toBe(page)
    for (const alias of Object.values(SETTINGS_ALIASES)) expect(SETTINGS_PAGES.some((p) => p.id === alias.page)).toBe(true)
    expect(resolveSettingsPage('project', 'generation-settings')).toEqual({ page: 'project-assets', anchor: 'generation-settings' })
    expect(resolveSettingsPage('project', 'unity-slots')).toEqual({ page: 'project-unity', anchor: 'unity-slots' })
    expect(resolveSettingsPage('patch')).toEqual({ page: 'system', anchor: 'settings-updates' })
    expect(resolveSettingsPage('project-commands')).toEqual({ page: 'project', anchor: 'settings-commands' })
    expect(resolveSettingsPage('no-such-page').page).toBe('general')
  })

  it('uses plain names with the game term kept as a hint, and keeps old names findable', () => {
    expect(['harnesses', 'dispatch'].map((id) => { const p = settingsPage(id as never); return `${p.label} (${p.term})` }))
      .toEqual(['Agent tools (Harnesses)', 'Model routing (Dispatch)'])
    const findable = SETTINGS_PAGES.flatMap((p) => [p.label, ...(p.synonyms ?? [])])
    for (const old of ['Gauntlet', 'Triggers', 'Loadout', 'Patch', 'Harnesses', 'Mail & replay', 'Comms & FX', 'Auto-loot', 'Clean HUD', 'Notifications', 'Commands']) expect(findable, old).toContain(old)
  })

  it('names Settings paths in one place for the main process', () => {
    expect(settingsPath('accounts')).toBe('Settings → Accounts & keys')
    expect(settingsPath('usage')).toBe('Settings → Usage & limits')
    expect(settingsPath('dispatch')).toBe('Settings → Advanced → Model routing (Dispatch)')
    expect(settingsPath('project-delivery')).toBe('Settings → This project → Delivery')
    expect(settingsPath('patch')).toBe('Settings → System → Updates (Patch)')
    expect(settingsPath('notifications')).toBe('Settings → General')
    expect(settingsPath('project-commands')).toBe('Settings → This project → General → Commands')
    expect(settingsPath('project-delivery', 'Merge finished work automatically')).toBe('Settings → This project → Delivery → Merge finished work automatically')
  })

  it('gives no page an intro line, and every renamed field its old label as a search synonym', async () => {
    await mount()
    for (const page of SETTINGS_PAGES) {
      await open(page.id)
      expect(host.querySelector('.sys-intro, .sys-scope, .sys-more'), page.id).toBeNull()
    }
    const renamed: Record<string, string> = {
      'Auto-loot': 'Merge finished work automatically', Capacity: 'Max units at once', 'Default harness': 'Default agent tool',
      'Brief additions': 'Instructions for every unit', 'Clean HUD': 'Clean chat', 'Usage mode for this project': 'Usage mode',
      'Allow cheap third-party models': 'OpenRouter models', 'Allow OpenRouter models for low-stakes work': 'OpenRouter models', 'Claude permission posture': 'Claude unit permissions',
      'Auto-dispatch queued quests': 'Start queued quests automatically', 'Strip AI commit trailers': 'Remove AI co-author lines',
      'Co-authored by Genio': 'Credit Genio as co-author', 'Visual FX': 'Scanlines and grid',
      Voice: 'Read replies aloud', 'Download natural voice': 'Read replies aloud', 'Sound effects': 'Sounds', 'Webhook URL': 'Send away alerts to',
      'Webhook kind': 'Send away alerts to', Alarm: "If you don't respond", 'Paid spend on cheap models': 'Allow paid OpenRouter spend',
      'Mail HTTP intake': 'Accept notes from scripts and your phone', 'Maximum slots': 'Slots', 'Unity slots for units': 'Slots',
      'Quit after idle': 'Your Play editor', 'Maximum player editors': 'Your Play editor', 'Check for patch': 'Updates',
      'Build command': 'Commands'
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
    expect(ids({ project: unity, projects: [unity] })).toEqual(['project', 'project-delivery', 'project-assets', 'project-unity', 'general', 'usage', 'accounts', 'memory', 'units', 'play', 'inbox', 'system', 'dispatch', 'harnesses'])
    expect(ids({ project: godot, projects: [godot] })).not.toContain('project-unity')
    expect(ids({ project: godot, projects: [godot] })).not.toContain('play')
    // A Unity project elsewhere still lists the global Play page, but not this project's slots.
    expect(ids({ project: godot, projects: [godot, unity] })).toEqual(expect.arrayContaining(['play']))
    expect(ids({ project: godot, projects: [godot, unity] })).not.toContain('project-unity')
    expect(ids({ projects: [] }).some((id) => id.startsWith('project'))).toBe(false)
    expect(ids({ projects: [] }).slice(-2)).toEqual(['dispatch', 'harnesses'])
    expect(ids({ projects: [], current: 'play' })).toContain('play')
  })
})

describe('Settings navigation', () => {
  it('shows the scopes with plain labels, the Advanced pages listed, and no switch or scope line', async () => {
    await mount()
    expect(groups()).toEqual(['This project', 'All projects', 'Advanced'])
    expect(navLabels()).toEqual(['General', 'Delivery', 'Asset generation', 'Unity slots', 'General', 'Usage & limits', 'Accounts & keys', 'Memory', 'Units', 'Unity & Play', 'Inbox & automation', 'System', 'Model routing', 'Agent tools'])
    expect(active()).toBe('General')
    expect(host.textContent).not.toContain('Settings saved with Zebra.')
    expect(host.textContent).not.toContain('Show advanced settings')
    expect(host.querySelector('.sys-link[title]')).toBeNull()
    expect(host.querySelector('.view-head .label')).toBeNull()
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.sys-link')].find((b) => b.textContent === 'Model routing')!.click())
    expect(host.querySelector('.sys-title')?.textContent).toBe('Model routing')
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
    expect(groups()).toEqual(['All projects', 'Advanced'])
    expect(active()).toBe('General')
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
    expect(host.textContent).not.toContain('Commit attribution')
    expect(host.textContent).not.toContain('Genio co-author name')
    await open('genio')
    expect(host.textContent).not.toContain('Model and effort')
    await open('usage')
    expect(host.textContent).not.toContain('Bot model')
    for (const gone of ['What Balanced sets', 'Automatic protection', 'Attributed to projects', 'Pin models and effort', 'Nothing pinned']) expect(host.textContent, gone).not.toContain(gone)
    expect(host.querySelectorAll('.plan-meter-marker')).toHaveLength(1)
    expect(host.querySelector('.usage-projects')).toBeNull()
    await open('accounts')
    expect(host.querySelectorAll('.plan-meter-marker')).toHaveLength(0)
    expect(host.textContent).not.toContain('Learn more')
    expect(host.textContent).not.toContain("Hide Genio's past sessions")
    await open('general')
    for (const gone of ['Replay the intro', 'Raise the alarm after', 'Bundle away alerts for']) expect(host.textContent, gone).not.toContain(gone)
    await open('inbox')
    for (const gone of ['Port', 'Keep an activity log file', 'curl']) expect(host.textContent, gone).not.toContain(gone)
    expect(host.querySelector('textarea[aria-label="Note for Genio"]')).toBeNull()
    await open('harnesses')
    expect(host.textContent).not.toContain('Claude Code path')
    expect(host.textContent).not.toContain('Add custom')
    await open('dispatch')
    expect(host.textContent).not.toContain('Scorecard')
    await open('system')
    expect(active()).toBe('System')
    expect(host.textContent).not.toContain('Hide them from the Codex and Claude apps')
    expect(host.textContent).not.toContain("Genio's past sessions")
    expect(f.calls.some(call => call.startsWith('sessionCleanup'))).toBe(false)
  })

  it('has no Pinned section or Unpin anywhere, even with chosen models, rows and rules', async () => {
    f.settings = {
      ...defaultSettings(), wkspModel: 'claude-opus-5-5', wkspEffort: 'high', defaultHarness: 'claude', defaultWorkerModel: 'claude-opus-5-5', defaultWorkerEffort: 'high',
      categoryPools: [{ category: 'ui', candidates: [{ harness: 'claude', model: 'claude-opus-5-5' }] }],
      dispatchRules: [{ id: 'r', match: 'shader', candidates: [{ harness: 'codex', spendPriority: 0 }] }]
    }
    await mount()
    await open('usage')
    for (const gone of ['Pinned', 'Unpin', 'Auto:', 'Sonnet', 'Opus']) expect(host.textContent, gone).not.toContain(gone)
    expect(host.textContent).toMatch(/Replies under about 250 words/)
    await open('dispatch')
    for (const gone of ['Learn the order automatically', 'Pinned', 'Reset to defaults']) expect(host.textContent, gone).not.toContain(gone)
    expect(host.querySelector('[title*="Pin"]')).toBeNull()
    // every category without a row of the player says it uses the default; the player's UI row is listed as written
    expect(host.querySelectorAll('.cat-row')).toHaveLength(13)
    expect(host.textContent!.match(/Default model/g)).toHaveLength(12)
  })

  it('moves the Play editor settings off the project page and checks for updates only on a click', async () => {
    await mount()
    await open('project-unity')
    expect(host.querySelector('[aria-label="Close your Play editor after (minutes)"]')).toBeNull()
    await open('play')
    expect(host.querySelector('[aria-label="Close your Play editor after (minutes)"]')).not.toBeNull()
    await open('system')
    expect([...host.querySelectorAll('.sys-subtitle')].map((h) => h.textContent)).toEqual(['Installed tools', 'Windows integration', 'Updates'])
    expect(host.textContent).not.toContain('C:/genio-base')
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
  it('finds the single Feature tips row by tips and hints and saves both switch directions', async () => {
    for (const word of ['tips', 'hints']) expect(searchSettings(word)[0]).toMatchObject({ page: 'general', label: 'Feature tips', anchor: 'setting-feature-tips', scope: 'All projects' })
    await mount(); await open('general')
    const row = host.querySelector('#setting-feature-tips')!
    expect(row.querySelector('.sys-row-hint')).toBeNull()
    expect(row.textContent).toBe('Feature tips')
    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(toggle.checked).toBe(true)
    await act(async () => toggle.click())
    expect(saveSettings).toHaveBeenLastCalledWith({ featureTips: false })
    f.settings = { ...defaultSettings(), featureTips: false }
    await act(async () => root.render(React.createElement(Systems)))
    await act(async () => toggle.click())
    expect(saveSettings).toHaveBeenLastCalledWith({ featureTips: true })
  })

  it('finds every old page name and game term on its new page', () => {
    const old: Record<string, string> = {
      Gauntlet: 'project-delivery', Harnesses: 'harnesses', Dispatch: 'dispatch', Loadout: 'system', Patch: 'system', Explorer: 'system', Triggers: 'inbox',
      'Mail & replay': 'inbox', 'Comms & FX': 'general', Profile: 'general', Alerts: 'general', 'Auto-loot': 'project-delivery', 'Clean HUD': 'general',
      'Your Play instance': 'play', Generation: 'project-assets', Notifications: 'general'
    }
    for (const [name, page] of Object.entries(old)) expect(searchSettings(name)[0]?.page, name).toBe(page)
    expect(searchSettings('dispatch')[0]).toMatchObject({ label: 'Model routing', scope: 'Advanced' })
    expect(searchSettings('loadout').map((h) => h.label)).toEqual(expect.arrayContaining(['System', 'Installed tools']))
    expect(searchSettings('auto-loot')[1]).toMatchObject({ label: 'Merge finished work automatically', anchor: settingAnchor('Merge finished work automatically'), scope: 'This project' })
    expect(searchSettings('overwatch')).toEqual([])
    for (const removed of ["Genio's past sessions", 'Past sessions', 'Housekeeping', 'Maintenance', 'Archive sessions', 'Codex app', 'Claude app']) {
      expect(searchSettings(removed), removed).toEqual([])
    }
    expect(searchSettings('Genio').map((h) => h.page)).toContain('units')
  })

  it('searches rows across both scopes with a scope chip, and only the pages a window offers', () => {
    expect(searchSettings('webhook url')[0]).toMatchObject({ page: 'general', anchor: 'setting-send-away-alerts-to', path: 'General › Send away alerts to', scope: 'All projects' })
    const usage = searchSettings('usage mode')
    expect(usage.slice(0, 2).map((h) => [h.page, h.scope])).toEqual([['project', 'This project'], ['usage', 'All projects']])
    expect(searchSettings('shell')[0].scope).toBe('Advanced')
    const hub = (id: string) => !id.startsWith('project')
    expect(searchSettings('delivery', hub)).toEqual([])
    expect(searchSettings('branch', hub)).toEqual([])
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('no such setting anywhere')).toEqual([])
  })

  it('keeps every index anchor rendering on its page, so the index cannot drift from the screens', async () => {
    await mount()
    const anchors = SETTINGS_INDEX.filter((e) => e.anchor)
    expect(anchors.length).toBeGreaterThan(35)
    for (const e of anchors) {
      await open(e.page, e.anchor)
      expect(active()?.replace(/\d+$/, ''), e.label).toBe(settingsPage(e.page).label)
      expect(host.querySelector(`#${e.anchor}`), `${e.page} › ${e.label} (#${e.anchor})`).not.toBeNull()
    }
    // Each page is in the index once, under its own name.
    expect(SETTINGS_PAGES.every((p) => SETTINGS_INDEX.filter((e) => !e.anchor && e.page === p.id).length === 1)).toBe(true)
  })

  it('shows a helper line only where it says what the control cannot: the unit cap, what OpenRouter sends, how the delivery mode works and where the voice runs', async () => {
    f.settings = { ...defaultSettings(), eventSources: [{ id: 't', name: 'Nightly', command: 'git log -1', intervalSec: 3600, trigger: 'match', enabled: true }],
      dispatchRules: [{ id: 'r', match: 'shader', kind: 'any', candidates: [{ harness: 'claude', spendPriority: 0 }] }] }
    await mount()
    const hinted: string[] = []
    for (const page of SETTINGS_PAGES) {
      await open(page.id)
      for (const el of host.querySelectorAll('.sys-body .sys-row, .sys-body .field')) {
        if (el.querySelector('.sys-row-hint, .field-hint')) hinted.push(el.querySelector('.sys-row-title, .label')?.textContent ?? '')
      }
    }
    expect(hinted).toEqual(['Max units at once', 'OpenRouter models', 'Delivery', 'Read replies aloud', 'Quota protection'])
  })

  describe('the Voice drop-down under Read replies aloud', () => {
    const DAVID = 'Microsoft David Desktop - English (United States)'
    const ZIRA = 'Microsoft Zira Desktop - English (United States)'
    const voiceSelect = () => host.querySelector<HTMLSelectElement>('select[aria-label="Voice"]')
    const options = () => [...voiceSelect()!.options].map((o) => o.text)
    const groups = () => [...voiceSelect()!.querySelectorAll('optgroup')].map((g) => g.label)
    const downloadButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Download natural voice')
    const choose = (value: string) => act(async () => { const s = voiceSelect()!; s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })) })
    beforeEach(() => {
      const voices = [DAVID, ZIRA, 'Microsoft Aria Online (Natural) - English (United States)']
        .map((name) => ({ name, lang: 'en-US', localService: !name.includes('Online'), default: false, voiceURI: name }))
      vi.stubGlobal('speechSynthesis', { getVoices: () => voices, addEventListener: () => undefined, removeEventListener: () => undefined })
      vi.stubGlobal('genio', { on: (fn: (e: unknown) => void) => { f.listeners.add(fn); return () => f.listeners.delete(fn) } })
    })
    const remount = async (settings: Partial<Settings>) => {
      await act(async () => root.unmount())
      root = createRoot(host)
      f.settings = { ...defaultSettings(), ...settings }
      await mount()
      await open('general')
    }

    it('lists the Windows voices of this PC and the natural voice download while the natural voice is missing', async () => {
      await remount({ voice: true })
      const rows = [...host.querySelectorAll('.sys-row-title')].map((e) => e.textContent)
      expect(rows[rows.indexOf('Read replies aloud') + 1]).toBe('Voice')
      // The saved natural voice speaks with the Windows default until it is installed.
      expect(voiceSelect()!.value).toBe('windows')
      expect(options()).toEqual(['Default', 'David - English (United States)', 'Zira - English (United States)'])
      expect(groups()).toEqual([])
      expect(downloadButton()).toBeDefined()
      vi.mocked(saveSettings).mockClear()
      await choose(`windows:${ZIRA}`)
      expect(saveSettings).toHaveBeenLastCalledWith({ replyVoice: `windows:${ZIRA}` })
    })

    it('shows a saved Windows voice, and Default once that voice is gone from this PC', async () => {
      await remount({ voice: true, replyVoice: `windows:${DAVID}` })
      expect(voiceSelect()!.value).toBe(`windows:${DAVID}`)
      await remount({ voice: true, replyVoice: 'windows:Microsoft Hazel Desktop - English (Great Britain)' })
      expect(voiceSelect()!.value).toBe('windows')
    })

    it('downloads the natural voice only after the same consent as the chat offer, with progress and the failure line', async () => {
      await remount({ voice: true })
      f.calls.length = 0
      await act(async () => downloadButton()!.click())
      const dialog = document.querySelector('[role="dialog"][aria-label="Natural voice"]')!
      expect(dialog.textContent).toContain('329 MB')
      expect(f.calls).not.toContain('voiceOutputInstall')
      await act(async () => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Download')!.click())
      await settle()
      expect(f.calls).toContain('voiceOutputInstall')
      expect(document.querySelector('[aria-label="Natural voice"]')).toBeNull()
      expect(downloadButton()!.disabled).toBe(true)
      expect(downloadButton()!.classList.contains('loading')).toBe(true)
      expect(Number(downloadButton()!.style.getPropertyValue('--progress'))).toBeCloseTo(0.5)
      await act(async () => f.finishInstall())
      await settle()
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Natural voice download failed: offline')
      expect(downloadButton()!.disabled).toBe(false)
      // Not now declines like the chat offer.
      await act(async () => downloadButton()!.click())
      await act(async () => [...document.querySelectorAll('[aria-label="Natural voice"] button')].find((b) => b.textContent === 'Not now')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(f.calls).toContain('voiceOutputDecline')
    })

    describe('Test voice', () => {
      const spoken: { text: string; voice?: { name: string } }[] = []
      const cancel = vi.fn()
      const testButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Test voice"]')
      const click = () => act(async () => { testButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)) })
      beforeEach(() => {
        spoken.length = 0
        cancel.mockClear()
        class Utterance { voice?: { name: string }; onend?: () => void; onerror?: () => void; constructor(public text: string) {} }
        vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
        const voices = [DAVID, ZIRA].map((name) => ({ name, lang: 'en-US', localService: true, default: false, voiceURI: name }))
        vi.stubGlobal('speechSynthesis', { getVoices: () => voices, addEventListener: () => undefined, removeEventListener: () => undefined, cancel, speak: (u: { text: string; voice?: { name: string } }) => spoken.push(u) })
      })

      it('is an icon-only button next to the drop-down', async () => {
        await remount({ voice: true })
        expect(testButton()!.textContent).toBe('')
        expect(testButton()!.previousElementSibling).toBe(voiceSelect())
        await remount({ voice: false })
        expect(testButton()).toBeNull()
      })

      it('speaks the sample with the shown voice through the reply path, changing no setting', async () => {
        await remount({ voice: true, replyVoice: `windows:${DAVID}` })
        vi.mocked(saveSettings).mockClear()
        await click()
        expect(spoken.map((u) => [u.text, u.voice?.name])).toEqual([[VOICE_SAMPLE, DAVID]])
        expect(testButton()!.getAttribute('aria-pressed')).toBe('true')
        expect(saveSettings).not.toHaveBeenCalled()
      })

      it('falls back to the Windows default while the natural voice is not installed', async () => {
        await remount({ voice: true })
        await click()
        expect(spoken).toHaveLength(1)
        expect(spoken[0].text).toBe(VOICE_SAMPLE)
      })

      it('stops on a second click, and is idle again when the sentence ends', async () => {
        await remount({ voice: true, replyVoice: `windows:${DAVID}` })
        await click()
        cancel.mockClear()
        await click()
        expect(cancel).toHaveBeenCalled()
        expect(testButton()!.getAttribute('aria-pressed')).toBe('false')
        await click()
        await act(async () => (spoken[1] as unknown as { onend: () => void }).onend())
        expect(testButton()!.getAttribute('aria-pressed')).toBe('false')
      })

      it('stops when the selection changes, without playing the new voice, and when the page closes', async () => {
        await remount({ voice: true, replyVoice: `windows:${DAVID}` })
        await click()
        cancel.mockClear()
        f.settings = { ...defaultSettings(), voice: true, replyVoice: `windows:${ZIRA}` }
        await act(async () => root.render(React.createElement(Systems)))
        expect(cancel).toHaveBeenCalled()
        expect(spoken).toHaveLength(1)
        expect(testButton()!.getAttribute('aria-pressed')).toBe('false')
        await click()
        cancel.mockClear()
        await act(async () => root.unmount())
        expect(cancel).toHaveBeenCalled()
        root = createRoot(host)
      })
    })

    it('adds the natural voices once installed, with no download, and saves the choice; hidden with Read replies aloud off', async () => {
      f.voiceState = 'ready'
      await remount({ voice: true })
      expect(voiceSelect()!.value).toBe('af')
      expect(groups()).toEqual(['Natural voices', 'Windows voices'])
      expect(options()).toEqual(['Default', 'Bella', 'Nicole', 'Sarah', 'Sky', 'Adam', 'Michael', 'Emma (British)', 'Isabella (British)', 'George (British)', 'Lewis (British)',
        'Default', 'David - English (United States)', 'Zira - English (United States)'])
      expect(downloadButton()).toBeUndefined()
      vi.mocked(saveSettings).mockClear()
      await choose('bf_emma')
      expect(saveSettings).toHaveBeenLastCalledWith({ replyVoice: 'bf_emma' })
      await remount({ voice: false })
      expect(voiceSelect()).toBeNull()
    })
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
    for (const f of ['Play.tsx', 'ProjectNotice.tsx', 'Comms.tsx', 'CommandPalette.tsx', 'Systems.tsx']) expect(files, f).toContain(f)
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
      { file: 'Comms.tsx', page: 'accounts' },
      { file: 'ProjectNotice.tsx', page: 'project', anchor: 'settings-engine' },
      { file: 'Play.tsx', page: 'play', anchor: 'player-instance' }
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
    expect(document.activeElement?.textContent).toBe('Agent tools')
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
    await type('dispatch')
    expect(host.querySelectorAll('.sys-link')).toHaveLength(0)
    const first = host.querySelector('.sys-result')!
    expect(first.textContent).toContain('Model routing')
    expect(first.textContent).toContain('Advanced')
    expect(first.textContent).not.toContain('“Dispatch”')
    await press(search(), 'Enter')
    await settle()
    expect(active()).toBe('Model routing')
    expect(search().value).toBe('')
    search().blur()
    await press(document.body, '/')
    expect(document.activeElement).toBe(search())
    await type('webhook')
    expect([...host.querySelectorAll('.sys-result')].map((r) => r.querySelector('.sys-result-label')?.textContent)).toEqual(['General', 'Send away alerts to'])
    await press(search(), 'ArrowDown')
    expect(host.querySelector('.sys-result.on .sys-result-label')?.textContent).toBe('Send away alerts to')
    expect(search().getAttribute('aria-activedescendant')).toBe('sys-result-1')
    await press(search(), 'Enter')
    await settle()
    expect(active()).toBe('General')
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
    expect(startPage({ project: zebra, projects: [zebra], last: 'dispatch' })).toBe('dispatch')
    expect(startPage({ project: project('Alpha', 'godot'), projects: [], last: 'project-unity' })).toBe('project')
    expect(isSettingsShortcut({ key: ',', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true)
    expect(isSettingsShortcut({ key: ',', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false)
  })
})


it('links to the default-on protection switch and saves disabling it', async () => {
  f.usage = { plans: [{ plan: 'claude', level: 'hot', known: true, percent: 90 }], waiting: [], worlds: [], cheap: { allowed: false, why: '' } } as unknown as import('../src/shared/usage-mode').UsagePolicyView
  await mount()
  await open('usage', settingAnchor('Quota protection'))
  const row = host.querySelector('#setting-quota-protection')!
  expect(document.activeElement).toBe(row)
  const toggle = row.querySelector<HTMLInputElement>('input[aria-label="Quota protection"]')!
  expect(toggle.checked).toBe(true)
  expect(host.querySelector('.usage-levels')).not.toBeNull()
  await act(() => toggle.click())
  expect(saveSettings).toHaveBeenCalledWith({ quotaProtection: false })
  f.settings = { ...defaultSettings(), quotaProtection: false }
  await act(() => root.render(React.createElement(Systems)))
  expect(host.querySelector('.usage-levels')).toBeNull()
  expect(host.querySelector('.plan-meter-marker')).not.toBeNull()
  expect(searchSettings('auto saving').some(hit => hit.anchor === 'setting-quota-protection')).toBe(true)
})
