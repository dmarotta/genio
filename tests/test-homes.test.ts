import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { assertChildHomes, assertIsolatedHomes, assertNoAgentLeaks, assertTempPath, copyFixtureBase, createIsolatedHomes, realAgentHomes, type IsolatedHomes } from './support/isolated-homes.mjs'
import { captureUserData } from '../src/main/capture-isolation'
import { defaultHomeRoot } from '../src/main/home'
import { codexHomeDir } from '../src/main/codex-session'
import { playerClaudeDir, playerClaudeJson } from '../src/main/claude-home'

let sandbox: IsolatedHomes | undefined
afterEach(() => { vi.unstubAllEnvs(); sandbox?.dispose(); sandbox = undefined })

it('isolates inherited homes and child processes, including HOME fallback paths', () => {
  sandbox = createIsolatedHomes()
  expect(() => assertIsolatedHomes(sandbox!.env)).not.toThrow()
  expect(() => assertChildHomes({ ...process.env, ...sandbox!.env })).not.toThrow()
  const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
    const sessions = path.join(process.env.CODEX_HOME, 'sessions');
    fs.mkdirSync(sessions); fs.writeFileSync(path.join(sessions, 'test.jsonl'), '{}');
    console.log(JSON.stringify({ home: os.homedir(), claude: process.env.CLAUDE_CONFIG_DIR, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, genio: process.env.GENIO_HOME }));
  `], { env: { ...process.env, ...sandbox.env }, encoding: 'utf8', windowsHide: true }))
  expect(child).toMatchObject({ home: sandbox.env.HOME, claude: sandbox.env.CLAUDE_CONFIG_DIR, secure: sandbox.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, genio: sandbox.env.GENIO_HOME })
  expect(fs.existsSync(path.join(sandbox.env.CODEX_HOME, 'sessions', 'test.jsonl'))).toBe(true)
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GENIO_HOME']) vi.stubEnv(key, undefined)
  for (const resolved of [os.homedir(), defaultHomeRoot(), codexHomeDir(), playerClaudeDir({}), playerClaudeJson({})]) assertTempPath(resolved)
})

it('rejects outside HOME paths and incomplete or unsafe capture environments before launch', () => {
  sandbox = createIsolatedHomes()
  expect(captureUserData({})).toBeUndefined()
  expect(() => captureUserData({ GENIO_CAPTURE_DIR: sandbox!.root })).toThrow(/isolated temp homes/)
  const env = { ...sandbox.env, GENIO_CAPTURE_DIR: sandbox.root, GENIO_CAPTURE_ROOT: sandbox.root }
  expect(captureUserData(env)).toBe(path.join(sandbox.root, 'electron-user-data'))
  for (const key of Object.keys(sandbox.env).filter(key => !key.startsWith('GENIO_TEST_'))) {
    expect(() => assertIsolatedHomes({ ...env, [key]: path.parse(os.tmpdir()).root })).toThrow()
    expect(() => captureUserData({ ...env, [key]: path.parse(os.tmpdir()).root })).toThrow()
  }
  const link = path.join(sandbox.root, 'escape')
  fs.symlinkSync(path.parse(os.tmpdir()).root, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertTempPath(path.join(link, 'outside'))).toThrow(/outside/)
  expect(() => captureUserData({ ...env, CODEX_HOME: link })).toThrow(/isolated temp homes/)
})

it('detects only attributable transcripts and SQLite threads, ignoring concurrent unrelated writes', () => {
  sandbox = createIsolatedHomes()
  const env = sandbox.env
  for (const dir of [path.join(env.CODEX_HOME, 'sessions'), path.join(env.CLAUDE_CONFIG_DIR, 'projects')]) fs.mkdirSync(dir)
  const db = path.join(env.CODEX_HOME, 'state_5.sqlite')
  const writer = new DatabaseSync(db)
  writer.exec('CREATE TABLE threads (cwd TEXT, rollout_path TEXT, first_user_message TEXT)')
  const token = path.basename(process.env.GENIO_TEST_RUN_ROOT!) + '-leak-fixture'
  const real = realAgentHomes(env, env.HOME)
  writer.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('unrelated-cwd', 'unrelated-path', 'unrelated prompt')
  fs.writeFileSync(path.join(env.CODEX_HOME, 'sessions', 'unrelated.jsonl'), '{"cwd":"unrelated"}\n')
  expect(() => assertNoAgentLeaks(real, token)).not.toThrow()
  fs.writeFileSync(path.join(env.CODEX_HOME, 'sessions', 'new.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(sandbox.root, token) } }))
  expect(() => assertNoAgentLeaks(real, token)).toThrow(/new.jsonl/)
  fs.unlinkSync(path.join(env.CODEX_HOME, 'sessions', 'new.jsonl'))
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'new.jsonl'), JSON.stringify({ cwd: token }))
  expect(() => assertNoAgentLeaks(real, token)).toThrow(/new.jsonl/)
  fs.unlinkSync(path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'new.jsonl'))
  writer.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(token, 'rollout', 'test prompt')
  writer.close()
  const bytesBefore = fs.readFileSync(db)
  expect(() => assertNoAgentLeaks(real, token)).toThrow(/attributable thread/)
  expect(fs.readFileSync(db)).toEqual(bytesBefore) // The guard opens the database read-only.
})

it('skips real session folders and database homes that do not exist', () => {
  sandbox = createIsolatedHomes()
  const absent = path.join(sandbox.root, 'absent')
  const real = realAgentHomes({ CODEX_HOME: absent, CLAUDE_CONFIG_DIR: absent }, absent)
  expect(() => assertNoAgentLeaks(real, 'genio-absent-fixture-token')).not.toThrow()
})

it('copies capture fixtures without retaining external homes or worktree paths', () => {
  sandbox = createIsolatedHomes()
  const source = path.join(sandbox.root, 'fixture')
  fs.mkdirSync(source)
  const file = path.join(source, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ home: source, worktree: path.join(source, 'worktrees', 'unit'), env: { CODEX_HOME: 'C:/real-provider' } }))
  copyFixtureBase(source, sandbox.env.GENIO_HOME, sandbox.env)
  expect(JSON.parse(fs.readFileSync(path.join(sandbox.env.GENIO_HOME, 'config.json'), 'utf8'))).toEqual({
    home: sandbox.env.GENIO_HOME, worktree: path.join(sandbox.env.GENIO_HOME, 'worktrees', 'unit'), env: { CODEX_HOME: sandbox.env.CODEX_HOME }
  })
  fs.writeFileSync(file, JSON.stringify({ worktree: path.parse(source).root }))
  expect(() => copyFixtureBase(source, sandbox!.env.GENIO_HOME, sandbox!.env)).toThrow(/outside its Base/)
})
