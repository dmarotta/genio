// @vitest-environment jsdom
/**
 * Renderer: the chat log with a long transcript. How much React work a
 * streamed reply causes (component renders, Markdown parses) and what the
 * markdown pipeline costs on long replies.
 */
import React, { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, WkspInfo } from '../../src/shared/types'
import { note, report, syntheticMessages, timeIt } from './measure'

const counters = vi.hoisted(() => ({ markdown: 0, message: 0 }))
vi.mock('../../src/renderer/src/components/Markdown', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/renderer/src/components/Markdown')>()
  return { ...m, Markdown: (props: Parameters<typeof m.Markdown>[0]) => { counters.markdown++; return m.Markdown(props) } }
})
vi.mock('../../src/renderer/src/components/ModelSelect', () => ({ ModelSelect: () => null, EffortSelect: () => null, requestSystemsSection: () => undefined }))

import { ChatPanel } from '../../src/renderer/src/views/Comms'
import { renderMarkdown } from '../../src/renderer/src/components/Markdown'
import { getState, handleEvent, setState } from '../../src/renderer/src/store'

const WKSP = 'genio'
const initial = getState()
let root: Root, host: HTMLDivElement
let commits = 0, renderMs = 0
const onRender = (_id: string, _phase: string, actualDuration: number): void => { commits++; renderMs += actualDuration }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  counters.markdown = 0; commits = 0; renderMs = 0
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })
afterAll(() => report())

function seed(messages: ChatMessage[], activity: WkspInfo['activity'] = 'thinking'): void {
  setState({ ...initial, chats: { [WKSP]: messages }, chatLoaded: { [WKSP]: true }, settings: { gamertag: 'Alex', calm: false } as never,
    snap: { ...initial.snap, wksps: [{ name: WKSP, displayName: 'Genio', activity, costUsd: 0, turns: 0, queued: 0 }] } })
}
const render = (): Promise<void> => act(async () => { root.render(React.createElement(Profiler, { id: 'chat', onRender }, React.createElement(ChatPanel, { wksp: WKSP }))) })

describe('chat log rendering', () => {
  it('initial render of a 300-message transcript', async () => {
    seed(syntheticMessages(WKSP, 300))
    const t0 = performance.now()
    await render()
    note('initial render: 300 messages', performance.now() - t0, 'ms')
    note('initial render: Markdown renders', counters.markdown, 'count')
    expect(host.querySelectorAll('.msg').length).toBeGreaterThan(200)
  })

  it('streaming 400 deltas into a 300-message transcript', async () => {
    seed(syntheticMessages(WKSP, 300))
    await render()
    counters.markdown = 0; commits = 0; renderMs = 0
    const t0 = performance.now()
    for (let i = 0; i < 400; i++) {
      await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: `word${i} ${i % 17 === 0 ? '\n\n' : ''}` }) })
    }
    note('stream 400 deltas: wall time', performance.now() - t0, 'ms', 'one act() per delta, as separate IPC events')
    note('stream 400 deltas: React commits', commits, 'count')
    note('stream 400 deltas: Profiler render time', renderMs, 'ms')
    note('stream 400 deltas: Markdown component renders', counters.markdown, 'count', 'before: every message re-renders per delta')
    expect(host.querySelector('.md.streaming')?.textContent).toContain('word399')
  })

  it('markdown pipeline cost on a long reply', () => {
    const long = syntheticMessages(WKSP, 60).filter((m) => m.role === 'genio' && m.text.includes('##')).map((m) => m.text).join('\n')
    note('long reply: characters', long.length, 'chars')
    timeIt('renderMarkdown(12 KB reply)', () => { renderMarkdown(long) }, { iterations: 30 })
    // what a token-by-token stream costs when every delta re-parses the whole text
    let total = 0
    const step = Math.max(1, Math.floor(long.length / 400))
    for (let n = step; n <= long.length; n += step) {
      const t = performance.now()
      renderMarkdown(long.slice(0, n))
      total += performance.now() - t
    }
    note('re-parse per delta × 400 deltas (cumulative)', total, 'ms')
  })
})
