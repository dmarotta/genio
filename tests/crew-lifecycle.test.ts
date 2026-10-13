import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { removeHandler() {}, handle: (name: string, fn: any) => handlers.set(name, fn) }, BrowserWindow: {}, dialog: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createToolRegistry } from '../src/main/wksp-tools'
import { registerIpc } from '../src/main/ipc'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'

let root: string, home: Home, ctx: AppCtx, task: Task
let terminal: { id: string; alive: boolean } | undefined
let release: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-lifecycle-'))
  home = new Home(root); home.ensure()
  const worktree = path.join(root, 'worktrees', 'unit')
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(home.taskDir('unit'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'preserve my work')
  fs.writeFileSync(home.briefFile('unit'), '# Existing mission')
  task = { id: 'unit', kind: 'ship', project: 'world', wksp: 'main', state: 'exited', harness: 'test',
    worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 1, automaticRelaunches: 1 } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
  terminal = undefined
  release = vi.fn()
  const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, id: 'test', enabled: true, command: 'fake-unit' }
  const hc = { home, crew: undefined as any }
  ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => undefined },
    terminals: { get: (id: string) => terminal?.id === id ? terminal : undefined, lastOutputAt: () => undefined,
      create: vi.fn(() => { terminal = { id: 'new-terminal', alive: true }; return terminal }),
      submit: vi.fn(async () => { if (terminal) terminal.alive = false }), kill: vi.fn(), onData: () => () => {}, onExit: vi.fn() },
    dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release, check: async () => {} })), record: vi.fn() },
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); handlers.clear() })

describe('non-destructive lifecycle recovery', () => {
  it('holds automatic repeats but gives UI and player-authorized chat the same explicit restart authority', async () => {
    const crew = ctx.main.crew
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(false)
    const tool = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'control')!
    expect(await tool.invoke({ task: task.id, action: 'relaunch' })).toMatchObject({ isError: true })
    expect(await tool.invoke({ task: task.id, action: 'relaunch', player_words: 'restart this unit' })).not.toHaveProperty('isError')
    expect(crew.get(task.id)).toMatchObject({ state: 'working', automaticRelaunches: 0, relaunches: 2, branch: task.branch, worktree: task.worktree })
    crew.update(task.id, { automaticRelaunches: 1 })
    registerIpc(() => ctx)
    expect(await handlers.get('genio:controlTask')!({ sender: { id: 1 } }, task.id, 'relaunch')).toMatchObject({ ok: true })
    expect(crew.get(task.id)).toMatchObject({ automaticRelaunches: 0, relaunches: 3 })
    expect(fs.readFileSync(path.join(task.worktree, 'uncommitted.txt'), 'utf8')).toBe('preserve my work')
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('preserves work and retry history when restart fails, and releases phantom capacity', async () => {
    ctx.terminals.create = vi.fn(() => { throw new Error('terminal launch failed') })
    const result = await ctx.main.crew.control(task.id, 'relaunch', 'resume existing work', true)
    expect(result).toEqual({ ok: false, message: 'terminal launch failed' })
    expect(ctx.main.crew.get(task.id)).toMatchObject({ state: 'failed', automaticRelaunches: 1, relaunches: 1, branch: task.branch, worktree: task.worktree })
    expect(ctx.main.crew.capacityUsed('world')).toBe(0)
    expect(fs.readFileSync(path.join(task.worktree, 'uncommitted.txt'), 'utf8')).toBe('preserve my work')
    expect(fs.readFileSync(task.briefPath, 'utf8')).toContain('# Existing mission')
    expect(release).toHaveBeenCalledOnce()
  })

  it('returns UI-safe preparation failures without stopping a still-live unit or losing its slot', async () => {
    terminal = { id: 'old', alive: true }
    ctx.main.crew.update(task.id, { state: 'working', terminalId: 'old', briefPath: path.join(root, 'absent', 'brief.md') })
    const result = await ctx.main.crew.control(task.id, 'relaunch', undefined, true)
    expect(result.ok).toBe(false)
    expect(terminal.alive).toBe(true)
    expect(ctx.terminals.submit).not.toHaveBeenCalled()
    expect(ctx.main.crew.capacityUsed('world')).toBe(1)
    expect(release).toHaveBeenCalledOnce()
  })

  it('serializes concurrent restarts and never bypasses a quota or capacity rejection', async () => {
    let proceed!: () => void
    const pending = new Promise<void>(resolve => { proceed = resolve })
    ctx.dispatch.reserve = vi.fn(async () => { await pending; throw new Error('deferred: quota protection') })
    const first = ctx.main.crew.control(task.id, 'relaunch', undefined, true)
    expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: false, message: expect.stringContaining('already in progress') })
    proceed()
    expect(await first).toEqual({ ok: false, message: 'deferred: quota protection' })
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(ctx.main.crew.get(task.id)?.state).toBe('exited')
  })
})
