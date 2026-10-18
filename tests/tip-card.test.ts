// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.hoisted(() => window.history.replaceState({}, '', '/?project=fixture&workspace=genio'))
import { TipCard } from '../src/renderer/src/components/TipCard'
import { getState, handleEvent, saveSettings, setState } from '../src/renderer/src/store'
import { PANEL_OPEN_EVENT, publishScreenContext } from '../src/renderer/src/lib/screen-context'
import { defaultSettings } from '../src/main/settings'

const initial = getState()
const tip = { id: 'plans', line: 'Work that needs several units in order? Ask Genio for a plan.', question: 'How do I use a plan?' }
const sendChat = vi.fn()
const persist = vi.fn()
let host: HTMLDivElement, root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  Object.assign(window, { genio: { api: { sendChat, saveSettings: persist } } })
  vi.useFakeTimers()
  sendChat.mockResolvedValue(undefined)
  persist.mockImplementation(async patch => ({ ...getState().settings, ...patch }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  setState({ ...initial, tip: undefined, settings: defaultSettings(), view: 'squad' })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.classList.contains('tip-card') ? { left: 16, right: 436, top: 750, bottom: 884, width: 420, height: 134 }
      : { left: 0, right: 1440, top: 44, bottom: 900, width: 1440, height: 856 }) as DOMRect
  })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); setState(initial)
  publishScreenContext('squad', undefined)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks()
})
const deliver = (project = 'fixture', value = tip) => act(async () => handleEvent({ type: 'tip', project, tip: value }))
const mount = () => act(async () => root.render(React.createElement(TipCard)))
const click = (label: string) => act(async () => {
  const b = [...host.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!
  b.click()
})

it('accepts only this project, never stacks tips and never steals focus', async () => {
  const field = document.createElement('textarea'); document.body.append(field); field.focus()
  await mount(); await deliver('other')
  expect(host.textContent).toBe('')
  await deliver(); await deliver('fixture', { ...tip, id: 'other', line: 'A second tip' })
  expect(host.querySelectorAll('.tip-card')).toHaveLength(1)
  expect(host.textContent).toContain(tip.line)
  expect(host.textContent).not.toContain('A second tip')
  expect(document.activeElement).toBe(field)
  field.remove()
})

it('fades after twenty seconds, expires without turning tips off, and has no later queue', async () => {
  await deliver(); await mount()
  await act(async () => vi.advanceTimersByTime(19_999))
  expect(host.querySelector('.tip-card.out')).toBeNull()
  await act(async () => vi.advanceTimersByTime(1))
  expect(host.querySelector('.tip-card.out')).not.toBeNull()
  await act(async () => vi.advanceTimersByTime(200))
  expect(host.querySelector('.tip-card')).toBeNull()
  expect(getState().settings?.featureTips).toBe(true)
  expect(persist).not.toHaveBeenCalled()
})

it('Escape and X dismiss only the tip', async () => {
  await mount(); await deliver()
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(getState().tip).toBeUndefined()
  await deliver(); await click('Dismiss tip')
  expect(getState().tip).toBeUndefined()
  expect(persist).not.toHaveBeenCalled()
})

it('sends the exact question as a player message with screen context and opens the chat', async () => {
  publishScreenContext('squad', { facts: [{ label: 'Unit', value: 'Market stalls' }] })
  const open = vi.fn(); window.addEventListener(PANEL_OPEN_EVENT, open)
  await mount(); await deliver(); await click('Ask Genio')
  expect(sendChat).toHaveBeenCalledExactlyOnceWith('genio', tip.question, undefined,
    expect.objectContaining({ world: 'fixture', screen: expect.objectContaining({ id: 'squad', facts: [{ label: 'Unit', value: 'Market stalls' }] }) }))
  expect(open).toHaveBeenCalledOnce()
  expect(getState().tip).toBeUndefined()
  window.removeEventListener(PANEL_OPEN_EVENT, open)
})

it('keeps the card usable when sending fails', async () => {
  sendChat.mockRejectedValueOnce(new Error('offline'))
  await mount(); await deliver(); await click('Ask Genio')
  expect(host.querySelector<HTMLButtonElement>('.tip-actions button')?.disabled).toBe(false)
  expect(getState().tip?.id).toBe(tip.id)
  await click('Ask Genio')
  expect(sendChat).toHaveBeenCalledTimes(2)
  expect(getState().tip).toBeUndefined()
})

it('No more tips disables immediately while persistence is pending; enabling does not revive the card', async () => {
  let finish!: (value: unknown) => void
  persist.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await mount(); await deliver(); await click('No more tips')
  expect(getState().tip).toBeUndefined()
  expect(getState().settings?.featureTips).toBe(false)
  expect(persist).toHaveBeenCalledWith({ featureTips: false })
  await deliver()
  expect(getState().tip).toBeUndefined()
  await act(async () => finish({ ...getState().settings, featureTips: false }))
  await act(async () => saveSettings({ featureTips: true }))
  expect(getState().settings?.featureTips).toBe(true)
  expect(host.querySelector('.tip-card')).toBeNull()
})

it('a global settings event removes a visible tip', async () => {
  await mount(); await deliver()
  await act(async () => handleEvent({ type: 'settings', settings: { ...defaultSettings(), featureTips: false } }))
  expect(host.querySelector('.tip-card')).toBeNull()
})

it('drops a tip event in the Hub even if it names a project', async () => {
  window.history.replaceState({}, '', '/')
  vi.resetModules()
  const hub = await import('../src/renderer/src/store')
  hub.setState({ settings: defaultSettings() })
  hub.handleEvent({ type: 'tip', project: 'fixture', tip })
  expect(hub.getState().tip).toBeUndefined()
})
