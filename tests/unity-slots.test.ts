// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '../src/shared/types'
import type { PlayPoolState, PlayerMachineStatus } from '../src/shared/play'
const fixture = vi.hoisted(() => ({
  projects: [] as Project[],
  pool: undefined as unknown as PlayPoolState,
  playPool: vi.fn(), playPoolCap: vi.fn(), playPoolLaunch: vi.fn(), playPoolDisk: vi.fn(), playPoolEstimate: vi.fn(), playCloseSlotEditor: vi.fn(),
  machine: { settings: { idleMinutes: 10, maxEditors: 2 }, playerEditors: 0, unitEditors: 1, batchEditors: 1, totalEditors: 2, workingSetBytes: 5 * 2 ** 30, freeBytes: 14 * 2 ** 30, totalBytes: 32 * 2 ** 30 } as PlayerMachineStatus,
  playerInstanceSettings: vi.fn()
}))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({ settings: {}, snap: { projects: fixture.projects, tasks: [{ id: 'task-7', title: 'fix-jump', project: 'Zebra', state: 'working' }], allies: [], inbox: [] } }),
  PROJECT_WINDOW: 'Zebra', saveSettings: vi.fn(),
  api: () => ({ homePath: async () => '', falWorld: async () => ({ config: {} }), uthanaWorld: async () => ({ config: {} }), projectMetadata: async () => ({}), projectPushStatus: async () => ({ ahead: 0, behind: 0 }),
    playPool: fixture.playPool, playPoolCap: fixture.playPoolCap, playPoolLaunch: fixture.playPoolLaunch, playPoolDisk: fixture.playPoolDisk, playPoolEstimate: fixture.playPoolEstimate, playCloseSlotEditor: fixture.playCloseSlotEditor,
    playerInstanceMachine: async () => fixture.machine, playerInstanceSettings: fixture.playerInstanceSettings }),
  hasView: () => false, go: vi.fn(), openDeploy: vi.fn(),
  op: async (_: string, fn: () => unknown) => fn(), setState: vi.fn(), toast: vi.fn(), errText: String
}))
import { ThisProjectSettings } from '../src/renderer/src/views/ProjectSettings'
import { PlayerInstanceSettings } from '../src/renderer/src/views/PlayerInstanceSettings'
const project = (engine: Project['engine']): Project => ({ name: 'Zebra', path: 'C:/games/Zebra', engine, commands: {}, defaultBranch: 'main', mode: 'local-only', forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '' })
const slot = (id: number, patch: object = {}) => ({ id, root: `C:/pool/slot-${id}`, revision: `abcdef${id}0123`, ...patch })
let root: Root | undefined
let host: HTMLDivElement
async function mount(engine: Project['engine']) {
  fixture.projects = [project(engine)]
  fixture.playPool.mockImplementation(async () => fixture.pool)
  fixture.playPoolDisk.mockResolvedValue({ 1: 2 * 1024 ** 3, 2: 1024 ** 3, 3: 3 * 1024 ** 3 })
  fixture.playPoolCap.mockImplementation(async (_: string, cap: number) => { fixture.pool = { ...fixture.pool, cap }; return { cap, draining: [] } })
  fixture.playerInstanceSettings.mockImplementation(async (_: string, patch: object) => { fixture.machine.settings = { ...fixture.machine.settings, ...patch }; return fixture.machine.settings })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(React.createElement(ThisProjectSettings, { page: 'project-unity' })))
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks() })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('Settings › Unity & Play', () => {
  it('shows the player idle time and global editor limit, with no machine readout or explanation', async () => {
    fixture.projects = [project('unity')]
    fixture.playerInstanceSettings.mockImplementation(async (_: string, patch: object) => { fixture.machine.settings = { ...fixture.machine.settings, ...patch }; return fixture.machine.settings })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(React.createElement(PlayerInstanceSettings, { world: 'Zebra' })))
    expect(host.querySelector('#player-instance')?.getAttribute('aria-label')).toBe('Your Play editor')
    expect(host.textContent).not.toContain('These settings apply to all projects.')
    // The instance's status shows on the Play screen only.
    expect(host.textContent).not.toContain('This project:')
    expect(host.textContent).not.toContain('Genio Unity editors')
    expect(host.textContent).not.toContain('GB')
    const idle = host.querySelector('[aria-label="Close your Play editor after (minutes)"]') as HTMLInputElement
    expect(idle.value).toBe('10')
    const cap = host.querySelector('[aria-label="Play editors open at once"]') as HTMLSelectElement
    expect(cap.value).toBe('2')
    await act(async () => { cap.value = '3'; cap.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fixture.playerInstanceSettings).toHaveBeenCalledWith('Zebra', { maxEditors: 3 })
    fixture.machine.settings.maxEditors = 2
  })
})

