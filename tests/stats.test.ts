import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bus } from '../src/main/bus'
import { createStatsService } from '../src/main/stats'
import type { AppCtx } from '../src/main/services'
import type { GenioEvent, Task } from '../src/shared/types'

let dir: string
let ctx: AppCtx
let task: Task | undefined
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-achievements-'))
  task = undefined
  ctx = {
    main: { home: { statsFile: path.join(dir, 'stats.json') } },
    homes: new Map([['main', { crew: { get: () => task, list: () => task ? [task] : [] } }]]),
    notifier: { sfx: vi.fn() }, ledger: { record: vi.fn() }
  } as unknown as AppCtx
})
afterEach(() => {
  bus.removeAllListeners('event')
  fs.rmSync(dir, { recursive: true, force: true })
})
const publish = (ev: unknown): void => bus.publish(ev as GenioEvent)

describe('live achievement outcomes', () => {
  it.each([
    ['fal-first', { type: 'fal-run', run: { id: 'agent-fal', world: 'test', status: 'completed', outputs: [{}] } }],
    ['animation-first', { type: 'uthana-run', run: { id: 'agent-motion', world: 'test', status: 'completed', kind: 'text', motionId: 'motion' } }]
  ])('unlocks %s from agent provider completion without a screen visit', (id, event) => {
    const svc = createStatsService(() => ctx)
    publish(event)
    publish(event)
    expect(svc.get().achievements.filter((a) => a.unlockedAt).map((a) => a.id)).toEqual([id])
  })
  it.each([
    ['screenshot', 'screenshot'], ['dock-split', 'dock-split'], ['world_push', 'push-first'],
    ['rate_task', 'rating-first'], ['account-login', 'account-login'], ['yolo-chat', 'yolo-chat'],
    ['quest_add', 'quest-first'], ['world_add', 'world-first'], ['memory_write', 'lore-first'], ['inventory-index', 'inventory-index']
  ])('unlocks %s on its feature outcome', (feature, id) => {
    const svc = createStatsService(() => ctx)
    publish({ type: 'feature-used', feature })
    expect(svc.get().achievements.filter((a) => a.unlockedAt).map((a) => a.id)).toEqual([id])
  })
  it('unlocks Blender only on a successful runner receipt, not progress or index snapshots', () => {
    const svc = createStatsService(() => ctx)
    publish({ type: 'status', event: { kind: 'working', key: 'genio-blender-run' } })
    publish({ type: 'inventory', state: { revision: 2, total: 50, refreshing: false } })
    expect(svc.get().achievements.every((a) => !a.unlockedAt)).toBe(true)
    publish({ type: 'status', event: { kind: 'note', key: 'genio-blender-run' } })
    expect(svc.get().achievements.filter((a) => a.unlockedAt).map((a) => a.id)).toEqual(['blender-first'])
  })
  it('preserves old unlocks and leaves additions locked across restart', () => {
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ achievements: { 'first-blood': '2025-01-01' } }))
    const svc = createStatsService(() => ctx)
    expect(svc.get().achievements.find((a) => a.id === 'first-blood')?.unlockedAt).toBe('2025-01-01')
    expect(svc.get().achievements.find((a) => a.id === 'chat-image')?.unlockedAt).toBeUndefined()
    const emitted: string[] = []
    bus.onEvent((e) => { if (e.type === 'achievement') emitted.push(e.achievement.id) })
    publish({ type: 'feature-used', feature: 'screenshot' })
    publish({ type: 'feature-used', feature: 'screenshot' })
    expect(emitted).toEqual(['screenshot'])
    bus.removeAllListeners('event')
    expect(createStatsService(() => ctx).get().achievements.find((a) => a.id === 'screenshot')?.unlockedAt).toBeTruthy()
  })
  it('counts generated outputs once, including after restart, for 10 and 50 tiers', () => {
    let svc = createStatsService(() => ctx)
    const made = { type: 'feature-used', feature: 'chat-image', id: 'images', count: 9 }
    publish(made)
    publish(made)
    expect(svc.get().achievements.find((a) => a.id === 'assets-10')?.unlockedAt).toBeUndefined()
    bus.removeAllListeners('event')
    svc = createStatsService(() => ctx)
    publish(made)
    publish({ type: 'fal-run', run: { id: 'f', status: 'completed', outputs: [{}] } })
    expect(svc.get().achievements.find((a) => a.id === 'assets-10')?.unlockedAt).toBeTruthy()
    publish({ type: 'feature-used', feature: 'chat-image', id: 'more', count: 40 })
    expect(svc.get().achievements.find((a) => a.id === 'assets-50')?.unlockedAt).toBeTruthy()
  })
  it('ignores failed assets, uploads, routed ally messages and previews', () => {
    const svc = createStatsService(() => ctx)
    publish({ type: 'fal-run', run: { id: 'f', status: 'failed' } })
    publish({ type: 'uthana-run', run: { id: 'u', status: 'completed', kind: 'character' } })
    publish({ type: 'chat', message: { role: 'player', wksp: 'ally', from: 'genio' } })
    expect(svc.get().achievements.every((a) => !a.unlockedAt)).toBe(true)
  })
  it('unlocks direct ally chat, queue edits, completed animations and unit image status', () => {
    const svc = createStatsService(() => ctx)
    publish({ type: 'chat', message: { role: 'player', wksp: 'ally' } })
    publish({ type: 'chat', message: { role: 'player', wksp: 'main', queue: 'cancelled' } })
    publish({ type: 'uthana-run', run: { id: 'u', status: 'completed', kind: 'text', motionId: 'motion' } })
    publish({ type: 'status', event: { kind: 'note', key: 'genio-codex-image', taskId: 't', text: 'run/image.png' } })
    expect(svc.get().achievements.filter((a) => a.unlockedAt).map((a) => a.id)).toEqual(['animation-first', 'ally-chat', 'queue-edit', 'unit-image'])
  })
  it.each([{ explored: true }, { loadout: ['Claude down-ranked: weekly window at 95%'] }])('awards smart dispatch only on actual deployment: %j', (pick) => {
    const svc = createStatsService(() => ctx)
    task = { id: 't', harness: 'opencode', state: 'working', ...pick } as Task
    expect(svc.get().achievements.every((a) => !a.unlockedAt)).toBe(true)
    svc.award('spawn', 't')
    expect(svc.get().achievements.filter((a) => a.unlockedAt).map((a) => a.id)).toEqual(['smart-pick', 'cheap-unit'])
  })
})
