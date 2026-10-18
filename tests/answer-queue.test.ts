import fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { Decision, Settings } from '../src/shared/types'
import { CARD_LIMIT, cardCueAllowed, cardCues, cardOrder, cardQueue, reconcileSlots } from '../src/renderer/src/lib/answer-queue'

const choice = (id: string, createdAt: string, patch: Partial<Decision> = {}): Decision => ({
  id, key: id, workspace: 'main', question: `Question ${id}`, options: [], source: 'unit', urgency: 'normal', createdAt, ...patch
})
const six = ['f', 'b', 'e', 'a', 'd', 'c'].map(id => choice(id, `2026-10-13T10:0${'abcdef'.indexOf(id)}:00Z`))
const ids = (list: { id: string }[]) => list.map(d => d.id)

it('shows only the oldest N pending choices, with the rest counted as waiting', () => {
  expect(CARD_LIMIT).toBe(3)
  const { shown, waiting, queue } = cardQueue(six)
  expect(ids(shown)).toEqual(['a', 'b', 'c'])
  expect(waiting).toBe(3)
  expect(ids(queue)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  expect(cardQueue(six.slice(0, 2)).waiting).toBe(0)
})

it('puts urgent approvals first regardless of age so ordinary choices never push them out', () => {
  const urgent = [choice('u1', '2026-10-13T12:00:00Z', { urgency: 'urgent' }), choice('u2', '2026-10-13T11:00:00Z', { urgency: 'urgent' })]
  expect(ids(cardOrder([...six, ...urgent])).slice(0, 4)).toEqual(['u2', 'u1', 'a', 'b'])
  expect(ids(cardQueue([...six, ...urgent]).shown)).toEqual(['u2', 'u1', 'a'])
  const many = [1, 2, 3, 4].map(i => choice(`u${i}`, `2026-10-13T1${i}:00:00Z`, { urgency: 'urgent' }))
  expect(ids(cardQueue([...six, ...many]).shown)).toEqual(['u1', 'u2', 'u3'])
})

it('pins a notification target into view in place of the last ordinary card, never an urgent one', () => {
  expect(ids(cardQueue(six, 'e').shown)).toEqual(['a', 'b', 'e'])
  expect(cardQueue(six, 'e').waiting).toBe(3)
  const urgent = [1, 2, 3].map(i => choice(`u${i}`, `2026-10-13T1${i}:00:00Z`, { urgency: 'urgent' }))
  expect(ids(cardQueue([...six, ...urgent], 'e').shown)).toEqual(['u1', 'u2', 'u3'])
})

it('promotes the next oldest when a shown card dequeues: the old card exits at its last position', () => {
  const before = cardQueue(six).shown.map(d => ({ id: d.id, d, phase: 'idle' as const }))
  const after = cardQueue(six.filter(d => d.id !== 'a')).shown
  const slots = reconcileSlots(before, after, new Map([['a', 0], ['b', 120], ['c', 240]]))
  expect(slots.map(s => [s.id, s.phase])).toEqual([['b', 'idle'], ['c', 'idle'], ['d', 'in'], ['a', 'out']])
  expect(slots.find(s => s.id === 'a')?.top).toBe(0)
  // a card that returns while it is still exiting enters again
  expect(reconcileSlots(slots, cardQueue(six).shown).map(s => [s.id, s.phase])).toEqual([['a', 'in'], ['b', 'idle'], ['c', 'idle'], ['d', 'out']])
})

it('earns an arrival cue only for new choices and a dequeue cue only when a shown card leaves the queue', () => {
  const snap = (list: Decision[]) => { const q = cardQueue(list); return { queue: ids(q.queue), shown: ids(q.shown) } }
  expect(cardCues(undefined, cardQueue(six))).toEqual({ in: false, urgent: false, out: false })
  // answered: d is promoted, which is not an arrival
  expect(cardCues(snap(six), cardQueue(six.filter(d => d.id !== 'a')))).toEqual({ in: false, urgent: false, out: true })
  // a new choice behind the visible three makes no sound; one that shows does
  expect(cardCues(snap(six), cardQueue([...six, choice('z', '2026-10-14T00:00:00Z')]))).toEqual({ in: false, urgent: false, out: false })
  expect(cardCues(snap(six.slice(0, 1)), cardQueue(six.slice(0, 2)))).toEqual({ in: true, urgent: false, out: false })
  expect(cardCues(snap(six), cardQueue([...six, choice('u', '2026-10-14T00:00:00Z', { urgency: 'urgent' })])).urgent).toBe(true)
  // pushed out of view by an urgent arrival but still waiting: no dequeue cue
  expect(cardCues(snap(six), cardQueue([...six, choice('u', '2026-10-14T00:00:00Z', { urgency: 'urgent' })])).out).toBe(false)
})

it('plays card sounds only with sound on, in the focused window and, for arrivals, while online', () => {
  const settings = { sound: true, soundVolume: 0.5, calm: false } as Settings
  const ctx = { settings, away: 'online' as const, focused: true }
  expect(cardCueAllowed('card-in', ctx)).toBe(true)
  expect(cardCueAllowed('card-out', ctx)).toBe(true)
  expect(cardCueAllowed('card-in', { ...ctx, settings: { ...settings, sound: false } })).toBe(false)
  expect(cardCueAllowed('card-out', { ...ctx, settings: null })).toBe(false)
  expect(cardCueAllowed('card-in', { ...ctx, focused: false })).toBe(false)
  expect(cardCueAllowed('card-out', { ...ctx, focused: false })).toBe(false)
  expect(cardCueAllowed('card-in', { ...ctx, away: 'dnd' })).toBe(false)
  expect(cardCueAllowed('card-in', { ...ctx, away: 'afk' })).toBe(false)
  expect(cardCueAllowed('card-out', { ...ctx, away: 'dnd' })).toBe(true)
  expect(cardCueAllowed('card-in', { ...ctx, settings: { ...settings, calm: true } })).toBe(false)
  expect(cardCueAllowed('card-in', { ...ctx, settings: { ...settings, calm: true }, urgent: true })).toBe(true)
})

it('styles the cards as a fixed overlay that cannot size the screen, never scrolls, and only fades under reduced motion', () => {
  const css = fs.readFileSync('src/renderer/src/styles/app.css', 'utf8')
  expect(css).toMatch(/\.answers-float \{[^}]*position: fixed;[^}]*z-index: 100;/)
  // the docked column and its reflowing rules are gone
  expect(css).not.toMatch(/(\.app-body|\.stage|\.stage-shell)[^{]*answers/)
  expect(css).not.toMatch(/(^|[\s,}])\.answers[\s{,:]/)
  expect(css).not.toMatch(/\.answer[^{]*\{[^}]*overflow(-[xy])?:\s*(auto|scroll)/)
  // above the Genio panel (30) and usage popups (60), below modals (200) and toasts (400)
  const z = Number(/\.answers-float \{[^}]*z-index: (\d+)/.exec(css)![1])
  expect(z).toBeGreaterThan(60)
  expect(z).toBeLessThan(200)
  // toasts move beside (or, narrow, below) the cards instead of covering them
  expect(css).toMatch(/body:has\(\.answers-float \.answer-card\) \.toasts \{ right: calc\(min\(380px/)
  expect(css).toMatch(/\.answer-stack\.reduced \.answer-card\.in \{ animation: card-fade-in [^}]*\}/)
  expect(css).toMatch(/\.answer-stack\.reduced \.answer-card\.out \{ animation: card-fade-out [^}]*\}/)
  expect(css).toMatch(/@keyframes card-fade-in \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/)
  expect(css).toMatch(/@keyframes card-out \{[^\n]*translateX/)
})

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('synthesises the two card sounds with WebAudio at the player volume and never twice for one arrival', async () => {
  const oscillators: string[] = []
  const gain = () => ({ gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })
  const master = gain()
  let made = 0
  class FakeAudio {
    state = 'running'; currentTime = 0; sampleRate = 8000; destination = {}
    constructor() { made++ }
    gains = 0
    createGain() { return this.gains++ ? gain() : master }
    createDynamicsCompressor() { return { connect: vi.fn() } }
    createOscillator() { const o = { type: '', frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }; oscillators.push('osc'); return o }
    createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) } }
    createBufferSource() { return { connect: vi.fn(), start: vi.fn(), buffer: null } }
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect: vi.fn() } }
    resume() { return Promise.resolve() }
  }
  vi.stubGlobal('AudioContext', FakeAudio)
  let now = 10_000
  vi.stubGlobal('performance', { now: () => now })
  const { playSfx } = await import('../src/renderer/src/lib/sfx')
  const on = { sound: true, soundVolume: 0.3 } as Settings
  playSfx('card-in', { ...on, sound: false })
  expect(made).toBe(0)
  playSfx('card-in', on)
  expect(oscillators.length).toBe(2)
  expect(master.gain.value).toBe(0.3)
  // the core's 'decision' chime for the same new choice is dropped, and vice versa
  now += 200; playSfx('decision', on)
  expect(oscillators.length).toBe(2)
  now += 2000; playSfx('card-out', on)
  expect(oscillators.length).toBe(3)
  now += 2000; playSfx('decision', on)
  expect(oscillators.length).toBe(6)
  now += 100; playSfx('card-in', on)
  expect(oscillators.length).toBe(6)
})
