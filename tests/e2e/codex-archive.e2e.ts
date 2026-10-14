/**
 * Opt-in check against the real Codex CLI (no login and no model usage: `codex
 * exec` records its thread before the unauthenticated turn fails):
 *   npm run test:e2e -- codex-archive
 * Everything runs in a temp CODEX_HOME; the player's ~/.codex is never touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { which } from '../../src/main/util'
import { archiveUnitThreads, manifestFile, runCodexCli, unarchiveCodexThread } from '../../src/main/codex-archive'
import { codexRolloutState, discoverCodexSession, findCodexSessions } from '../../src/main/codex-session'

const codex = which('codex')
const saved = { home: process.env.CODEX_HOME, bin: process.env.GENIO_CODEX_BIN }
let root: string, codexHome: string, cwd: string, data: string

describe.skipIf(!codex)('codex archive against the real CLI', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-e2e-codex-archive-'))
    codexHome = path.join(root, 'codex-home')
    cwd = path.join(root, 'worktrees', 'world', 'unit')
    data = path.join(root, 'data')
    fs.mkdirSync(codexHome, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    process.env.CODEX_HOME = codexHome
    delete process.env.GENIO_CODEX_BIN
  })
  afterAll(() => {
    if (saved.home === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved.home
    if (saved.bin !== undefined) process.env.GENIO_CODEX_BIN = saved.bin
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('archives a finished unit thread, keeps it discoverable, and unarchives it for a resume', async () => {
    const r = await runCodexCli(['exec', '--skip-git-repo-check', '-C', cwd, '--json', 'hi'], codexHome)
    const id = /"thread_id":"([^"]+)"/.exec(r.stdout)?.[1]
    expect(id, r.stderr).toBeTruthy()
    expect(await findCodexSessions(cwd, codexHome)).toMatchObject([{ id, archived: false }])

    expect(await archiveUnitThreads(cwd, { dataDir: data, codexHome, task: 'unit' })).toEqual({ archived: [id], pending: [], skipped: [] })
    expect(await codexRolloutState(id!, codexHome)).toBe('archived')
    expect(fs.readdirSync(path.join(codexHome, 'archived_sessions')).some(f => f.endsWith(`-${id}.jsonl`))).toBe(true)
    expect(await discoverCodexSession(cwd, codexHome)).toBe(id)
    // Already archived: nothing more to do, and Codex is not asked again.
    expect(await archiveUnitThreads(cwd, { dataDir: data, codexHome })).toEqual({ archived: [], pending: [], skipped: [] })

    expect(await unarchiveCodexThread(id!, { dataDir: data, codexHome, task: 'unit' })).toBe(true)
    expect(await codexRolloutState(id!, codexHome)).toBe('live')
    const manifest = fs.readFileSync(manifestFile(data), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(manifest.map(e => [e.action, e.id])).toEqual([['archive', id], ['unarchive', id]])
  })
})
