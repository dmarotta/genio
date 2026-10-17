// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerInstanceStatus, PlayerScene, PlayerSourceOption, PlayerState } from '../src/shared/play'

// A fake player backend: no main process, no Unity. The screen only talks to window.genio.api.
const nav = vi.hoisted(() => ({ go: vi.fn(), section: vi.fn(), toast: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WINDOW: 'game', go: nav.go, toast: nav.toast, api: () => (window as unknown as { genio: { api: unknown } }).genio.api,
  errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useStore: (sel: (s: unknown) => unknown) => sel({ snap: { tasks: [] } }), getState: () => ({}), playAvailable: () => true, subscribe: () => () => {}, op: async (_l: string, fn: () => unknown) => fn()
}))
vi.mock('../src/renderer/src/lib/settings-nav', () => ({ openSettings: nav.section }))
import { Play } from '../src/renderer/src/views/Play'
import { PlayLive, wheelNotches } from '../src/renderer/src/views/PlayLive'
import { getScreenContext } from '../src/renderer/src/lib/screen-context'
import { chipText, playLine, sourceText } from '../src/renderer/src/lib/play-screen'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const SOURCES: PlayerSourceOption[] = [
  { id: 'main', group: 'main', label: 'Main checkout', source: { path: 'C:/games/game' }, branch: 'main', head: 'a'.repeat(40), dirty: 0 },
  { id: 'worktree:C:/games/game-fog', group: 'worktree', label: 'game-fog', source: { path: 'C:/games/game-fog' }, branch: 'feat/fog', dirty: 1 },
  { id: 'unit:t1', group: 'unit', label: 'Ranger (lairs AI)', task: 't1', source: { path: 'C:/units/lairs' }, branch: 'genio/lairs-ai', dirty: 3 },
  { id: 'branch:develop', group: 'branch', label: 'develop', source: { ref: 'develop' }, branch: 'develop', head: '6ff3823aaaa' }
]
const SCENES: PlayerScene[] = [
  { path: 'Assets/Scenes/Arena.unity', name: 'Arena', inBuild: true, enabled: true, active: true },
  { path: 'Assets/Scenes/Menu.unity', name: 'Menu', inBuild: true, enabled: true }
]
const copy = (extra: object = {}) => ({ version: 1, key: 'k', id: 'c1', project: 'C:/games/game', engineRoot: '', dir: 'D:/copy', root: 'D:/copy/p', state: 'ready', createdAt: NOW, idleMs: 600000, ...extra })
const synced = { lastSync: { at: NOW, complete: true, elapsedMs: 1200, files: { source: 9, unchanged: 0, added: 1, updated: 30, restored: 0, deleted: 0, unityMadeDeleted: 0, unityMadeKept: 0 }, bytes: { copied: 12 * 2 ** 20, deleted: 0 }, source: { kind: 'checkout', path: 'C:/games/game', branch: 'main', head: 'b'.repeat(40) } } }
const copying = (done: number, total: number) => copy({ state: 'syncing', progress: { phase: 'copying', startedAt: NOW - 60_000, bytes: { done, total }, files: { done: 1200, total: 5000 } } }) as never
let status: PlayerInstanceStatus
let root: Root, host: HTMLDivElement
const ok = () => vi.fn(async () => status)
const api = {
  playerInstanceStatus: ok(), playerSources: vi.fn(async () => SOURCES), playerSourceAvailable: vi.fn(async (_world: string, _source: { path?: string; ref?: string }) => true),
  playerCopySizes: vi.fn(async () => ({ exists: false })),
  playerInstanceStartUnity: ok(), playerInstanceEnterPlay: ok(), playerInstanceExitPlay: ok(), playerInstanceStopUnity: ok(),
  playerInstancePause: ok(), playerInstanceStep: ok(), playerInstanceSetScene: ok(), playerInstanceResize: ok(),
  playerInstanceScenes: vi.fn(async () => SCENES),
  playerInstanceRestart: ok(),
  playerInstanceConsole: vi.fn(async () => ({ entries: [{ message: 'Assets/Code.cs(3,1): error CS1002: ; expected', level: 'Error', seq: 1 }], cursor: 1, session: 's' })),
  playerInstanceStream: vi.fn(async () => undefined), featureUsed: vi.fn(async () => undefined)
}
const text = () => host.textContent ?? ''
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
const click = async (label: string) => { await act(async () => button(label).click()) }
const select = (label: string) => host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
const choose = async (label: string, value: string) => { await act(async () => { const s = select(label); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })) }) }
const statusLine = () => host.querySelector('[role=status]')?.textContent ?? ''
/** The status line sits alone in the game area (play.css centers it there); it is gone while the game shows. */
const centered = () => host.querySelector('.play-screen > .play-status[role=status]:only-child')
const noStatus = () => { expect(host.querySelector('[role=status], [role=progressbar]')).toBeNull() }
const bar = () => host.querySelector('[role=progressbar]')
const problem = () => !!host.querySelector('.play-status.alert-text')
const facts = () => getScreenContext('play')?.facts ?? []
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const mount = async () => { await act(async () => root.render(React.createElement(Play))); await settle() }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api } })
  localStorage.clear()
  status = { state: 'idle', project: 'C:/games/game' }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); vi.useRealTimers() })

