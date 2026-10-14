import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../src/main/git', () => ({ baseRef: async () => 'main', statusPorcelain: async () => [], hasRemote: async () => false,
  aheadBehind: async () => ({ ahead: 1, behind: 0 }), isAncestor: async () => true, push: vi.fn(), diff: async () => '' }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
vi.mock('../src/main/gauntlet-unity', () => ({ runUnityGate: vi.fn(async () => ({ outcome: 'passed', code: 0, output: 'Fake gate: 2 tests passed' })) }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createGauntlet } from '../src/main/gauntlet'
import { runUnityGate } from '../src/main/gauntlet-unity'
import { Home } from '../src/main/home'
import { unityUnitConfig } from '../src/main/unity-unit'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'

let tmp: string | undefined
afterEach(() => { vi.clearAllMocks(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

it('the Unity audit sends findings and skips review/push/PR before any external operation', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-gauntlet-guard-'))
  const home = new Home(tmp); home.ensure()
  const worktree = path.join(tmp, 'copy'), world = path.join(tmp, 'world')
  for (const dir of [worktree, world, home.taskDir('unit')]) fs.mkdirSync(dir, { recursive: true })
  const task = { id: 'unit', kind: 'ship', project: 'world', worktree, branch: 'genio/unit', baseBranch: 'main', terminalId: 'term', title: 'Fix game' } as Task
  const project = { name: 'world', path: world, engine: 'unity', engineRoot: '', commands: {} } as any
  const c = unityUnitConfig(project, { task: 'unit', worktree, data: home.data, taskDir: home.taskDir('unit') })!
  fs.writeFileSync(home.taskStateFile('unit', '.unity.json'), JSON.stringify(c))
  const crew = { get: () => task, update: vi.fn((_id, patch) => Object.assign(task, patch)), send: vi.fn(async () => ({ ok: true })), bump: vi.fn() }
  const hc = { crew }
  const ctx = { appRoot: tmp, home: () => hc, projects: { get: () => project }, settings: { get: () => ({ validationMaxRounds: 3 }) },
    terminals: { scrollback: () => '$ unity test' }, forge: { createPr: vi.fn() } } as unknown as AppCtx
  expect(await createGauntlet(() => ctx, home).run('unit')).toMatchObject({ ok: false })
  expect(task.validation).toMatchObject({ state: 'findings', findings: expect.stringContaining('Raw Unity command') })
  expect(task.validation!.steps.find(s => s.name === 'unity-guard')!.state).toBe('failed')
  expect(task.validation!.steps.filter(s => ['review', 'push', 'pr'].includes(s.name)).every(s => s.state === 'skipped')).toBe(true)
  expect(crew.send).toHaveBeenCalledWith('unit', expect.stringContaining('genio-unity'))
  expect(runUnityGate).toHaveBeenCalledOnce()
  expect(task.validation!.steps.find(s => s.name === 'test')!.state).toBe('passed')
  expect(query).not.toHaveBeenCalled()
  expect(ctx.forge.createPr).not.toHaveBeenCalled()
})
