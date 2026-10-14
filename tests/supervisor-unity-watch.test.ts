import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const watcher = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), poll: vi.fn(async (_roots: unknown[], _notify: unknown) => {}) }))
vi.mock('../src/main/unity-guards', () => ({ createUnityProcessWatch: () => watcher }))
import { Home } from '../src/main/home'
import { createSupervisor } from '../src/main/supervisor'
import { unityUnitConfig } from '../src/main/unity-unit'
import type { AppCtx } from '../src/main/services'

let tmp: string
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

it('watches Claude, Codex and other harnesses every five seconds independently of status polling, and stops on shutdown', async () => {
  vi.useFakeTimers()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-supervisor-unity-'))
  const home = new Home(tmp); home.ensure()
  const world = path.join(tmp, 'world'); fs.mkdirSync(world)
  const tasks = ['claude', 'codex', 'other'].map((harness, index) => {
    const id = `unit-${harness}`, worktree = path.join(tmp, id)
    fs.mkdirSync(worktree)
    const config = unityUnitConfig({ path: world, engine: 'unity', engineRoot: '' } as any,
      { task: id, worktree, data: home.data, taskDir: home.taskDir(id) })!
    fs.writeFileSync(home.taskStateFile(id, '.unity.json'), JSON.stringify(config))
    return { id, harness, terminalId: `terminal-${index}` }
  })
  const terminals = new Map(tasks.map((task, index) => [task.terminalId, { alive: true, pid: index + 100, processStartedAt: Date.now(), processSpawnedAt: Date.now() }]))
  const crew = { list: () => tasks, send: vi.fn(async () => ({ ok: true })) }
  const ctx = { home: () => ({ crew }), settings: { get: () => ({ pollSeconds: 60 }) }, terminals: { get: (id: string) => terminals.get(id) } } as unknown as AppCtx
  const supervisor = createSupervisor(() => ctx, home)
  supervisor.start()
  expect(watcher.poll).toHaveBeenCalledOnce()
  const roots = watcher.poll.mock.calls[0][0] as any[]
  expect(roots.map(root => root.config.task)).toEqual(tasks.map(task => task.id))
  expect(roots.every(root => root.isLive())).toBe(true)
  terminals.get(tasks[0].terminalId)!.alive = false
  expect(roots[0].isLive()).toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(watcher.poll).toHaveBeenCalledTimes(2)
  expect((watcher.poll.mock.calls[1][0] as any[]).map(root => root.config.task)).toEqual(tasks.slice(1).map(task => task.id))
  const notify = watcher.poll.mock.calls[1][1] as any
  notify(tasks[1].id, 'Use genio-unity')
  expect(crew.send).toHaveBeenCalledWith(tasks[1].id, 'Use genio-unity')
  supervisor.stop()
  await vi.advanceTimersByTimeAsync(10000)
  expect(watcher.stop).toHaveBeenCalledOnce()
  expect(watcher.poll).toHaveBeenCalledTimes(2)
})
