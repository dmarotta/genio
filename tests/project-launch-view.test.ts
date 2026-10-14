// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

it('starts project windows on their own main chat, including newly registered projects', async () => {
  window.history.replaceState({}, '', '?project=alpha&wksp=ally-alpha&registered=1')
  vi.resetModules()
  const store = await import('../src/renderer/src/store')
  expect(store.PROJECT_WINDOW).toBe('alpha')
  expect(store.PROJECT_WKSP).toBe('ally-alpha')
  expect(store.getState()).toMatchObject({ view: 'comms', registeredProject: 'alpha' })
})
