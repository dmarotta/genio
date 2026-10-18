// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/views/ProjectSettings', () => ({ CloneProject: () => null, RemoveProject: () => null }))
vi.mock('../src/renderer/src/components/Terminal', () => ({ TerminalView: () => React.createElement('div', { className: 'terminal-marker' }) }))
import { Hub } from '../src/renderer/src/views/Hub'
import { handleEvent, setState } from '../src/renderer/src/store'
import { GENIO_CODEX } from '../src/shared/api'
import type { FleetSnapshot, Project } from '../src/shared/types'

const project = { name: 'Zebra', path: 'C:/games/Zebra' } as Project

describe('the launcher sign-in gate', () => {
  let host: HTMLDivElement
  let root: Root
  const api = {
    projectMetadata: vi.fn(async () => ({})),
    projectOpen: vi.fn(async () => {}),
    accountSession: vi.fn(async (tool: string) => ({ id: `term-${tool}`, title: `Log in · ${tool}`, alive: true })),
    terminalKill: vi.fn(async () => {})
  }
  const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement
  const row = (): HTMLButtonElement => host.querySelector('.hub-project') as HTMLButtonElement

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { genio: { api, on: () => () => {} } })
    for (const fn of Object.values(api)) fn.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    setState(s => ({ booted: true, connected: true, signInGate: true, snap: { ...s.snap, projects: [project] } as FleetSnapshot }))
    await act(async () => root.render(React.createElement(Hub)))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    setState({ signInGate: false })
  })

  it('lists the projects but opens none while neither Claude nor Codex is signed in', () => {
    expect(row().textContent).toContain('Zebra')
    expect(row().disabled).toBe(true)
    expect(button('Open folder').disabled).toBe(true)
    expect(button('Clone').disabled).toBe(true)
    expect(host.textContent).toContain('Sign in with Claude or Codex to open a project.')
  })

  it('offers both sign-ins through the existing login flows', async () => {
    await act(async () => button('Sign in with Claude').click())
    expect(api.accountSession).toHaveBeenCalledWith('claude', 'login')
    expect(host.querySelector('.terminal-marker')).not.toBeNull()
    await act(async () => button('Sign in with Codex').click())
    expect(api.terminalKill).toHaveBeenCalledWith('term-claude')
    expect(api.accountSession).toHaveBeenLastCalledWith(GENIO_CODEX, 'login')
  })

  it('opens projects as soon as one sign-in works, without a restart', async () => {
    await act(async () => handleEvent({ type: 'sign-in-needed', tools: [], gate: false }))
    expect(host.textContent).not.toContain('Sign in with Claude')
    expect(row().disabled).toBe(false)
    await act(async () => row().click())
    expect(api.projectOpen).toHaveBeenCalledWith('C:/games/Zebra')
    // a sign-in lost later closes the gate again
    await act(async () => handleEvent({ type: 'sign-in-needed', tools: ['Claude', 'Codex'], gate: true }))
    expect(row().disabled).toBe(true)
  })
})
