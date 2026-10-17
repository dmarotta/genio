// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignChatInfo } from '../src/shared/types'
import type { DesignNote } from '../src/shared/design-notes'

vi.hoisted(() => window.history.replaceState(null, '', '/?project=forest&wksp=forest'))
vi.mock('../src/renderer/src/components/ModelSelect', () => ({
  ModelSelect: (p: { value: string }) => React.createElement('select', { 'aria-label': 'Model', value: p.value, onChange: () => {} }),
  EffortSelect: (p: { value: string }) => React.createElement('select', { 'aria-label': 'Effort', value: p.value, onChange: () => {} })
}))
import { DESIGN_EMPTY, Design } from '../src/renderer/src/views/Design'
import { useGlobalKeys } from '../src/renderer/src/components/CommandPalette'
import { getState, handleEvent, setState } from '../src/renderer/src/store'
import { getScreenContext } from '../src/renderer/src/lib/screen-context'
import { RAIL, navItems } from '../src/renderer/src/lib/railmenu'

const WKSP = 'forest'
const initial = getState()
const chat = (id: string, title: string, over: Partial<DesignChatInfo> = {}): DesignChatInfo =>
  ({ id, title, createdAt: '2026-10-17T09:00:00Z', model: '', effort: '', activity: 'offline', queued: 0, costUsd: 0, turns: 1, ...over })
const COMBAT = '---\ntitle: Combat\nupdated: 2026-10-17\n---\n# Combat: prepare, hold, repair\n\n## Open questions\n- Repair cost: wood or gold?\n'
const note = (name: string, text: string): DesignNote => ({ name, file: `${name}.md`, text, version: `v-${name}-${text.length}` })

const api = {
  designChats: vi.fn(async (): Promise<DesignChatInfo[]> => []),
  designChatCreate: vi.fn(async (): Promise<DesignChatInfo> => chat('d-0000000c', '', { turns: 0 })),
  designChatDelete: vi.fn(async () => {}),
  designChatConfigure: vi.fn(),
  designNotes: vi.fn(async (): Promise<DesignNote[]> => []),
  designNoteWrite: vi.fn(),
  chatHistory: vi.fn(async () => []),
  sendChat: vi.fn(async () => {}),
  steerChat: vi.fn(async () => {})
}
let root: Root, host: HTMLDivElement, previous: typeof window.genio, media: typeof window.matchMedia

const flush = async (): Promise<void> => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render(): Promise<void> { await act(async () => root.render(React.createElement(Design))); await flush() }
const text = (): string => host.textContent ?? ''
const button = (label: string, within: ParentNode = document): HTMLButtonElement | undefined =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label)
const items = (group: string): string[] => [...host.querySelectorAll(`[role="group"][aria-label="${group}"] .design-item`)].map(b => b.textContent ?? '')
/** What is open: the highlighted list item, or the picker's face when narrow. */
const title = (): string | null | undefined => host.querySelector('.design-item.on, .design-picker b')?.textContent
const fact = () => getScreenContext('design')?.facts?.filter(Boolean)
async function typeInto(area: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  previous = window.genio
  media = window.matchMedia
  window.genio = { api } as never
  for (const f of Object.values(api)) f.mockClear()
  api.designChats.mockResolvedValue([])
  api.designNotes.mockResolvedValue([])
  setState({ ...initial, designChats: undefined, designOpen: undefined, chats: {}, chatLoaded: {}, view: 'design', settings: { gamertag: 'Dani' } as never })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(() => root.unmount()); host.remove(); setState(initial)
  window.genio = previous; window.matchMedia = media
})

