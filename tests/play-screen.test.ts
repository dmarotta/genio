// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerInstanceStatus, PlayerScene, PlayerSourceOption } from '../src/shared/play'

// A fake player backend: no main process, no Unity. The screen only talks to window.genio.api.
const nav = vi.hoisted(() => ({ go: vi.fn(), section: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WINDOW: 'game', go: nav.go, api: () => (window as unknown as { genio: { api: unknown } }).genio.api,
  errText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
vi.mock('../src/renderer/src/views/Systems', () => ({ requestSystemsSection: nav.section }))
import { Play } from '../src/renderer/src/views/Play'
import { PlayLive } from '../src/renderer/src/views/PlayLive'
import { getScreenContext } from '../src/renderer/src/lib/screen-context'
import { chipText, clock, firstCopyText, progressText, sourceText, statusText, syncSummary } from '../src/renderer/src/lib/play-screen'
import { copyMinutes } from '../src/shared/play'

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
let status: PlayerInstanceStatus
let root: Root, host: HTMLDivElement
const ok = () => vi.fn(async () => status)
const api = {
  playerInstanceStatus: ok(), playerSources: vi.fn(async () => SOURCES),
  playerInstanceMachine: vi.fn(async () => ({ settings: { idleMinutes: 10, maxEditors: 2 } })),
  playerCopySizes: vi.fn(async () => ({ exists: false, estimate: { projectBytes: 40e9, libraryBytes: 15e9, totalBytes: 55e9, files: 1000 } })),
  playerInstanceStartUnity: ok(), playerInstanceEnterPlay: ok(), playerInstanceExitPlay: ok(), playerInstanceStopUnity: ok(),
  playerInstancePause: ok(), playerInstanceStep: ok(), playerInstanceSetScene: ok(), playerInstanceResize: ok(),
  playerInstanceScenes: vi.fn(async () => SCENES),
  playerInstanceRestart: ok(), playerInstanceKeepAlive: ok(),
  playerInstanceConsole: vi.fn(async () => ({ entries: [{ message: 'Assets/Code.cs(3,1): error CS1002: ; expected', level: 'Error', seq: 1 }], cursor: 1, session: 's' })),
  playerInstanceDialogShot: vi.fn(async () => 'data:image/png;base64,AAAA'),
  playerInstanceStream: vi.fn(async () => undefined), featureUsed: vi.fn(async () => undefined)
}
const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
const click = async (label: string) => { await act(async () => button(label).click()) }
const select = (label: string) => host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
const choose = async (label: string, value: string) => { await act(async () => { const s = select(label); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })) }) }
const statusLine = () => host.querySelector('[role=status]')?.textContent ?? ''
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
  it('keeps only the header chip, one toolbar and one status line, and starts Unity or Play without a copy prompt', async () => {
    await mount()
    const source = select('Play source')
    expect([...source.querySelectorAll('optgroup')].map(g => g.label)).toEqual(['Main checkout', 'Your worktrees', 'Units', 'Branches (played from commits)'])
    expect([...source.querySelectorAll('optgroup option')].map(o => o.textContent)).toEqual([
      'Main checkout · main · clean', 'game-fog · feat/fog · 1 uncommitted', 'Ranger (lairs AI) · genio/lairs-ai · 3 uncommitted', 'develop @ 6ff3823'
    ])
    expect(source.value).toBe('main')
    expect(host.querySelector('.play-chip > span')?.textContent).toBe('main')
    expect(statusLine()).toBe('Unity is off')
    expect([...host.querySelectorAll('[role=toolbar] button')].map(b => b.getAttribute('aria-label'))).toEqual(['Start Unity', 'Enter Play', 'Pause', 'Step'])
    expect(button('Pause').disabled).toBe(true)
    expect(button('Step').disabled).toBe(true)
    // Removed: Ask Genio, the step tracker, the first-copy confirm, the footer and the inline console.
    expect(text()).not.toContain('Ask Genio')
    expect(host.querySelector('.play-steps, .play-foot, .play-console, [role=alertdialog]')).toBeNull()
    expect(facts()).toContainEqual({ label: 'First start', value: 'Copies the project first: about 51.2 GB, about 13–20 min' })

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

  it('turns the status line into a progress bar while copying, with Cancel on the Unity button', async () => {
    status = { state: 'copying', project: 'C:/games/game', copy: copy({ state: 'syncing', progress: { phase: 'copying', startedAt: NOW - 60_000, bytes: { done: 4 * 2 ** 30, total: 16 * 2 ** 30 }, files: { done: 1200, total: 5000 } } }) as never }
    await mount()
    expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(statusLine()).toBe('Copying · 4.0 of 16.0 GB · about 3 min left')
    expect(facts()).toContainEqual({ label: 'Copy progress', value: 'Copying · 4.0 of 16.0 GB · about 3 min left' })
    expect(button('Enter Play').disabled).toBe(true)
    await click('Cancel')
    expect(api.playerInstanceStopUnity).toHaveBeenCalledWith('game')
  })

  it('shows Unity ready with a dim idle countdown that keeps it open, and stops Unity', async () => {
    status = { state: 'ready', project: 'C:/games/game', source: { path: 'C:/games/game' }, stoppedAt: NOW - 138_000, deadline: NOW + 462_000, pid: 7, unityVersion: '6000.3.1f1', copy: copy(synced) as never }
    await mount()
    expect(statusLine()).toBe('Unity readyquits in 7:42 if idle')
    expect(text()).not.toContain('synced 31 files')
    await settle(2000)
    expect(text()).toContain('quits in 7:40 if idle')
    expect(facts()).toContainEqual({ label: 'Idle', value: 'Unity quits and the copy is deleted in 7:40 if idle' })
    expect(facts()).toContainEqual({ label: 'Playing from', value: 'main @ bbbbbbb · synced 31 files (12 MB) in 1.2 s' })
    expect(facts()).toContainEqual({ label: 'Unity', value: '6000.3.1f1' })
    await click('quits in 7:40 if idle')
    expect(api.playerInstanceKeepAlive).toHaveBeenCalledWith('game')
    expect(button('Enter Play').disabled).toBe(false)
    await click('Stop Unity')
    expect(api.playerInstanceStopUnity).toHaveBeenCalledWith('game')
    await choose('Scene', 'Assets/Scenes/Menu.unity')
    expect(api.playerInstanceSetScene).toHaveBeenCalledWith('game', 'Assets/Scenes/Menu.unity')
  })

  it('asks on low memory with Start anyway on the Unity button and on ▶, and drops it when Windows cannot commit', async () => {
    const lowMemory = { availableBytes: 3.3 * 2 ** 30, neededBytes: 6 * 2 ** 30, hard: false, consumers: [{ name: 'lands-of-old editor', bytes: 13.5 * 2 ** 30 }], closed: [] }
    status = { state: 'low-memory', project: 'C:/games/game', copy: copy() as never, lowMemory, message: '3.3 GB available; Unity needs about 6.0 GB. Biggest: lands-of-old editor 13.5 GB.' }
    await mount()
    expect(statusLine()).toContain('Biggest: lands-of-old editor 13.5 GB')
    expect(facts()).toContainEqual({ label: 'Memory', value: status.message })
    await click('Start anyway')
    expect(api.playerInstanceStartUnity).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, { startAnyway: true })
    await click('Enter Play')
    expect(api.playerInstanceEnterPlay).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, { startAnyway: true })

    status = { ...status, lowMemory: { ...lowMemory, hard: true, commitBytes: 5 * 2 ** 30 }, message: 'Windows cannot commit enough memory for Unity' }
    await settle(3000)
    expect(host.querySelector('[role=toolbar]')?.textContent).not.toContain('Start anyway')
    expect(button('Start Unity').disabled).toBe(false)
  })

  it('restarts Unity from the Unity button on a stuck dialog and shows the dialog in place of the game', async () => {
    status = { state: 'stuck-dialog', project: 'C:/games/game', source: { ref: 'develop' }, pid: 9, copy: copy() as never, message: 'Unity is waiting on a licence prompt',
      dialog: { hwnd: '1', pid: 9, title: 'Unity Licensing', text: 'Sign in to continue', buttons: ['OK', 'Cancel'], rule: 'licence', reason: 'licence', screenshot: 'D:/x/blocked-1.png', message: 'Unity is waiting on a licence prompt' } }
    await mount()
    expect(statusLine()).toBe('A Unity dialog is blocking the editor: Unity Licensing')
    expect(text()).toContain('Buttons: OK · Cancel')
    expect(host.querySelector('.play-dialog img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(facts()).toContainEqual({ label: 'Blocking dialog', value: 'Unity Licensing: Sign in to continue' })
    await click('Restart Unity')
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game')
    await click('Open Unity visibly')
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game', true)
  })

  it('names a crash in one line and offers Start Unity again', async () => {
    status = { state: 'crashed', project: 'C:/games/game', exitCode: 1, copy: copy() as never, message: 'Unity exited' }
    await mount()
    expect(statusLine()).toBe('Unity closed unexpectedly (exit 1)')
    expect(button('Start Unity').disabled).toBe(false)
    expect(button('Enter Play').disabled).toBe(false)
  })

  it('opens the console drawer by itself on compile errors', async () => {
    status = { state: 'compile-errors', project: 'C:/games/game', pid: 4, copy: copy() as never, message: 'Fix the compile errors in the source, then Play again.' }
    await mount()
    await settle()
    expect(statusLine()).toBe('Compile errorsShow console')
    expect(api.playerInstanceConsole).toHaveBeenCalledWith('game', undefined, undefined)
    expect(host.querySelector('.play-console-body')?.textContent).toContain('error CS1002')
    expect(facts()).toContainEqual({ label: 'Last console error', value: 'Assets/Code.cs(3,1): error CS1002: ; expected' })
    expect(button('Enter Play').disabled).toBe(false)
    await click('Close the console')
    expect(host.querySelector('.play-console')).toBeNull()
  })

  it('keeps Restart, Open visibly, the console and Settings › Unity & Play in the ⋯ menu', async () => {
    status = { state: 'ready', project: 'C:/games/game', source: { path: 'C:/games/game' }, pid: 7, copy: copy() as never }
    await mount()
    await click('More Play actions')
    expect([...host.querySelectorAll('[role=menuitem]')].map(b => b.textContent)).toEqual(['Restart Unity', 'Open Unity visibly (debug)', 'Unity console', 'Idle time and editor limit…'])
    await click('Open Unity visibly (debug)')
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game', true)
    await click('More Play actions')
    await click('Unity console')
    expect(host.querySelector('.play-console')).not.toBeNull()
    await click('More Play actions')
    await click('Idle time and editor limit…')
    expect(nav.section).toHaveBeenCalledWith('play', 'player-instance')
    expect(nav.go).toHaveBeenCalledWith('systems')
  })

  it('pauses, steps, resizes without reconnecting, re-plays on a new scene or source, and exits Play', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, scene: 'Assets/Scenes/Arena.unity', capabilities: { input: true }, copy: copy(synced) as never }
    await mount()
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 1280, 720)
    expect(statusLine()).toBe('Playing · main @ bbbbbbb · Arena')
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

  it('marks Pause pressed while paused and follows Unity\'s Play shortcuts outside the game', async () => {
    status = { state: 'paused', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
    await mount()
    expect(button('Resume').getAttribute('aria-pressed')).toBe('true')
    const key = async (init: KeyboardEventInit) => { await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, ...init }))) }
    await key({ shiftKey: true })
    expect(api.playerInstancePause).toHaveBeenCalledWith('game')
    await key({ altKey: true })
    expect(api.playerInstanceStep).toHaveBeenCalledWith('game')
    await key({})
    expect(api.playerInstanceExitPlay).toHaveBeenCalledWith('game')
  })

  it('streams the saved resolution, notes legacy input, and exits Play when the screen closes', async () => {
    localStorage.setItem('genio.play.resolution.game', '640x360')
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: false }, copy: copy() as never }
    await mount()
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 640, 360)
    expect(text()).toContain('View only: this game reads legacy input')
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

  it('does not stop the next Play when main closed the stream first', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
    const channel = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((e: { data: unknown }) => Promise<void>) | null }
    await mount()
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'genio:play-port', world: 'game' }, ports: [channel as unknown as MessagePort] })))
    await act(async () => channel.onmessage!({ data: { type: 'closed' } }))
    expect(text()).toContain('The live stream ended.')
    expect(api.playerInstanceStream).toHaveBeenCalledTimes(1)
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

