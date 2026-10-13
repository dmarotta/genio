// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Decision } from '../src/shared/types'
import { Answers } from '../src/renderer/src/components/Answers'
import { getState, handleEvent, setState } from '../src/renderer/src/store'
import { navItems } from '../src/renderer/src/lib/railmenu'

const initial = getState()
const answerDecision = vi.fn()
const deferDecision = vi.fn().mockResolvedValue(undefined)
let host: HTMLDivElement
let root: Root
const choice = (id: string, patch: Partial<Decision> = {}): Decision => ({
  id, key: id, wksp: 'main', question: `Question ${id}`, options: ['A', 'B'],
  source: 'unit', urgency: 'normal', createdAt: '2026-10-13T10:00:00Z', ...patch
})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { answerDecision, deferDecision } } })
  setState({ ...initial, answersOpen: true, view: 'worlds', snap: { ...initial.snap, decisions: [choice('one')] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.resetAllMocks(); vi.useRealTimers()
  setState(initial)
})
async function mount() { await act(async () => root.render(React.createElement(Answers))) }
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
  await act(async () => button.click())
}

it('removes the page from navigation and shows choices without taking focus or changing screens', async () => {
  const input = document.createElement('input'); document.body.append(input); input.focus()
  await mount()
  expect(navItems().some(n => n.id as string === 'move' || n.key === '4')).toBe(false)
  expect(host.querySelector('[role="dialog"], .modal-scrim')).toBeNull()
  expect(document.activeElement).toBe(input)
  await click('Hide pending answers')
  expect(host.textContent).toBe('')
  await act(async () => handleEvent({ type: 'navigate', target: { view: 'move' } }))
  expect(host.textContent).toContain('Question one')
  expect(getState().view).toBe('worlds')
  expect(document.activeElement).toBe(input)
  input.remove()
})

it('submits once while pending, preserves the choice on failure and removes it on resolution', async () => {
  let finish!: (result: { ok: boolean; message: string }) => void
  answerDecision.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await mount()
  await click('1A')
  await click('2B')
  expect(answerDecision).toHaveBeenCalledExactlyOnceWith('one', 'A')
  await act(async () => finish({ ok: false, message: 'Try again' }))
  expect(host.textContent).toContain('Question one')
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
  answerDecision.mockImplementationOnce(async (id, answer) => {
    handleEvent({ type: 'decisions', decisions: [choice(id, { answer, resolvedAt: new Date().toISOString() })] })
    return { ok: true }
  })
  await click('2B')
  expect(answerDecision).toHaveBeenLastCalledWith('one', 'B')
  expect(host.textContent).toBe('')
})

it('sorts urgent choices first and resurfaces deferred choices when their date arrives', async () => {
  vi.useFakeTimers()
  const until = new Date(Date.now() + 10_000).toISOString()
  setState({ snap: { ...getState().snap, decisions: [choice('normal'), choice('urgent', { urgency: 'urgent' }), choice('later', { until }), choice('resolved', { resolvedAt: until })] } })
  await mount()
  expect([...host.querySelectorAll('.choice-q')].map(e => e.textContent)).toEqual(['Question urgent', 'Question normal'])
  await act(async () => vi.advanceTimersByTime(30_000))
  expect(host.textContent).toContain('Question later')
  expect(host.textContent).not.toContain('Question resolved')
})

it('sends a recommendation and a valid deferral through the existing APIs', async () => {
  answerDecision.mockResolvedValue({ ok: true })
  setState({ snap: { ...getState().snap, decisions: [choice('one', { options: [], recommendation: 'Keep going' })] } })
  await mount()
  await click('Go with recommendation')
  expect(answerDecision).toHaveBeenCalledWith('one', 'Keep going')
  await click('Later')
  const date = host.querySelector<HTMLInputElement>('input[type="date"]')!.value
  await click('Confirm')
  expect(deferDecision).toHaveBeenCalledWith('one', new Date(date).toISOString())
})
