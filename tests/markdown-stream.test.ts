// @vitest-environment jsdom
/**
 * A streaming reply rebuilds only its changed trailing blocks. Guard: at every prefix of a streamed
 * reply, the DOM equals a full render of that prefix, and blocks before the change keep their nodes.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Markdown, renderMarkdown, updateStreamingBlocks, type StreamedBlocks } from '../src/renderer/src/components/Markdown'

const SAMPLES = [
  '## Report\n\nGenio deployed **two** units.\n\n- first: `done`\n- second: pending\n\n```ts\nconst x = 1\nconst y = 2\n```\n\nThat is all.',
  'A paragraph\nwith a soft break and a [link](https://example.com) and an ![image](genio-media://chat/a/b.png).\n\n> quoted\n> lines\n\n1. one\n2. two\n\n   nested text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nSetext heading\n==============\n\nEnd.',
  'See [the docs][docs] and [more][m].\n\n[docs]: https://example.com/docs\n[m]: https://example.com/more "More"\n\nAfter the definitions.',
  'Inline <b>html</b> and <script>alert(1)</script> and <a href="javascript:alert(1)" target="_blank">x</a>.\n\n<div>\nblock html\n</div>\n\nTail *emphasis* and ~~strike~~.',
  '- [ ] task\n- [x] done\n\n    indented code\n\nText right after\n```\nunterminated fence'
]

const chunks = (text: string, size: number): string[] => {
  const out: string[] = []
  for (let i = size; i < text.length + size; i += size) out.push(text.slice(0, Math.min(i, text.length)))
  return out
}

it('matches a full render at every prefix of a streamed reply', () => {
  for (const sample of SAMPLES) {
    for (const size of [1, 7, 40]) {
      const host = document.createElement('div')
      const state: StreamedBlocks = { links: '', blocks: [] }
      for (const prefix of chunks(sample, size)) {
        updateStreamingBlocks(host, state, prefix)
        expect(host.innerHTML, `${JSON.stringify(prefix)}`).toBe(renderMarkdown(prefix))
      }
    }
  }
})

it('keeps the nodes of unchanged blocks and rebuilds only the tail', () => {
  const host = document.createElement('div')
  const state: StreamedBlocks = { links: '', blocks: [] }
  updateStreamingBlocks(host, state, 'First paragraph.\n\nSecond')
  const first = host.firstChild
  updateStreamingBlocks(host, state, 'First paragraph.\n\nSecond grows')
  expect(host.firstChild).toBe(first)
  expect(host.innerHTML).toBe(renderMarkdown('First paragraph.\n\nSecond grows'))
  // A reference definition can change earlier blocks: everything is rebuilt.
  updateStreamingBlocks(host, state, '[a][r] First paragraph.\n\nSecond grows')
  const relinked = host.firstChild
  updateStreamingBlocks(host, state, '[a][r] First paragraph.\n\nSecond grows\n\n[r]: https://example.com')
  expect(host.firstChild).not.toBe(relinked)
  expect(host.innerHTML).toBe(renderMarkdown('[a][r] First paragraph.\n\nSecond grows\n\n[r]: https://example.com'))
})

it('renders the final reply in full once it stops streaming', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const el = document.createElement('div')
  const root = createRoot(el)
  await act(async () => root.render(React.createElement(Markdown, { text: 'One.\n\nTw', className: 'streaming' })))
  expect(el.querySelector('.md.streaming')!.innerHTML).toBe(renderMarkdown('One.\n\nTw'))
  await act(async () => root.render(React.createElement(Markdown, { text: 'One.\n\nTwo.', className: 'streaming' })))
  expect(el.querySelector('.md.streaming')!.innerHTML).toBe(renderMarkdown('One.\n\nTwo.'))
  await act(async () => root.render(React.createElement(Markdown, { text: 'One.\n\nTwo.', className: '' })))
  expect(el.querySelector('.md.streaming')).toBeNull()
  expect(el.querySelector('.md')!.innerHTML).toBe(renderMarkdown('One.\n\nTwo.'))
  await act(async () => root.unmount())
})
