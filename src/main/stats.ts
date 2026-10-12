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
  { id: 'first-blood', name: 'First Blood', description: 'Merge your first build.' },
  { id: 'squad-up', name: 'Squad Up', description: 'Have 3 units deployed at once.' },
  { id: 'full-party', name: 'Full Party', description: 'Have 5 units deployed at once.' },
  { id: 'recon-expert', name: 'Recon Expert', description: 'Complete 10 recon missions.' },
  { id: 'speedrunner', name: 'Speedrunner', description: 'A build is ready less than 15 minutes after deploy.' },
  { id: 'night-owl', name: 'Night Owl', description: 'Merge a build between midnight and 5 AM.' },
  { id: 'inbox-zero', name: 'Inbox Zero', description: 'Answer every open choice.' },
  { id: 'combo-x5', name: 'Combo x5', description: 'Merge 5 builds in a single day.' },
  { id: 'on-a-roll', name: 'On a Roll', description: 'Play 7 days in a row.' },
  { id: 'janitor', name: 'Janitor', description: 'Despawn 25 units cleanly.' },
  { id: 'big-spender', name: 'Big Spender', description: 'Spend $50 of model time in total.' },
  { id: 'hardcore-hero', name: 'Hardcore Hero', description: 'Pass the Gauntlet 10 times.' }
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

  return svc
}
