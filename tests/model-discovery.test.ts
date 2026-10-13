import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ sent: [] as { method: string; params: any }[], geminiError: false }))
vi.mock('../src/main/util', () => ({ which: () => 'fake-cli.exe', killTree: vi.fn(), stripAnsi: (s: string) => s, run: vi.fn(), runShell: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { PassThrough, Writable } = await import('node:stream')
  const { EventEmitter } = await import('node:events')
  return { spawn: () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new Writable({ write(chunk, _, callback) {
      const message = JSON.parse(chunk.toString())
      state.sent.push(message)
      if (message.id) queueMicrotask(() => {
        let result: unknown = {}
        if (message.method === 'model/list') result = message.params.cursor ?
          { data: [{ id: 'second', hidden: true }], nextCursor: null } : { data: [{ id: 'first' }], nextCursor: 'next' }
        if (message.method === 'session/new') result = { models: { availableModels: [{ modelId: 'gemini-real' }] } }
        stdout.write(JSON.stringify(message.method === 'session/new' && state.geminiError ?
          { id: message.id, error: { message: 'Gemini API key is missing or not configured' } } : { id: message.id, result }) + '\n')
      })
      callback()
    } })
    return Object.assign(new EventEmitter(), { stdin, stdout, stderr })
  } }
})
beforeEach(() => { state.sent = []; state.geminiError = false })
it('initializes Codex and follows model/list pages, without sending any inference request', async () => {
  const { codexModels } = await import('../src/main/model-discovery')
  expect(await codexModels()).toEqual([{ id: 'first' }, { id: 'second', hidden: true }])
  expect(state.sent.map(s => s.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
  expect(state.sent[3].params).toMatchObject({ cursor: 'next', includeHidden: true })
})
it('reads authenticated Gemini ACP session options without prompting', async () => {
  const { geminiModels } = await import('../src/main/model-discovery')
  expect(await geminiModels()).toEqual([{ modelId: 'gemini-real' }])
  expect(state.sent.map(s => s.method)).toEqual(['initialize', 'session/new'])
})
it('preserves the Gemini authentication failure for state mapping', async () => {
  state.geminiError = true
  const { geminiModels } = await import('../src/main/model-discovery')
  await expect(geminiModels()).rejects.toThrow('Gemini API key is missing or not configured')
})
