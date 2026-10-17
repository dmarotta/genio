/**
 * Shared helpers for the perf harness: timing, event-loop lag, payload sizes
 * and a realistic synthetic Base (shapes and sizes copied from a real one:
 * ~100 units, ~100 quests, a 2 MB chat log, a 200 KB stats file).
 *
 * GENIO_PERF_BASE=<base root> copies a real Base into the temp dir instead.
 * The copy rewrites ally homes to stay inside the temp dir; nothing outside it is written.
 * Worktrees, Play pools and the Claude/Codex homes (credentials) are never copied.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { BacklogItem, Decision, Task, Wake } from '../../src/shared/types'
import { summarise, syntheticMessages, word } from './measure'
import { assertIsolatedHomes } from '../support/isolated-homes.mjs'

export { note, report, summarise, syntheticMessages, timeAsync, timeIt, type Stat } from './measure'

/** Event-loop delay while `run` executes (what IPC handlers and timers wait behind). */
export async function withLoopLag(label: string, run: () => Promise<void>): Promise<{ p50: number; p99: number; max: number }> {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  await run()
  await new Promise((r) => setTimeout(r, 5))
  h.disable()
  const lag = { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 }
  summarise(`${label} (loop lag p50)`, [lag.p50], 'ms', `p99 ${lag.p99.toFixed(1)} ms, max ${lag.max.toFixed(1)} ms; Windows timer granularity adds ~15 ms noise`)
  return lag
}

export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

export const perfRoot = (prefix = 'genio-perf-'): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

// ------------------------------------------------------------------ synthetic data

const ISO = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

export function syntheticTask(i: number, root: string, state: Task['state'] = 'cleaned', project = 'genio'): Task {
  const id = `${word(i)}-${word(i + 3)}-step-${i}-${(i * 7919).toString(16).slice(0, 4)}`
  return {
    id, kind: i % 5 === 0 ? 'scout' : 'ship', title: `${word(i)} ${word(i + 1)} step ${i}: make the ${word(i + 2)} ${word(i + 4)} work`, project, wksp: project,
    backlogId: `${word(i)}-${i}-q`, mode: 'local-only', yolo: false, branchPrefix: 'genio/', baseBranch: 'main', branch: `genio/${id}`,
    worktree: path.join(root, 'wksps', project, 'worktrees', project, id), briefPath: path.join(root, 'wksps', project, 'data', id, 'brief.md'),
    harness: i % 3 ? 'claude' : 'codex', model: i % 3 ? 'claude-opus-5-5' : 'gpt-5-codex', effort: 'high',
    loadout: ['category Feature: given at deploy', 'warning: Codex CLI quota unverified (missing or expired report); ordinary dispatch allowed, exploration off', 'Claude Code: your pick', 'model: your pick', 'effort high: your pick'],
    category: 'feature', loadoutSource: 'player', counters: { pings: i % 3, lagging: 0, stopped: i % 2, fixRounds: 0 }, usageAtStart: 3,
    state, stateReason: state === 'cleaned' ? 'despawned: landed (fast-forward into local main)' : 'profiling chat, main-process loops and IPC before changing anything',
    createdAt: ISO(10_000 - i * 90), updatedAt: ISO(9_000 - i * 90), inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 3348, relaunches: 1,
    ...(state === 'cleaned' ? { cleanedAt: ISO(9_000 - i * 90), landedAt: ISO(9_001 - i * 90), finishedAt: ISO(9_001 - i * 90), outcome: 'merged', landedCommit: 'e820fa2ab0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5' } : {}),
    ...(state === 'working' ? { terminalId: `worker-${i}` } : {})
  } as Task
}

export function syntheticTasks(root: string, n = 102, project = 'genio'): Task[] {
  const states: Task['state'][] = seq(n).map((i) => (i >= n - 1 ? 'working' : i >= n - 2 ? 'done' : i >= n - 4 ? 'exited' : i >= n - 8 ? 'merged' : 'cleaned'))
  return states.map((state, i) => syntheticTask(i, root, state, project))
}

