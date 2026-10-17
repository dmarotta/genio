// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Task, TerminalInfo } from '../src/shared/types'
import { holdsCapacity } from '../src/shared/unit-capacity'
import { getState, handleEvent, runningUnits, setState } from '../src/renderer/src/store'
import { Rail } from '../src/renderer/src/components/Rail'
import { TitleBar } from '../src/renderer/src/components/TitleBar'

vi.mock('../src/renderer/src/components/PlanMeter', () => ({}))

it('renders Units and Queue totals using the cap definition, including live waits and pending reservations', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = getState()
  const tasks = ['ready', 'merged', 'done', 'failed', 'cleaned', 'working', 'paused', 'blocked', 'needs-decision', 'stale', 'validating', 'spawning', 'detached'].map((state, i) => ({
    id: String(i), state, project: 'world', wksp: i % 2 ? 'genio' : 'main', terminalId: state === 'spawning' ? undefined : String(i),
    pr: { url: 'https://example.com/pull/1' }
  } as Task))
  const terminals = Object.fromEntries(tasks.filter(t => t.terminalId).map(t => [t.terminalId!, { id: t.terminalId, alive: t.state !== 'detached' } as TerminalInfo]))
  const used = tasks.filter(t => holdsCapacity(t, !!t.terminalId && !!terminals[t.terminalId]?.alive)).length
  expect(used).toBe(7)
  expect(tasks.slice(0, 5).every(t => !holdsCapacity(t, true))).toBe(true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    setState({ ...original, terminals, snap: { ...original.snap, tasks, pendingUnits: ['world'], backlog: [], stats: { ...original.snap.stats, costTodayUsd: 27 } } })
    expect(runningUnits(getState())).toBe(used + 1)
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Rail), React.createElement(TitleBar))))
    expect(host.querySelector('.rail-badge')?.textContent).toBe('8')
    expect(host.querySelector('.hud-cost')).toBeNull()
    expect(host.querySelector('.titlebar')?.textContent).not.toMatch(/Chat\/review|\$/)
    expect(getState().snap.stats.costTodayUsd).toBe(27)
    await act(async () => {
      handleEvent({ type: 'pending-units', projects: [] })
      for (const terminal of Object.values(terminals)) handleEvent({ type: 'terminal', terminal: { ...terminal, alive: false } })
    })
    expect(runningUnits(getState())).toBe(1) // spawning still holds the launch slot
    expect(host.querySelector('.rail-badge')?.textContent).toBe('1')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    setState(original)
  }
})
