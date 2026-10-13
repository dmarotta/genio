/**
 * XP, levels, streaks and achievements. Pure flavour on top of real outcomes:
 * every award is triggered by an actual event (deploy, loot, merge, ...).
 * Persisted in the main base's data/stats.json.
 */
import type { Achievement, FleetStats, Task } from '@shared/types'
import { bus } from './bus'
import type { AppCtx, StatsService } from './services'
import { nowIso, readJson, todayStamp, writeJson } from './util'

type AwardEvent = 'spawn' | 'ship' | 'merge' | 'scout' | 'decision' | 'cleanup' | 'save'

const XP: Record<AwardEvent, number> = {
  spawn: 10,
  scout: 60,
  ship: 100,
  merge: 150,
  decision: 15,
  cleanup: 20,
  save: 25
}

export const ACHIEVEMENTS: Omit<Achievement, 'unlockedAt'>[] = [
  { id: 'project-window-open', name: 'Home Base', description: 'Open your first project window.', feature: 'project-window' },
  { id: 'project-cli-open', name: 'Direct Entry', description: 'Open a project with genio <folder>.', feature: 'project-cli' },
  { id: 'play-first', name: 'Press Play', description: 'Start a Unity Play session.', feature: 'play' },
  { id: 'play-snapshot', name: 'In the Frame', description: 'Capture a game snapshot.', feature: 'play' },
  { id: 'play-observed', name: 'Shared Sight', description: 'Let Genio observe a game frame.', feature: 'play_frame' },
  { id: 'chat-provider-switch', feature: 'comms', name: 'New Perspective', description: 'Switch the chat provider.' },
  { id: 'codex-chat-turn', feature: 'comms', name: 'Codex Companion', description: 'Complete a Codex-driven chat turn.' },
  { id: 'inventory-chat', name: 'Shared View', description: 'Send a message with Inventory context from floating chat.', feature: 'inventory-chat' },
  { id: 'inventory-scout', name: 'Inventory Scout', description: 'Find an asset or locate a new asset destination.', feature: 'assets_find' },
  { id: 'asset-pathfinder', name: 'Asset Pathfinder', description: 'Locate a new asset destination.', feature: 'asset_locate' },
  { id: 'inventory-open', name: 'Open the Vault', description: 'Open a world Inventory.', feature: 'inventory' },
  { id: 'inventory-preview', name: 'Closer Look', description: 'Select an asset to preview in Inventory.', feature: 'inventory' },
  { id: 'model-picker', feature: 'comms', name: 'Meet the Models', description: 'Open the live model picker.' },
  { id: 'model-switch', feature: 'comms', name: 'Change of Mind', description: 'Switch a chat model in the picker.' },
  { id: 'screenshot', feature: 'comms', name: 'Show and Tell', description: 'Paste a screenshot into chat.' },
  { id: 'chat-image', feature: 'generate_image', name: 'Pixel Summoner', description: 'Generate an image in chat.' },
  { id: 'fal-first', feature: 'fal_generate', name: 'Asset Alchemist', description: 'Complete a FAL run.' },
  { id: 'animation-first', feature: 'uthana_motion', name: 'Motion Unlocked', description: 'Generate your first Uthana animation.' },
  { id: 'ally-chat', feature: 'comms', name: 'Project Chat', description: 'Talk to Genio in a project window.' },
  { id: 'push-first', feature: 'world_push', name: 'Go Live', description: 'Push a world on demand.' },
  { id: 'rating-first', feature: 'rate_task', name: 'GG or Go Again', description: 'Rate a unit on the scorecard.' },
  { id: 'smart-pick', feature: 'loadout_preview', name: 'Adaptive Build', description: 'Deploy an exploration or quota-based pick.' },
  { id: 'queue-edit', feature: 'comms', name: 'Second Thoughts', description: 'Edit or cancel a queued message.' },
  { id: 'yolo-chat', feature: 'comms', name: 'No Safety Wheels', description: 'Switch chat to YOLO mode.' },
  { id: 'account-login', feature: 'systems', name: 'Signed In', description: 'Log in from Systems Accounts.' },
  { id: 'usage-mode', feature: 'systems', name: 'Gear Shift', description: 'Switch the Usage mode between Save, Balanced and Max.' },
  { id: 'cheap-unit', feature: 'deploy', name: 'Budget Build', description: 'Deploy an OpenCode unit.' },
  { id: 'agent-asset-first', feature: 'agent_generation', name: 'Made to Order', description: 'Generate your first asset through Genio.' },
  { id: 'asset-placed-first', feature: 'asset_place', name: 'Loot Delivered', description: 'Place an agent-generated asset in a world.' },
  { id: 'unit-image', feature: 'assets', name: 'Pixel Crafter', description: 'A unit creates a Codex image.' },
  { id: 'blender-first', feature: 'blender', name: 'Polygon Power', description: 'Complete a Blender skill run.' },
  { id: 'inventory-index', feature: 'inventory-index', name: 'Loot Catalog', description: "Index a world's assets for the first time." },
  { id: 'assets-10', feature: 'assets', name: 'Asset Combo', description: 'Generate 10 assets.' },
  { id: 'assets-50', feature: 'assets', name: 'Asset Factory', description: 'Generate 50 assets.' },
  { id: 'quest-first', feature: 'quests', name: 'Side Quest', description: 'Add a quest.' },
  { id: 'world-first', feature: 'worlds', name: 'New Game', description: 'Register a world.' },
  { id: 'lore-first', feature: 'lore', name: 'Save Point', description: 'Save your first memory update.' },
  { feature: 'move', id: 'first-blood', name: 'First Blood', description: 'Merge your first build.' },
  { feature: 'squad', id: 'squad-up', name: 'Squad Up', description: 'Have 3 units deployed at once.' },
  { feature: 'squad', id: 'full-party', name: 'Full Party', description: 'Have 5 units deployed at once.' },
  { feature: 'squad', id: 'recon-expert', name: 'Recon Expert', description: 'Complete 10 recon missions.' },
  { feature: 'squad', id: 'speedrunner', name: 'Speedrunner', description: 'A build is ready less than 15 minutes after deploy.' },
  { feature: 'move', id: 'night-owl', name: 'Night Owl', description: 'Merge a build between midnight and 5 AM.' },
  { feature: 'move', id: 'inbox-zero', name: 'Inbox Zero', description: 'Answer every open choice.' },
  { feature: 'move', id: 'combo-x5', name: 'Combo x5', description: 'Merge 5 builds in a single day.' },
  { feature: 'status', id: 'on-a-roll', name: 'On a Roll', description: 'Play 7 days in a row.' },
  { feature: 'squad', id: 'janitor', name: 'Janitor', description: 'Despawn 25 units cleanly.' },
  { feature: 'systems', id: 'big-spender', name: 'Big Spender', description: 'Spend $50 of model time in total.' },
  { feature: 'squad', id: 'hardcore-hero', name: 'Hardcore Hero', description: 'Pass the Gauntlet 10 times.' }
]