describe('Play screen', () => {
  it('keeps the source chip, one toolbar and one status line, and starts Unity or Play without a copy prompt', async () => {
    await mount()
    const source = select('Play source')
    expect([...source.querySelectorAll('optgroup')].map(g => g.label)).toEqual(['Main checkout', 'Your worktrees', 'Units', 'Branches (played from commits)'])
    expect([...source.querySelectorAll('optgroup option')].map(o => o.textContent)).toEqual([
      'Main checkout · main · clean', 'game-fog · feat/fog · 1 uncommitted', 'Ranger (lairs AI) · genio/lairs-ai · 3 uncommitted', 'develop @ 6ff3823'
    ])
    expect(source.value).toBe('main')
    expect(host.querySelector('.play-chip > span')?.textContent).toBe('main')
    expect(statusLine()).toBe('Stopped')
    expect(bar()).toBeNull()
    expect([...host.querySelectorAll('[role=toolbar] button')].map(b => b.getAttribute('aria-label'))).toEqual(['Start Unity', 'Enter Play', 'Pause', 'Step', 'Mute game sound'])
    expect(button('Pause').disabled).toBe(true)
    expect(button('Step').disabled).toBe(true)
    // Only the status line in the game area, none on the toolbar: no hint, no first-copy estimate, no console unless asked.
    expect(centered()?.textContent).toBe('Stopped')
    expect(host.querySelector('.play-screen')?.textContent).toBe('Stopped')
    expect(host.querySelector('[role=toolbar]')?.textContent).not.toContain('Stopped')
    expect(host.querySelector('.play-console, [role=alertdialog], [role=note]')).toBeNull()
    expect(api.playerCopySizes).not.toHaveBeenCalled()

    await click('Start Unity')
    expect(api.playerInstanceStartUnity).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, {})
    await choose('Play source', 'unit:t1')
    expect(host.querySelector('.play-chip > span')?.textContent).toBe('Ranger (lairs AI)')
    await click('Enter Play')
    expect(api.playerInstanceEnterPlay).toHaveBeenCalledWith('game', { path: 'C:/units/lairs' }, {})
    await choose('Play source', '__refresh')
    expect(api.playerSources).toHaveBeenCalledTimes(2)
    expect(select('Play source').value).toBe('unit:t1')
  })

  it('shows Preparing with an indeterminate bar the moment Start Unity is pressed', async () => {
    let finish!: (s: PlayerInstanceStatus) => void
    api.playerInstanceStartUnity.mockImplementationOnce(() => new Promise<PlayerInstanceStatus>(r => { finish = r }))
    await mount()
    await click('Start Unity')
    expect(statusLine()).toBe('Preparing')
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false)
    expect(bar()?.querySelector('.indeterminate')).not.toBeNull()
    status = { state: 'ready', project: 'C:/games/game', pid: 7, source: { path: 'C:/games/game' } }
    await act(async () => finish(status)); await settle()
    expect(statusLine()).toBe('Ready')
    expect(bar()).toBeNull()
  })

  it('shows one overall percentage while preparing the copy, with Cancel on the Unity button', async () => {
    status = { state: 'copying', project: 'C:/games/game', copy: copying(4 * 2 ** 30, 16 * 2 ** 30) }
    await mount()
    expect(statusLine()).toBe('Preparing')
    expect(bar()?.getAttribute('aria-valuenow')).toBe('25')
    expect(host.querySelectorAll('[role=progressbar]')).toHaveLength(1)
    expect(text()).not.toMatch(/GB|files|min left/)
    expect(button('Enter Play').disabled).toBe(true)
    await click('Cancel')
    expect(api.playerInstanceStopUnity).toHaveBeenCalledWith('game')
  })

  it('says Ready with no idle countdown, stops Unity and changes the scene', async () => {
    status = { state: 'ready', project: 'C:/games/game', source: { path: 'C:/games/game' }, stoppedAt: NOW - 138_000, deadline: NOW + 462_000, pid: 7, unityVersion: '6000.3.1f1', copy: copy(synced) as never }
    await mount()
    expect(statusLine()).toBe('Ready')
    expect(text()).not.toMatch(/quits in|synced|idle/)
    expect(facts()).toContainEqual({ label: 'Unity', value: '6000.3.1f1' })
    expect(button('Enter Play').disabled).toBe(false)
    await click('Stop Unity')
    expect(api.playerInstanceStopUnity).toHaveBeenCalledWith('game')
    await choose('Scene', 'Assets/Scenes/Menu.unity')
    expect(api.playerInstanceSetScene).toHaveBeenCalledWith('game', 'Assets/Scenes/Menu.unity')
  })

  it('says Starting Unity with an indeterminate bar, keeping the startup log for Genio only', async () => {
    status = { state: 'starting', project: 'C:/games/game', pid: 7, copy: copy() as never, startup: 'Loading packages\nCompiling scripts' }
    await mount()
    expect(statusLine()).toBe('Starting Unity')
    expect(bar()?.querySelector('.indeterminate')).not.toBeNull()
    expect(text()).not.toContain('Compiling')
    expect(facts()).toContainEqual({ label: 'Unity log', value: 'Loading packages · Compiling scripts' })
  })

  it('adds the start phase to Starting Unity, with a determinate bar only when main sends one', async () => {
    status = { state: 'starting', project: 'C:/games/game', pid: 7, copy: copy() as never, startup: 'Begin MonoManager ReloadAssembly', start: { phase: 'compiling' } }
    await mount()
    expect(statusLine()).toBe('Starting Unity · compiling scripts')
    expect(bar()?.querySelector('.indeterminate')).not.toBeNull()
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false)
    status = { ...status, start: { phase: 'loading', bar: 42 } }
    await settle(3000)
    expect(statusLine()).toBe('Starting Unity · loading scripts')
    expect(bar()?.getAttribute('aria-valuenow')).toBe('42')
    expect(bar()?.getAttribute('aria-label')).toBe('Starting Unity · loading scripts')
    expect(host.querySelectorAll('[role=progressbar]')).toHaveLength(1)
    expect(text()).not.toMatch(/Begin MonoManager|left|%|\d+ ?s\b/)
    expect(host.querySelector('.play-screen')?.textContent).toBe('Starting Unity · loading scripts')
    expect(centered()?.querySelector('[role=progressbar]')).not.toBeNull()
  })

  it('names low memory in one alert line and keeps Start anyway on the toolbar, dropping it when Windows cannot commit', async () => {
    const lowMemory = { availableBytes: 3.3 * 2 ** 30, neededBytes: 6 * 2 ** 30, hard: false, consumers: [{ name: 'lands-of-old editor', bytes: 13.5 * 2 ** 30 }], closed: [] }
    status = { state: 'low-memory', project: 'C:/games/game', copy: copy() as never, lowMemory, message: '3.3 GB available; Unity needs about 6.0 GB. Biggest: lands-of-old editor 13.5 GB.' }
    await mount()
    expect(statusLine()).toBe('Not enough free memory for Unity.')
    expect(problem()).toBe(true)
    expect(host.querySelector('.play-status')?.getAttribute('title')).toContain('Biggest: lands-of-old editor')
    expect(facts()).toContainEqual({ label: 'Status', value: `Not enough free memory for Unity. · ${status.message}` })
    await click('Start anyway')
    expect(api.playerInstanceStartUnity).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, { startAnyway: true })
    await click('Enter Play')
    expect(api.playerInstanceEnterPlay).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, { startAnyway: true })

    status = { ...status, lowMemory: { ...lowMemory, hard: true, commitBytes: 5 * 2 ** 30 }, message: 'Windows cannot commit enough memory for Unity' }
    await settle(3000)
    expect(host.querySelector('[role=toolbar]')?.textContent).not.toContain('Start anyway')
    expect(button('Start Unity').disabled).toBe(false)
  })

  it('names a stuck dialog in one line with Open Unity as its only action, and no dialog panel', async () => {
    status = { state: 'stuck-dialog', project: 'C:/games/game', source: { ref: 'develop' }, pid: 9, copy: copy() as never, message: 'Unity is waiting on a licence prompt',
      dialog: { hwnd: '1', pid: 9, title: 'Unity Licensing', text: 'Sign in to continue', buttons: ['OK', 'Cancel'], rule: 'licence', reason: 'licence', screenshot: 'D:/x/blocked-1.png', message: 'Unity is waiting on a licence prompt' } }
    await mount()
    expect(statusLine()).toBe('A Unity dialog is blocking the editor.Open Unity')
    expect(text()).not.toContain('Sign in to continue')
    expect(host.querySelector('.play-screen img')).toBeNull()
    expect(facts()).toContainEqual({ label: 'Blocking dialog', value: 'Unity Licensing: Sign in to continue' })
    await click('Open Unity')
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game', true)
    await click('Restart Unity')
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game')
  })

  it('names a crash in one line and offers Start Unity again on the toolbar', async () => {
    status = { state: 'crashed', project: 'C:/games/game', exitCode: 1, copy: copy() as never, message: 'Unity exited' }
    await mount()
    expect(statusLine()).toBe('Unity closed unexpectedly.')
    expect(problem()).toBe(true)
    expect(button('Start Unity').disabled).toBe(false)
    expect(button('Enter Play').disabled).toBe(false)
  })

  it('keeps the console closed on compile errors until Show console is pressed', async () => {
    status = { state: 'compile-errors', project: 'C:/games/game', pid: 4, copy: copy() as never, message: 'Fix the compile errors in the source, then Play again.' }
    await mount()
    await settle()
    expect(statusLine()).toBe('The game has compile errors.Show console')
    expect(host.querySelector('.play-console')).toBeNull()
    await click('Show console')
    expect(api.playerInstanceConsole).toHaveBeenCalledWith('game', undefined, undefined)
    expect(host.querySelector('.play-console-body')?.textContent).toContain('error CS1002')
    expect(facts()).toContainEqual({ label: 'Last console error', value: 'Assets/Code.cs(3,1): error CS1002: ; expected' })
    expect(button('Enter Play').disabled).toBe(false)
    await click('Close the console')
    expect(host.querySelector('.play-console')).toBeNull()
  })

  it('keeps only Open Unity and the console in the ⋯ menu, with the project name left to the title bar', async () => {
    status = { state: 'ready', project: 'C:/games/game', source: { path: 'C:/games/game' }, pid: 7, copy: copy() as never }
    await mount()
    expect(host.querySelector('.play-head h1')?.textContent).toBe('Play')
    expect(text()).not.toMatch(/Scene/)
    await click('More Play actions')
    expect([...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent)).toEqual(['Open Unity', 'Unity console'])
    await click('Open Unity')
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game', true)
    await click('More Play actions')
    await click('Unity console')
    expect(host.querySelector('.play-console-head')?.textContent).toBe('Unity console')
  })

  it('pauses, steps, resizes without reconnecting, re-plays on a new scene or source, and exits Play', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, scene: 'Assets/Scenes/Arena.unity', capabilities: { input: true }, copy: copy(synced) as never }
    await mount()
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 1280, 720)
    noStatus()
    expect(facts()).toContainEqual({ label: 'Status', value: 'Playing' })
    expect(button('Exit Play').getAttribute('aria-pressed')).toBe('true')
    expect(facts()).toEqual(expect.arrayContaining([{ label: 'Scene', value: 'Assets/Scenes/Arena.unity' }, { label: 'Resolution', value: '1280 × 720' }]))
    await click('Pause')
    expect(api.playerInstancePause).toHaveBeenCalledWith('game')
    await click('Step')
    expect(api.playerInstanceStep).toHaveBeenCalledWith('game')

    await choose('Resolution', '1920x1080')
    expect(api.playerInstanceResize).toHaveBeenCalledWith('game', 1920, 1080)
    await settle()
    expect(api.playerInstanceStream).toHaveBeenCalledTimes(1)
    expect(host.querySelector('canvas')?.getAttribute('width')).toBe('1920')
    expect(localStorage.getItem('genio.play.resolution.game')).toBe('1920x1080')
    expect(facts()).toContainEqual({ label: 'Resolution', value: '1920 × 1080' })

    await choose('Scene', 'Assets/Scenes/Menu.unity')
    expect(api.playerInstanceSetScene).toHaveBeenCalledWith('game', 'Assets/Scenes/Menu.unity')
    await choose('Play source', 'worktree:C:/games/game-fog')
    expect(api.playerInstanceEnterPlay).toHaveBeenCalledWith('game', { path: 'C:/games/game-fog' })
    await click('Exit Play')
    expect(api.playerInstanceExitPlay).toHaveBeenCalledWith('game')
  })

  it('says Paused, marks Pause pressed and follows Unity\'s Play shortcuts outside the game', async () => {
    status = { state: 'paused', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
    await mount()
    noStatus()
    expect(facts()).toContainEqual({ label: 'Status', value: 'Paused' })
    expect(button('Resume').getAttribute('aria-pressed')).toBe('true')
    const key = async (init: KeyboardEventInit) => { await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, ...init }))) }
    await key({ shiftKey: true })
    expect(api.playerInstancePause).toHaveBeenCalledWith('game')
    await key({ altKey: true })
    expect(api.playerInstanceStep).toHaveBeenCalledWith('game')
    await key({})
    expect(api.playerInstanceExitPlay).toHaveBeenCalledWith('game')
  })

  it('streams the saved resolution, keeps legacy input out of the page, and exits Play when the screen closes', async () => {
    localStorage.setItem('genio.play.resolution.game', '640x360')
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: false }, copy: copy() as never }
    await mount()
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 640, 360)
    expect(text()).not.toContain('View only')
    expect(button('Lock pointer').disabled).toBe(true)
    expect(facts()).toContainEqual({ label: 'Input', value: 'This game reads legacy input, so the stream is view-only' })
    await act(async () => root.render(null))
    expect(api.playerInstanceStream).toHaveBeenCalledTimes(1)
    await settle()
    expect(api.playerInstanceStream).toHaveBeenLastCalledWith('game', false)
  })

  it('keeps playing through a StrictMode remount of the live view', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Play))))
    await settle()
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 1280, 720)
    expect(api.playerInstanceStream).not.toHaveBeenCalledWith('game', false)
  })

  it('says the live view stopped on the status line, with Reconnect, when main closed the stream first', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
    const channel = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => Promise<void>) | null }
    await mount()
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'genio:play-port', world: 'game' }, ports: [channel as unknown as MessagePort] })))
    await act(async () => channel.onmessage!({ data: { type: 'closed' } }))
    expect(statusLine()).toBe('The live view stopped.Reconnect')
    expect(centered()?.className).toContain('alert-text')
    expect(host.querySelector('canvas')).toBeNull()
    expect(facts()).toContainEqual({ label: 'Live view', value: 'The live stream ended.' })
    expect(api.playerInstanceStream).toHaveBeenCalledTimes(1)
    await click('Reconnect')
    expect(api.playerInstanceStream).toHaveBeenCalledTimes(2)
    noStatus()
  })

  it('shows exactly one status line, at most one progress bar and nothing else in every main state', async () => {
    const states: PlayerInstanceStatus[] = [
      { state: 'idle', project: 'p' },
      { state: 'copying', project: 'p', copy: copying(1, 4) },
      { state: 'starting', project: 'p', pid: 3, startup: 'Importing' },
      ...(['opening', 'packages', 'compiling', 'loading', 'importing', 'scene'] as const).map((phase, n): PlayerInstanceStatus => ({ state: 'starting', project: 'p', pid: 3, start: { phase, ...(n % 2 ? { bar: n * 15 } : {}) } })),
      { state: 'ready', project: 'p', pid: 3, source: { path: 'C:/games/game' }, deadline: NOW + 60_000, copy: copy(synced) as never },
      { state: 'error', project: 'p', message: 'Play hit an unexpected problem: boom.' }
    ]
    for (const s of states) {
      status = s
      await mount()
      expect(host.querySelectorAll('[role=status]')).toHaveLength(1)
      expect(host.querySelectorAll('[role=progressbar]').length).toBeLessThanOrEqual(1)
      expect(host.querySelectorAll('[role=note], [role=alert], [role=alertdialog]')).toHaveLength(0)
      expect(centered()).not.toBeNull()
      expect(host.querySelector('.play-screen')?.textContent).toBe(statusLine())
      await act(async () => root.unmount()); root = createRoot(host)
    }
    expect(nav.toast).not.toHaveBeenCalled()
  })

  it('centers the line and bar in the game area while the game is off, and drops them the moment it shows', async () => {
    const cases: [PlayerInstanceStatus, string, boolean][] = [
      [{ state: 'idle', project: 'p' }, 'Stopped', false],
      [{ state: 'copying', project: 'p', copy: copying(1, 4) }, 'Preparing', true],
      [{ state: 'starting', project: 'p', pid: 3, start: { phase: 'packages' } }, 'Starting Unity · unpacking packages', true],
      [{ state: 'ready', project: 'p', pid: 3, source: { path: 'C:/games/game' } }, 'Ready', false],
      [{ state: 'error', project: 'p', message: 'boom' }, 'Play failed.Try again', false]
    ]
    for (const [s, line, withBar] of cases) {
      status = s
      await mount()
      expect(centered()?.textContent, s.state).toBe(line)
      expect(!!centered()?.querySelector('[role=progressbar]'), s.state).toBe(withBar)
      expect(!!centered()?.matches('.alert-text'), s.state).toBe(s.state === 'error')
      expect(host.querySelector('.play-toolbar [role=status], .play-head [role=status]')).toBeNull()
      await act(async () => root.unmount()); root = createRoot(host)
    }
    for (const state of ['playing', 'paused'] as const) {
      status = { state, project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
      await mount()
      noStatus()
      expect(host.querySelector('.play-screen canvas')).not.toBeNull()
      await act(async () => root.unmount()); root = createRoot(host)
    }
  })

  it('styles the line large and the bar thick, wide, green and still under reduced motion', async () => {
    const { readFileSync } = await import('node:fs' as string) as { readFileSync(file: string, encoding: 'utf8'): string }
    const css = readFileSync('src/renderer/src/styles/play.css', 'utf8').replace(/\s+/g, ' ')
    expect(css).toMatch(/\.play-screen \{[^}]*justify-content: center; align-items: center;/)
    expect(css).toMatch(/\.play-status-line \{[^}]*font-size: 19px; font-weight: 500;/)
    expect(css).toMatch(/\.play-status-text \{[^}]*text-overflow: ellipsis; white-space: nowrap;/)
    expect(css).toMatch(/\.play-progress-track \{[^}]*width: 320px; max-width: 100%; height: 8px; border-radius: 4px;/)
    expect(css).toMatch(/\.play-progress-track span \{[^}]*background: var\(--volt\)/)
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{(.*?\}) \}/)?.[1] ?? ''
    expect(reduced).toMatch(/\.play-progress-track span\.indeterminate \{[^}]*animation: none;/)
    expect(reduced).toMatch(/\.play-dot\.work \{ animation: none; \}/)
  })
})

