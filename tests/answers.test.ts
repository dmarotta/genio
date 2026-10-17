// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Decision, Settings, Task } from '../src/shared/types'
import { pendingDecision } from '../src/shared/decisions'
import { Answers } from '../src/renderer/src/components/Answers'
import { getState, handleEvent, openDecisions, setState, toggleAnswers } from '../src/renderer/src/store'
import { navItems } from '../src/renderer/src/lib/railmenu'
import { playSfx } from '../src/renderer/src/lib/sfx'

vi.mock('../src/renderer/src/lib/sfx', () => ({ playSfx: vi.fn() }))

const initial = getState()
const answerDecision = vi.fn()
const deferDecision = vi.fn().mockResolvedValue(undefined)
const holdDecision = vi.fn().mockResolvedValue(undefined)
const sendChat = vi.fn().mockResolvedValue(undefined)
const applyRecommendations = vi.fn()
let host: HTMLDivElement
let root: Root
const choice = (id: string, patch: Partial<Decision> = {}): Decision => ({
  id, key: id, wksp: 'main', question: `Question ${id}`, options: ['A', 'B'],
  source: 'unit', urgency: 'normal', createdAt: '2026-10-13T10:00:00Z', ...patch
})
/** Six choices, a oldest to f newest. */
const six = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => choice(id, { createdAt: `2026-10-13T10:0${i}:00Z` }))
const animate = vi.fn()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { answerDecision, deferDecision, holdDecision, sendChat, applyRecommendations } } })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  // jsdom has no layout: give each in-flow card a 100px row so slide-up (FLIP) can be observed.
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get(this: HTMLElement) {
    const row = this.parentElement ? [...this.parentElement.children].filter(c => !c.classList.contains('out')) : []
    return Math.max(0, row.indexOf(this)) * 100
  } })
  setState({ ...initial, answerHistory: undefined, answerTarget: undefined, answersOpen: true, view: 'worlds', snap: { ...initial.snap, decisions: [choice('one')] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers()
  delete (HTMLElement.prototype as { animate?: unknown }).animate
  delete (HTMLElement.prototype as { offsetTop?: unknown }).offsetTop
  delete (window as { matchMedia?: unknown }).matchMedia
  setState(initial)
})
async function mount() { await act(async () => root.render(React.createElement(Answers))) }
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
  await act(async () => button.click())
}
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.answer-card:not(.out) [role="radio"]')]
const row = (text: string) => rows().find(r => r.querySelector('.option-text')?.textContent === text)!
const pick = (text: string) => act(async () => row(text).click())
const lockIn = () => [...host.querySelectorAll<HTMLButtonElement>('.choice-foot button')].find(b => b.textContent === 'Lock in')!
const questions = () =>[...host.querySelectorAll('.answer-card:not(.out) .choice-q')].map(e => e.textContent)
const card = (id: string) => host.querySelector<HTMLElement>(`#answer-${id}`)
const decide = (decisions: Decision[]) => act(async () => handleEvent({ type: 'decisions', decisions }))
async function type(text: string) {
  const box = host.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const wait = (ms: number) =>act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })

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
  await decide([choice('one'), choice('two', { urgency: 'urgent' })])
  expect(document.activeElement).toBe(input)
  input.remove()
})

it('submits once while pending, preserves the choice on failure and dequeues it on resolution', async () => {
  let finish!: (result: { ok: boolean; message: string }) => void
  answerDecision.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await mount()
  await pick('A')
  await click('Lock in')
  await click('Lock in')
  expect(answerDecision).toHaveBeenCalledExactlyOnceWith('one', 'A')
  expect(row('B').disabled).toBe(true)
  await act(async () => finish({ ok: false, message: 'Try again' }))
  expect(host.textContent).toContain('Question one')
  expect(row('B').disabled).toBe(false)
  answerDecision.mockImplementationOnce(async (id, answer) => {
    handleEvent({ type: 'decisions', decisions: [choice(id, { answer, resolvedAt: new Date().toISOString() })] })
    return { ok: true }
  })
  await pick('B')
  await click('Lock in')
  expect(answerDecision).toHaveBeenLastCalledWith('one', 'B')
  expect(card('one')?.classList.contains('out')).toBe(true)
  expect(card('one')?.getAttribute('aria-hidden')).toBe('true')
  await wait(250)
  expect(host.textContent).toBe('')
})

