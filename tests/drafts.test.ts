import { describe, expect, it } from 'vitest'
import { clearDraft, getDraft, setDraft } from '../src/renderer/src/drafts'

describe('composer drafts', () => {
  it('keeps one draft per chat', () => {
    setDraft('genio', 'hello')
    setDraft('ally-1', 'other')
    expect(getDraft('genio')).toBe('hello')
    expect(getDraft('ally-1')).toBe('other')
    expect(getDraft('nobody')).toBe('')
  })

  it('clears a draft', () => {
    setDraft('genio', 'sent soon')
    clearDraft('genio')
    expect(getDraft('genio')).toBe('')
    setDraft('ally-1', '')
    expect(getDraft('ally-1')).toBe('')
  })
})
