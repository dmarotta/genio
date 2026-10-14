/**
 * Main process: what one bus event costs on its way to the windows (snapshot
 * work, IPC bytes), how a streaming reply and a tool-heavy turn load the event
 * loop, and what terminal output from N units costs per 16 ms flush.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jsonBytes, note, perfRoot, report, seedBase, syntheticMessages, timeIt, withLoopLag, type SeededBase } from './support'
import type { ChatMessage, FleetSnapshot, GenioEvent } from '../../src/shared/types'

const f = vi.hoisted(() => ({ windows: [] as any[], ctx: undefined as any, terminalData: undefined as ((id: string, data: string) => void) | undefined, sent: [] as { channel: string; payload: unknown }[] }))
vi.mock('../../src/main/ctx', () => ({
  createApp: () => f.ctx, getCtx: () => f.ctx, startApp: async () => {}, stopApp: async () => {},
  ensureProjectBase: async (_ctx: unknown, project: string) => project, startProjectBase: async () => {}, stopProjectBase: async () => {}
}))
vi.mock('../../src/main/ipc', () => ({ registerIpc: () => {} }))
vi.mock('../../src/main/win-identity', async (actual) => ({ ...(await actual<object>()), ensureWindowsToastIdentity: () => {}, setWindowsAppId: () => {} }))
vi.mock('../../src/main/fal-service', () => ({ MEDIA_SCHEME: 'genio-media', mediaResponse: () => {} }))
vi.mock('../../src/main/chat-images', () => ({ chatImageDir: () => '', chatImagePath: () => undefined }))
vi.mock('../../src/main/home', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/main/home')>()), defaultHomeRoot: () => f.ctx.main.home.root }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, whenReady: async () => {}, isPackaged: true, getAppPath: () => '.', quit: vi.fn(), exit: vi.fn() })
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      id: f.windows.length + 1, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => 'file:///genio/index.html',
      send: (channel: string, payload: unknown) => { f.sent.push({ channel, payload }) }, setWindowOpenHandler: () => {}
    })
    query: unknown
    focus = vi.fn(); show = vi.fn(); restore = vi.fn(); moveTop = vi.fn(); setMenu = vi.fn(); setAppDetails = vi.fn(); isMinimized = () => false; isDestroyed = () => false
    constructor(_options: unknown) { super(); f.windows.push(this) }
    async loadFile(_file: string, options: { query: unknown }) { this.query = options.query; queueMicrotask(() => this.webContents.emit('did-finish-load')) }
    close() {}
  }
  const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), on() {}, off() {} }
  return { app, BrowserWindow: Window, screen, protocol: { registerSchemesAsPrivileged() {}, handle() {} }, shell: {}, dialog: { showMessageBoxSync: () => 1, showErrorBox: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }
})

import { bus } from '../../src/main/bus'
import { Home } from '../../src/main/home'
import { createCrewService } from '../../src/main/crew'
import { createBacklogService } from '../../src/main/backlog'
import { createDecisionService } from '../../src/main/decisions'
import { createWakeService } from '../../src/main/wakes'
import { createStatsService } from '../../src/main/stats'
import type { AppCtx, HomeCtx } from '../../src/main/services'

let base: SeededBase
let snapshots = 0
let openProject: (folder: string) => Promise<void>

/** The real per-home services over the seeded Base, composed into a snapshot exactly like ctx.ts does. */
function buildCtx(seed: SeededBase): AppCtx {
  const mainHome = new Home(seed.mainHome, 'main'); mainHome.ensure()
  const projectHome = new Home(seed.projectHome, seed.wksp, mainHome); projectHome.ensure()
  const projects = JSON.parse(fs.readFileSync(path.join(seed.mainHome, 'data', 'projects.json'), 'utf8'))
  const allies = JSON.parse(fs.readFileSync(path.join(seed.mainHome, 'data', 'allies.json'), 'utf8'))
  const outcomes = JSON.parse(fs.readFileSync(path.join(seed.mainHome, 'data', 'dispatch', 'scorecard.json'), 'utf8'))
  const terminals = new Map<string, { id: string; alive: boolean; lastOutputAt?: number; cwd: string; taskId?: string; title: string; kind: string; cols: number; rows: number }>()
  const ctx = {
    appRoot: seed.root, homes: new Map<string, HomeCtx>(),
    settings: { get: () => ({ gamertag: 'Dani', ledger: false, pollSeconds: 15, usageMode: 'balanced', sound: true, desktopNotifications: false, harnesses: [] }), harness: () => undefined, availableHarnesses: () => [] },
    terminals: {
      get: (id: string) => { const t = terminals.get(id); return t ? { ...t } : undefined }, list: () => [...terminals.values()].map((t) => ({ ...t })),
      lastOutputAt: (id: string) => terminals.get(id)?.lastOutputAt, onAnyData: (fn: (id: string, data: string) => void) => { f.terminalData = fn; return () => undefined },
      onData: () => () => undefined, onExit: () => () => undefined, kill: () => undefined, write: () => undefined, resize: () => undefined
    },
    projects: { list: () => [...projects], get: (name: string) => projects.find((p: { name: string }) => p.name === name), openFolder: async (name: string) => ({ project: projects.find((p: { name: string }) => p.name === name) ?? projects[0], registered: true }) },
    allies: { list: () => [...allies] },
    away: { state: () => ({ mode: 'online', held: [], returnSummaryPending: false }) },
    inbox: { list: () => [] },
    dispatch: { outcomes: () => [...outcomes], pendingUnits: () => [], record: () => undefined, capacity: () => ({ cap: 4, used: 1 }), quotaWait: () => undefined },
    notifier: { sfx: () => undefined, notify: () => undefined }, ledger: { record: () => undefined },
    permissions: { pending: () => [] }
  } as unknown as AppCtx
  const homeCtx = (home: Home): HomeCtx => {
    const hc = { home } as HomeCtx
    hc.crew = createCrewService(() => ctx, home)
    hc.backlog = createBacklogService(() => ctx, home)
    hc.decisions = createDecisionService(() => ctx, home)
    hc.wakes = createWakeService(() => ctx, home)
    hc.wksp = { info: () => ({ name: home.name, displayName: 'Genio', activity: 'idle', costUsd: 1.2, turns: 40, queued: 0 }), deliverWakes: () => undefined } as unknown as HomeCtx['wksp']
    hc.supervisor = { start() {}, stop() {}, poke() {}, replayStatus() {}, touch() {}, turnEnded() {} }
    return hc
  }
  ctx.main = homeCtx(mainHome)
  ctx.homes.set('main', ctx.main)
  ctx.homes.set(seed.wksp, homeCtx(projectHome))
  ctx.home = (name: string) => ctx.homes.get(name || 'main')!
  ctx.stats = createStatsService(() => ctx)
  ctx.snapshot = (): FleetSnapshot => {
    snapshots++
    const all = [...ctx.homes.values()]
    return {
      tasks: all.flatMap((h) => h.crew.list()), pendingUnits: ctx.dispatch.pendingUnits(), backlog: all.flatMap((h) => h.backlog.list()),
      decisions: all.flatMap((h) => h.decisions.list(true)), projects: ctx.projects.list(), wksps: all.map((h) => h.wksp.info()), allies: ctx.allies.list(),
      away: ctx.away.state(), inbox: ctx.inbox.list(), stats: ctx.stats.get()
    }
  }
  // one live unit terminal per working task, plus idle ones for the terminal-flush scenario
  for (const t of ctx.home(seed.wksp).crew.list()) if (t.terminalId) terminals.set(t.terminalId, { id: t.terminalId, alive: true, cwd: t.worktree, taskId: t.id, title: t.id, kind: 'worker', cols: 120, rows: 32, lastOutputAt: Date.now() })
  for (let i = 0; i < 12; i++) terminals.set(`worker-extra-${i}`, { id: `worker-extra-${i}`, alive: true, cwd: path.join(seed.projectHome, 'worktrees', seed.project, `u${i}`), title: `u${i}`, kind: 'worker', cols: 120, rows: 32, lastOutputAt: Date.now() })
  return ctx
}

