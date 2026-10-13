// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Task, TerminalInfo } from '../src/shared/types'
import { Roster } from '../src/renderer/src/components/SquadPanel'
import { boot, getState, handleEvent, setState } from '../src/renderer/src/store'

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

it('counts only active units and moves completed units into the done history without a Killfeed', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.num')?.textContent).toBe('3')
  expect([...host.querySelectorAll('.roster-state')].map(n => n.textContent)).toEqual(['WORKING', 'WORKING', 'READY TO MERGE'])
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--blue')
  expect(host.querySelector('.roster-divider')).toBeNull()
  await act(async () => {
    handleEvent({ type: 'task', task: task('Build', { state: 'merged', finishedAt: '2026-10-13T10:05:00Z' }) })
    handleEvent({ type: 'task', task: task('Recon', { state: 'needs-decision', kind: 'scout' }) })
  })
  expect(host.querySelector('.num')?.textContent).toBe('2')
  expect([...host.querySelectorAll('.roster-active .roster-title')].map(n => n.textContent)).not.toContain('Build')
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--amber')
  expect(host.querySelector('.roster-divider')?.textContent).toBe('Recently done (1)')
  const done = host.querySelector('.roster-done .done-row')!
  expect(done.querySelector('.roster-title')?.textContent).toBe('Build')
  expect(done.querySelector('.roster-state')?.textContent).toBe('merged')
  expect(done.querySelector('.roster-state')?.getAttribute('style')).toContain('--volt')
  expect(done.textContent).toContain('· 1:05:00') // created 09:00, finished 10:05
  expect(host.textContent).not.toContain('Killfeed')
  expect('feed' in getState()).toBe(false)
  expect(getState().snap.tasks.find(t => t.id === 'Build')?.state).toBe('merged')
  await act(async () => (done as HTMLButtonElement).click())
  expect(getState().focus).toEqual({ type: 'task', id: 'Build' })
})

it('shows the 25 most recent finished units newest first, red for failures, from persisted records', async () => {
  const finished = Array.from({ length: 32 }, (_, i) => task(`done-${i}`, {
    state: i === 31 ? 'failed' : i === 30 ? 'exited' : 'cleaned', landedAt: i % 2 || i >= 30 ? undefined : `2026-10-13T08:${String(i).padStart(2, '0')}:00Z`,
    finishedAt: `2026-10-13T08:${String(i).padStart(2, '0')}:00Z`, createdAt: '2026-10-13T07:00:00Z',
    stateReason: i === 30 ? 'unit process exited (code 1) without a final status' : undefined }))
  setState({ snap: { ...getState().snap, tasks: [task('Live'), ...finished] } })
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.num')?.textContent).toBe('1')
  expect(host.querySelector('.roster-divider')?.textContent).toBe('Recently done (25)')
  const rows = [...host.querySelectorAll('.roster-done .done-row')]
  expect(rows.map(r => r.querySelector('.roster-title')?.textContent)).toEqual(Array.from({ length: 25 }, (_, i) => `done-${31 - i}`))
  expect(rows.slice(0, 4).map(r => r.querySelector('.roster-state')?.textContent)).toEqual(['failed', 'exited abnormally', 'done', 'merged'])
  expect(rows[0].querySelector('.roster-state')?.getAttribute('style')).toContain('--alert')
  expect(rows[1].querySelector('.roster-state')?.getAttribute('style')).toContain('--alert')
  expect(rows[3].querySelector('.roster-state')?.getAttribute('style')).toContain('--volt')
})

it('turns a stale ready label into WORKING on live terminal output', async () => {
  setState({ terminals: { pty: { id: 'pty', alive: true } as TerminalInfo }, snap: { ...getState().snap,
    tasks: [task('Ready', { state: 'ready', terminalId: 'pty', readyAt: '2026-10-13T10:00:00Z' })] } })
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.textContent).toContain('READY TO MERGE')
  await act(async () => handleEvent({ type: 'terminal', terminal: { id: 'pty', alive: true, lastOutputAt: '2026-10-13T10:00:01Z' } as TerminalInfo }))
  expect(host.querySelector('.roster-state')?.textContent).toBe('WORKING')
})

it('uses output source time so a pre-ready batch delivered late does not create false live work', async () => {
  let output!: (batch: { id: string; data: string; at?: string }[]) => void
  const snap = { ...initial.snap, tasks: [task('Ready', { state: 'ready', terminalId: 'pty', readyAt: '2026-10-13T10:00:00Z' })] }
  Object.assign(window, { genio: { on: vi.fn(), onTerminalData: (fn: typeof output) => { output = fn; return () => {} },
    api: { snapshot: async () => snap, getSettings: async () => ({}), terminals: async () => [{ id: 'pty', alive: true }] } } })
  await act(async () => { await boot(); root.render(React.createElement(Roster)) })
  await act(async () => output([{ id: 'pty', data: 'final output', at: '2026-10-13T09:59:59Z' }]))
  expect(host.querySelector('.roster-state')?.textContent).toBe('READY TO MERGE')
  await act(async () => output([{ id: 'pty', data: 'new work', at: '2026-10-13T10:00:01Z' }]))
  expect(host.querySelector('.roster-state')?.textContent).toBe('WORKING')
})
