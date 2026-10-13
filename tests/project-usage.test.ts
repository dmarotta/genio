import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import { recordCodexChatUsage, usageReport } from '../src/main/usage'

// Attribution uses local session logs; live plan refresh has separate coverage.
vi.mock('../src/main/claude-usage-probe', () => ({ refreshClaudePlanUsage: async () => {}, claudeProbeError: () => undefined }))

it('attributes project chats despite cwd drift, nested unit worktrees and old sessions without splitting legacy chat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-project-usage-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'))
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'))
  try {
    const main = new Home(path.join(root, 'genio'))
    const a = new Home(main.wkspHome('a'), 'a', main)
    const b = new Home(main.wkspHome('b'), 'b', main)
    for (const home of [main, a, b]) home.ensure()
    fs.writeFileSync(main.wkspFile, JSON.stringify({ sessionId: 'legacy' }))
    fs.writeFileSync(a.wkspFile, JSON.stringify({ sessionId: 'a-chat', botSessionId: 'a-bot' }))
    fs.mkdirSync(path.join(b.data, 'usage'), { recursive: true })
    fs.writeFileSync(path.join(b.data, 'usage', 'session-costs.json'), JSON.stringify({ sessions: { 'b-old': {}, 'codex-old': {} } }))
    const dir = path.join(root, 'claude', 'projects', 'test')
    fs.mkdirSync(dir, { recursive: true })
    const row = (session: string, cwd: string, input: number) => JSON.stringify({ type: 'assistant', sessionId: session,
      cwd, timestamp: new Date().toISOString(), requestId: session,
      message: { id: session, usage: { input_tokens: input, output_tokens: 1 } } })
    fs.writeFileSync(path.join(dir, 'usage.jsonl'), [
      row('a-chat', path.join(root, 'external'), 10), row('a-chat', path.join(root, 'external'), 10),
      row('a-bot', a.root, 20), row('b-old', path.join(root, 'other'), 30),
      row('a-unit', a.worktreeFor('world-a', 'task'), 40), row('legacy', main.root, 50),
      row('unrelated', path.join(root, 'external'), 900)
    ].join('\n'))
    recordCodexChatUsage(main.data, a.root, 'codex-a', { total: { inputTokens: 100, outputTokens: 5 } })
    recordCodexChatUsage(main.data, b.root, 'codex-b', { total: { inputTokens: 200, outputTokens: 5 } })
    const codexDir = path.join(root, 'codex', 'sessions')
    fs.mkdirSync(codexDir, { recursive: true })
    const codexLog = (id: string, cwd: string) => [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count',
        info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } } })
    ].join('\n')
    fs.writeFileSync(path.join(codexDir, 'rollout-old.jsonl'), codexLog('codex-old', path.join(root, 'external')))
    fs.writeFileSync(path.join(codexDir, 'rollout-unit.jsonl'), codexLog('codex-unit', a.worktreeFor('world-a', 'unit')))
    const ctx = { settings: { get: () => ({}) }, main: { home: main }, homes: new Map([['main', { home: main }], ['a', { home: a }], ['b', { home: b }]]),
      allies: { list: () => [{ name: 'a', projects: ['world-a'] }, { name: 'b', projects: ['world-b'] }] } } as unknown as AppCtx
    const report = await usageReport(ctx)
    expect(report.tools.map(t => t.error)).toEqual([undefined, undefined])
    const claude = report.tools.find(t => t.tool === 'claude')!.measured!
    expect(claude.today.total).toBe(155)
    expect(claude.byWorld?.['world-a'].today.total).toBe(73)
    expect(claude.byWorld?.['world-b'].today.total).toBe(31)
    const codex = report.tools.find(t => t.tool === 'codex')!.measured!
    expect(codex.byWorld?.['world-a'].today.total).toBe(117)
    expect(codex.byWorld?.['world-b'].today.total).toBe(217)
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
