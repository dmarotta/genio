// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project, Task, TerminalInfo } from '../src/shared/types'
import { UNIT_ACTION_HINT } from '../src/shared/unit-actions'

// The agent terminal is xterm; here it only records how the page mounts it.
vi.mock('../src/renderer/src/components/Terminal', () => ({
  TerminalView: (p: { id: string; passive?: boolean; interactive?: boolean; autoFocus?: boolean }) =>
    React.createElement('div', { className: 'term-mock', 'data-id': p.id, 'data-passive': String(!!p.passive), 'data-interactive': String(p.interactive ?? true), 'data-autofocus': String(!!p.autoFocus) })
}))
import { Squad } from '../src/renderer/src/views/Squad'
import { getState, setState } from '../src/renderer/src/store'

const initial = getState()
let root: Root, host: HTMLDivElement
const calls = new Map<string, ReturnType<typeof vi.fn>>()
const apiCall = (name: string): ReturnType<typeof vi.fn> => {
  if (!calls.has(name)) calls.set(name, vi.fn(async () => (name === 'terminalOpenShell' ? { id: 'shell-1' } : name === 'readTaskFile' ? '' : { ok: true, message: 'ok' })))
  return calls.get(name)!
}

const NOW = '2026-10-13T12:00:00Z'
const project = { name: 'world', path: 'C:/games/world', engine: 'other', commands: { run: 'npm run dev' }, defaultBranch: 'main', mode: 'local-only',
  forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '', gitRepo: true } as unknown as Project
const unit = (patch: Partial<Task> = {}): Task => ({ id: 'u1', title: 'Fix the jump', kind: 'ship', state: 'working', project: 'world', wksp: 'main',
  mode: 'local-only', harness: 'claude', branch: 'genio/u1', baseBranch: 'main', worktree: 'C:/wt/u1', relaunches: 0,
  createdAt: '2026-10-13T11:00:00Z', updatedAt: '2026-10-13T11:30:00Z', ...patch } as Task)
const pty = (patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 'pty-1', taskId: 'u1', title: 'u1', cwd: 'C:/wt/u1', alive: true, cols: 120, rows: 32, kind: 'worker', ...patch })

async function open(t: Task, terminals: TerminalInfo[] = []): Promise<void> {
  setState({ ...initial, focus: { type: 'task', id: t.id }, terminals: Object.fromEntries(terminals.map((x) => [x.id, x])),
    snap: { ...initial.snap, tasks: [t], projects: [project] } })
  await act(async () => root.render(React.createElement(Squad)))
}
const toolbar = (): string[] => [...host.querySelectorAll('.detail-toolbar button')].map((b) => b.textContent!.trim())
const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!
const badge = (): Element => host.querySelector('.detail-kicker .chip:nth-child(2)')!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  calls.clear()
  Object.assign(window, { genio: { on: () => () => {}, api: new Proxy({}, { get: (_, name: string) => apiCall(name) }) } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  setState(initial)
  vi.useRealTimers()
})