describe('Play screen: game sound', () => {
  const playing = (): PlayerInstanceStatus => ({ state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never })
  const sound = () => host.querySelector('[role=toolbar]')!.lastElementChild as HTMLButtonElement
  const contexts: { state: string; gain: { gain: { value: number } }; suspend: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  const nodes: { name: string; options: unknown; port: { postMessage: ReturnType<typeof vi.fn> } }[] = []
  class FakeContext {
    state = 'running'; destination = {}; audioWorklet = { addModule: vi.fn(async () => {}) }
    gain = { gain: { value: 1 }, connect: vi.fn() }
    suspend = vi.fn(async () => { this.state = 'suspended' }); resume = vi.fn(async () => { this.state = 'running' }); close = vi.fn(async () => { this.state = 'closed' })
    constructor() { contexts.push(this) }
    createGain() { return this.gain }
  }
  class FakeNode {
    port = { postMessage: vi.fn() }; connect = vi.fn()
    constructor(_context: unknown, readonly name: string, readonly options: unknown) { nodes.push(this) }
  }
  const channel = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => Promise<void>) | null }
  const connect = () => act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'genio:play-port', world: 'game' }, ports: [channel as unknown as MessagePort] })))
  const audio = async (n = 1) => { for (let i = 0; i < n; i++) await act(async () => channel.onmessage!({ data: { type: 'audio', bytes: new Uint8Array(32) } })) }
  const acks = () => channel.postMessage.mock.calls.filter(([m]) => m?.type === 'audio-ack').map(([m]) => m.count)
  beforeEach(() => {
    contexts.length = 0; nodes.length = 0; channel.postMessage.mockClear()
    vi.stubGlobal('AudioContext', FakeContext); vi.stubGlobal('AudioWorkletNode', FakeNode)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('adds exactly one toggle, after Resolution: sound on by default, usable before Play, remembered per project, silent on the status line', async () => {
    localStorage.setItem('genio.play.muted.other', '1')
    await mount()
    expect(host.querySelectorAll('[role=toolbar] button')).toHaveLength(5)
    expect(sound().previousElementSibling?.getAttribute('aria-label')).toBe('Resolution')
    expect(sound()).toMatchObject({ disabled: false, title: 'Mute game sound' })
    expect(sound().getAttribute('aria-label')).toBe('Mute game sound')
    expect(sound().getAttribute('aria-pressed')).toBe('false')
    expect(sound().className).toContain('is-ready')
    expect(facts()).toContainEqual({ label: 'Audio', value: 'on' })
    const line = statusLine()

    await click('Mute game sound')
    expect(sound().getAttribute('aria-pressed')).toBe('true')
    expect(sound()).toMatchObject({ title: 'Unmute game sound' })
    expect(sound().className).toContain('is-on')
    expect(localStorage.getItem('genio.play.muted.game')).toBe('1')
    expect(facts()).toContainEqual({ label: 'Audio', value: 'muted' })
    expect(statusLine()).toBe(line)
    expect(text()).not.toMatch(/mute|sound|audio/i)
    expect(nav.toast).not.toHaveBeenCalled()

    await act(async () => root.unmount()); root = createRoot(host); await mount()
    expect(sound().getAttribute('aria-pressed')).toBe('true')
    await click('Mute game sound')
    expect(sound().getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem('genio.play.muted.game')).toBe('0')
    expect(localStorage.getItem('genio.play.muted.other')).toBe('1')
  })

  it('plays the stream through the worklet, acks it, mutes by suspending, and closes the sound on leaving Play', async () => {
    status = playing()
    await mount(); await connect()
    await audio()
    expect(contexts).toHaveLength(1)
    await settle()
    expect(nodes).toMatchObject([{ name: 'genio-play-audio', options: { numberOfInputs: 0, outputChannelCount: [2] } }])
    await audio(9)
    expect(acks()).toEqual([10])
    expect(nodes[0].port.postMessage).toHaveBeenCalledTimes(9) // the first packet came before the worklet loaded
    expect(facts()).toContainEqual({ label: 'Audio', value: 'on' })

    await click('Mute game sound')
    expect(contexts[0].gain.gain.value).toBe(0); expect(contexts[0].suspend).toHaveBeenCalledOnce()
    await audio(10)
    expect(acks()).toEqual([10, 10]) // still acked, so main keeps sending
    expect(nodes[0].port.postMessage).toHaveBeenCalledTimes(9)

    await click('Mute game sound')
    expect(nodes[0].port.postMessage).toHaveBeenLastCalledWith({ type: 'flush' })
    expect(contexts[0].gain.gain.value).toBe(1); expect(contexts[0].resume).toHaveBeenCalled()
    await audio()
    expect(nodes[0].port.postMessage).toHaveBeenLastCalledWith(expect.any(Uint8Array), [expect.any(ArrayBuffer)])

    await act(async () => root.render(null))
    expect(contexts[0].close).toHaveBeenCalledOnce()
  })

  it('creates no audio while muted before Play, and tells Genio when the game sends no sound', async () => {
    localStorage.setItem('genio.play.muted.game', '1')
    status = playing()
    await mount(); await connect()
    await audio(10)
    expect(contexts).toHaveLength(0)
    expect(acks()).toEqual([10])
    expect(facts()).toContainEqual({ label: 'Audio', value: 'muted' })

    await act(async () => root.unmount()); root = createRoot(host)
    localStorage.removeItem('genio.play.muted.game')
    await mount(); await connect()
    await settle(3000)
    expect(facts()).toContainEqual({ label: 'Audio', value: 'no sound from the game' })
    noStatus()
    await audio()
    expect(facts()).toContainEqual({ label: 'Audio', value: 'on' })
  })
})

