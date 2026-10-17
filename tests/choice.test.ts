import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { answerKey, askGenioMessage, choiceRows, isRecommended, quickRecommendation, recommendedFromQuestion } from '../src/renderer/src/lib/choice'

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
  it('does not mistake a compound or prefix answer for a recommended option', () => {
    expect(isRecommended('A', 'AB')).toBe(false)
    expect(isRecommended('A', 'A and B')).toBe(false)
    expect(quickRecommendation({ question: 'Which?', options: ['A', 'B'], recommendation: 'A and B' })).toBe('A and B')
    expect(quickRecommendation({ question: 'Which?', options: ['A', 'A — cheaper'], recommendation: 'A — cheaper' })).toBe('A — cheaper')
  })
})

describe('choiceRows', () => {
  it('gives each option a row and marks exactly the recommended one', () => {
    expect(choiceRows({ question: 'A or B?', options: ['A', 'B'], recommendation: 'A — cheaper' })).toEqual([{ text: 'A', rec: true }, { text: 'B', rec: false }])
    expect(choiceRows({ question: 'Which?', options: ['A', 'A — cheaper'], recommendation: 'A — cheaper' })).toEqual([{ text: 'A', rec: false }, { text: 'A — cheaper', rec: true }])
    expect(choiceRows({ question: 'Merge now?', options: ['Merge now', 'Not yet'] })).toEqual([{ text: 'Merge now', rec: false }, { text: 'Not yet', rec: false }])
  })
  it('adds a recommendation that is not an option as its own last row', () => {
    expect(choiceRows({ question: 'Which?', options: ['A', 'B'], recommendation: 'A and B' })).toEqual([{ text: 'A', rec: false }, { text: 'B', rec: false }, { text: 'A and B', rec: true }])
    expect(choiceRows({ question: 'X (recommended) or Y?', options: [] })).toEqual([{ text: 'X', rec: true }])
    expect(choiceRows({ question: 'How?', options: [] })).toEqual([])
  })
})

describe('askGenioMessage', () => {
  it('carries the question, details, numbered options with the recommendation and the asking unit', () => {
    expect(askGenioMessage({ question: 'Close the scene?', context: ' Only the copy. ', options: ['Close it', 'Keep it'], recommendation: 'Close it' }, 'Fix the jump')).toBe(
      'Help me decide this open choice.\nAsked by: Fix the jump\nQuestion: Close the scene?\nDetails: Only the copy.\nOptions:\n1. Close it (recommended)\n2. Keep it')
  })
  it('leaves out what a choice does not have', () => {
    expect(askGenioMessage({ question: 'What name?', options: [] })).toBe('Help me decide this open choice.\nQuestion: What name?')
  })
})

describe('choice panel stylesheet', () => {
  it('lays each option out as a full-width row above a bottom bar', () => {
    const css = readFileSync('src/renderer/src/styles/app.css', 'utf8')
    expect(css).toMatch(/\n\.choice-options \{[^}]*flex-direction: column/)
    expect(css).toMatch(/\n\.option \{[^}]*width: 100%/)
    expect(css).toMatch(/\n\.choice-foot \{[^}]*border-top/)
  })
})
