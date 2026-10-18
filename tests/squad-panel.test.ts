// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Task, TerminalInfo } from '../src/shared/types'
import { Roster } from '../src/renderer/src/components/SquadPanel'
import { boot, despawnUnit, getState, handleEvent, setState, squadRoster } from '../src/renderer/src/store'
import { DONE_HISTORY } from '../src/shared/squad-display'

const initial = getState()
let root: Root, host: HTMLDivElement
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, kind: 'ship', state: 'working', project: 'world',
  createdAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T10:00:00Z', ...patch } as Task)
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  setState({ ...initial, snap: { ...initial.snap, tasks: [task('Build'), task('Recon', { kind: 'scout' }), task('Ready', { state: 'ready' })] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })

it('moves a finished unit below active units, keeps its outcome and opens its page', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.num')).toBeNull()
  expect([...host.querySelectorAll('.roster-state')].map(n => n.textContent)).toEqual(['WORKING', 'WORKING', 'READY TO MERGE'])
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--blue')
  await act(async () => {
    handleEvent({ type: 'task', task: task('Build', { state: 'merged', finishedAt: '2026-10-13T10:05:00Z' }) })
    handleEvent({ type: 'task', task: task('Recon', { state: 'needs-decision', kind: 'scout' }) })
  })
  expect([...host.querySelectorAll('.roster-title')].map(n => n.textContent)).toEqual(['Recon', 'Ready', 'Build'])
  // the Recon asking the player keeps its purple and gains the yellow indicator
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--violet')
  expect(host.querySelector('.roster-state')?.textContent).toBe('WORKING')
  expect(host.querySelector('.roster-state .needs-you.amber')).not.toBeNull()
  expect(host.querySelector('.roster-done .roster-state')?.textContent).toBe('MERGED')
  expect(host.querySelector('.roster-done .dot.pulse')).toBeNull()
  expect(host.textContent).not.toContain('Killfeed')
  expect('feed' in getState()).toBe(false)
  expect(getState().snap.tasks.find(t => t.id === 'Build')?.state).toBe('merged')
  await act(async () => (host.querySelector('.roster-row') as HTMLButtonElement).click())
  expect(getState().focus).toEqual({ type: 'task', id: 'Recon' })
  await act(async () => (host.querySelector('.done-row') as HTMLButtonElement).click())
  expect(getState().focus).toEqual({ type: 'task', id: 'Build' })
})

it('a row is the title, the kind, the state and how long the unit has run: no project, plan step or tooltip', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-13T10:12:30Z'))
  try {
    await act(async () => root.render(React.createElement(Roster)))
    const row = host.querySelector('.roster-row')!
    expect(row.querySelector('.roster-sub')?.textContent?.trim()).toBe('Build')
    expect(row.textContent).not.toMatch(/world/)
    expect(row.getAttribute('title')).toBeNull()
    // the same clock as the unit page, short: live while working, stopped at the ready time
    expect([...host.querySelectorAll('.roster-right .mono')].map(n => n.textContent)).toEqual(['1h 12m 30s', '1h 12m 30s', '1h 0m 0s'])
  } finally { vi.useRealTimers() }
})

it('says so in one line when no unit is deployed and no history remains', async () => {
  setState({ snap: { ...getState().snap, tasks: [task('Despawned', { state: 'cleaned' })] } })
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.side-empty')?.textContent).toBe('No units deployed.')
  expect(host.querySelector('button')).toBeNull()
})