it('decodes one live frame per credit, forwards held input only while focused, and releases on close', async () => {
  const bitmap = { close: vi.fn() }, drawImage = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  const channel = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => Promise<void>) | null }
  try {
    await act(async () => root.render(React.createElement(PlayLive, { world: 'game', width: 640, height: 360, input: true, onClosed: vi.fn() })))
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 640, 360)
    expect(host.textContent).toBe('')
    expect([...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))).toEqual(['Lock pointer', 'Full screen'])
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'genio:play-port', world: 'game' }, ports: [channel as unknown as MessagePort] })))
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'ready' })
    await act(async () => channel.onmessage!({ data: { type: 'frame', bytes: new Uint8Array([255, 216, 255, 217]) } }))
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 640, 360)
    expect(bitmap.close).toHaveBeenCalledOnce()
    const canvas = host.querySelector('canvas')!
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true })); await vi.advanceTimersByTimeAsync(33) })
    expect(channel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'input', input: expect.objectContaining({ type: 'state', keys: ['W'] }) }))
    await act(async () => canvas.blur())
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'input', input: { type: 'release' } })
    await act(async () => root.render(null))
    expect(channel.close).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.playerInstanceStream).toHaveBeenLastCalledWith('game', false)
  } finally { context.mockRestore(); vi.unstubAllGlobals() }
})

