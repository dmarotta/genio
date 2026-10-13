import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { codexLimits, parseCodexSession, recordCodexChatLimits, recordCodexChatUsage, tally } from '../src/main/usage'

it('records cumulative chat telemetry once as plan tokens and preserves account windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-usage-'))
  try {
    const first = { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } }
    recordCodexChatUsage(dir, '/external/project', 'session-1', first)
    recordCodexChatUsage(dir, '/external/project', 'session-1', first)
    recordCodexChatUsage(dir, '/external/project', 'session-1', { total: { inputTokens: 150, cachedInputTokens: 50, outputTokens: 20 } })
    const contents = fs.readFileSync(path.join(dir, 'usage', 'codex-chat', 'session-1.jsonl'), 'utf8')
    const session = parseCodexSession(contents.split('\n'), 'session-1')
    expect(session.cwd).toBe('/external/project')
    expect(tally(session.records, 0)).toEqual({ input: 100, cached: 50, output: 20, total: 170, sessions: 1 })
    expect(contents).not.toMatch(/cost|dollars|USD/)
    recordCodexChatLimits(dir, { rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 } } })
    const snapshots = JSON.parse(fs.readFileSync(path.join(dir, 'usage', 'codex-chat-limits.json'), 'utf8'))
    expect(codexLimits(snapshots)[0].windows[0]).toMatchObject({ label: '5-hour', usedPercent: 23 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
