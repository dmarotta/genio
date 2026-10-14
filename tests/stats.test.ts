import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bus } from '../src/main/bus'
import { ASSET_IDS_KEEP, createStatsService } from '../src/main/stats'
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
    ['character-sheet', 'character-sheet-open'], ['screenshot', 'screenshot'], ['world_push', 'push-first'],
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
  it('keeps earned retired achievements in saved stats, hides unearned ones and never unlocks them again', () => {
    const saved = { achievements: { 'play-snapshot': '2026-09-01', 'first-blood': '2026-09-02' }, pins: ['play-snapshot'] }
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(saved))
    const svc = createStatsService(() => ctx)
    const shown = svc.get().achievements
    expect(shown.find((a) => a.id === 'play-snapshot')).toMatchObject({ unlockedAt: '2026-09-01', retired: true })
    expect(shown.some((a) => a.id === 'play-step')).toBe(false)
    expect(svc.get().pins).toEqual(['play-snapshot'])
    expect(svc.unlock('play-step')).toBeUndefined()
    expect(svc.unlock('play-takeover')).toBeUndefined()
    expect(svc.get().achievements.some((a) => a.id === 'play-step' || a.id === 'play-takeover')).toBe(false)
    expect(svc.unlock('play-observed')?.unlockedAt).toBeTruthy()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')).achievements).toMatchObject(saved.achievements)
  })
  it('brings back the new Play screen trophies with their original ids and earned dates', () => {
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ achievements: { 'play-stream': '2026-09-01' }, pins: ['play-stream'] }))
    const svc = createStatsService(() => ctx)
    const stream = svc.get().achievements.find((a) => a.id === 'play-stream')
    expect(stream).toMatchObject({ unlockedAt: '2026-09-01' })
    expect(stream?.retired).toBeUndefined()
    expect(svc.get().pins).toEqual(['play-stream'])
    for (const id of ['play-input', 'play-fullscreen', 'play-unit']) expect(svc.get().achievements.find((a) => a.id === id)?.unlockedAt).toBeUndefined()
    publish({ type: 'feature-used', feature: 'play-fullscreen' })
    expect(svc.get().achievements.find((a) => a.id === 'play-fullscreen')?.unlockedAt).toBeTruthy()
    expect(svc.unlock('play-input')?.unlockedAt).toBeTruthy()
    expect(svc.unlock('play-unit')?.unlockedAt).toBeTruthy()
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
  it('keeps the asset dedupe keys bounded on disk, newest first, including on load', () => {
    const keys = (n: number): Record<string, true> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`old:${i}`, true]))
    const stored = (): { assetIds: Record<string, true>; assetsTotal: number } => JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'))
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ assetIds: keys(ASSET_IDS_KEEP - 2), assetsTotal: 40 }))
    const svc = createStatsService(() => ctx)
    for (let i = 0; i < 5; i++) publish({ type: 'feature-used', feature: 'chat-image', id: `img-${i}`, count: 2 })
    expect(Object.keys(stored().assetIds)).toHaveLength(ASSET_IDS_KEEP)
    expect(stored().assetIds['old:2']).toBeUndefined()
    expect(stored().assetIds['old:3']).toBe(true)
    expect(stored().assetIds['chat-image:img-4']).toBe(true)
    expect(stored().assetsTotal).toBe(50)
    publish({ type: 'feature-used', feature: 'chat-image', id: 'img-4', count: 2 }) // still deduped
    expect(stored().assetsTotal).toBe(50)
    expect(svc.get().achievements.find((a) => a.id === 'assets-50')?.unlockedAt).toBeTruthy()
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ assetIds: keys(ASSET_IDS_KEEP + 100) }))
    bus.removeAllListeners('event')
    createStatsService(() => ctx)
    publish({ type: 'feature-used', feature: 'chat-image', id: 'after-reload', count: 1 })
    expect(Object.keys(stored().assetIds)).toHaveLength(ASSET_IDS_KEEP)
    expect(stored().assetIds[`old:${ASSET_IDS_KEEP + 99}`]).toBe(true)
    expect(stored().assetIds['chat-image:after-reload']).toBe(true)
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
  it('counts Shipped on merge, not when a branch becomes ready, and lands each mission once', () => {
    const svc = createStatsService(() => ctx)
    task = { id: 't', kind: 'ship', state: 'ready', createdAt: '2020-01-01T00:00:00Z', backlogId: 'q' } as Task
    svc.award('ship', 't')
    expect(svc.get()).toMatchObject({ shippedToday: 0, shippedTotal: 0 })
    svc.award('merge', 't')
    svc.award('merge', 't')
    expect(svc.get()).toMatchObject({ shippedToday: 1, shippedTotal: 1 })
    const today = svc.get().landings.filter((d) => d.state !== 'future').at(-1)
    expect(today).toMatchObject({ builds: 1, recons: 0, state: 'recorded' })
  })
  it.each([{ explored: true }, { loadout: ['Claude down-ranked: weekly window at 95%'] }])('awards smart dispatch only on actual deployment: %j', (pick) => {
    const svc = createStatsService(() => ctx)
    task = { id: 't', harness: 'opencode', state: 'working', ...pick } as Task
    expect(svc.get().achievements.every((a) => !a.unlockedAt)).toBe(true)
    svc.award('spawn', 't')
    expect(svc.get().achievements.filter((a) => a.unlockedAt).map((a) => a.id)).toEqual(['smart-pick', 'cheap-unit'])
  })
})