export function syntheticBacklog(tasks: Task[], project = 'genio'): BacklogItem[] {
  return tasks.map((t, i) => ({
    id: t.backlogId!, title: t.title, project, kind: t.kind, state: t.state === 'working' ? 'in-flight' : i % 25 === 3 ? 'dropped' : 'done',
    notes: `${t.title}. `.repeat(6).trim(), priority: 'normal', dependsOn: [], tags: [], taskId: t.id, mode: 'local-only', yolo: false,
    createdAt: t.createdAt, updatedAt: t.updatedAt, doneAt: t.cleanedAt, outcome: 'landed locally from ' + t.branch, origin: 'genio'
  } as BacklogItem))
}

export function syntheticDecisions(tasks: Task[], n = 34): Decision[] {
  return seq(n).map((i) => ({
    id: `ch-${(i * 104729).toString(16).padStart(8, '0')}`, key: 'default', wksp: 'genio', taskId: tasks[i % tasks.length].id, project: 'genio',
    question: `Unit ${tasks[i % tasks.length].title} asks: may it close the test scene and run the checks?`, context: 'PID, project path and exact command go here. '.repeat(8),
    options: ['Close the test scene and run checks', 'Keep it open'], recommendation: 'Close the test scene and run checks', source: 'unit', urgency: 'normal',
    createdAt: tasks[i % tasks.length].createdAt, revision: 1, resolvedAt: tasks[i % tasks.length].updatedAt, answer: 'Close the test scene and run checks'
  } as Decision))
}

export function syntheticStats(assetIds = 1306): Record<string, unknown> {
  const ids: Record<string, true> = {}
  for (let i = 0; i < assetIds; i++) ids[`unit-image:${word(i)}-${word(i + 1)}-step-${i % 40}-${(i * 31).toString(16)}:7d62b285-74a4-48c9-8b31-${i.toString(16).padStart(12, '0')}/exec-b21d68aa-c693-4ef5-a4e5-${(i * 97).toString(16).padStart(12, '0')}`] = true
  const awarded: Record<string, string[]> = {}
  for (let i = 0; i < 100; i++) awarded[`${word(i)}-${word(i + 3)}-step-${i}-${(i * 7919).toString(16).slice(0, 4)}`] = ['spawn', 'ship', 'merge', 'cleanup']
  const achievements: Record<string, string> = {}
  for (const id of ['first-blood', 'squad-up', 'project-window-open', 'inventory-open', 'quest-first', 'world-first', 'janitor', 'on-a-roll', 'combo-x5', 'speedrunner']) achievements[id] = ISO(5000)
  return { totalXp: 9100, xp: 240, level: 9, scoutsTotal: 7, mergesTotal: 60, despawnsTotal: 94, gauntletPasses: 0, costTotalUsd: 11.2, day: new Date().toISOString().slice(0, 10), mergesToday: 1, costTodayUsd: 0.4,
    activeDays: seq(20).map((i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)), achievements, assetsTotal: 1306, assetIds: ids, awarded,
    landings: { since: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), days: {}, seen: {}, observed: [] }, titles: { builder: ISO(2000) }, pins: [] }
}

export function syntheticScorecard(tasks: Task[]): unknown[] {
  return tasks.filter((t) => t.state === 'cleaned').slice(0, 79).map((t) => ({ v: 1, taskId: t.id, title: t.title, kind: t.kind, category: 'feature', world: 'genio', harness: t.harness, model: t.model, effort: t.effort,
    source: 'player', outcome: 'landed', landed: true, pings: 1, relaunches: 1, lagging: 0, stopped: 1, wallMinutes: 42, verdict: undefined, endedAt: t.updatedAt }))
}

export function syntheticWakes(wksp: string, n = 229): Wake[] {
  return seq(n).map((i) => ({ seq: i + 1, ts: ISO(n - i), wksp, kind: i % 4 === 0 ? 'stale' : 'signal', reason: `BUILD "${word(i)} ${word(i + 1)} step ${i}" (genio) reported done`, lines: [`done [at=${1760000000 + i}]: ready in branch genio/${word(i)}-${i}`], routine: i % 4 === 0 } as Wake))
}

export interface SeededBase { root: string; mainHome: string; projectHome: string; wksp: string; project: string }

