import { describe, expect, it, vi } from 'vitest'
import { applyLiveConfig, sessionConfig, type LiveControls } from '../src/main/workspace'

const s = (workspaceModel: string, workspaceEffort: string, botModel = 'claude-haiku-5-5') => ({ workspaceModel, workspaceEffort, botModel })

function fakeQuery(fail = false): LiveControls & { setModel: ReturnType<typeof vi.fn>; applyFlagSettings: ReturnType<typeof vi.fn> } {
  const impl = () => (fail ? Promise.reject(new Error('unsupported')) : Promise.resolve())
  return { setModel: vi.fn(impl), applyFlagSettings: vi.fn(impl) } as never
}

describe('sessionConfig: chat model/effort settings', () => {
  it('Genio follows workspaceModel/workspaceEffort; blank means default', () => {
    expect(sessionConfig('genio', s('claude-opus-5-5', 'xhigh'))).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(sessionConfig('genio', s('', ''))).toEqual({ model: undefined, effort: undefined })
    expect(sessionConfig('genio', s('  ', 'bogus'))).toEqual({ model: undefined, effort: undefined })
  })

  it('an ally keeps its own overrides and falls back to the chat settings', () => {
    expect(sessionConfig('genio', s('claude-opus-5-5', 'high'), { model: 'claude-sonnet-5-5', effort: 'low' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(sessionConfig('genio', s('claude-opus-5-5', 'high'), {})).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  it('the Bot keeps botModel and low effort whatever the chat settings', () => {
    expect(sessionConfig('bot', s('claude-opus-5-5', 'max'))).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
    expect(sessionConfig('bot', s('claude-opus-5-5', 'max', ''))).toEqual({ model: undefined, effort: 'low' })
  })
})

describe('applyLiveConfig: switching a running session', () => {
  it('sends only what changed', async () => {
    const q = fakeQuery()
    expect(await applyLiveConfig(q, { model: 'a', effort: 'high' }, { model: 'b', effort: 'high' })).toBe(true)
    expect(q.setModel).toHaveBeenCalledWith('b')
    expect(q.applyFlagSettings).not.toHaveBeenCalled()
  })

  it('effort change uses the flag layer; clearing goes back to the default', async () => {
    const q = fakeQuery()
    await applyLiveConfig(q, { model: 'a', effort: 'high' }, { model: 'a', effort: 'max' })
    await applyLiveConfig(q, { model: 'a', effort: 'max' }, { model: undefined, effort: undefined })
    expect(q.applyFlagSettings).toHaveBeenNthCalledWith(1, { effortLevel: 'max' })
    expect(q.applyFlagSettings).toHaveBeenNthCalledWith(2, { effortLevel: null })
    expect(q.setModel).toHaveBeenCalledWith(undefined)
  })

  it('reports failure so the session restarts with resume', async () => {
    expect(await applyLiveConfig(fakeQuery(true), { model: 'a' }, { model: 'b' })).toBe(false)
  })
})
