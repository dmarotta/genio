import { describe, expect, it } from 'vitest'
import { answerKey, isRecommended, quickRecommendation, recommendedFromQuestion } from '../src/renderer/src/lib/choice'

describe('answerKey', () => {
  it('Enter submits, Shift+Enter breaks the line, Esc blurs', () => {
    expect(answerKey({ key: 'Enter' })).toBe('submit')
    expect(answerKey({ key: 'Enter', shiftKey: true })).toBe('newline')
    expect(answerKey({ key: 'Escape' })).toBe('blur')
    expect(answerKey({ key: 'a' })).toBe('none')
  })
  it('ignores keys while an IME composes', () => {
    expect(answerKey({ key: 'Enter', isComposing: true })).toBe('none')
  })
})

describe('recommendedFromQuestion', () => {
  it('takes the option before "(recommended)"', () => {
    const q =
      "Asset browser as its own 'Inventory' screen replacing the Asset Generation rail menu, with an Inventory button on each world card (recommended), or merged into the Worlds screen?"
    expect(recommendedFromQuestion(q)).toBe(
      "Asset browser as its own 'Inventory' screen replacing the Asset Generation rail menu, with an Inventory button on each world card"
    )
  })
  it('finds a later option', () => {
    expect(recommendedFromQuestion('Keep the old menu, or drop it (recommended)?')).toBe('drop it')
    expect(recommendedFromQuestion('Pick one: SQLite (Recommended) vs JSON files')).toBe('SQLite')
    expect(recommendedFromQuestion('Either tabs [recommended] or a sidebar?')).toBe('tabs')
  })
  it('is undefined without a marker', () => {
    expect(recommendedFromQuestion('Tabs or a sidebar?')).toBeUndefined()
    expect(recommendedFromQuestion('(recommended) tabs or a sidebar?')).toBeUndefined()
  })
})

describe('quickRecommendation', () => {
  it('skips a recommendation that is already an option button', () => {
    expect(quickRecommendation({ question: 'A or B?', options: ['A', 'B'], recommendation: 'A — cheaper' })).toBeUndefined()
    expect(isRecommended('A', 'A — cheaper')).toBe(true)
  })
  it('offers a free-standing recommendation or one named in the question', () => {
    expect(quickRecommendation({ question: 'How?', options: [], recommendation: 'Do X' })).toBe('Do X')
    expect(quickRecommendation({ question: 'X (recommended) or Y?', options: [] })).toBe('X')
    expect(quickRecommendation({ question: 'X or Y?', options: [] })).toBeUndefined()
  })
})
