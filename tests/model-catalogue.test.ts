import { describe, expect, it } from 'vitest'
import { canDrive, filterModels, modelState, normalizeModels, type CatalogueRoute } from '@shared/model-catalogue'
import { parseOpenCodeModels } from '../src/main/model-discovery'

describe('model catalogue normalization', () => {
  it('merges Claude aliases by resolved id while retaining effort metadata', () => {
    const models = normalizeModels('claude', 'Anthropic', [
      { value: 'default', resolvedModel: 'claude-opus', displayName: 'Default', supportedEffortLevels: ['low', 'max'] },
      { value: 'opus', resolvedModel: 'claude-opus', displayName: 'Opus' },
      { value: 'claude-opus', displayName: 'Opus' }, { value: 'sonnet', resolvedModel: 'claude-sonnet' }
    ])
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'claude-opus', name: 'Opus', aliases: ['default', 'opus', 'claude-opus'], efforts: ['low', 'max'] })
    expect(models[0].key).toBe('claude:Anthropic:claude-opus')
  })
  it('keeps different provider routes distinct and retains Codex capabilities', () => {
    const raw = [{ id: 'internal-id', model: 'gpt', hidden: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]
    const [codex] = normalizeModels('codex', 'OpenAI', raw)
    const [router] = normalizeModels('opencode', 'OpenRouter', raw)
    expect(codex.key).not.toBe(router.key)
    expect(codex).toMatchObject({ id: 'gpt', images: true, hidden: true, efforts: ['high'] })
  })
})
describe('honest route states', () => {
  it('maps Gemini missing authentication to Sign in, never a fabricated list', () => {
    expect(modelState(true, 'unknown', 'Gemini API key is missing or not configured')).toBe('sign-in-needed')
    expect(normalizeModels('gemini', 'Google', [])).toEqual([])
  })
  it('distinguishes unknown, missing CLI, signed out and connected', () => {
    expect(modelState(false, 'logged-in')).toBe('unavailable')
    expect(modelState(true, 'unknown')).toBe('unavailable')
    expect(modelState(true, 'logged-out')).toBe('sign-in-needed')
    expect(modelState(true, 'logged-in')).toBe('connected')
    expect(modelState(true, 'logged-in', 'Timed out')).toBe('unavailable')
  })
  it('allows only fresh authenticated Claude routes to drive chat', () => {
    const route: CatalogueRoute = { runtime: 'claude', provider: 'Anthropic', state: 'connected', stale: false, checkedAt: '', lastResult: 'ok', models: [] }
    expect(canDrive(route)).toBe(true)
    expect(canDrive({ ...route, runtime: 'codex' })).toBe(false)
    expect(canDrive({ ...route, stale: true })).toBe(false)
    expect(canDrive({ ...route, state: 'sign-in-needed' })).toBe(false)
  })
})
describe('picker filtering', () => {
  const models = [
    ...normalizeModels('claude', 'Anthropic', [{ value: 'opus', resolvedModel: 'claude-opus', displayName: 'Opus' }]),
    ...normalizeModels('codex', 'OpenAI', [{ id: 'gpt-sol', displayName: 'GPT Sol' }, { id: 'internal', hidden: true }])
  ]
  it('searches case-insensitively across names, aliases and runtime and combines chips', () => {
    expect(filterModels(models, 'OPUS claude', 'Anthropic').map(m => m.id)).toEqual(['claude-opus'])
    expect(filterModels(models, 'codex sol').map(m => m.id)).toEqual(['gpt-sol'])
    expect(filterModels(models, 'opus', 'OpenAI')).toEqual([])
  })
  it('hides internal models unless explicitly requested', () => {
    expect(filterModels(models, '')).toHaveLength(2)
    expect(filterModels(models, '', 'OpenAI', true)).toHaveLength(2)
    expect(filterModels(models, 'internal')).toEqual([])
  })
})
it('parses OpenCode metadata and only advertises verified zero-cost text candidates anonymously', () => {
  const text = (name: string, input: number) => `opencode/${name}\n${JSON.stringify({ name, cost: { input, output: input }, capabilities: { input: { text: true, image: true }, output: { text: true } }, variants: { high: {} } }, null, 2)}\n`
  expect(parseOpenCodeModels(text('free', 0) + text('paid', 1), 'opencode')).toEqual([
    { id: 'opencode/free', name: 'free', inputModalities: ['text', 'image'], hidden: false, supportedEffortLevels: ['high'] }
  ])
})