it('floats only the oldest three, urgent approvals first, and counts the rest in a +K pill', async () => {
  setState({ snap: { ...getState().snap, decisions: [...six().reverse(), choice('urgent', { urgency: 'urgent', createdAt: '2026-10-14T00:00:00Z' })] } })
  await mount()
  expect(questions()).toEqual(['Question urgent', 'Question a', 'Question b'])
  expect(card('urgent')?.classList.contains('urgent')).toBe(true)
  expect(host.querySelector('.answers-pill')?.textContent).toContain('+4 waiting')
  expect(host.querySelector('.answers-pill')?.tagName).toBe('SPAN')
  // the first card is open to answer; the others are compact until activated
  expect(card('urgent')?.querySelector('.choice-foot')).not.toBeNull()
  expect(card('a')?.classList.contains('compact')).toBe(true)
  await act(async () => card('a')!.querySelector<HTMLButtonElement>('.choice-expand')!.click())
  expect(card('a')?.querySelector('.choice-foot')).not.toBeNull()
  expect(card('urgent')?.classList.contains('compact')).toBe(true)
})

it('hides the +K pill when every pending choice fits', async () => {
  setState({ snap: { ...getState().snap, decisions: six().slice(0, 3) } })
  await mount()
  expect(questions()).toHaveLength(3)
  expect(host.querySelector('.answers-pill')).toBeNull()
})

it('dequeues: the answered card slides out, the rest slide up and the next oldest slides in', async () => {
  vi.useFakeTimers()
  setState({ snap: { ...getState().snap, decisions: six() } })
  await mount()
  await decide(six().filter(d => d.id !== 'a'))
  expect(card('a')?.classList.contains('out')).toBe(true)
  expect(card('a')?.classList.contains('compact')).toBe(false)
  expect(card('b')?.classList.contains('compact')).toBe(false)
  expect(card('a')?.style.top).toBe('0px')
  expect(card('d')?.classList.contains('in')).toBe(true)
  expect(questions()).toEqual(['Question b', 'Question c', 'Question d'])
  expect(host.querySelector('.answers-pill')?.textContent).toContain('+2 waiting')
  expect(animate.mock.calls.map(([frames]) => frames[0].transform)).toEqual(['translateY(100px)', 'translateY(100px)'])
  await act(async () => vi.advanceTimersByTime(250))
  expect(card('a')).toBeNull()
  expect(card('d')?.classList.contains('in')).toBe(false)
  // a new arrival while fewer than three show slides in from the right
  await decide([choice('b', { createdAt: '2026-10-13T10:01:00Z' })])
  await act(async () => vi.advanceTimersByTime(250))
  await decide([choice('b', { createdAt: '2026-10-13T10:01:00Z' }), choice('new', { createdAt: '2026-10-14T00:00:00Z' })])
  expect(card('new')?.classList.contains('in')).toBe(true)
})

it('respects reduced motion: no slides, only fades', async () => {
  vi.useFakeTimers()
  Object.assign(window, { matchMedia: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  setState({ snap: { ...getState().snap, decisions: six() } })
  await mount()
  expect(host.querySelector('.answer-stack')?.classList.contains('reduced')).toBe(true)
  await decide(six().filter(d => d.id !== 'a'))
  expect(animate).not.toHaveBeenCalled()
  expect(card('a')?.classList.contains('out')).toBe(true)
  expect(card('d')?.classList.contains('in')).toBe(true)
})

it('plays a soft cue when a card arrives and another when one dequeues, but not for promotions', async () => {
  setState({ settings: { sound: true, soundVolume: 0.4, calm: false } as Settings, snap: { ...getState().snap, decisions: six().slice(0, 2) } })
  await mount()
  expect(playSfx).not.toHaveBeenCalled()
  await decide(six().slice(0, 4))
  expect(vi.mocked(playSfx).mock.calls.map(c => c[0])).toEqual(['card-in'])
  vi.mocked(playSfx).mockClear()
  await decide(six().slice(1, 4))
  expect(vi.mocked(playSfx).mock.calls.map(c => c[0])).toEqual(['card-out'])
  vi.mocked(playSfx).mockClear()
  vi.mocked(document.hasFocus).mockReturnValue(false)
  await decide([...six().slice(2, 4), choice('late', { createdAt: '2026-10-12T00:00:00Z' })])
  expect(playSfx).not.toHaveBeenCalled()
})

it('takes focus only on Answer next and hands it back on Escape', async () => {
  const composer = document.createElement('textarea'); document.body.append(composer); composer.focus()
  setState({ answersOpen: false, snap: { ...getState().snap, decisions: six() } })
  await mount()
  expect(host.textContent).toBe('')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })) })
  expect(document.activeElement).toBe(card('a')?.querySelector('.option'))
  const box = card('a')!.querySelectorAll<HTMLElement>('.option')[1]
  await act(async () => box.focus())
  await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.activeElement).toBe(composer)
  // a compact card reached by Answer next opens and keeps focus inside itself
  await act(async () => card('c')!.querySelector<HTMLButtonElement>('.choice-expand')!.click())
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })) })
  expect(card('a')?.classList.contains('compact')).toBe(false)
  expect(document.activeElement).toBe(card('a')?.querySelector('.option'))
  composer.remove()
})

