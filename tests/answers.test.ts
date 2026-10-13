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
const clarifyDecision = vi.fn()
const applyRecommendations = vi.fn()
let host: HTMLDivElement
let root: Root
const choice = (id: string, patch: Partial<Decision> = {}): Decision => ({
  id, key: id, wksp: 'main', question: `Question ${id}`, options: ['A', 'B'],
  source: 'unit', urgency: 'normal', createdAt: '2026-10-13T10:00:00Z', ...patch
})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { answerDecision, deferDecision, clarifyDecision, applyRecommendations } } })
  setState({ ...initial, answerHistory: undefined, answerTarget: undefined, answersOpen: true, view: 'worlds', snap: { ...initial.snap, decisions: [choice('one')] } })
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


it('retrieves Answered and Deferred history and resumes a deferred choice', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString()
  setState({ snap: { ...getState().snap, decisions: [choice('pending'), choice('done', { resolvedAt: new Date().toISOString(), answer: 'A' }), choice('later', { until })] } })
  await mount()
  await click('Answered')
  expect(host.textContent).toContain('Question done')
  expect(host.textContent).not.toContain('Question pending')
  await click('Deferred')
  expect(host.textContent).toContain('Question later')
  await click('Resume')
  expect(deferDecision).toHaveBeenCalledWith('later', '')
  expect(getState().answerHistory).toBeUndefined()
})

it('notification targets reveal a specific answered choice without changing the current screen', async () => {
  setState({ answersOpen: false, snap: { ...getState().snap, decisions: [choice('done', { resolvedAt: new Date().toISOString(), answer: 'B' })] } })
  await mount()
  await act(async () => handleEvent({ type: 'navigate', target: { view: 'move', decisionId: 'done', wksp: 'main' } }))
  expect(host.querySelector('#answer-done')?.textContent).toContain('Question done')
  expect(getState().view).toBe('worlds')
  expect(answerDecision).not.toHaveBeenCalled()
})

async function type(text: string) {
  const box = host.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('keeps diagnostics under Details and sends clarification through its own action', async () => {
  setState({ snap: { ...getState().snap, decisions: [choice('one', { context: 'PID 123; C:/test; exact command' })] } })
  clarifyDecision.mockResolvedValue({ ok: true, message: 'Question sent. The choice remains pending.' })
  await mount()
  expect(host.querySelector('details')?.open).toBe(false)
  expect(host.querySelector('summary')?.textContent).toBe('Details')
  await click('Ask for clarification')
  expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe('Your clarification question')
  await type('Which test scene?')
  await click('Send question')
  expect(clarifyDecision).toHaveBeenCalledExactlyOnceWith('one', 'Which test scene?')
  expect(answerDecision).not.toHaveBeenCalled()
  expect(host.textContent).toContain('Question one')
  expect(host.textContent).toContain('choice remains pending')
})

it('reviews exact captured answers, excludes new arrivals and retains partial-failure results', async () => {
  const a = choice('one', { taskId: 'task', recommendation: 'A' })
  const b = choice('two', { taskId: 'task', recommendation: 'B' })
  setState({ snap: { ...getState().snap, decisions: [a, b, choice('ambiguous', { taskId: 'task', question: 'Maybe A (recommended) or B?' })] } })
  await mount()
  const reviewButton = [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('Review recommendations'))!
  await act(async () => reviewButton.click())
  expect(host.querySelector('[aria-label="Review recommendations"]')?.textContent).toContain('Answer: A')
  expect(host.querySelector('[aria-label="Review recommendations"]')?.textContent).toContain('Answer: B')
  await act(async () => handleEvent({ type: 'decisions', decisions: [a, b, choice('new', { taskId: 'task', recommendation: 'A' })] }))
  applyRecommendations.mockResolvedValue([{ id: a.id, ok: true, message: 'Applied' }, { id: b.id, ok: false, message: 'Changed since review' }])
  await click('Apply recommendations (2)')
  expect(applyRecommendations.mock.calls[0][0].map((r: { id: string }) => r.id)).toEqual(['one', 'two'])
  expect(host.textContent).toContain('Not applied: Changed since review')
  expect(answerDecision).not.toHaveBeenCalled()
})

it('retains the batch receipt after its final pending choice resolves', async () => {
  setState({ snap: { ...getState().snap, decisions: [choice('one', { taskId: 'task', recommendation: 'A' }), choice('two', { taskId: 'task', recommendation: 'B' })] } })
  await mount()
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('Review recommendations'))!.click())
  applyRecommendations.mockImplementation(async () => {
    handleEvent({ type: 'decisions', decisions: [] })
    return [{ id: 'one', ok: true, message: 'Applied' }, { id: 'two', ok: true, message: 'Applied' }]
  })
  await click('Apply recommendations (2)')
  expect(host.textContent).toContain('Close results')
  await click('Close results')
  expect(host.textContent).toBe('')
})