/** Write a realistic Base under `root` (or copy GENIO_PERF_BASE into it). */
export function seedBase(root: string): SeededBase {
  const real = process.env.GENIO_PERF_BASE
  const project = 'genio'
  const wksp = 'genio'
  const projectHome = path.join(root, 'wksps', wksp)
  if (real) {
    fs.cpSync(real, root, { recursive: true, filter: (src: string) => !/[\\/](worktrees|projects|node_modules|inventory|chat-images|validation-node_modules|play-pools|claude-home|codex-home|skills)([\\/]|$)/.test(src) && !/[\\/]data[\\/][^\\/]+-[0-9a-f]{4}[\\/]/.test(src) })
    const alliesFile = path.join(root, 'data', 'allies.json')
    const allies = JSON.parse(fs.readFileSync(alliesFile, 'utf8')) as { name: string; home: string }[]
    for (const a of allies) a.home = path.join(root, 'wksps', a.name)
    fs.writeFileSync(alliesFile, JSON.stringify(allies, null, 2))
    // A copied player's harness must never override the worker's sandbox homes.
    const settingsFile = path.join(root, 'config', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { harnesses?: { env?: NodeJS.ProcessEnv }[] }
    for (const harness of settings.harnesses ?? []) {
      if (!harness.env) continue
      for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'GENIO_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP', 'TMPDIR', 'GENIO_TEST_RUN_ROOT', 'GENIO_TEST_SYSTEM_TMP'])
        if (key in harness.env) harness.env[key] = process.env[key]
      assertIsolatedHomes({ ...process.env, ...harness.env })
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
    return { root, mainHome: root, projectHome, wksp, project }
  }
  const dirs = ['config', 'data', 'data/dispatch', 'state', path.join('wksps', wksp, 'data'), path.join('wksps', wksp, 'state'), path.join('wksps', wksp, 'config')]
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true })
  const tasks = syntheticTasks(root)
  const write = (p: string, v: unknown): void => { fs.writeFileSync(path.join(root, p), JSON.stringify(v, null, 2)) }
  write('config/settings.json', { gamertag: 'Dani', firstRunDone: true, usageMode: 'balanced', ledger: true, pollSeconds: 15 })
  write('data/projects.json', [{ name: project, path: path.join(root, 'projects', project), gitRepo: true, defaultBranch: 'main', mode: 'local-only', modeSource: 'auto', yolo: false, branchPrefix: 'genio/', forge: 'none', engine: 'other', engineRoot: '', engineSource: 'auto', commands: {}, managed: false, addedAt: ISO(20_000) }])
  write('data/allies.json', [{ name: wksp, scope: `All work in ${project}`, charter: '', projects: [project], home: projectHome, createdAt: ISO(20_000) }])
  write('data/stats.json', syntheticStats())
  write('data/dispatch/scorecard.json', syntheticScorecard(tasks))
  write('data/decisions.json', [])
  write('data/backlog.json', [])
  write('state/tasks.json', [])
  write(`wksps/${wksp}/state/tasks.json`, tasks)
  write(`wksps/${wksp}/data/backlog.json`, syntheticBacklog(tasks))
  write(`wksps/${wksp}/data/decisions.json`, syntheticDecisions(tasks))
  fs.writeFileSync(path.join(projectHome, 'data', 'chat.jsonl'), syntheticMessages(wksp).map((m) => JSON.stringify(m)).join('\n') + '\n')
  const wakes = syntheticWakes(wksp)
  fs.writeFileSync(path.join(projectHome, 'state', 'wakes.jsonl'), wakes.map((w) => JSON.stringify(w)).join('\n') + '\n')
  write(`wksps/${wksp}/state/wakes.ack`, { through: wakes.length, at: ISO(1), events: {} })
  for (const t of tasks) {
    fs.mkdirSync(path.dirname(t.briefPath), { recursive: true })
    fs.writeFileSync(t.briefPath, '# Mission\n')
    fs.writeFileSync(path.join(projectHome, 'state', `${t.id}.status`), `working [at=1760000000]: started\nworking [at=1760000100]: tests\n${t.state === 'cleaned' ? 'done [at=1760000500]: ready in branch ' + t.branch + '\n' : ''}`)
  }
  return { root, mainHome: root, projectHome, wksp, project }
}