it('Answer next with nothing pending does not take focus when a choice arrives later', async () => {
  const composer = document.createElement('textarea'); document.body.append(composer); composer.focus()
  setState({ snap: { ...getState().snap, decisions: [] } })
  await mount()
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })) })
  await decide([choice('late')])
  expect(card('late')).not.toBeNull()
  expect(document.activeElement).toBe(composer)
  composer.remove()
})

it('shows the details, one full-width row per option with Recommended on its row, and locks in only a selection', async () => {
  answerDecision.mockResolvedValue({ ok: true })
  const long = 'Only the isolated test copy is affected. '.repeat(40)
  setState({ snap: { ...getState().snap, decisions: [choice('one', { options: ['Close the test scene and run checks', 'Keep it open', 'Skip the checks'], recommendation: 'Close the test scene and run checks', context: long })] } })
  await mount()
  expect(host.querySelector('details, summary')).toBeNull()
  expect(host.querySelector('.choice-context')?.textContent).toContain(long.trim())
  expect(host.querySelector('.choice-options')?.getAttribute('role')).toBe('radiogroup')
  expect(rows().map(r => r.querySelector('.option-text')?.textContent)).toEqual(['Close the test scene and run checks', 'Keep it open', 'Skip the checks'])
  expect(rows().map(r => r.querySelector('.option-rec')?.textContent ?? '')).toEqual(['Recommended', '', ''])
  expect(rows().every(r => r.getAttribute('aria-checked') === 'false')).toBe(true)
  // the bottom bar: exactly these three actions, Lock in only once a row is picked
  expect([...host.querySelectorAll('.choice-foot button')].map(b => b.textContent)).toEqual(['Later', 'Ask Genio', 'Lock in'])
  expect(lockIn().disabled).toBe(true)
  await pick('Keep it open')
  expect(row('Keep it open').getAttribute('aria-checked')).toBe('true')
  expect(row('Keep it open').classList.contains('on')).toBe(true)
  await pick('Skip the checks')
  expect(row('Keep it open').getAttribute('aria-checked')).toBe('false')
  expect(lockIn().disabled).toBe(false)
  expect(answerDecision).not.toHaveBeenCalled()
  await click('Lock in')
  expect(answerDecision).toHaveBeenCalledExactlyOnceWith('one', 'Skip the checks')
})

it('renders a plain yes/no with no recommendation and no details', async () => {
  setState({ snap: { ...getState().snap, decisions: [choice('merge', { question: 'Merge now?', options: ['Merge now', 'Not yet'] })] } })
  await mount()
  expect(rows()).toHaveLength(2)
  expect(host.querySelector('.option-rec, .choice-context, textarea')).toBeNull()
  expect(lockIn().disabled).toBe(true)
})

