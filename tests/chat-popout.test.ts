import { expect, it } from 'vitest'
import { isChatPopoutUrl } from '../src/shared/chat-popout'

it('requires the exact owning page, project and dedicated fragment', () => {
  for (const owner of ['file:///genio/index.html?project=one&wksp=ally-one', 'http://localhost:5173/?project=one&wksp=ally-one']) {
    expect(isChatPopoutUrl(owner + '#genio-inventory-chat', owner)).toBe(true)
    expect(isChatPopoutUrl(owner.replace('project=one', 'project=two') + '#genio-inventory-chat', owner)).toBe(false)
    expect(isChatPopoutUrl(owner + '#other', owner)).toBe(false)
    expect(isChatPopoutUrl('https://example.com/#genio-inventory-chat', owner)).toBe(false)
  }
  expect(isChatPopoutUrl('invalid', 'invalid')).toBe(false)
})
