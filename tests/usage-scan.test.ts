import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/claude-usage-probe', () => ({ refreshClaudePlanUsage: async () => undefined, claudeProbeError: () => undefined }))
vi.mock('../src/main/codex-usage-probe', async (original) => ({ ...await original<typeof import('../src/main/codex-usage-probe')>(), refreshCodexPlanUsage: async () => undefined }))
import { readLines, scanDiagnostics, usageReport } from '../src/main/usage'
import type { AppCtx } from '../src/main/services'

let root: string, ctx: AppCtx, claudeFile: string, codexFile: string
const env = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }

const assistant = (i: number, cwd: string, session = 'sess-1'): string => JSON.stringify({ type: 'assistant', sessionId: session, cwd, requestId: `req_${i}`, timestamp: new Date(Date.now() - 1000 + i).toISOString(),
  message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 * i, output_tokens: i } } })
const codexMeta = (cwd: string): string => JSON.stringify({ timestamp: '2026-10-12T19:36:30.542Z', type: 'session_meta', payload: { id: 'cx-1', cwd } })
const codexTokens = (i: number, input: number, output: number): string => JSON.stringify({ timestamp: new Date(Date.now() - 1000 + i).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } }, rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 10 + i, window_minutes: 10080, resets_at: 1792312471 } } } })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-usage-scan-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  process.env.CODEX_HOME = path.join(root, 'codex')
  const base = path.join(root, 'base')
  fs.mkdirSync(path.join(base, 'data', 'usage'), { recursive: true })
  const project = path.join(root, 'claude', 'projects', 'C--base-worktrees-world-unit')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(root, 'codex', 'sessions'), { recursive: true })
  claudeFile = path.join(project, 'session.jsonl')
  codexFile = path.join(root, 'codex', 'sessions', 'cx-1.jsonl')
  const cwd = path.join(base, 'worktrees', 'world', 'unit')
  fs.writeFileSync(claudeFile, [assistant(1, cwd), assistant(2, cwd)].join('\n') + '\n')
  fs.writeFileSync(codexFile, [codexMeta(cwd), codexTokens(1, 1000, 50)].join('\n') + '\n')
  const home = { root: base, data: path.join(base, 'data'), wkspFile: path.join(base, 'state', 'wksp.json'), name: 'main' }
  ctx = { main: { home }, homes: new Map([['main', { home }]]), allies: { list: () => [] }, settings: { get: () => ({}) } } as unknown as AppCtx
  scanDiagnostics.bytesRead = 0; scanDiagnostics.filesRead = 0
})
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = env.claude; process.env.CODEX_HOME = env.codex
  if (env.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  if (env.codex === undefined) delete process.env.CODEX_HOME
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readLines', () => {
  it('reads from an offset, strips CR, and leaves a trailing partial line for the next read', async () => {
    const file = path.join(root, 'lines.txt')
    fs.writeFileSync(file, 'one\r\ntwo\nthr')
    const seen: string[] = []
    const consumed = await readLines(file, 0, (l) => seen.push(l))
    expect(seen).toEqual(['one', 'two', 'thr'])
    expect(consumed).toBe(Buffer.byteLength('one\r\ntwo\n'))
    fs.appendFileSync(file, 'ee\nfour\n')
    const more: string[] = []
    expect(await readLines(file, consumed, (l) => more.push(l))).toBe(fs.statSync(file).size)
    expect(more).toEqual(['three', 'four'])
  })
})

describe('usage scan over append-only session logs', () => {
  it('parses only the appended tail of a grown log and keeps earlier records and counters', async () => {
    const first = await usageReport(ctx)
    const cold = scanDiagnostics.bytesRead
    expect(cold).toBe(fs.statSync(claudeFile).size + fs.statSync(codexFile).size)
    expect(first.tools.find((t) => t.tool === 'claude')?.measured?.week).toMatchObject({ input: 20, cached: 300, output: 3, sessions: 1 })
    expect(first.tools.find((t) => t.tool === 'codex')?.measured?.week).toMatchObject({ input: 1000, output: 50 })

    scanDiagnostics.bytesRead = 0
    await usageReport(ctx)
    expect(scanDiagnostics.bytesRead).toBe(0) // unchanged files are never re-read

    const cwd = path.join(root, 'base', 'worktrees', 'world', 'unit')
    const claudeTail = assistant(3, cwd) + '\n'
    const codexTail = codexTokens(2, 1600, 80) + '\n'
    fs.appendFileSync(claudeFile, claudeTail)
    fs.appendFileSync(codexFile, codexTail)
    scanDiagnostics.bytesRead = 0
    const grown = await usageReport(ctx)
    expect(scanDiagnostics.bytesRead).toBe(Buffer.byteLength(claudeTail) + Buffer.byteLength(codexTail))
    expect(grown.tools.find((t) => t.tool === 'claude')?.measured?.week).toMatchObject({ input: 30, cached: 600, output: 6 })
    // the Codex delta continues from the cumulative total seen in the first scan: +600 input, +30 output
    expect(grown.tools.find((t) => t.tool === 'codex')?.measured?.week).toMatchObject({ input: 1600, output: 80 })
    expect(grown.tools.find((t) => t.tool === 'codex')?.limits[0]?.windows[0]).toMatchObject({ usedPercent: 12 })
  })

  it('re-reads a log from the start when it was truncated or rewritten', async () => {
    await usageReport(ctx)
    const cwd = path.join(root, 'base', 'worktrees', 'world', 'unit')
    fs.writeFileSync(claudeFile, assistant(9, cwd) + '\n')
    scanDiagnostics.bytesRead = 0
    const again = await usageReport(ctx)
    expect(scanDiagnostics.bytesRead).toBe(fs.statSync(claudeFile).size)
    expect(again.tools.find((t) => t.tool === 'claude')?.measured?.week).toMatchObject({ input: 10, cached: 900, output: 9 })
  })
})
