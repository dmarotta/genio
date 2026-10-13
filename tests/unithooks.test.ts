import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { installUnitHooks, type UnitHookOptions } from '../src/main/unithooks'

const GENIO = 'Co-authored-by: Genio <noreply@genio.invalid>'
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function setup(o: UnitHookOptions): Promise<{ commit: (msg: string, ...extra: string[]) => string; env: Record<string, string> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-hooks-'))
  dirs.push(root)
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } })
  run(['init', '-q'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'user.email', 'test@example.invalid'])
  const env = await installUnitHooks(path.join(root, 'hooks'), repo, o)
  let n = 0
  const commit = (msg: string, ...extra: string[]): string => {
    fs.writeFileSync(path.join(repo, 'f.txt'), String(n++))
    run(['add', '.'])
    run(['commit', '-q', '-m', msg, ...extra], env)
    return run(['log', '-1', '--format=%B'])
  }
  return { commit, env }
}

const count = (s: string, needle: string): number => s.split(needle).length - 1

describe('unit commit hooks', () => {
  it('appends exactly one Genio trailer as a proper trailer block', async () => {
    const { commit } = await setup({ stripAiTrailers: false, genioCoAuthor: true })
    const msg = commit('Add jump')
    expect(msg.trim()).toBe(`Add jump\n\n${GENIO}`)
  })

  it('is idempotent on amend and never duplicates a hand-added trailer', async () => {
    const { commit } = await setup({ stripAiTrailers: false, genioCoAuthor: true })
    const first = commit('Add jump')
    const amended = commit(first, '--amend')
    expect(count(amended, 'noreply@genio.invalid')).toBe(1)
    expect(count(commit(`Fix\n\n${GENIO}`), 'noreply@genio.invalid')).toBe(1)
  })

  it('coexists with stripping: Claude/Codex trailers go, Genio stays', async () => {
    const { commit } = await setup({ stripAiTrailers: true, genioCoAuthor: true })
    const msg = commit(
      'Add jump\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Codex <codex@openai.com>\nCo-authored-by: Ana <ana@example.com>'
    )
    expect(msg).not.toMatch(/Claude|Codex/)
    expect(msg).toContain('Co-authored-by: Ana <ana@example.com>')
    expect(count(msg, GENIO)).toBe(1)
  })

  it('adds nothing when disabled', async () => {
    const { commit } = await setup({ stripAiTrailers: true, genioCoAuthor: false })
    expect(commit('Add jump')).not.toContain('Genio')
  })

  it('uses a configured identity', async () => {
    const { commit } = await setup({ stripAiTrailers: false, genioCoAuthor: true, genioCoAuthorIdentity: 'Bot <bot@x.invalid>' })
    expect(commit('Add jump')).toContain('Co-authored-by: Bot <bot@x.invalid>')
  })

  it('installs hooks when only genioCoAuthor is on, and none when both are off', async () => {
    expect((await setup({ stripAiTrailers: false, genioCoAuthor: true })).env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect((await setup({ stripAiTrailers: false, genioCoAuthor: false })).env).toEqual({})
  })
})