describe('trophy pins', () => {
  const unlocked = { 'first-blood': '2026-10-01', 'recon-expert': '2026-10-02', 'combo-x5': '2026-10-03', 'night-owl': '2026-10-04' }
  it('keeps up to three unlocked pins in order across a restart', () => {
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ achievements: unlocked }))
    const svc = createStatsService(() => ctx)
    expect(svc.pin('recon-expert', true).ok).toBe(true)
    expect(svc.pin('first-blood', true).ok).toBe(true)
    expect(svc.pin('combo-x5', true).ok).toBe(true)
    expect(svc.pin('night-owl', true)).toMatchObject({ ok: false, message: 'Only 3 trophies fit; unpin one first.' })
    expect(svc.pin('first-blood', false).ok).toBe(true)
    expect(svc.pin('night-owl', true).ok).toBe(true)
    bus.removeAllListeners('event')
    expect(createStatsService(() => ctx).get().pins).toEqual(['recon-expert', 'combo-x5', 'night-owl'])
  })
  it('refuses locked or unknown achievements and unlocks Trophy Case on the first pin', () => {
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ achievements: { 'first-blood': '2026-10-01' } }))
    const svc = createStatsService(() => ctx)
    expect(svc.pin('janitor', true)).toMatchObject({ ok: false, message: 'Janitor is still locked.' })
    expect(svc.pin('nope', true).ok).toBe(false)
    expect(svc.get().achievements.find((a) => a.id === 'trophy-pin')?.unlockedAt).toBeUndefined()
    svc.pin('first-blood', true)
    expect(svc.get().pins).toEqual(['first-blood'])
    expect(svc.get().achievements.find((a) => a.id === 'trophy-pin')?.unlockedAt).toBeTruthy()
  })
  it('drops stale or malformed pins from an edited stats file', () => {
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ achievements: unlocked, pins: ['janitor', 'first-blood', 7, 'combo-x5', 'night-owl'] }))
    expect(createStatsService(() => ctx).get().pins).toEqual(['first-blood', 'combo-x5', 'night-owl'])
  })
})

describe('playstyle titles', () => {
  let records: { kind: string; category: string; landed: boolean }[]
  beforeEach(() => {
    records = []
    Object.assign(ctx, { dispatch: { outcomes: () => records } })
  })
  it('earns a title from landings, keeps it after play changes and lets the player equip it', () => {
    const svc = createStatsService(() => ctx)
    records = Array.from({ length: 5 }, () => ({ kind: 'ship', category: 'tests', landed: true }))
    task = { id: 't', kind: 'ship', state: 'merged', createdAt: '2020-01-01T00:00:00Z' } as Task
    svc.award('merge', 't')
    expect(svc.get().playstyle).toMatchObject({ current: 'warden', shown: 'warden', samples: 5 })
    expect(svc.get().playstyle.earned.map((e) => e.id)).toEqual(['warden'])
    expect(svc.get().achievements.find((a) => a.id === 'title-earned')?.unlockedAt).toBeTruthy()

    records = Array.from({ length: 20 }, () => ({ kind: 'scout', category: 'recon-design', landed: true }))
    expect(svc.equipTitle('scout')).toMatchObject({ ok: false })
    expect(svc.equipTitle('warden').ok).toBe(true)
    bus.removeAllListeners('event')
    const again = createStatsService(() => ctx).get().playstyle
    expect(again).toMatchObject({ current: 'scout', shown: 'warden', equipped: 'warden' })
    expect(again.earned.map((e) => e.id)).toEqual(['warden'])
  })
  it('stays Adventurer without enough evidence and picks up older history on a sheet visit', () => {
    const svc = createStatsService(() => ctx)
    expect(svc.get().playstyle).toMatchObject({ current: 'adventurer', shown: 'adventurer', earned: [] })
    records = Array.from({ length: 6 }, () => ({ kind: 'ship', category: 'art', landed: true }))
    publish({ type: 'feature-used', feature: 'character-sheet' })
    expect(svc.get().playstyle.earned.map((e) => e.id)).toEqual(['artificer'])
    expect(svc.equipTitle(null).ok).toBe(true)
    expect(svc.get().playstyle.shown).toBe('artificer')
  })
})
