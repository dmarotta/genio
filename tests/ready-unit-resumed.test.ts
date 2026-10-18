import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createWakeService } from '../src/main/wakes'
import { createSupervisor } from '../src/main/supervisor'
import { liveUnits } from '../src/main/usage-policy'
import type { AppCtx } from '../src/main/services'
import type { Task, TerminalInfo } from '../src/shared/types'
import { squadBadge, squadState, unitClock } from '../src/shared/squad-display'
import { holdsCapacity, occupiedUnits } from '../src/shared/unit-capacity'
import { OUTPUT_GRACE_MS, createActivityMeter, resumedAfterReady } from '../src/shared/unit-activity'

const READY = '2026-10-16T10:00:00Z'
const after = (ms: number): string => new Date(Date.parse(READY) + ms).toISOString()
const ready = (patch: Partial<Task> = {}): Task => ({ id: 'unit', state: 'ready', kind: 'ship', title: 'Fix', harness: 'claude',
  createdAt: '2026-10-16T09:00:00Z', updatedAt: after(5_000), readyAt: READY, terminalId: 'pty', ...patch } as Task)
const live = (patch: Partial<TerminalInfo> = {}): TerminalInfo =>
  ({ id: 'pty', alive: true, processSpawnedAt: Date.parse('2026-10-16T09:00:00Z'), ...patch } as TerminalInfo)

describe('a ready unit stays ready until there is positive evidence of work', () => {
  it('keeps READY TO MERGE, a stopped clock and a free slot when its idle CLI prints a dialog', () => {
    const t = ready({ lastOutputAt: after(90_000) })
    const term = live({ lastOutputAt: after(90_000) })
    expect(squadState(t, term)).toBe('READY TO MERGE')
    expect(squadBadge(t, term)).toEqual({ label: 'READY TO MERGE', tone: 'volt' })
    expect(unitClock(t, term, Date.parse(after(3_600_000)))).toBe('took 1h 0m 0s')
    expect(holdsCapacity(t, true, term)).toBe(false)
    expect(occupiedUnits([t], { pty: term })).toBe(0)
  })

  it('flips to WORKING on a recorded resume (status line, delivered ping, new turn) everywhere at once', () => {
    const t = ready({ resumedAt: after(1_000) })
    expect(squadState(t, live())).toBe('WORKING')
    expect(unitClock(t, live(), Date.parse(after(60_000)))).toBe('working 1h 1m 0s')
    expect(holdsCapacity(t, true)).toBe(true)
    expect(occupiedUnits([t], { pty: live() })).toBe(1)
    // a resume from before the latest ready line is history
    expect(squadState(ready({ resumedAt: after(-1_000) }), live())).toBe('READY TO MERGE')
  })

  it('flips to WORKING on a relaunch after the ready line', () => {
    const term = live({ processSpawnedAt: Date.parse(after(10_000)) })
    expect(squadState(ready(), term)).toBe('WORKING')
    expect(occupiedUnits([ready()], { pty: term })).toBe(1)
  })

  it('counts sustained output only for a runtime without a turn marker, and only past the closing summary', () => {
    const codex = ready({ harness: 'codex' })
    expect(squadState(codex, live({ workOutputAt: after(OUTPUT_GRACE_MS + 1_000) }))).toBe('WORKING')
    expect(squadState(codex, live({ workOutputAt: after(20_000) }))).toBe('READY TO MERGE')
    expect(squadState(ready(), live({ workOutputAt: after(OUTPUT_GRACE_MS + 1_000) }))).toBe('READY TO MERGE')
    expect(resumedAfterReady({ harness: 'codex' }, live({ workOutputAt: after(0) }))).toBe(true)
  })
})

describe('sustained output meter', () => {
  const feed = (meter: ReturnType<typeof createActivityMeter>, chunks: [number, string][]): boolean =>
    chunks.map(([ms, text]) => meter.push(text, Date.parse(after(ms)))).some(Boolean)

  it('ignores idle chrome: dialogs, tips, repaints, usage and update notices, cursor redraws', () => {
    const chrome: [number, string][] = []
    for (let s = 0; s < 30; s++) {
      chrome.push([s * 1_000, '╭──────────╮\n│ Autocompact at 400k tokens? │\n│ ❯ Yes  No │\n╰──────────╯'])
      chrome.push([s * 1_000 + 10, '? for shortcuts                       Context left until auto-compact: 12%'])
      chrome.push([s * 1_000 + 20, 'Tip: Use /memory to edit your memory'])
      chrome.push([s * 1_000 + 30, 'Update available! Run: npm i -g @anthropic-ai/claude-code'])
      chrome.push([s * 1_000 + 40, 'Approaching usage limit · resets at 3pm'])
      chrome.push([s * 1_000 + 50, '> '])
      // the same status line repainted every second is not new text
      chrome.push([s * 1_000 + 60, '  ✻ Idle · model claude-opus · ready in branch genio/fix'])
    }
    expect(feed(createActivityMeter('claude'), chrome)).toBe(false)
  })

  it('ignores a single burst of new text', () => {
    expect(feed(createActivityMeter('codex'), [[0, Array.from({ length: 40 }, (_, i) => `line ${i} of a summary`).join('\n')]])).toBe(false)
  })

  it('reports new text arriving across several seconds, like a running tool', () => {
    const tool: [number, string][] = Array.from({ length: 8 }, (_, s) =>
      [s * 1_000, Array.from({ length: 4 }, (_, i) => ` ✓ tests/case-${s}-${i}.test.ts (12 tests) ${s * 40 + i}ms`).join('\n')])
    expect(feed(createActivityMeter('codex'), tool)).toBe(true)
  })
})