it('ticks seconds in every working row and freezes each clock at its ready time', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-13T10:08:03Z') })
  const clocks = (): (string | null)[] => [...host.querySelectorAll('.roster-right .mono')].map(n => n.textContent)
  try {
    await act(async () => root.render(React.createElement(Roster)))
    expect(clocks()).toEqual(['1h 8m 3s', '1h 8m 3s', '1h 0m 0s'])
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(clocks()).toEqual(['1h 8m 4s', '1h 8m 4s', '1h 0m 0s'])
    await act(async () => handleEvent({ type: 'task', task: task('Build', { state: 'ready', readyAt: new Date().toISOString() }) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(clocks()).toEqual(['1h 8m 4s', '1h 8m 6s', '1h 0m 0s'])
  } finally {
    await act(async () => root.render(null))
    vi.useRealTimers()
  }
})

it('shows the newest 25 finished rows with frozen durations and no trimmed details', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
  try {
    const done = Array.from({ length: DONE_HISTORY + 4 }, (_, i) => task(`Done-${i}`, {
      state: i % 2 ? 'failed' : 'done', kind: i % 2 ? 'ship' : 'scout',
      finishedAt: new Date(Date.parse('2026-10-13T10:00:37Z') + i * 60_000).toISOString(),
      stateReason: 'private details', modeller: i % 2 ? true : undefined
    }))
    setState({ snap: { ...getState().snap, tasks: done } })
    const roster = squadRoster(getState())
    expect(squadRoster(getState())).toBe(roster)
    await act(async () => root.render(React.createElement(Roster)))
    const rows = [...host.querySelectorAll('.done-row')]
    expect(rows.map(r => r.querySelector('.roster-title')?.textContent)).toEqual(done.slice(4).reverse().map(t => t.title))
    expect(host.querySelector('.side-empty')?.textContent).toBe('No units deployed.')
    expect(host.querySelector('.num, .roster-divider, .roster-thumb, [title]')).toBeNull()
    expect(host.textContent).not.toMatch(/world|private details|Recently done/)
    expect(rows[0].querySelector('.roster-state')?.textContent).toBe('DONE')
    expect(rows[1].querySelector('.roster-state')?.textContent).toBe('FAILED')
    const clocks = rows.map(r => r.querySelector('.roster-right .mono')?.textContent)
    expect(clocks[0]).toBe('1h 28m 37s')
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
    await act(async () => vi.advanceTimersByTime(60_000))
    expect([...host.querySelectorAll('.done-row .roster-right .mono')].map(n => n.textContent)).toEqual(clocks)
  } finally {
    await act(async () => root.render(null))
    vi.useRealTimers()
  }
})

it('hides a despawning finished row at once and never restores it from a cleaned update or snapshot', async () => {
  let finish!: (result: { ok: boolean; message: string }) => void
  Object.assign(window, { genio: { api: { cleanupTask: vi.fn(() => new Promise(resolve => { finish = resolve })) } } })
  const done = task('Finished', { state: 'merged', finishedAt: '2026-10-13T10:05:00Z' })
  setState({ snap: { ...getState().snap, tasks: [done] } })
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.done-row')).not.toBeNull()
  let removing!: Promise<void>
  await act(async () => { removing = despawnUnit(done.id) })
  expect(host.querySelector('.done-row')).toBeNull()
  // Main can publish the old snapshot while filesystem deletion is pending.
  await act(async () => setState({ snap: { ...getState().snap, tasks: [{ ...done }] } }))
  expect(host.querySelector('.done-row')).toBeNull()
  await act(async () => {
    handleEvent({ type: 'task', task: { ...done, state: 'cleaned' } })
    finish({ ok: true, message: 'Despawned.' })
    await removing
  })
  expect(host.querySelector('.done-row')).toBeNull()
  await act(async () => setState({ snap: { ...getState().snap, tasks: [{ ...done, state: 'cleaned' }] } }))
  expect(host.querySelector('.done-row')).toBeNull()
})

it('turns a stale ready label into WORKING on resumed work, never on idle CLI output', async () => {
  setState({ terminals: { pty: { id: 'pty', alive: true } as TerminalInfo }, snap: { ...getState().snap,
    tasks: [task('Ready', { state: 'ready', terminalId: 'pty', readyAt: '2026-10-13T10:00:00Z' })] } })
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.textContent).toContain('READY TO MERGE')
  await act(async () => handleEvent({ type: 'terminal', terminal: { id: 'pty', alive: true, lastOutputAt: '2026-10-13T10:00:01Z' } as TerminalInfo }))
  expect(host.querySelector('.roster-state')?.textContent).toBe('READY TO MERGE')
  await act(async () => handleEvent({ type: 'task', task: task('Ready', { state: 'ready', terminalId: 'pty', readyAt: '2026-10-13T10:00:00Z', resumedAt: '2026-10-13T10:00:02Z' }) }))
  expect(host.querySelector('.roster-state')?.textContent).toBe('WORKING')
})

it('turns a stale ready label into WORKING on sustained work output from the terminal', async () => {
  setState({ terminals: { pty: { id: 'pty', alive: true } as TerminalInfo }, snap: { ...getState().snap,
    tasks: [task('Ready', { state: 'ready', harness: 'codex', terminalId: 'pty', readyAt: '2026-10-13T10:00:00Z' })] } })
  await act(async () => root.render(React.createElement(Roster)))
  await act(async () => handleEvent({ type: 'terminal', terminal: { id: 'pty', alive: true, workOutputAt: '2026-10-13T10:05:00Z' } as TerminalInfo }))
  expect(host.querySelector('.roster-state')?.textContent).toBe('WORKING')
})

it('never relabels a ready unit from raw output batches, before or after its ready time', async () => {
  let output: ((batch: { id: string; data: string; at?: string }[]) => void) | undefined
  const snap = { ...initial.snap, tasks: [task('Ready', { state: 'ready', terminalId: 'pty', readyAt: '2026-10-13T10:00:00Z' })] }
  Object.assign(window, { genio: { on: vi.fn(), onTerminalData: (fn: NonNullable<typeof output>) => { output = fn; return () => {} },
    api: { snapshot: async () => snap, getSettings: async () => ({}), terminals: async () => [{ id: 'pty', alive: true }] } } })
  await act(async () => { await boot(); root.render(React.createElement(Roster)) })
  await act(async () => output?.([{ id: 'pty', data: 'final output', at: '2026-10-13T09:59:59Z' }]))
  expect(host.querySelector('.roster-state')?.textContent).toBe('READY TO MERGE')
  await act(async () => output?.([{ id: 'pty', data: 'Autocompact at 400k tokens?', at: '2026-10-13T10:00:01Z' }]))
  expect(host.querySelector('.roster-state')?.textContent).toBe('READY TO MERGE')
})
