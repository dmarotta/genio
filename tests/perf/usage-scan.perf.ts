/**
 * Usage scan (Systems → Accounts, dispatch signals, every 5 minutes): parsing
 * the week's Claude Code and Codex session logs. Transcripts of running units
 * change constantly, so what a changed file costs to re-scan matters most.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { note, perfRoot, report, timeAsync } from './support'

vi.mock('../../src/main/claude-usage-probe', () => ({ refreshClaudePlanUsage: async () => undefined, claudeProbeError: () => undefined }))
vi.mock('../../src/main/codex-usage-probe', async (original) => ({ ...await original<typeof import('../../src/main/codex-usage-probe')>(), refreshCodexPlanUsage: async () => undefined }))

import { usageReport } from '../../src/main/usage'
import type { AppCtx } from '../../src/main/services'

const FILES = 6
const LINES_PER_FILE = 12_000
let root: string
const savedHomes = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }
let ctx: AppCtx
let files: string[] = []

/** Claude Code transcript lines: mostly tool results and user turns, one assistant line with usage per ~4 lines. */
function transcriptLine(i: number, session: string, cwd: string): string {
  const ts = new Date(Date.now() - (LINES_PER_FILE - i) * 1000).toISOString()
  if (i % 4 === 1) return JSON.stringify({ type: 'assistant', uuid: `u-${i}`, requestId: `req_${i}`, sessionId: session, cwd, timestamp: ts, message: { id: `msg_${i}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Working on it. '.repeat(40) }], usage: { input_tokens: 12, cache_creation_input_tokens: 400, cache_read_input_tokens: 90_000, output_tokens: 180 } } })
  if (i % 4 === 2) return JSON.stringify({ type: 'user', uuid: `u-${i}`, sessionId: session, cwd, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'x'.repeat(6000) }] } })
  return JSON.stringify({ type: 'progress', uuid: `u-${i}`, sessionId: session, cwd, timestamp: ts, data: { kind: 'bash', line: '#'.repeat(1500) } })
}

beforeAll(() => {
  root = perfRoot('genio-usage-')
  const claudeHome = path.join(root, 'claude')
  const codexHome = path.join(root, 'codex')
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  process.env.CODEX_HOME = codexHome
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true })
  const base = path.join(root, 'base')
  fs.mkdirSync(path.join(base, 'data', 'usage'), { recursive: true })
  const project = path.join(claudeHome, 'projects', 'C--Users-dani--genio-worktrees-genio-unit')
  fs.mkdirSync(project, { recursive: true })
  for (let k = 0; k < FILES; k++) {
    const file = path.join(project, `session-${k}.jsonl`)
    const cwd = path.join(base, 'worktrees', 'genio', `unit-${k}`)
    const lines: string[] = []
    for (let i = 0; i < LINES_PER_FILE; i++) lines.push(transcriptLine(i, `session-${k}`, cwd))
    fs.writeFileSync(file, lines.join('\n') + '\n')
    files.push(file)
  }
  const home = { root: base, data: path.join(base, 'data'), wkspFile: path.join(base, 'state', 'wksp.json'), name: 'main' }
  ctx = { main: { home }, homes: new Map([['main', { home }]]), allies: { list: () => [] }, settings: { get: () => ({}) } } as unknown as AppCtx
})
afterAll(() => { report(); process.env.CLAUDE_CONFIG_DIR = savedHomes.claude; process.env.CODEX_HOME = savedHomes.codex; fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

describe('usage scan over a week of session logs', () => {
  it('cold scan, warm scan, and a re-scan after one appended line per file', async () => {
    note('transcript bytes on disk', files.reduce((n, f) => n + fs.statSync(f).size, 0), 'bytes', `${FILES} files`)
    await timeAsync('usage scan: cold (every file parsed)', async () => { await usageReport(ctx) }, { iterations: 1, warmup: 0 })
    await timeAsync('usage scan: warm (nothing changed)', async () => { await usageReport(ctx) }, { iterations: 3, warmup: 1 })
    await timeAsync('usage scan: after 1 appended line per file', async () => {
      for (const [k, file] of files.entries()) fs.appendFileSync(file, transcriptLine(LINES_PER_FILE + 1, `session-${k}`, path.join(root, 'base', 'worktrees', 'genio', `unit-${k}`)) + '\n')
      await usageReport(ctx)
    }, { iterations: 3, warmup: 0 })
  })
})