it('draws fast-path GPU frames on the same canvas, returns each credit on the port, and still takes JPEG after a fallback', async () => {
  const bitmap = { close: vi.fn() }, drawImage = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  const channel = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => Promise<void>) | null }
  let listener: ((frame: unknown, meta: object) => void) | undefined
  const off = vi.fn(), genio = (window as unknown as { genio: Record<string, unknown> }).genio
  genio.onPlayFrame = vi.fn((world: string, fn: typeof listener) => { expect(world).toBe('game'); listener = fn; return off })
  try {
    await act(async () => root.render(React.createElement(PlayLive, { world: 'game', width: 1280, height: 720, input: true, onClosed: vi.fn() })))
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'genio:play-port', world: 'game' }, ports: [channel as unknown as MessagePort] })))
    channel.postMessage.mockClear()
    const frame = { codedWidth: 1280 }
    act(() => listener!(frame, { seq: 1, width: 1280, height: 720 }))
    // Drawn as it came, no decode and no layout work; then the one credit goes back.
    expect(drawImage).toHaveBeenCalledWith(frame, 0, 0, 1280, 720)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(channel.postMessage.mock.calls).toEqual([[{ type: 'ready' }]])
    // A frame that fails to draw still returns the credit, so the stream never stalls.
    drawImage.mockImplementationOnce(() => { throw new Error('lost') })
    expect(() => listener!(frame, { seq: 2, width: 1280, height: 720 })).toThrow('lost')
    expect(channel.postMessage).toHaveBeenCalledTimes(2)
    await act(async () => channel.onmessage!({ data: { type: 'frame', bytes: new Uint8Array([255, 216, 255, 217]) } }))
    expect(drawImage).toHaveBeenLastCalledWith(bitmap, 0, 0, 1280, 720)
    await act(async () => root.render(null))
    expect(off).toHaveBeenCalledOnce()
  } finally { delete genio.onPlayFrame; context.mockRestore(); vi.unstubAllGlobals() }
})

