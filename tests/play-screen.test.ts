// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerInstanceStatus, PlayerSourceOption } from '../src/shared/play'

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
import { clock, firstCopyWarning, progressText, sourceText, stepIndex, syncSummary } from '../src/renderer/src/lib/play-screen'
import { copyMinutes } from '../src/shared/play'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const SOURCES: PlayerSourceOption[] = [
  { id: 'main', group: 'main', label: 'Main checkout', source: { path: 'C:/games/game' }, branch: 'main', head: 'a'.repeat(40), dirty: 0 },
  { id: 'worktree:C:/games/game-fog', group: 'worktree', label: 'game-fog', source: { path: 'C:/games/game-fog' }, branch: 'feat/fog', dirty: 1 },
  { id: 'unit:t1', group: 'unit', label: 'Ranger (lairs AI)', task: 't1', source: { path: 'C:/units/lairs' }, branch: 'genio/lairs-ai', dirty: 3 },
  { id: 'branch:develop', group: 'branch', label: 'develop', source: { ref: 'develop' }, branch: 'develop', head: '6ff3823aaaa' }
]
const copy = (extra: object = {}) => ({ version: 1, key: 'k', id: 'c1', project: 'C:/games/game', engineRoot: '', dir: 'D:/copy', root: 'D:/copy/p', state: 'ready', createdAt: NOW, idleMs: 600000, ...extra })
let status: PlayerInstanceStatus
let root: Root, host: HTMLDivElement
const api = {
  playerInstanceStatus: vi.fn(async () => status), playerSources: vi.fn(async () => SOURCES),
  playerInstanceMachine: vi.fn(async () => ({ settings: { idleMinutes: 10, maxEditors: 2 } })),
  playerCopySizes: vi.fn(async () => ({ exists: false, estimate: { projectBytes: 40e9, libraryBytes: 15e9, totalBytes: 55e9, files: 1000 } })),
  playerInstancePlay: vi.fn(async () => status), playerInstanceStop: vi.fn(async () => status), playerInstanceRestart: vi.fn(async () => status),
  playerInstanceQuit: vi.fn(async () => status), playerInstanceKeepAlive: vi.fn(async () => status),
  playerInstanceConsole: vi.fn(async () => ({ entries: [{ message: 'Assets/Code.cs(3,1): error CS1002: ; expected', level: 'Error', seq: 1 }], cursor: 1, session: 's' })),
  playerInstanceDialogShot: vi.fn(async () => 'data:image/png;base64,AAAA'),
  playerInstanceStream: vi.fn(async () => undefined), featureUsed: vi.fn(async () => undefined)
}
const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
const click = async (label: string) => { await act(async () => button(label).click()) }
const mount = async () => { await act(async () => root.render(React.createElement(Play))); await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api } })
  status = { state: 'idle', project: 'C:/games/game' }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); vi.useRealTimers() })

