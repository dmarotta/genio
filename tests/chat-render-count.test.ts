// @vitest-environment jsdom
/**
 * Render-count guard: a streamed token must re-render only the message it
 * belongs to, not every message of a long transcript.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'

const counters = vi.hoisted(() => ({ markdown: 0 }))
vi.mock('../src/renderer/src/components/Markdown', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/renderer/src/components/Markdown')>()
  return { ...m, Markdown: (props: Parameters<typeof m.Markdown>[0]) => { counters.markdown++; return m.Markdown(props) } }
})
vi.mock('../src/renderer/src/components/ModelSelect', () => ({ ModelSelect: () => null, EffortSelect: () => null, requestSystemsSection: () => undefined }))

import { ChatPanel } from '../src/renderer/src/views/Comms'
import { getState, handleEvent, setState } from '../src/renderer/src/store'

const WKSP = 'genio'
const initial = getState()
let root: Root, host: HTMLDivElement
const genio = (i: number): ChatMessage => ({ id: `m-${i}`, wksp: WKSP, role: 'genio', text: `Reply ${i} with **bold** and \`code\`.`, ts: `2026-10-14T06:${String(i % 60).padStart(2, '0')}:00Z`, tools: [{ id: `t-${i}`, name: 'mcp__genio__fleet_view', input: '{}', result: 'ok' }] })
const player = (i: number): ChatMessage => ({ id: `p-${i}`, wksp: WKSP, role: 'player', text: `Question ${i}`, ts: `2026-10-14T06:${String(i % 60).padStart(2, '0')}:00Z` })

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  counters.markdown = 0
  const messages = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? player(i) : genio(i)))
  setState({ ...initial, chats: { [WKSP]: messages }, chatLoaded: { [WKSP]: true }, settings: { gamertag: 'Alex', calm: false } as never,
    snap: { ...initial.snap, wksps: [{ name: WKSP, displayName: 'Genio', activity: 'thinking', costUsd: 0, turns: 0, queued: 0 }] } })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })

it('re-renders only the streaming message per delta, and only the replaced message on a final chat event', async () => {
  await act(async () => { root.render(React.createElement(ChatPanel, { wksp: WKSP })) })
  const first = counters.markdown
  expect(first).toBeGreaterThanOrEqual(66)
  counters.markdown = 0
  for (let i = 0; i < 50; i++) await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: `tok${i} ` }) })
  expect(host.querySelector('.md.streaming')?.textContent).toContain('tok49')
  expect(counters.markdown).toBeLessThanOrEqual(50 + 2)
  counters.markdown = 0
  await act(async () => { handleEvent({ type: 'chat', message: { ...genio(7), text: 'Edited reply 7' } }) })
  expect(counters.markdown).toBeLessThanOrEqual(2)
  expect(host.textContent).toContain('Edited reply 7')
})