describe('unit page toolbar', () => {
  it('has no Playtest or manual Gauntlet, and explains Respawn, Recall and Despawn in one line each', async () => {
    await open(unit({ terminalId: 'pty-1' }), [pty()])
    expect(toolbar()).toEqual(['Interrupt', 'Recall', 'Respawn', 'Folder', 'Shell', 'Despawn'])
    expect(host.textContent).not.toMatch(/Playtest/)
    expect(button('Respawn').title).toBe(UNIT_ACTION_HINT.respawn)
    expect(button('Recall').title).toBe(UNIT_ACTION_HINT.recall)
    expect(button('Despawn').title).toBe(UNIT_ACTION_HINT.despawn)
    for (const hint of [UNIT_ACTION_HINT.respawn, UNIT_ACTION_HINT.recall, UNIT_ACTION_HINT.despawn]) expect(hint).not.toMatch(/\n/)
    expect(calls.has('validateTask')).toBe(false)
    expect(calls.has('playtest')).toBe(false)
  })

  it('drops the debug crew line and keeps the agent terminal primary, watched without focus or resize', async () => {
    await open(unit({ terminalId: 'pty-1' }), [pty()])
    expect(host.textContent).not.toMatch(/state: .* source:/)
    expect(calls.has('crewState')).toBe(false)
    const term = host.querySelector('.detail-term .term-mock')!
    expect([term.getAttribute('data-passive'), term.getAttribute('data-interactive'), term.getAttribute('data-autofocus')]).toEqual(['true', 'true', 'false'])
    expect(badge().textContent).toBe('WORKING')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('working 1 h 00 min')
    expect(button('Respawn').disabled).toBe(false)
  })

  it('gives a finished unit\'s page to its content: no No-signal panel, the clock stopped, Respawn off on a ready Build', async () => {
    await open(unit({ state: 'ready', readyAt: '2026-10-13T11:54:00Z' }))
    expect(host.querySelector('.no-signal')).toBeNull()
    expect(host.querySelector('.detail-term')).toBeNull()
    expect(host.querySelector('.detail-body')!.classList.contains('no-term')).toBe(true)
    expect(badge().textContent).toBe('READY TO MERGE')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('took 54 min')
    expect(toolbar()).toContain('Merge')
    expect(button('Respawn').disabled).toBe(true)
    expect(button('Recall').disabled).toBe(true)
  })

  it('shows FAILED with its reason, and lets a failed unit respawn', async () => {
    await open(unit({ state: 'failed', stateReason: 'usage limit reached', finishedAt: '2026-10-13T11:20:00Z' }))
    expect(badge().textContent).toBe('FAILED')
    expect(badge().className).toContain('alert')
    expect(host.querySelector('.detail-reason')?.textContent).toBe('usage limit reached')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('took 20 min')
    await act(async () => button('Respawn').click())
    expect(calls.get('controlTask')).toHaveBeenCalledWith('u1', 'relaunch')
  })

  it('shows MERGED for a landed, despawned Build with every control off', async () => {
    await open(unit({ state: 'cleaned', landedAt: '2026-10-13T11:40:00Z', finishedAt: '2026-10-13T11:40:00Z', cleanedAt: '2026-10-13T11:41:00Z' }))
    expect(badge().textContent).toBe('MERGED')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('took 40 min')
    expect([...host.querySelectorAll<HTMLButtonElement>('.detail-toolbar button')].every((b) => b.disabled)).toBe(true)
  })

  it('opens a Recon\'s report first, offers Upgrade to Build, and never Respawn on a finished Recon', async () => {
    await open(unit({ kind: 'scout', state: 'done', reportPath: 'C:/r.md' }))
    expect(toolbar()).toEqual(['Interrupt', 'Recall', 'Respawn', 'Upgrade to Build', 'Folder', 'Shell', 'Despawn'])
    expect(button('Respawn').disabled).toBe(true)
    expect(host.querySelector('.detail-side-tabs .tab.on')?.textContent).toBe('Report')
    expect(calls.get('readTaskFile')).toHaveBeenCalledWith('u1', 'report')
  })

  it('opens Shell tied to the unit', async () => {
    await open(unit({ terminalId: 'pty-1' }), [pty()])
    await act(async () => button('Shell').click())
    expect(calls.get('terminalOpenShell')).toHaveBeenCalledWith(undefined, 'u1')
    expect(getState().focus).toEqual({ type: 'terminal', id: 'shell-1' })
  })

  it('warns before despawning a Build with an open PR, and says Recall does not stick', async () => {
    await open(unit({ state: 'ready', mode: 'direct-PR', pr: { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN' } }))
    await act(async () => button('Despawn').click())
    expect(document.querySelector('.despawn-pr')?.textContent).toContain('PR #7 is still open')
    await act(async () => button('Cancel').click())
    await open(unit({ state: 'ready', readyAt: NOW }))
    await act(async () => button('Despawn').click())
    expect(document.querySelector('.despawn-pr')).toBeNull()
    await act(async () => button('Cancel').click())
    await open(unit({ terminalId: 'pty-1' }), [pty()])
    await act(async () => button('Recall').click())
    expect(document.body.textContent).toContain('reopening the project respawns it automatically')
    expect(document.body.textContent).not.toContain('respawn any time')
  })

  it('keeps every side tab one click away in narrow windows, with the terminal as the default pane', async () => {
    await open(unit({ terminalId: 'pty-1' }), [pty()])
    const strip = (): string[] => [...host.querySelectorAll('.detail-switch .tab')].map((t) => t.textContent!)
    expect(strip()).toEqual(['Terminal', 'Brief', 'Timeline', 'Pings', 'Diff', 'Gauntlet'])
    const body = host.querySelector('.detail-body')!
    expect(body.classList.contains('pane-terminal')).toBe(true)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.detail-switch .tab')].find((t) => t.textContent === 'Diff')!.click())
    expect(body.classList.contains('pane-side')).toBe(true)
    expect(host.querySelector('.detail-side-tabs .tab.on')?.textContent).toBe('Diff')
  })
})