describe('Play screen helpers', () => {
  it('formats the countdown, progress, status line, chip, sync and first copy', () => {
    expect(clock(462_000)).toBe('7:42')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(-5)).toBe('0:00')
    expect(progressText({ phase: 'scanning', startedAt: NOW }, NOW)).toBe('Comparing files')
    expect(progressText({ phase: 'copying', startedAt: NOW - 60_000, bytes: { done: 120 * 2 ** 20, total: 253 * 2 ** 20 } }, NOW)).toBe('Copying · 120 of 253 MB · about 2 min left')
    expect(progressText({ phase: 'library', startedAt: NOW, bytes: { done: 512 * 2 ** 20, total: 2 ** 31 } }, NOW + 1000)).toBe('Seeding the Library · 512 MB of 2.0 GB')
    expect(statusText({ state: 'idle', project: 'p' })).toBe('Unity is off')
    expect(statusText({ state: 'paused', project: 'p', copy: copy({ source: { kind: 'ref', ref: 'develop', commit: 'c0ffee12' } }) as never }, 'Arena')).toBe('Paused · develop @ c0ffee1 · Arena')
    expect(statusText({ state: 'limit-reached', project: 'p', message: '2 Unity editors already open' })).toBe('2 Unity editors already open')
    expect(chipText(SOURCES[0])).toBe('main')
    expect(chipText(SOURCES[2])).toBe('Ranger (lairs AI)')
    expect(syncSummary({ lastSync: { at: 0, complete: true, elapsedMs: 15_400, files: { source: 1, unchanged: 1, added: 0, updated: 0, restored: 0, deleted: 0, unityMadeDeleted: 0, unityMadeKept: 0 } } } as never)).toBe('already in sync (15 s)')
    expect(firstCopyText(3.6e9)).toBe('about 3.4 GB, about 1 min')
    expect(copyMinutes(55e9)).toEqual({ min: 13, max: 20 })
    expect(sourceText({ id: 'w', group: 'worktree', label: 'x', source: { path: 'x' }, head: 'c'.repeat(40) })).toBe('x · detached ccccccc')
  })
})