it('normalizes wheel notches across deltaMode, with up positive as in Unity', () => {
  expect(wheelNotches({ deltaY: -100, deltaMode: 0 })).toBe(1)
  expect(wheelNotches({ deltaY: 3, deltaMode: 1 })).toBe(-1)
  expect(wheelNotches({ deltaY: -1, deltaMode: 2 })).toBe(1)
  expect(wheelNotches({ deltaY: 40, deltaMode: 0 })).toBe(-0.4)
  expect(wheelNotches({ deltaY: NaN, deltaMode: 0 })).toBe(0)
})

it('sends the wheel to the game only while it has input, summed per state packet and reset after sending', async () => {
  const channel = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => Promise<void>) | null }
  const render = (input: boolean) => act(async () => root.render(React.createElement(PlayLive, { world: 'game', width: 640, height: 360, input, onClosed: vi.fn() })))
  const wheel = (deltaY: number, deltaMode = 0) => { const e = new WheelEvent('wheel', { deltaY, deltaMode, cancelable: true, bubbles: true }); host.querySelector('canvas')!.dispatchEvent(e); return e.defaultPrevented }
  const states = () => channel.postMessage.mock.calls.map(([m]) => m.input).filter(i => i?.type === 'state')
  await render(true)
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'genio:play-port', world: 'game' }, ports: [channel as unknown as MessagePort] })))
  const canvas = host.querySelector('canvas')!
  expect(wheel(-100)).toBe(false) // not focused: the page scrolls
  await act(async () => { canvas.focus() })
  expect([wheel(-100), wheel(3, 1), wheel(-1, 2), wheel(-50)]).toEqual([true, true, true, true])
  await act(async () => { await vi.advanceTimersByTimeAsync(33) })
  expect(states().at(-1).scroll).toBe(1.5)
  await act(async () => { await vi.advanceTimersByTimeAsync(33) })
  expect(states().at(-1).scroll).toBe(0)
  expect(wheel(100)).toBe(true)
  await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })) })
  expect(wheel(100)).toBe(false) // released: the page scrolls again and nothing is left to send
  await act(async () => { canvas.focus(); await vi.advanceTimersByTimeAsync(33) })
  expect(states().at(-1).scroll).toBe(0)
  await render(false)
  const before = states().length
  await act(async () => { canvas.focus() })
  expect(wheel(-100)).toBe(false) // view-only game
  await act(async () => { await vi.advanceTimersByTimeAsync(66) })
  expect(states()).toHaveLength(before)
})