describe('Play screen', () => {
  it('offers main, worktrees, units by name and branches, and warns before the first copy', async () => {
    await mount()
    const select = host.querySelector('select[aria-label="Play source"]') as HTMLSelectElement
    expect([...select.querySelectorAll('optgroup')].map(g => g.label)).toEqual(['Main checkout', 'Your worktrees', 'Units', 'Branches (played from commits)'])
    expect([...select.options].map(o => o.textContent)).toEqual([
      'Main checkout · main · clean', 'game-fog · feat/fog · 1 uncommitted', 'Ranger (lairs AI) · genio/lairs-ai · 3 uncommitted', 'develop @ 6ff3823'
    ])
    expect(select.value).toBe('main')
    expect(text()).toContain('No instance')
    expect([...host.querySelectorAll('.play-steps li')].map(l => l.textContent)).toEqual(['Copy · sync', 'Start Unity', 'Enter Play', 'Playing', 'Stopped, warm', 'Quit · delete copy'])
    await act(async () => { select.value = 'unit:t1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Play')
    expect(api.playerInstancePlay).not.toHaveBeenCalled()
    expect(text()).toContain('The first Play of this project copies about 51.2 GB and takes about 13–20 min')
    await click('Copy and Play')
    expect(api.playerInstancePlay).toHaveBeenCalledWith('game', { path: 'C:/units/lairs' }, {})
  })

  it('links its idle time and editor limit to Settings › Unity & Play, where they apply to all projects', async () => {
    await mount()
    await click('Idle time and editor limit')
    expect(nav.section).toHaveBeenCalledWith('play', 'player-instance')
    expect(nav.go).toHaveBeenCalledWith('systems')
  })

  it('shows copy progress with sizes and the lifecycle step while copying', async () => {
    status = { state: 'copying', project: 'C:/games/game', copy: copy({ state: 'syncing', progress: { phase: 'copying', startedAt: NOW - 60_000, bytes: { done: 4 * 2 ** 30, total: 16 * 2 ** 30 }, files: { done: 1200, total: 5000 } } }) as never }
    await mount()
    expect(text()).toContain('Copying 4.0 GB / 16.0 GB · 1,200 / 5,000 files · about 3 min left')
    expect(host.querySelector('.play-steps li.on')?.textContent).toBe('Copy · sync')
    expect(button('Play').disabled).toBe(true)
    expect(button('Stop').disabled).toBe(false)
  })

  it('counts down to deletion after Stop, keeps it warm longer or quits now', async () => {
    status = { state: 'ready', project: 'C:/games/game', source: { path: 'C:/games/game' }, stoppedAt: NOW - 138_000, deadline: NOW + 462_000, pid: 7, copy: copy({ lastSync: { at: NOW, complete: true, elapsedMs: 1200, files: { source: 9, unchanged: 0, added: 1, updated: 30, restored: 0, deleted: 0, unityMadeDeleted: 0, unityMadeKept: 0 }, bytes: { copied: 12 * 2 ** 20, deleted: 0 }, source: { kind: 'checkout', path: 'C:/games/game', branch: 'main', head: 'b'.repeat(40) } } }) as never }
    await mount()
    expect(text()).toContain('the instance is deleted in 7:42')
    expect(text()).toContain('synced 31 files (12 MB) in 1.2 s')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(text()).toContain('deleted in 7:40')
    expect(getScreenContext('play')?.facts).toContainEqual({ label: 'Idle', value: 'Unity quits and the copy is deleted in 7:40' })
    await click('Keep 10 more min')
    expect(api.playerInstanceKeepAlive).toHaveBeenCalledWith('game')
    await click('Quit now')
    expect(api.playerInstanceQuit).toHaveBeenCalledWith('game')
  })

  it('turns the Unity button into Start anyway on low memory, with Cancel, and Open this instance visibly on a stuck dialog', async () => {
    const lowMemory = { availableBytes: 3.3 * 2 ** 30, neededBytes: 6 * 2 ** 30, hard: false, consumers: [{ name: 'lands-of-old editor', bytes: 13.5 * 2 ** 30 }], closed: [] }
    status = { state: 'low-memory', project: 'C:/games/game', copy: copy() as never, lowMemory, message: '3.3 GB available; Unity needs about 6.0 GB. Biggest: lands-of-old editor 13.5 GB. Close something, or Start anyway.' }
    await mount()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Biggest: lands-of-old editor 13.5 GB')
    expect(host.querySelector('.play-buttons')?.textContent).toContain('Start anyway')
    await click('Cancel')
    expect(api.playerInstanceStop).toHaveBeenCalledWith('game')
    await click('Start anyway')
    expect(api.playerInstancePlay).toHaveBeenCalledWith('game', { path: 'C:/games/game' }, { startAnyway: true })

    status = { ...status, lowMemory: { ...lowMemory, hard: true, commitBytes: 5 * 2 ** 30 }, message: 'Windows cannot commit enough memory for Unity' }
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(host.querySelector('.play-buttons')?.textContent).not.toContain('Start anyway')

    status = { state: 'stuck-dialog', project: 'C:/games/game', source: { ref: 'develop' }, pid: 9, copy: copy() as never, message: 'Unity is waiting on a licence prompt',
      dialog: { hwnd: '1', pid: 9, title: 'Unity Licensing', text: 'Sign in to continue', buttons: ['OK', 'Cancel'], rule: 'licence', reason: 'licence', screenshot: 'D:/x/blocked-1.png', message: 'Unity is waiting on a licence prompt' } }
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(text()).toContain('Unity Licensing')
    expect(text()).toContain('Buttons: OK · Cancel')
    expect(host.querySelector('.play-dialog img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.play-callout button')].find(b => b.textContent === 'Open this instance visibly')!.click())
    expect(api.playerInstanceRestart).toHaveBeenCalledWith('game', true)
  })

  it('opens the console drawer on compile errors', async () => {
    status = { state: 'compile-errors', project: 'C:/games/game', pid: 4, copy: copy() as never, message: 'Fix the compile errors in the source, then Play again.' }
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.playerInstanceConsole).toHaveBeenCalledWith('game', undefined, undefined)
    expect(host.querySelector('.play-console-body')?.textContent).toContain('error CS1002')
    expect(button('Play').disabled).toBe(false)
  })

  it('streams while playing, notes legacy input, and stops Play when the screen closes', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: false }, copy: copy() as never }
    await mount()
    expect(api.playerInstanceStream).toHaveBeenCalledWith('game', true, 1280, 720)
    expect(text()).toContain('legacy input, so it is view-only')
    expect(host.querySelector('.play-steps li.on')?.textContent).toBe('Playing')
    await act(async () => root.render(null))
    expect(api.playerInstanceStream).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.playerInstanceStream).toHaveBeenLastCalledWith('game', false)
  })

  it('keeps playing through a StrictMode remount of the live view', async () => {
    status = { state: 'playing', project: 'C:/games/game', pid: 4, source: { path: 'C:/games/game' }, capabilities: { input: true }, copy: copy() as never }
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Play))))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
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
  it('formats the countdown, steps, progress, sync and first-copy warning', () => {
    expect(clock(462_000)).toBe('7:42')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(-5)).toBe('0:00')
    expect(stepIndex('syncing')).toBe(0)
    expect(stepIndex('crashed')).toBe(-1)
    expect(progressText({ phase: 'scanning', startedAt: NOW }, NOW)).toBe('Comparing files with the source')
    expect(progressText({ phase: 'library', startedAt: NOW, bytes: { done: 0, total: 2 ** 30 } }, NOW + 1000)).toBe('Seeding the Library 0 KB / 1.0 GB')
    expect(syncSummary({ lastSync: { at: 0, complete: true, elapsedMs: 15_400, files: { source: 1, unchanged: 1, added: 0, updated: 0, restored: 0, deleted: 0, unityMadeDeleted: 0, unityMadeKept: 0 } } } as never)).toBe('already in sync (15 s)')
    expect(firstCopyWarning(3.6e9, 10)).toContain('about 3.4 GB and takes about 1 min')
    expect(copyMinutes(55e9)).toEqual({ min: 13, max: 20 })
    expect(sourceText({ id: 'w', group: 'worktree', label: 'x', source: { path: 'x' }, head: 'c'.repeat(40) })).toBe('x · detached ccccccc')
  })
})
