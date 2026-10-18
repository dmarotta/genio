// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

it('starts project windows on their own main chat', async () => {
  window.history.replaceState({}, '', '?project=alpha&workspace=ally-alpha')
  vi.resetModules()
  const store = await import('../src/renderer/src/store')
  expect(store.PROJECT_WINDOW).toBe('alpha')
  expect(store.PROJECT_WORKSPACE).toBe('ally-alpha')
  expect(store.getState()).toMatchObject({ view: 'comms' })
})