describe('playLine: one status line and one progress bar per state', () => {
  const at = (state: PlayerState, extra: Partial<PlayerInstanceStatus> = {}) => ({ state, project: 'p', ...extra }) as PlayerInstanceStatus
  it('maps every instance state to a plain word or one short problem sentence', () => {
    const table: [PlayerState, string, string, unknown, string | undefined][] = [
      ['idle', 'Stopped', 'off', undefined, undefined],
      ['copying', 'Preparing', 'work', 'indeterminate', undefined],
      ['syncing', 'Preparing', 'work', 'indeterminate', undefined],
      ['starting', 'Starting Unity', 'work', 'indeterminate', undefined],
      ['entering-play', 'Starting Play', 'work', 'indeterminate', undefined],
      ['ready', 'Ready', 'ready', undefined, undefined],
      ['playing', 'Playing', 'live', undefined, undefined],
      ['paused', 'Paused', 'live', undefined, undefined],
      ['exiting-play', 'Stopping', 'work', undefined, undefined],
      ['shutting-down', 'Stopping', 'work', undefined, undefined],
      ['crashed', 'Unity closed unexpectedly.', 'problem', undefined, undefined],
      ['stuck-dialog', 'A Unity dialog is blocking the editor.', 'problem', undefined, 'visible'],
      ['close-stuck', 'Unity would not close.', 'problem', undefined, undefined],
      ['compile-errors', 'The game has compile errors.', 'problem', undefined, 'console'],
      ['low-memory', 'Not enough free memory for Unity.', 'problem', undefined, undefined],
      ['missing-editor', 'This project\'s Unity version is not installed.', 'problem', undefined, undefined],
      ['limit-reached', 'Too many Play editors are open.', 'problem', undefined, 'settings'],
      ['error', 'Play failed.', 'problem', undefined, 'retry']
    ]
    for (const [state, text, kind, bar, action] of table) {
      expect(playLine({ status: at(state, { message: 'technical detail, 12 files, 3.1 GB' }) }), state).toEqual({ text, kind, ...(bar ? { bar } : {}), ...(action ? { action } : {}) })
    }
    expect(playLine({})).toEqual({ text: 'Loading', kind: 'off' })
  })

  it('drives the bar by the copy\'s overall percentage, else indeterminate', () => {
    expect(playLine({ status: at('copying', { copy: copying(3, 4) }) }).bar).toBe(75)
    expect(playLine({ status: at('syncing', { copy: copying(0, 0) }) }).bar).toBe('indeterminate')
  })

  it('names each Unity start phase after Starting Unity and takes the bar from main, else indeterminate', () => {
    const steps = { opening: 'opening', packages: 'unpacking packages', compiling: 'compiling scripts', loading: 'loading scripts', importing: 'importing', scene: 'opening scene' } as const
    for (const [phase, step] of Object.entries(steps)) {
      expect(playLine({ status: at('starting', { start: { phase: phase as keyof typeof steps } }) })).toEqual({ text: `Starting Unity · ${step}`, kind: 'work', bar: 'indeterminate' })
    }
    expect(playLine({ status: at('starting', { start: { phase: 'compiling', bar: 0 } }) }).bar).toBe(0)
    expect(playLine({ status: at('starting', { start: { phase: 'scene', bar: 97 } }) }).bar).toBe(97)
    // Only Starting Unity carries a step: a stale phase never leaks into another state.
    expect(playLine({ status: at('entering-play', { start: { phase: 'scene', bar: 97 } }) })).toEqual({ text: 'Starting Play', kind: 'work', bar: 'indeterminate' })
    expect(playLine({ status: at('ready', { start: { phase: 'scene' } }) })).toEqual({ text: 'Ready', kind: 'ready' })
  })

  it('says a path too long for Unity while Unity starts and after a failed or crashed start, nowhere else', () => {
    const pathWarning = "Paths in com.unity.visualscripting reach 262 characters, over Windows' 260 limit, so Unity may fail to load them. Remove that package or shorten the Unity folder name."
    expect(playLine({ status: at('starting', { pathWarning, start: { phase: 'packages', bar: 40 } }) })).toEqual({ text: pathWarning, kind: 'work', bar: 40 })
    expect(playLine({ status: at('error', { pathWarning }) })).toEqual({ text: pathWarning, kind: 'problem', action: 'retry' })
    expect(playLine({ status: at('crashed', { pathWarning }) })).toEqual({ text: pathWarning, kind: 'problem' })
    expect(playLine({ status: at('ready', { pathWarning }) })).toEqual({ text: 'Ready', kind: 'ready' })
    expect(playLine({ status: at('playing', { pathWarning }) })).toEqual({ text: 'Playing', kind: 'live' })
    expect(playLine({ status: at('compile-errors', { pathWarning }) }).text).toBe('The game has compile errors.')
  })

  it('answers a press at once: Preparing, Starting Play or Stopping while the call runs', () => {
    expect(playLine({ status: at('idle'), busy: 'start' })).toEqual({ text: 'Preparing', kind: 'work', bar: 'indeterminate' })
    expect(playLine({ status: at('crashed'), busy: 'enter' })).toEqual({ text: 'Preparing', kind: 'work', bar: 'indeterminate' })
    expect(playLine({ status: at('ready'), busy: 'enter' })).toEqual({ text: 'Starting Play', kind: 'work', bar: 'indeterminate' })
    expect(playLine({ status: at('playing'), busy: 'exit' })).toEqual({ text: 'Stopping', kind: 'work' })
    expect(playLine({ status: at('playing'), busy: 'pause' })).toEqual({ text: 'Playing', kind: 'live' })
    expect(playLine({ status: at('ready'), busy: 'scene' })).toEqual({ text: 'Ready', kind: 'ready' })
  })

  it('folds local problems into the same line: a failed call, a missing source, a closed live view, a removed source', () => {
    expect(playLine({ status: at('ready'), error: 'Streaming requires the owning project window' })).toEqual({ text: 'Something went wrong.', kind: 'problem' })
    expect(playLine({ status: at('crashed'), error: 'x' }).text).toBe('Unity closed unexpectedly.')
    expect(playLine({ status: at('idle'), missing: true })).toEqual({ text: 'That source is gone. Pick another one.', kind: 'problem' })
    expect(playLine({ status: at('playing'), streamEnded: true })).toEqual({ text: 'The live view stopped.', kind: 'problem', action: 'reconnect' })
    expect(playLine({ status: at('idle'), streamEnded: true }).text).toBe('Stopped')
    expect(playLine({ status: at('idle', { sourceGone: { when: 'loading', at: NOW, unit: 'Ranger', merged: true, base: 'main' } }) })).toEqual({ text: 'This unit was removed.', kind: 'problem', action: 'main' })
    expect(playLine({ status: at('playing', { sourceGone: { when: 'running', at: NOW } }) }).text).toBe('Playing')
    expect(playLine({ status: at('playing', { sourceGone: { when: 'fallback', at: NOW } }) }).text).toBe('Playing')
  })

  it('formats picker rows and the chip', () => {
    expect(chipText(SOURCES[0])).toBe('main')
    expect(chipText(SOURCES[2])).toBe('Ranger (lairs AI)')
    expect(sourceText({ id: 'w', group: 'worktree', label: 'x', source: { path: 'x' }, head: 'c'.repeat(40) })).toBe('x · detached ccccccc')
  })
})