describe('Design screen', () => {
  it('with nothing yet, shows one plain line and New chat', async () => {
    await render()
    expect(api.designChats).toHaveBeenCalledWith(WKSP)
    expect(api.designNotes).toHaveBeenCalledWith(WKSP)
    expect(host.querySelector('.design-empty')?.textContent).toBe(DESIGN_EMPTY)
    expect(DESIGN_EMPTY).toBe('No design chats yet. Start one with New chat.')
    expect([...host.querySelectorAll('button')].map(b => b.textContent?.trim())).toEqual(['New chat'])
    expect(host.querySelector('[role="group"]')).toBeNull()
    expect(fact()).toEqual([])
  })

  it('lists chats (newest first) and notes in two groups and opens the newest chat in the chat view', async () => {
    api.designChats.mockResolvedValue([chat('d-0000000a', 'Combat loop'), chat('d-0000000b', 'Gold sinks and the market')])
    api.designNotes.mockResolvedValue([note('combat', COMBAT), note('economy', '# Economy\n')])
    await render()
    expect(items('Chats')).toEqual(['Gold sinks and the market', 'Combat loop'])
    expect(items('Notes')).toEqual(['combat.md', 'economy.md'])
    expect(host.querySelector('.design-item.on')?.textContent).toBe('Gold sinks and the market')
    expect(title()).toBe('Gold sinks and the market')
    expect(host.querySelector('.design-head')).toBeNull()
    expect(api.chatHistory).toHaveBeenCalledWith(WKSP, 300, 'd-0000000b')
    // the chat view with its model and effort only: no status bar, approval mode, Clean HUD, shell or quick links
    expect(host.querySelector('textarea')?.placeholder).toBe('Message the design chat')
    expect([...host.querySelectorAll('.composer select')].map(s => s.getAttribute('aria-label'))).toEqual(['Model', 'Effort'])
    expect(host.querySelector('.comms-head')).toBeNull()
    expect(host.querySelector('.composer-keys')).toBeNull()
    expect(text()).not.toMatch(/Clean HUD|Recap|Deploy|YOLO|Restart/)
    expect([...host.querySelectorAll('.composer-hints button')]).toHaveLength(0)
    expect(fact()).toEqual([{ label: 'Design chat', value: 'Gold sinks and the market' }])
    expect(text()).not.toMatch(/Send to Genio/)
  })

  it('sends to the open design chat and shows its replies as the design chat, never Genio', async () => {
    api.designChats.mockResolvedValue([chat('d-0000000a', 'Combat loop')])
    await render()
    const area = host.querySelector('textarea')!
    await typeInto(area, 'Be a harsh critic')
    await act(async () => { area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(api.sendChat).toHaveBeenCalledWith(WKSP, 'Be a harsh critic', undefined, undefined, 'd-0000000a')
    await act(async () => handleEvent({ type: 'design-chat', wksp: WKSP, conversation: 'd-0000000a', message: { id: 'r1', wksp: WKSP, role: 'genio', text: 'Three loops.', ts: '2026-10-17T09:01:00Z' } }))
    expect(getState().chats[WKSP]).toBeUndefined()
    const reply = host.querySelector('.msg.genio')!
    expect(reply.textContent).toContain('Three loops.')
    expect(reply.querySelector('.msg-meta')?.textContent).not.toMatch(/Genio/)
    expect(reply.querySelector('.msg-avatar')).toBeNull()
    expect(reply.querySelector('.msg-react')).toBeNull()
    // another project's design chat never shows here
    await act(async () => handleEvent({ type: 'design-chats', wksp: 'other', chats: [] }))
    expect(items('Chats')).toEqual(['Combat loop'])
  })

  it('New chat opens a new chat, and reuses one that is still untouched', async () => {
    api.designChats.mockResolvedValue([chat('d-0000000a', 'Combat loop')])
    await render()
    await act(async () => button('New chat')!.click())
    await flush()
    expect(api.designChatCreate).toHaveBeenCalledWith(WKSP)
    expect(items('Chats')).toEqual(['New chat', 'Combat loop'])
    expect(title()).toBe('New chat')
    expect(fact()).toEqual([{ label: 'Design chat', value: 'New chat' }])
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.design-item')[1].click())
    await act(async () => button('New chat')!.click())
    expect(api.designChatCreate).toHaveBeenCalledTimes(1)
    expect(title()).toBe('New chat')
  })

  it('deletes a chat from its context menu', async () => {
    api.designChats.mockResolvedValue([chat('d-0000000a', 'Combat loop'), chat('d-0000000b', 'Gold sinks')])
    await render()
    const item = [...host.querySelectorAll<HTMLButtonElement>('.design-item')].find(b => b.textContent === 'Gold sinks')!
    expect(button('Delete chat')).toBeUndefined()
    await act(async () => { item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const menu = document.querySelector('[role="menu"]')!
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(b => b.textContent)).toEqual(['Delete chat'])
    await act(async () => button('Delete chat', menu)!.click())
    await flush()
    expect(api.designChatDelete).toHaveBeenCalledWith(WKSP, 'd-0000000b')
    expect(items('Chats')).toEqual(['Combat loop'])
    expect(title()).toBe('Combat loop')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('opens a note as rendered markdown and edits it with the Art Bible editor', async () => {
    const combat = note('combat', COMBAT)
    const edited = COMBAT + '\n## Decided\n- Wood.\n'
    api.designNotes.mockResolvedValue([combat])
    api.designNoteWrite.mockImplementation(async () => [note('combat', edited)])
    await render()
    expect(host.querySelector('.design-empty')?.textContent).toBe(DESIGN_EMPTY)
    await act(async () => button('combat.md')!.click())
    expect(title()).toBe('combat.md')
    expect(fact()).toEqual([{ label: 'Design note', value: 'combat.md' }])
    expect(host.querySelector('.design-note h1')?.textContent).toBe('Combat: prepare, hold, repair')
    expect(text()).not.toContain('title: Combat')
    expect(host.querySelector('textarea')).toBeNull()
    await act(async () => button('Edit')!.click())
    const area = host.querySelector<HTMLTextAreaElement>('.design-note textarea')!
    expect(area.value).toBe(COMBAT)
    expect(button('Edit')).toBeUndefined()
    expect(button('Save file')!.disabled).toBe(true)
    expect(button('Preview')).toBeUndefined()
    await typeInto(area, edited)
    expect(button('Save file')!.disabled).toBe(false)
    await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
    await flush()
    expect(api.designNoteWrite).toHaveBeenCalledWith(WKSP, 'combat', edited, combat.version)
    expect(host.querySelector('.design-note textarea')).toBeNull()
    expect(host.querySelector('.design-note')?.textContent).toContain('Wood.')
  })

  it('keeps a refused note edit, and Cancel drops it', async () => {
    api.designNotes.mockResolvedValue([note('combat', COMBAT)])
    api.designNoteWrite.mockRejectedValue(new Error('Not saved: the note changed while you edited it.'))
    await render()
    await act(async () => button('combat.md')!.click())
    await act(async () => button('Edit')!.click())
    await typeInto(host.querySelector<HTMLTextAreaElement>('.design-note textarea')!, '# Mine\n')
    await act(async () => button('Save file')!.click())
    await flush()
    expect(host.querySelector<HTMLTextAreaElement>('.design-note textarea')?.value).toBe('# Mine\n')
    expect(getState().toasts.at(-1)).toMatchObject({ level: 'error', title: 'Note not saved' })
    await act(async () => button('Cancel')!.click())
    expect(host.querySelector('.design-note textarea')).toBeNull()
    expect(host.querySelector('.design-note h1')?.textContent).toBe('Combat: prepare, hold, repair')
  })

  it('below 720 px, the list becomes a picker in the header', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })) as never
    api.designChats.mockResolvedValue([chat('d-0000000a', 'Combat loop')])
    api.designNotes.mockResolvedValue([note('combat', COMBAT)])
    await render()
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 720px)')
    expect(host.querySelector('.design-list')).toBeNull()
    const picker = host.querySelector<HTMLButtonElement>('.design-picker')!
    expect(picker.textContent).toBe('Combat loop')
    expect(picker.getAttribute('aria-expanded')).toBe('false')
    await act(async () => picker.click())
    const sheet = document.querySelector('.design-sheet')!
    expect([...sheet.querySelectorAll('.design-item')].map(b => b.textContent)).toEqual(['Combat loop', 'combat.md'])
    expect(button('New chat', sheet)).toBeDefined()
    await act(async () => button('combat.md', sheet)!.click())
    expect(document.querySelector('.design-sheet')).toBeNull()
    expect(host.querySelector('.design-picker')?.textContent).toBe('combat.md')
    expect(button('Edit')).toBeDefined()
  })

  it('narrow with nothing yet: the picker reads Design and the plain line stays', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })) as never
    await render()
    expect(host.querySelector('.design-picker')?.textContent).toBe('Design')
    expect(host.querySelector('.design-empty')?.textContent).toBe(DESIGN_EMPTY)
  })
})

describe('Design in the rail', () => {
  it('is a rail entry with Ctrl+7', async () => {
    expect(RAIL.some(e => e.kind === 'view' && e.item.id === 'design' && e.item.label === 'Design')).toBe(true)
    expect(navItems().find(i => i.key === '7')?.id).toBe('design')
    setState({ view: 'comms' })
    function Keys() { useGlobalKeys(true); return null }
    await act(async () => root.render(React.createElement(Keys)))
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '7', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(getState().view).toBe('design')
  })
})
