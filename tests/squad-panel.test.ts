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

it('lists only active units; a finished one leaves the rail for the Quest log, without a Killfeed or done list', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.num')).toBeNull()
  expect([...host.querySelectorAll('.roster-state')].map(n => n.textContent)).toEqual(['WORKING', 'WORKING', 'READY TO MERGE'])
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--blue')
  await act(async () => {
    handleEvent({ type: 'task', task: task('Build', { state: 'merged', finishedAt: '2026-10-13T10:05:00Z' }) })
    handleEvent({ type: 'task', task: task('Recon', { state: 'needs-decision', kind: 'scout' }) })
  })
  expect([...host.querySelectorAll('.roster-title')].map(n => n.textContent)).toEqual(['Recon', 'Ready'])
  // the Recon asking the player keeps its purple and gains the yellow indicator
  expect(host.querySelector('.roster-state')?.getAttribute('style')).toContain('--violet')
  expect(host.querySelector('.roster-state')?.textContent).toBe('WORKING')
  expect(host.querySelector('.roster-state .needs-you.amber')).not.toBeNull()
  expect(host.querySelector('.roster-divider, .roster-done')).toBeNull()
  expect(host.textContent).not.toContain('Killfeed')
  expect('feed' in getState()).toBe(false)
  expect(getState().snap.tasks.find(t => t.id === 'Build')?.state).toBe('merged')
  await act(async () => (host.querySelector('.roster-row') as HTMLButtonElement).click())
  expect(getState().focus).toEqual({ type: 'task', id: 'Recon' })
})

it('a row is the title, the kind and the state: no project, plan step, clock or tooltip', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  const row = host.querySelector('.roster-row')!
  expect(row.querySelector('.roster-sub')?.textContent?.trim()).toBe('Build')
  expect(row.textContent).not.toMatch(/world|\d:\d\d/)
  expect(row.getAttribute('title')).toBeNull()
})

it('says so in one line when no unit is deployed', async () => {
  setState({ snap: { ...getState().snap, tasks: [task('Old', { state: 'merged' })] } })
  await act(async () => root.render(React.createElement(Roster)))
  expect(host.querySelector('.side-empty')?.textContent).toBe('No units deployed.')
  expect(host.querySelector('button')).toBeNull()
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