describe('overwatch records resumed work on a ready unit', () => {
  let root: string, home: Home, ctx: AppCtx, terminal: TerminalInfo
  const crew = (): AppCtx['main']['crew'] => ctx.main.crew
  const poke = (): void => createSupervisor(() => ctx, home).poke()
  const touch = (suffix: string, at: number): void => {
    const file = home.taskStateFile('unit', suffix)
    fs.writeFileSync(file, String(at))
    fs.utimesSync(file, new Date(at), new Date(at))
  }
  const label = (): string => squadState(crew().get('unit')!, terminal)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-resumed-'))
    home = new Home(root); home.ensure()
    const task = { id: 'unit', title: 'Fix', kind: 'ship', mode: 'local-only', project: 'world', workspace: 'main', harness: 'claude',
      state: 'working', terminalId: 'pty', worktree: root, branch: 'genio/unit', relaunches: 0,
      inbox: { seq: 0, acked: 0, rings: 0 }, createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date().toISOString() } as Task
    fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
    terminal = live({ processSpawnedAt: Date.now() - 3_600_000 })
    const hc = { home, crew: undefined as any, wakes: undefined as any, workspace: { deliverWakes: vi.fn() }, decisions: { list: () => [] } }
    ctx = { main: hc, home: () => hc, homes: new Map([['main', hc]]),
      settings: { get: () => ({ signalGraceSeconds: 30, usageMode: 'balanced' }), harness: () => undefined },
      terminals: { get: () => terminal, lastOutputAt: () => Date.now(), submit: vi.fn(async () => {}) },
      notifier: { sfx: vi.fn() }
    } as unknown as AppCtx
    hc.crew = createCrewService(() => ctx, home)
    hc.wakes = createWakeService(() => ctx, home)
    // the unit reports ready a minute ago
    crew().appendStatus('unit', 'done: ready in branch genio/unit')
    poke()
    crew().update('unit', { readyAt: new Date(Date.now() - 60_000).toISOString() })
    expect(label()).toBe('READY TO MERGE')
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  it('stays READY TO MERGE when the idle CLI prints its own dialog after the ready line', () => {
    terminal = { ...terminal, lastOutputAt: new Date().toISOString() }
    poke()
    expect(label()).toBe('READY TO MERGE')
    expect(crew().get('unit')?.resumedAt).toBeUndefined()
    expect(crew().capacityUsed('world')).toBe(0)
    expect(liveUnits(ctx.homes.values(), () => true)).toBe(0)
  })

  it('flips to WORKING when a ping is delivered, and back once that turn ends without a new ready line', async () => {
    await crew().send('unit', 'one more thing')
    expect(ctx.terminals.submit).toHaveBeenCalled()
    expect(label()).toBe('WORKING')
    expect(crew().capacityUsed('world')).toBe(1)
    touch('.turn-ended', Date.now() + 2_000)
    poke()
    expect(label()).toBe('READY TO MERGE')
    expect(crew().capacityUsed('world')).toBe(0)
  })

  it('flips to WORKING on a new status line after the ready one', () => {
    crew().appendStatus('unit', 'working: addressing review feedback')
    poke()
    expect(crew().get('unit')?.state).toBe('ready')
    expect(label()).toBe('WORKING')
    expect(liveUnits(ctx.homes.values(), () => true)).toBe(1)
    // the next ready line settles it again
    crew().appendStatus('unit', 'done: ready in branch genio/unit')
    poke()
    expect(label()).toBe('READY TO MERGE')
  })

  it('flips to WORKING when the harness reports a new turn after the ready line, not for the turn that finished', () => {
    touch('.turn-started', Date.now() - 120_000)
    touch('.turn-ended', Date.now() - 59_000)
    poke()
    expect(label()).toBe('READY TO MERGE')
    touch('.turn-started', Date.now())
    poke()
    expect(label()).toBe('WORKING')
  })

  it('flips to WORKING on a relaunch', () => {
    terminal = { ...terminal, processSpawnedAt: Date.now() }
    expect(label()).toBe('WORKING')
    poke()
    expect(crew().capacityUsed('world')).toBe(1)
  })

  it('flips to WORKING on sustained tool output from a runtime without a turn marker', () => {
    crew().update('unit', { harness: 'codex' })
    terminal = { ...terminal, workOutputAt: new Date(Date.now() - 30_000).toISOString() }
    poke()
    expect(label()).toBe('READY TO MERGE') // still within the closing summary
    terminal = { ...terminal, workOutputAt: new Date().toISOString() }
    poke()
    expect(label()).toBe('WORKING')
    expect(crew().capacityUsed('world')).toBe(1)
  })
})
