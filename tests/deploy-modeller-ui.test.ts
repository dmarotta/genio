// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolStatus } from '../src/shared/types'
const f = vi.hoisted(() => ({ spawn: vi.fn(), toolchain: vi.fn(), preview: vi.fn(), state: {} as Record<string, unknown> }))
vi.mock('../src/renderer/src/store', () => ({
  api: () => ({ spawnTask: f.spawn, toolchain: f.toolchain, previewLoadout: f.preview }),
  useStore: (pick: (s: unknown) => unknown) => pick(f.state),
  errText: String, focusTask: vi.fn(), setState: vi.fn(), toast: vi.fn()
}))
vi.mock('../src/renderer/src/lib/sfx', () => ({ playSfx: vi.fn() }))
vi.mock('../src/renderer/src/components/ui', () => ({
  Modal: ({ title, footer, children }: { title: string; footer: React.ReactNode; children: React.ReactNode }) =>
    React.createElement('div', { role: 'dialog', 'aria-label': title }, children, footer),
  Field: ({ children }: { children: React.ReactNode }) => React.createElement('label', null, children),
  Toggle: () => null
}))
import { DeployModal } from '../src/renderer/src/components/DeployModal'

let root: Root, host: HTMLDivElement
const button = (label: RegExp): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => label.test(b.textContent ?? ''))!
const tools = (found: boolean): ToolStatus[] => [{ name: 'blender', found, required: false, purpose: '' }]
const render = async (): Promise<void> => { await act(async () => root.render(React.createElement(DeployModal))) }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  f.state = { deploy: { kind: 'ship', project: 'game', title: 'Watchtower', intent: 'a low-poly wooden watchtower' }, snap: { projects: [{ name: 'game', mode: 'local-only' }] }, settings: { harnesses: [] } }
  f.spawn.mockResolvedValue({ id: 't1', title: 'Watchtower' })
  f.preview.mockResolvedValue(null)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks() })

describe('Deploy a Modeller', () => {
  it('refreshes the loadout preview when switching between Build and Modeller', async () => {
    vi.useFakeTimers()
    try {
      f.toolchain.mockResolvedValue(tools(true))
      await render()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(f.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ship', modeller: false }))
      await act(async () => button(/^Modeller/).click())
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(f.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ship', modeller: true }))
      await act(async () => button(/^Build/).click())
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(f.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ship', modeller: false }))
    } finally { vi.useRealTimers() }
  })

  it('deploys a Build with the Modeller flag when Blender is installed', async () => {
    f.toolchain.mockResolvedValue(tools(true))
    await render()
    await act(async () => button(/^Modeller/).click())
    expect(host.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('New Modeller mission')
    await act(async () => button(/Deploy now/).click())
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ship', modeller: true, project: 'game' }))
  })

  it('without Blender, says how to get it and keeps Deploy off; Build stays a plain Build', async () => {
    f.toolchain.mockResolvedValue(tools(false))
    await render()
    await act(async () => button(/^Modeller/).click())
    expect(host.textContent).toContain('Install Blender 4.2 LTS or newer (free)')
    expect(button(/Deploy now/).disabled).toBe(true)
    await act(async () => button(/^Build/).click())
    await act(async () => button(/Deploy now/).click())
    expect(f.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ modeller: true }))
  })
})

describe('Deploy a Generator', () => {
  it('deploys a Build with the Generator flag and never with the Modeller flag too', async () => {
    f.toolchain.mockResolvedValue(tools(false))
    await render()
    await act(async () => button(/^Modeller/).click())
    await act(async () => button(/^Generator/).click())
    expect(host.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('New Generator mission')
    expect(button(/^Generator/).className).toBe('kind-opt magenta on')
    expect(button(/^Modeller/).className).not.toContain('on')
    expect(button(/Deploy now/).className).toContain('magenta')
    expect(button(/Deploy now/).disabled).toBe(false)
    await act(async () => button(/Deploy now/).click())
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ship', generator: true, project: 'game' }))
    expect(f.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ modeller: true }))
  })

  it('opens on the Generator option for a Generator draft; Recon drops the flag', async () => {
    f.state = { ...f.state, deploy: { kind: 'ship', project: 'game', title: 'Door sounds', intent: 'a door creak', generator: true } }
    await render()
    expect(host.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('New Generator mission')
    await act(async () => button(/^Recon/).click())
    await act(async () => button(/Deploy now/).click())
    expect(f.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ generator: true }))
  })
})