it('answers an open question in words, with a recommendation that is not an option as its own row', async () => {
  answerDecision.mockResolvedValue({ ok: true })
  setState({ snap: { ...getState().snap, decisions: [choice('one', { options: [], recommendation: 'Keep going' })] } })
  await mount()
  expect(rows().map(r => r.textContent)).toEqual(['Keep goingRecommended'])
  expect(lockIn().disabled).toBe(true)
  await type('Use the second copy')
  expect(lockIn().disabled).toBe(false)
  await act(async () => { host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(answerDecision).toHaveBeenCalledExactlyOnceWith('one', 'Use the second copy')
  await pick('Keep going')
  await click('Lock in')
  expect(answerDecision).toHaveBeenLastCalledWith('one', 'Keep going')
})

it('Later sets the choice aside unanswered: off the popup and the count, back under Deferred', async () => {
  setState({ snap: { ...getState().snap, decisions: [choice('one', { backlogId: 'quest' })] } })
  await mount()
  await click('Later')
  expect(holdDecision).toHaveBeenCalledExactlyOnceWith('one', 'later')
  expect(answerDecision).not.toHaveBeenCalled()
  expect(deferDecision).not.toHaveBeenCalled()
  await decide([choice('one', { backlogId: 'quest', held: 'later' })])
  await wait(250)
  expect(card('one')).toBeNull()
  expect(openDecisions(getState())).toHaveLength(0)
  await act(async () => toggleAnswers())
  expect(getState().answerHistory).toBe('deferred')
  expect(host.textContent).toContain('Question one')
  await click('Resume')
  expect(deferDecision).toHaveBeenCalledWith('one', '')
})

it('Ask Genio sends one chat message as the player and sets the choice aside, still open', async () => {
  setState({ snap: { ...getState().snap, tasks: [{ id: 'unit-7', title: 'Fix the jump' } as Task],
    decisions: [choice('ch-1', { taskId: 'unit-7', key: 'level-key', question: 'Close the test level?', options: ['Close it', 'Keep it'], recommendation: 'Close it', context: 'Only the test copy.' })] } })
  await mount()
  await click('Ask Genio')
  expect(sendChat).toHaveBeenCalledTimes(1)
  const [wksp, text, images, context] = sendChat.mock.calls[0]
  expect(wksp).toBe('main')
  expect(text).toBe(['Help me decide this open choice.', 'Asked by: Fix the jump', 'Question: Close the test level?', 'Details: Only the test copy.', 'Options:', '1. Close it (recommended)', '2. Keep it'].join('\n'))
  for (const id of ['ch-1', 'unit-7', 'level-key']) expect(text).not.toContain(id)
  expect(images).toBeUndefined()
  expect(context.screen.id).toBe('worlds')
  expect(holdDecision).toHaveBeenCalledExactlyOnceWith('ch-1', 'genio')
  expect(answerDecision).not.toHaveBeenCalled()
  await decide([choice('ch-1', { taskId: 'unit-7', held: 'genio' })])
  await wait(250)
  expect(card('ch-1')).toBeNull()
  expect(openDecisions(getState())).toHaveLength(0)
  expect(pendingDecision(getState().snap.decisions[0])).toBe(true)
})

it('Ask Genio leaves the choice in the popup when the message is not sent', async () => {
  sendChat.mockRejectedValueOnce(new Error('Chat unavailable'))
  await mount()
  await click('Ask Genio')
  expect(holdDecision).not.toHaveBeenCalled()
  expect(card('one')).not.toBeNull()
})

it('resurfaces deferred choices when their date arrives', async () => {
  vi.useFakeTimers()
  const until = new Date(Date.now() + 10_000).toISOString()
  setState({ snap: { ...getState().snap, decisions: [choice('normal'), choice('urgent', { urgency: 'urgent' }), choice('later', { until }), choice('resolved', { resolvedAt: until })] } })
  await mount()
  expect(questions()).toEqual(['Question urgent', 'Question normal'])
  await act(async () => vi.advanceTimersByTime(30_000))
  expect(host.textContent).toContain('Question later')
  expect(host.textContent).not.toContain('Question resolved')
})

it('retrieves Answered and Deferred history and resumes a deferred choice', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString()
  setState({ snap: { ...getState().snap, decisions: [choice('pending'), choice('done', { resolvedAt: new Date().toISOString(), answer: 'A' }), choice('later', { until })] } })
  await mount()
  await click('Answer history')
  expect(host.textContent).toContain('Question done')
  expect(host.textContent).not.toContain('Question pending')
  await click('Deferred')
  expect(host.textContent).toContain('Question later')
  await click('Resume')
  expect(deferDecision).toHaveBeenCalledWith('later', '')
  expect(getState().answerHistory).toBeUndefined()
})

it('pages long history instead of scrolling it', async () => {
  const done = six().map((d, i) => ({ ...d, resolvedAt: `2026-10-13T11:0${i}:00Z`, answer: 'A' }))
  setState({ answerHistory: 'answered', snap: { ...getState().snap, decisions: done } })
  await mount()
  expect([...host.querySelectorAll('.answers-row .choice-q')].map(e => e.textContent)).toEqual(['Question f', 'Question e', 'Question d'])
  await click('Older')
  expect([...host.querySelectorAll('.answers-row .choice-q')].map(e => e.textContent)).toEqual(['Question c', 'Question b', 'Question a'])
})

it('notification targets reveal a specific answered choice without changing the current screen', async () => {
  setState({ answersOpen: false, snap: { ...getState().snap, decisions: [choice('done', { resolvedAt: new Date().toISOString(), answer: 'B' })] } })
  await mount()
  await act(async () => handleEvent({ type: 'navigate', target: { view: 'move', decisionId: 'done', wksp: 'main' } }))
  expect(host.querySelector('#answer-done')?.textContent).toContain('Question done')
  expect(getState().view).toBe('worlds')
  expect(answerDecision).not.toHaveBeenCalled()
})

it('notification targets bring a waiting choice into view and open it', async () => {
  setState({ answersOpen: false, snap: { ...getState().snap, decisions: six() } })
  await mount()
  await act(async () => handleEvent({ type: 'navigate', target: { view: 'move', decisionId: 'e', wksp: 'main' } }))
  expect(questions()).toEqual(['Question a', 'Question b', 'Question e'])
  expect(card('e')?.querySelector('.choice-foot')).not.toBeNull()
  await act(async () => card('a')!.querySelector<HTMLButtonElement>('.choice-expand')!.click())
  expect(card('a')?.querySelector('.choice-foot')).not.toBeNull()
  expect(card('e')?.classList.contains('compact')).toBe(true)
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
  expect(host.querySelector('.answer-stack')).toBeNull()
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