const sentBytes = (): number => f.sent.reduce((n, s) => n + jsonBytes(s.payload), 0)
const resetSent = (): void => { f.sent.length = 0; snapshots = 0 }
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

beforeAll(async () => {
  base = seedBase(perfRoot())
  f.ctx = buildCtx(base)
  const argv = process.argv
  process.argv = ['Genio.exe']
  try {
    ;({ openProject } = await import('../../src/main/index'))
    await vi.waitFor(() => expect(f.windows).toHaveLength(1))
  } finally { process.argv = argv }
  await openProject(base.project)
  await vi.waitFor(() => expect(f.windows).toHaveLength(2))
})
afterAll(() => { report(); fs.rmSync(base.root, { recursive: true, force: true, maxRetries: 3 }) })

describe('main-process event path', () => {
  it('fleet snapshot cost with a realistic Base', () => {
    const snap = f.ctx.snapshot()
    note('snapshot: tasks', snap.tasks.length, 'count')
    note('snapshot: JSON bytes', jsonBytes(snap), 'bytes')
    timeIt('ctx.snapshot()', () => { f.ctx.snapshot() }, { iterations: 200, warmup: 10 })
    timeIt('stats.get()', () => { f.ctx.stats.get() }, { iterations: 200, warmup: 10 })
    timeIt('crew.list() (project home)', () => { f.ctx.home(base.wksp).crew.list() }, { iterations: 200, warmup: 10 })
  })

  it('a streaming reply: 2000 chat-delta events in bursts of 50 every 10 ms (as the SDK stdout delivers them)', async () => {
    resetSent()
    const t0 = performance.now()
    await withLoopLag('chat-delta stream', async () => {
      for (let i = 0; i < 2000; i++) {
        bus.publish({ type: 'chat-delta', wksp: base.wksp, id: 'm-msg_stream', text: `token ${i} ` })
        if (i % 50 === 49) await new Promise((r) => setTimeout(r, 10))
      }
      await new Promise((r) => setTimeout(r, 120))
    })
    note('chat-delta stream: wall time', performance.now() - t0, 'ms', '2000 deltas over ~0.5 s of bursts')
    note('chat-delta stream: snapshot() calls', snapshots, 'count')
    note('chat-delta stream: IPC messages sent', f.sent.length, 'count', 'hub + project window')
    note('chat-delta stream: IPC bytes', sentBytes(), 'bytes')
  })

  it('a tool-heavy turn: 30 tool calls, each re-sending the growing partial message', () => {
    resetSent()
    const msgs = syntheticMessages(base.wksp, 1, true)
    const m: ChatMessage = { ...msgs[0], id: 'm-msg_tools', tools: [], partial: true }
    const t0 = performance.now()
    for (let k = 0; k < 30; k++) {
      m.tools = [...(m.tools ?? []), { id: `toolu_${k}`, name: 'mcp__genio__fleet_view', input: JSON.stringify({ page_size: 2000 }).padEnd(600, ' '), result: 'x'.repeat(4000) }]
      bus.publish({ type: 'wksp', wksp: { name: base.wksp, displayName: 'Genio', activity: 'tool', activityDetail: 'fleet view', costUsd: 1, turns: 1, queued: 0 } })
      bus.publish({ type: 'chat', message: { ...m } })
      bus.publish({ type: 'chat', message: { ...m } }) // tool result arrives: the message is re-sent once more
    }
    note('tool-heavy turn: wall time', performance.now() - t0, 'ms')
    note('tool-heavy turn: snapshot() calls', snapshots, 'count')
    note('tool-heavy turn: IPC bytes', sentBytes(), 'bytes', '30 tools × growing message, both windows')
  })

  it('status, task and backlog events (what overwatch publishes per poll)', () => {
    resetSent()
    const hc = f.ctx.home(base.wksp)
    const task = hc.crew.list().find((t: { state: string }) => t.state === 'working')!
    timeIt('crew.update() (persist tasks.json + task event)', () => { hc.crew.update(task.id, { stateReason: `tick ${Math.random()}` }) }, { iterations: 30, warmup: 2 })
    note('task event: IPC bytes per update', sentBytes() / Math.max(1, f.sent.length), 'bytes')
    resetSent()
    bus.publish({ type: 'backlog', items: hc.backlog.list() })
    note('backlog event: IPC bytes (project window gets a full snapshot)', sentBytes(), 'bytes')
    note('backlog event: snapshot() calls', snapshots, 'count')
    resetSent()
    bus.publish({ type: 'status', event: { taskId: task.id, ts: new Date().toISOString(), raw: 'working: x', kind: 'working', text: 'x', fields: {}, playerRelevant: false } })
    note('status event: snapshot() calls', snapshots, 'count')
  })

  it('terminal streaming: 12 units emitting output, flushed every 16 ms', async () => {
    resetSent()
    const ids = [...f.ctx.terminals.list()].map((t: { id: string }) => t.id)
    const t0 = performance.now()
    await withLoopLag('terminal flush ×40', async () => {
      for (let round = 0; round < 40; round++) {
        for (const id of ids) for (let c = 0; c < 4; c++) f.terminalData?.(id, `\x1b[32m${id}\x1b[0m line ${round}.${c} ${'#'.repeat(120)}\r\n`)
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    note('terminal flush ×40: wall time', performance.now() - t0, 'ms', '12 terminals × 4 chunks per round')
    note('terminal flush ×40: snapshot() calls', snapshots, 'count')
    note('terminal flush ×40: IPC messages', f.sent.filter((s) => s.channel === 'genio:term-data').length, 'count')
    note('terminal flush ×40: IPC bytes', sentBytes(), 'bytes')
  })

  it('event routing with no bound snapshot: 5000 wksp activity events', () => {
    resetSent()
    const t0 = performance.now()
    for (let i = 0; i < 5000; i++) bus.publish({ type: 'wksp', wksp: { name: base.wksp, displayName: 'Genio', activity: i % 2 ? 'tool' : 'thinking', costUsd: 1, turns: 1, queued: 0 } } as GenioEvent)
    note('wksp ×5000: wall time', performance.now() - t0, 'ms')
    note('wksp ×5000: snapshot() calls', snapshots, 'count')
  })
})
