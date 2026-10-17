// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { GenerationCard } from '../src/renderer/src/components/GenerationCard'

const approve = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../src/renderer/src/store', () => ({ api: () => ({ approveGeneration: approve }), errText: (e: Error) => e.message }))

it('shows a one-click quote, exact cost and budget, and replaces it with saved paths', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const el = document.createElement('div'), root = createRoot(el)
  const card = { id: 'q-1', provider: 'fal' as const, model: 'fal-ai/example', world: 'world', status: 'awaiting_approval' as const, estimatedUsd: 0.4, spentUsd: 1, capUsd: 5, paths: [], warnings: [] }
  await act(() => root.render(createElement(GenerationCard, { card, wksp: 'ally' })))
  expect(el.textContent).toContain('Approve $0.400')
  expect(el.textContent).toContain('month $1.000 / $5.00')
  await act(async () => el.querySelector('button')!.click())
  expect(approve).toHaveBeenCalledWith('ally', 'q-1')
  await act(() => root.render(createElement(GenerationCard, { card: { ...card, status: 'completed', paths: ['Assets/door.wav'] }, wksp: 'ally' })))
  expect(el.querySelector('button')).toBeNull()
  expect(el.textContent).toContain('Assets/door.wav')
  expect(el.textContent).not.toMatch(/uncommitted|· world/)
  await act(() => root.unmount())
})