describe('Play screen: a source that vanishes', () => {
  const gone = (when: 'loading' | 'running' | 'fallback') => ({ when, at: NOW, unit: 'Ranger (lairs AI)', merged: true, base: 'main' })

  it('says a unit was removed while loading on the status line and plays main in one click', async () => {
    status = { state: 'idle', project: 'C:/games/game', message: 'x', sourceGone: gone('loading') }
    await mount()
    expect(statusLine()).toBe('This unit was removed.Play main')
    expect(facts()).toContainEqual({ label: 'Source gone', value: 'This unit was merged and removed while loading. Its work is in main now.' })
    await click('Play main')
    expect(api.playerInstanceEnterPlay).toHaveBeenCalledWith('game', { path: 'C:/games/game' })
    expect(select('Play source').value).toBe('main')
  })

  it('keeps playing with no extra note when the source went after the copy; the controls still work', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 7, source: { path: 'C:/units/lairs' }, sourceGone: gone('running') }
    await mount()
    noStatus()
    expect(button('Pause').disabled).toBe(false)
    await click('Pause')
    expect(api.playerInstancePause).toHaveBeenCalledWith('game')
    await click('Exit Play')
    expect(api.playerInstanceExitPlay).toHaveBeenCalledWith('game')
  })

  it('says only Playing when the next Play fell back to main', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 7, source: { path: 'C:/games/game' }, sourceGone: gone('fallback') }
    await mount()
    noStatus()
    expect(facts()).toContainEqual({ label: 'Status', value: 'Playing' })
  })

  it('preselects the unit from Play this unit, once, without starting Unity', async () => {
    localStorage.setItem('genio.play.request', JSON.stringify({ world: 'game', source: 'unit:t1', at: NOW }))
    await mount(); await settle()
    expect(select('Play source').value).toBe('unit:t1')
    expect(statusLine()).toBe('Stopped')
    expect(localStorage.getItem('genio.play.request')).toBeNull()
    expect(api.playerInstanceEnterPlay).not.toHaveBeenCalled(); expect(api.playerInstanceStartUnity).not.toHaveBeenCalled()
  })

  it('says so on the status line when the requested unit is already gone', async () => {
    localStorage.setItem('genio.play.request', JSON.stringify({ world: 'game', source: 'unit:t9', at: NOW }))
    await mount(); await settle()
    expect(select('Play source').value).toBe('main')
    expect(statusLine()).toBe('That source is gone. Pick another one.')
    await choose('Play source', 'branch:develop')
    expect(statusLine()).toBe('Stopped')
  })

  it('drops a vanished unit from the picker within seconds and says so', async () => {
    localStorage.setItem('genio.play.request', JSON.stringify({ world: 'game', source: 'unit:t1', at: NOW }))
    await mount(); await settle()
    expect(select('Play source').value).toBe('unit:t1')
    api.playerSourceAvailable.mockImplementation(async (_w: string, s: { path?: string }) => s.path !== 'C:/units/lairs')
    api.playerSources.mockImplementation(async () => SOURCES.filter(o => o.id !== 'unit:t1'))
    await settle(10_000)
    expect([...select('Play source').querySelectorAll('option')].map(o => o.value)).not.toContain('unit:t1')
    expect(select('Play source').value).toBe('main')
    expect(statusLine()).toBe('That source is gone. Pick another one.')
    api.playerSourceAvailable.mockImplementation(async () => true); api.playerSources.mockImplementation(async () => SOURCES)
  })

  it('answers a pick of a source that vanished since the list was read on the status line, not with a Play', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 7, source: { path: 'C:/games/game' } }
    api.playerSourceAvailable.mockImplementation(async () => false)
    await mount()
    await choose('Play source', 'unit:t1'); await settle()
    expect(statusLine()).toBe('That source is gone. Pick another one.')
    // A problem while the game shows: the same centered line, on a dark backing over the picture.
    expect(host.querySelector('.play-screen > .play-status.over.alert-text')).not.toBeNull()
    expect(api.playerInstanceEnterPlay).not.toHaveBeenCalled()
    api.playerSourceAvailable.mockImplementation(async () => true)
  })

  it('offers Try again after an unexpected failure, keeping the detail for Genio', async () => {
    status = { state: 'error', project: 'C:/games/game', message: 'Play hit an unexpected problem: boom. Retry, or Stop Unity.' }
    await mount()
    expect(statusLine()).toBe('Play failed.Try again')
    expect(text()).not.toContain('boom')
    expect(facts()).toContainEqual({ label: 'Status', value: 'Play failed. · Play hit an unexpected problem: boom. Retry, or Stop Unity.' })
    await click('Try again')
    expect(api.playerInstanceEnterPlay).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, {})
  })
})