interface StatsFile {
  totalXp: number
  xp: number
  level: number
  shippedTotal: number
  scoutsTotal: number
  mergesTotal: number
  despawnsTotal: number
  gauntletPasses: number
  costTotalUsd: number
  day: string
  shippedToday: number
  mergesToday: number
  costTodayUsd: number
  activeDays: string[]
  achievements: Record<string, string>
  assetsTotal: number
  assetIds: Record<string, true>
  awarded: Record<string, string[]>
}

const LIVE_STATES = new Set<Task['state']>(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'stale'])

export const xpForLevel = (level: number): number => Math.round(400 * Math.pow(Math.max(1, level), 1.35))

function fresh(): StatsFile {
  return {
    totalXp: 0,
    xp: 0,
    level: 1,
    shippedTotal: 0,
    scoutsTotal: 0,
    mergesTotal: 0,
    despawnsTotal: 0,
    gauntletPasses: 0,
    costTotalUsd: 0,
    day: todayStamp(),
    shippedToday: 0,
    mergesToday: 0,
    costTodayUsd: 0,
    activeDays: [],
    achievements: {},
    assetsTotal: 0,
    assetIds: {},
    awarded: {}
  }
}

export function createStatsService(getCtx: () => AppCtx): StatsService {
  let data: StatsFile | undefined

  const file = (): string => getCtx().main.home.statsFile

  function load(): StatsFile {
    if (!data) {
      let raw: Partial<StatsFile> = {}
      try {
        raw = readJson<Partial<StatsFile>>(file(), {})
      } catch {
        raw = {}
      }
      data = { ...fresh(), ...raw }
      data.achievements = data.achievements ?? {}
      data.awarded = data.awarded ?? {}
      data.assetIds = data.assetIds ?? {}
      data.activeDays = Array.isArray(data.activeDays) ? data.activeDays : []
    }
    rollDay(data)
    return data
  }

  function rollDay(d: StatsFile): void {
    const today = todayStamp()
    if (d.day !== today) {
      d.day = today
      d.shippedToday = 0
      d.mergesToday = 0
      d.costTodayUsd = 0
    }
  }

  function save(): void {
    try {
      writeJson(file(), data)
    } catch {
      /* stats are cosmetic */
    }
    bus.publish({ type: 'stats', stats: svc.get() })
  }

  function streak(d: StatsFile): number {
    const days = new Set(d.activeDays)
    let n = 0
    const cur = new Date()
    for (;;) {
      if (!days.has(todayStamp(cur))) break
      n++
      cur.setDate(cur.getDate() - 1)
    }
    return n
  }

  function markActive(d: StatsFile): void {
    const t = todayStamp()
    if (!d.activeDays.includes(t)) {
      d.activeDays.push(t)
      d.activeDays = d.activeDays.slice(-60)
    }
    if (streak(d) >= 7) svc.unlock('on-a-roll')
  }

  function addXp(d: StatsFile, amount: number): void {
    d.totalXp += amount
    d.xp += amount
    let leveled = false
    while (d.xp >= xpForLevel(d.level)) {
      d.xp -= xpForLevel(d.level)
      d.level++
      leveled = true
    }
    if (leveled) {
      bus.toast('success', `LEVEL UP // LV ${d.level}`, 'Your squad grows stronger.')
      try {
        getCtx().notifier.sfx('levelup')
      } catch {
        /* not wired */
      }
    }
  }

  function findTask(taskId?: string): Task | undefined {
    if (!taskId) return undefined
    try {
      for (const h of getCtx().homes.values()) {
        const t = h.crew.get(taskId)
        if (t) return t
      }
    } catch {
      /* not wired */
    }
    return undefined
  }

  function liveUnits(): number {
    try {
      return [...getCtx().homes.values()].reduce((n, h) => n + h.crew.list().filter((t) => LIVE_STATES.has(t.state)).length, 0)
    } catch {
      return 0
    }
  }

  function openChoices(): number {
    try {
      return [...getCtx().homes.values()].reduce((n, h) => n + h.decisions.list(false).length, 0)
    } catch {
      return 1
    }
  }

  const svc: StatsService = {
    get(): FleetStats {
      const d = load()
      return {
        shippedToday: d.shippedToday,
        shippedTotal: d.shippedTotal,
        scoutsTotal: d.scoutsTotal,
        costTodayUsd: Math.round(d.costTodayUsd * 10000) / 10000,
        level: d.level,
        xp: d.xp,
        xpNext: xpForLevel(d.level),
        streakDays: streak(d),
        achievements: ACHIEVEMENTS.map((a) => ({ ...a, ...(d.achievements[a.id] ? { unlockedAt: d.achievements[a.id] } : {}) }))
      }
    },

    award(event, taskId) {
      const d = load()
      // An outcome counts once per task (e.g. a re-registered PR is not a second ship).
      if (taskId && event !== 'decision') {
        const seen = d.awarded[taskId] ?? []
        if (seen.includes(event)) return
        d.awarded[taskId] = [...seen, event]
        const keys = Object.keys(d.awarded)
        if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete d.awarded[k]
      }
      addXp(d, XP[event])
      markActive(d)
      const task = findTask(taskId)
      switch (event) {
        case 'spawn': {
          if (task?.harness === 'opencode') svc.unlock('cheap-unit')
          if (task?.explored || task?.loadout?.some((r) => r.includes('down-ranked:'))) svc.unlock('smart-pick')
          const live = liveUnits()
          if (live >= 3) svc.unlock('squad-up')
          if (live >= 5) svc.unlock('full-party')
          break
        }
        case 'scout':
          d.scoutsTotal++
          if (d.scoutsTotal >= 10) svc.unlock('recon-expert')
          break
        case 'ship':
          d.shippedTotal++
          d.shippedToday++
          if (task && Date.now() - Date.parse(task.createdAt) < 15 * 60_000) svc.unlock('speedrunner')
          if (task?.mode === 'no-mistakes') {
            d.gauntletPasses++
            if (d.gauntletPasses >= 10) svc.unlock('hardcore-hero')
          }
          break
        case 'merge': {
          d.mergesTotal++
          d.mergesToday++
          svc.unlock('first-blood')
          const h = new Date().getHours()
          if (h >= 0 && h < 5) svc.unlock('night-owl')
          if (d.mergesToday >= 5) svc.unlock('combo-x5')
          break
        }
        case 'decision':
          if (openChoices() === 0) svc.unlock('inbox-zero')
          break
        case 'cleanup':
          d.despawnsTotal++
          if (d.despawnsTotal >= 25) svc.unlock('janitor')
          break
        case 'save':
          svc.unlock('lore-first')
          break
      }
      save()
    },

    addCost(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return
      const d = load()
      d.costTotalUsd += usd
      d.costTodayUsd += usd
      if (d.costTotalUsd >= 50) svc.unlock('big-spender')
      save()
    },

    unlock(id) {
      const def = ACHIEVEMENTS.find((a) => a.id === id)
      if (!def) return undefined
      const d = load()
      if (d.achievements[id]) return { ...def, unlockedAt: d.achievements[id] }
      const ach: Achievement = { ...def, unlockedAt: nowIso() }
      d.achievements[id] = ach.unlockedAt as string
      bus.publish({ type: 'achievement', achievement: ach })
      try {
        const ctx = getCtx()
        ctx.notifier.sfx('levelup')
        ctx.ledger.record({ event: 'achievement', data: { id, name: def.name } })
      } catch {
        /* not wired */
      }
      save()
      return ach
    }
  }

  // Listen only to live outcomes; snapshots/history never backfill new unlocks.
  bus.onEvent((ev) => {
    if (ev.type === 'feature-used') {
      const ids: Record<string, string> = {
        'model-picker': 'model-picker', 'model-switch': 'model-switch', screenshot: 'screenshot', world_push: 'push-first',
        rate_task: 'rating-first', 'account-login': 'account-login', 'yolo-chat': 'yolo-chat', 'usage-mode': 'usage-mode',
        quest_add: 'quest-first', world_add: 'world-first', memory_write: 'lore-first', 'inventory-index': 'inventory-index'
      }
      if (ids[ev.feature]) svc.unlock(ids[ev.feature])
      if (ev.feature === 'unit-image' && ev.id) asset('unit-image', ev.id, ev.count)
      if (ev.feature === 'chat-image' && ev.id) asset('chat-image', ev.id, ev.count)
    } else if (ev.type === 'chat') {
      const m = ev.message
      if (m.queue === 'cancelled') svc.unlock('queue-edit')
      if (m.role === 'player' && m.wksp !== 'main' && !m.from) svc.unlock('ally-chat')
    } else if (ev.type === 'fal-run' && ev.run.status === 'completed') {
      asset('fal-first', ev.run.id, ev.run.outputs.length)
    } else if (ev.type === 'uthana-run' && ev.run.status === 'completed' && ev.run.kind !== 'character') {
      asset('animation-first', ev.run.id, ev.run.motionIds?.length || 1)
    } else if (ev.type === 'status' && ev.event.kind === 'note' && ev.event.key === 'genio-blender-run') {
      svc.unlock('blender-first')
    } else if (ev.type === 'status' && ev.event.kind === 'note' && ev.event.key === 'genio-codex-image') {
      asset('unit-image', ev.event.taskId + ':' + ev.event.text)
    }
  })

  function asset(achievement: string, id: string, count = 1): void {
    const d = load()
    const key = achievement + ':' + id
    if (d.assetIds[key]) return
    d.assetIds[key] = true
    d.assetsTotal += (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0)
    svc.unlock(achievement)
    if (d.assetsTotal >= 10) svc.unlock('assets-10')
    if (d.assetsTotal >= 50) svc.unlock('assets-50')
    save()
  }

  return svc
}
