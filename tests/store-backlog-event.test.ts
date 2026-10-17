// @vitest-environment jsdom
/** A project window applies its quests from the backlog event; only the Hub fetches a snapshot for it. */
import { afterEach, expect, it, vi } from 'vitest'
import type { BacklogItem } from '../src/shared/types'

vi.hoisted(() => window.history.replaceState(null, '', '/?project=one&wksp=ally-one'))
const snapshot = vi.fn(async () => { throw new Error('a project window must not fetch a snapshot for its quests') })
Object.assign(window, { genio: { api: { snapshot } } })
import { getState, handleEvent, setState } from '../src/renderer/src/store'

const initial = getState()
afterEach(() => setState(initial))

it('replaces the quests at once, with allies present, and never asks for a snapshot', async () => {
  vi.useFakeTimers()
  setState({ snap: { ...initial.snap, allies: [{ name: 'ally-one', projects: ['one'] }] as never } })
  const items = [{ id: 'q1', project: 'one', title: 'First' }] as BacklogItem[]
  handleEvent({ type: 'backlog', items })
  expect(getState().snap.backlog).toBe(items)
  await vi.advanceTimersByTimeAsync(1000)
  expect(snapshot).not.toHaveBeenCalled()
  vi.useRealTimers()
})
