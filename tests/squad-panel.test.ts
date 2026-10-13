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

it('counts only active units and removes completed units without a Killfeed', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.num')?.textContent).toBe('3')
  expect([...host.querySelectorAll('.roster-state')].map(n => n.textContent)).toEqual(['WORKING', 'WORKING', 'READY TO MERGE'])
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--blue')
  await act(async () => {
    handleEvent({ type: 'task', task: task('Build', { state: 'merged' }) })
    handleEvent({ type: 'task', task: task('Recon', { state: 'needs-decision', kind: 'scout' }) })
  })
  expect(host.querySelector('.num')?.textContent).toBe('2')
  expect([...host.querySelectorAll('.roster-title')].map(n => n.textContent)).not.toContain('Build')
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--amber')
  expect(host.textContent).not.toContain('Killfeed')
  expect('feed' in getState()).toBe(false)
  expect(getState().snap.tasks.find(t => t.id === 'Build')?.state).toBe('merged')
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
