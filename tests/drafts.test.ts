import { describe, expect, it } from 'vitest'
import { clearDraft, getDraft, getDraftImages, setDraft, setDraftImages } from '../src/renderer/src/drafts'

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

  it('keeps attached images per chat and clears them with the draft', () => {
    const img = { id: 'i1', mediaType: 'image/png' as const, data: 'AAAA', preview: 'data:image/png;base64,AAAA' }
    setDraftImages('genio', [img])
    expect(getDraftImages('genio')).toEqual([img])
    expect(getDraftImages('ally-1')).toEqual([])
    clearDraft('genio')
    expect(getDraftImages('genio')).toEqual([])
  })
})