describe('Settings › This project › Unity slots', () => {
  it('no longer holds the global Play editor settings, nor a link to them', async () => {
    fixture.pool = { cap: 1, queue: [], slots: [] }
    await mount('unity')
    expect(host.querySelector('[aria-label="Close your Play editor after (minutes)"]')).toBeNull()
    expect(host.querySelector('[aria-label="Play editors open at once"]')).toBeNull()
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Unity & Play →')).toBe(false)
    expect(host.textContent).not.toContain('Nobody is waiting')
  })
  it('appears for Unity projects with the cap, every slot state and the queue', async () => {
    fixture.pool = { cap: 2, queue: ['unit:task-9'], slots: [
      slot(1, { owner: 'unit:task-7', expires: 1, editor: true }),
      slot(2, { preparing: true, owner: 'player:42' }),
      slot(3, { owner: 'unit:task-8', draining: true, editor: true }),
      slot(4, { retired: true }),
      slot(5, { draining: true, editor: true }),
      slot(6, { stuck: { reason: 'its Unity processes survived a forced stop', pids: [99], at: 1 }, retired: true })
    ] }
    await mount('unity')
    const section = host.querySelector('[aria-label="Unity slots"]')!
    expect(section).not.toBeNull()
    expect(section.id).toBe('unity-slots')
    expect((section.querySelector('select[aria-label="Slots"]') as HTMLSelectElement).value).toBe('2')
    const rows = [...section.querySelectorAll('li.unity-slot')].map(li => li.textContent)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toContain('Leased by unit fix-jump')
    expect(rows[0]).not.toContain('GB')
    expect(rows[0]).not.toContain('abcdef')
    expect(rows[1]).toContain('Preparing a copy for you')
    expect(rows[1]).not.toContain('Play screen')
    expect(rows[2]).toContain('Leased by unit task-8 · draining')
    expect(rows[3]).toContain('Retired')
    expect(rows[4]).toContain('Free · editor running · draining')
    expect(rows[5]).toContain('Stuck')
    expect(section.textContent).not.toContain('slots in use')
    expect(section.textContent).not.toContain('Draining: slot')
    expect(section.textContent).toContain('1. unit task-9')
    expect([...section.querySelectorAll('button')].filter(b => b.textContent === 'Close slot editor')).toHaveLength(4)
  })

  it.each(['godot', 'other', 'bevy'] as Project['engine'][])('is hidden for %s projects', async (engine) => {
    fixture.pool = { cap: 1, queue: [], slots: [] }
    await mount(engine)
    expect(host.querySelector('[aria-label="Unity slots"]')).toBeNull()
    expect(host.textContent).toContain('Unity slots are for Unity projects only.')
    expect(fixture.playPool).not.toHaveBeenCalled()
  })

  it('changes the cap at once, even below slots in use', async () => {
    fixture.pool = { cap: 2, queue: [], slots: [slot(1, { owner: 'unit:task-7' }), slot(2, { owner: 'unit:task-8' })] }
    await mount('unity')
    fixture.playPoolCap.mockImplementationOnce(async () => { fixture.pool = { ...fixture.pool, cap: 1, slots: [fixture.pool.slots[0], { ...fixture.pool.slots[1], draining: true }] }; return { cap: 1, draining: [2] } })
    const select = host.querySelector('select[aria-label="Slots"]') as HTMLSelectElement
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fixture.playPoolCap).toHaveBeenCalledWith('Zebra', 1)
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(host.textContent).toContain('· draining')
    expect(fixture.playPoolDisk).not.toHaveBeenCalled()
  })

  it('closes a slot editor only after confirmation', async () => {
    fixture.pool = { cap: 1, queue: [], slots: [slot(1, { owner: 'unit:task-7', editor: true })] }
    fixture.playCloseSlotEditor.mockResolvedValue(undefined)
    await mount('unity')
    const close = [...host.querySelectorAll('button')].find(b => b.textContent === 'Close slot editor')!
    await act(async () => close.click())
    expect(fixture.playCloseSlotEditor).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Close the Unity editor in slot 1?')
    expect(document.body.textContent).toContain('unit fix-jump loses its lease')
    const confirm = [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Close slot editor') as HTMLButtonElement
    await act(async () => confirm.click())
    expect(fixture.playCloseSlotEditor).toHaveBeenCalledWith('Zebra', 1)
  })

  it('switches slot editor windows between hidden and visible, and shows fallback warnings and dialog failures', async () => {
    fixture.pool = { cap: 2, launch: 'hidden', queue: [], slots: [
      slot(1, { editor: true, window: 'visible', warning: 'Opened the slot editor visibly: hidden desktops exist only on Windows.' }),
      slot(2, { failure: { message: 'Play slot 2 editor is blocked by a Unity licence or sign-in prompt on its hidden desktop.', at: 1 } })
    ] }
    fixture.playPoolLaunch.mockImplementation(async (_: string, visible: boolean) => { fixture.pool = { ...fixture.pool, launch: visible ? 'visible' : 'hidden' }; return { launch: fixture.pool.launch } })
    await mount('unity')
    const select = host.querySelector('select[aria-label="Slot editor windows"]') as HTMLSelectElement
    expect(select.value).toBe('hidden')
    const rows = [...host.querySelectorAll('li.unity-slot')].map(li => li.textContent)
    expect(rows[0]).toContain('· visible window')
    expect(rows[0]).toContain('hidden desktops exist only on Windows')
    expect(rows[1]).toContain('blocked by a Unity licence')
    await act(async () => { select.value = 'visible'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fixture.playPoolLaunch).toHaveBeenCalledWith('Zebra', true)
    expect((host.querySelector('select[aria-label="Slot editor windows"]') as HTMLSelectElement).value).toBe('visible')
  })
})
