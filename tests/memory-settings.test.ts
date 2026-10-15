// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
  const files: Record<string, string> = {}
  return {
    files,
    api: {
      homePath: vi.fn(async () => 'C:/genio'),
      readMemory: vi.fn(async (which: string) => files[which] ?? ''),
      writeMemory: vi.fn(async (which: string, text: string) => { files[which] = text }),
      memoryReport: vi.fn(),
      memoryArchive: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      inboxSubmit: vi.fn(),
      inboxAck: vi.fn()
    },
    state: {
      settings: { memoryBudgetTokens: 100, gamertag: 'Dani', inboxServer: false, inboxPort: 7777, inboxToken: '', ledger: false, eventSources: [] },
      snap: { inbox: [{ id: 'n1', ts: '2026-10-13T10:00:00Z', from: 'phone', text: 'add a pause menu' }], projects: [] }
    }
  }
})
vi.mock('../src/renderer/src/store', () => ({
  api: () => f.api,
  errText: String,
  toast: vi.fn(),
  saveSettings: vi.fn(),
  useStore: (selector: (s: unknown) => unknown) => selector(f.state),
  op: async (_: string, fn: () => Promise<unknown>) => { try { return await fn() } catch { return undefined } }
}))
vi.mock('../src/renderer/src/components/Terminal', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/views/ProjectSettings', () => ({ ThisProjectSettings: () => null }))
vi.mock('../src/renderer/src/components/PlanMeter', () => ({ PlanMeter: () => null, useUsagePolicyState: () => ({ view: null, error: '' }) }))
vi.mock('../src/renderer/src/components/ModelPicker', () => ({ ModelPicker: () => null, useModelCatalogue: () => ({ routes: [] }) }))
vi.mock('../src/renderer/src/components/Markdown', () => ({ Markdown: ({ text }: { text: string }) => React.createElement('div', { className: 'md' }, text) }))

import { SECTIONS, Systems, requestSystemsSection } from '../src/renderer/src/views/Systems'
import { RAIL, navItems } from '../src/renderer/src/lib/railmenu'

const STALE = 'lore.md: - godot export needs templates <!--a:2020-01-01-->'
let root: Root
let host: HTMLDivElement
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(f.files, { player: '# Player Profile\n- likes tests', lore: '# Squad memory\n- godot export needs templates <!--a:2020-01-01-->', 'player-shared': '# Shared' })
  f.api.memoryReport.mockResolvedValue({ tokens: 120, budget: 100, overBudget: true, stale: [STALE], files: [{ file: 'player.md', tokens: 40 }, { file: 'lore.md', tokens: 80 }] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

async function open(section: 'memory' | 'mail') {
  requestSystemsSection(section)
  await act(async () => root.render(React.createElement(Systems)))
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const textarea = () => host.querySelector<HTMLTextAreaElement>('.memory-text')!
async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('navigation', () => {
  it('has no Lore screen or rail entry; Memory is a plainly named Settings section', () => {
    const ids: string[] = navItems().map((n) => n.id)
    expect(ids).not.toContain('lore')
    expect(navItems().some((n) => /\blore\b/i.test(n.label))).toBe(false)
    expect(RAIL.some((e) => e.kind === 'menu' && /\blore\b/i.test(e.label))).toBe(false)
    expect(SECTIONS.find((s) => s.id === 'memory')?.label).toBe('Memory')
    expect(SECTIONS.some((s) => /\blore\b/i.test(s.label))).toBe(false)
  })
})

describe('Settings → Memory', () => {
  it('edits each memory file under plain names and keeps the stored ids', async () => {
    await open('memory')
    expect(host.querySelector('.sys-link.on')?.textContent).toBe('Memory')
    expect(host.querySelector('.sys-title')?.textContent).toContain('Memory')
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
    expect(tabs).toEqual(['Player profile', 'Squad memory', 'Shared profile'])
    expect(host.textContent).not.toMatch(/\blore\b(?!\.md)/i)
    expect(textarea().value).toContain('likes tests')

    await act(async () => (host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]).click())
    expect(f.api.readMemory).toHaveBeenLastCalledWith('lore')
    await type(textarea(), '# Squad memory\n- new fact <!--P-->')
    expect(button('Save file')!.disabled).toBe(false)
    await act(async () => button('Save file')!.click())
    expect(f.api.writeMemory).toHaveBeenCalledWith('lore', '# Squad memory\n- new fact <!--P-->')
    expect(button('Save file')!.disabled).toBe(true)
  })

  it('shows sizes against the budget and archives expired entries', async () => {
    await open('memory')
    const size = host.querySelector('.memory-size')!.textContent!
    expect(size).toContain('Player profile')
    expect(size).toContain('Squad memory')
    expect(size).toContain('~120 tok · over budget')
    expect(host.querySelector('.memory-stale')!.textContent).toContain('godot export needs templates')

    f.api.memoryReport.mockResolvedValue({ tokens: 40, budget: 100, overBudget: false, stale: [], files: [{ file: 'player.md', tokens: 40 }] })
    await act(async () => host.querySelector<HTMLButtonElement>('.memory-stale-row button')!.click())
    expect(f.api.memoryArchive).toHaveBeenCalledWith([STALE], expect.stringMatching(/archived/i))
    expect(host.textContent).toContain('Nothing expired')
    expect(button('Archive all')!.disabled).toBe(true)
  })

  it('blocks archiving while the open file has unsaved edits', async () => {
    await open('memory')
    await type(textarea(), 'unsaved')
    expect(host.querySelector<HTMLButtonElement>('.memory-stale-row button')!.disabled).toBe(true)
    expect(button('Archive all')!.disabled).toBe(true)
  })

  it('keeps /save reachable from the section', async () => {
    await open('memory')
    await act(async () => button('/save')!.click())
    expect(f.api.save).toHaveBeenCalled()
  })
})

describe('Settings → Inbox & automation', () => {
  it('keeps the former Lore mailbox under the old mail id: unread badge, notes and acknowledgement', async () => {
    await open('mail')
    expect(host.querySelector('.sys-link.on')?.textContent).toBe('Inbox & automation1')
    expect(host.querySelector('.mail-note.unread')?.textContent).toContain('add a pause menu')
    await act(async () => button('Ack')!.click())
    expect(f.api.inboxAck).toHaveBeenCalledWith('n1')
  })
})
