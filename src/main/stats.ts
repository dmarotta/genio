/**
 * XP, levels, streaks and achievements. Pure flavour on top of real outcomes:
 * every award is triggered by an actual event (deploy, loot, merge, ...).
 * Persisted in the main base's data/stats.json.
 */
import type { Achievement, FleetStats, PlaystyleId, PlaystyleView, Task } from '@shared/types'
import type { OpResult } from '@shared/api'
import type { OutcomeRecord } from '@shared/dispatch'
import { PLAYSTYLES, classifyPlaystyle, isPlaystyleId, titleName } from '@shared/playstyle'
import { bus } from './bus'
import { landedDaysInWeek, landingWindow, loadLandingLog, observeDay, recordLanding, type LandingLog } from './landings'
import type { AppCtx, StatsService } from './services'
import { nowIso, readJson, todayStamp, writeJson } from './util'
import { settingsPath } from '@shared/settings-pages'

/** trophies a player can pin to the front of the achievements grid */
export const MAX_PINS = 3
/** Asset dedupe keys kept on disk (newest wins): bounds stats.json, which is rewritten on every award. */
export const ASSET_IDS_KEEP = 2000

/** Drop the oldest dedupe keys past the cap; insertion order is the order they were recorded in. */
function pruneAssetIds(d: Pick<StatsFile, 'assetIds'>): void {
  const keys = Object.keys(d.assetIds)
  if (keys.length <= ASSET_IDS_KEEP) return
  for (const k of keys.slice(0, keys.length - ASSET_IDS_KEEP)) delete d.assetIds[k]
}

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
  { id: 'explorer-install', name: 'Open Sesame', description: 'Install Open with Genio in Windows Explorer.', feature: 'explorer' },
  { id: 'character-sheet-open', name: 'Know Your Character', description: 'Open your Character Sheet.', feature: 'status' },
  { id: 'project-window-open', name: 'Home Base', description: 'Open your first project window.', feature: 'project-window' },
  { id: 'project-welcome', name: 'Welcome Back', description: 'Genio greets you with a project recap.', feature: 'comms' },
  { id: 'project-cli-open', name: 'Direct Entry', description: 'Open a project with genio <folder>.', feature: 'project-cli' },
  { id: 'project-windows-two', name: 'Split Screen', description: 'Have two project windows open at once.', feature: 'file-menu' },
  { id: 'play-first', name: 'Press Play', description: 'Start a Unity Play session.', feature: 'play' },
  { id: 'play-pool-configured', name: 'Room for the Crew', description: `Set the Unity slots for units in ${settingsPath('project-unity')}.`, feature: 'systems' },
  { id: 'play-observed', name: 'Shared Sight', description: 'Let Genio look at a frame of your game.', feature: 'play_frame' },
  // The new Play screen brought these back; their ids (and any earned dates) are unchanged.
  { id: 'play-stream', name: 'Motion Picture', description: 'See your game live on the Play screen.', feature: 'play' },
  { id: 'play-input', name: 'Hands On', description: 'Control a live game with keyboard, mouse or gamepad.', feature: 'play' },
  { id: 'play-fullscreen', name: 'Big Screen', description: 'Expand the live game to full screen.', feature: 'play' },
  { id: 'play-unit', name: 'Field Test', description: "Play a unit's version of your game before it lands.", feature: 'play' },
  { id: 'play-step', name: 'One Frame at a Time', description: 'Step a paused Unity game.', feature: 'play' },
  { id: 'play-resolution', name: 'Aspect Ratio', description: 'Change the streamed resolution while playing.', feature: 'play' },
  { id: 'play-audio', name: 'Sound Check', description: "Hear your game's sound on the Play screen.", feature: 'play' },
  { id: 'play-kept-copy', name: 'Warm Start', description: 'Start Unity again from the Play copy Genio kept for you.', feature: 'play' },
  // Retired with the old Play screen: earned dates stay in stats.json and on the sheet.
  { id: 'play-package', name: 'Live Link', description: 'Enable the Genio Play package in a project.', feature: 'play', retired: true },
  { id: 'play-slot', name: 'Shared Playground', description: 'Prepare and lease a shared Unity slot.', feature: 'play', retired: true },
  { id: 'play-takeover', name: 'My Turn', description: 'Take over a shared Play slot.', feature: 'play', retired: true },
  { id: 'play-snapshot', name: 'In the Frame', description: 'Capture a game snapshot.', feature: 'play', retired: true },
  { id: 'chat-provider-switch', feature: 'comms', name: 'New Perspective', description: 'Switch the chat provider.' },
  { id: 'codex-chat-turn', feature: 'comms', name: 'Codex Companion', description: 'Complete a Codex-driven chat turn.' },
  { id: 'design-chat-reply', feature: 'design', name: 'Sounding Board', description: 'Get a reply from a design chat.' },
  { id: 'design-note-saved', feature: 'design_notes', name: 'Noted', description: 'Have a design chat save a design note.' },
  { id: 'inventory-chat', name: 'Shared View', description: 'Ask Genio about the assets you picked in Inventory.', feature: 'inventory-chat' },
  { id: 'genio-panel-context', name: 'Over the Shoulder', description: 'Ask Genio from the floating panel on any screen.', feature: 'genio-panel' },
  { id: 'inventory-scout', name: 'Inventory Scout', description: 'Have Genio find an asset in your project.', feature: 'assets_find' },
  { id: 'asset-pathfinder', name: 'Asset Pathfinder', description: 'Have Genio pick the folder for a new asset.', feature: 'asset_locate' },
  { id: 'inventory-open', name: 'Open the Vault', description: 'Open a project Inventory.', feature: 'inventory' },
  { id: 'inventory-preview', name: 'Closer Look', description: 'Select an asset to preview in Inventory.', feature: 'inventory' },
  { id: 'art-bible-edit', name: 'House Style', description: 'Save a project Art Bible from its screen.', feature: 'art-bible' },
  { id: 'art-bible-chat', name: 'Style by Word', description: 'Have Genio write your Art Bible from chat.', feature: 'art_bible' },
  { id: 'model-picker', feature: 'comms', name: 'Meet the Models', description: 'Open the live model picker.' },
  { id: 'model-switch', feature: 'comms', name: 'Change of Mind', description: 'Switch a chat model in the picker.' },
  { id: 'screenshot', feature: 'comms', name: 'Show and Tell', description: 'Paste a screenshot into chat.' },
  { id: 'chat-image', feature: 'generate_image', name: 'Pixel Summoner', description: 'Generate an image in chat.' },
  { id: 'fal-first', feature: 'fal_generate', name: 'Asset Alchemist', description: 'Complete a FAL run.' },
  { id: 'animation-first', feature: 'uthana_motion', name: 'Motion Unlocked', description: 'Generate your first Uthana animation.' },
  { id: 'help-first', feature: 'genio_help', name: 'Read the Manual', description: "Ask how Genio works and get the answer from Genio's own help." },
  { id: 'ally-chat', feature: 'comms', name: 'Project Chat', description: 'Talk to Genio in a project window.' },
  { id: 'push-first', feature: 'world_push', name: 'Go Live', description: 'Push a project on demand.' },
  { id: 'rating-first', feature: 'rate_task', name: 'GG or Go Again', description: 'Rate a unit on the scorecard.' },
  { id: 'smart-pick', feature: 'loadout_preview', name: 'Adaptive Build', description: 'Deploy a unit whose tool Genio picked to try something new or to save quota.' },
  { id: 'queue-edit', feature: 'comms', name: 'Second Thoughts', description: 'Edit or cancel a queued message.' },
  { id: 'chat-steer', feature: 'comms', name: 'Change Course', description: 'Steer Genio mid-turn (Steer or Send now): it stops and reads your message first.' },
  { id: 'shell-command', feature: 'terminal', name: 'Command Line', description: 'Run a shell command from chat with ! and see it in the terminal pane.' },
  { id: 'reaction-like', feature: 'comms', name: 'Right Track', description: 'Like a Genio message to confirm the path.' },
  { id: 'reaction-dislike', feature: 'comms', name: 'Hold Up', description: 'Dislike a Genio message so it pauses and asks what is wrong.' },
  { id: 'yolo-chat', feature: 'comms', name: 'No Safety Wheels', description: 'Switch chat to YOLO mode.' },
  { id: 'account-login', feature: 'systems', name: 'Signed In', description: `Log in from ${settingsPath('accounts')}.` },
  { id: 'usage-mode', feature: 'systems', name: 'Gear Shift', description: `Switch the Usage mode between Save, Balanced and Max in ${settingsPath('usage')}.` },
  { id: 'cheap-unit', feature: 'deploy', name: 'Budget Build', description: 'Deploy an OpenCode unit.' },
  { id: 'agent-asset-first', feature: 'agent_generation', name: 'Made to Order', description: 'Generate your first asset through Genio.' },
  { id: 'asset-placed-first', feature: 'asset_place', name: 'Loot Delivered', description: 'Place an agent-generated asset in a project.' },
  { id: 'spend-approve', feature: 'approve_run', name: 'Worth Every Cent', description: 'Approve a paid generation quote.' },
  { id: 'unit-spend-grant', feature: 'spend-grant', name: 'Purse Strings', description: 'Approve spending for a unit: a budget at deploy or its spend question.' },
  { id: 'unit-image', feature: 'assets', name: 'Pixel Crafter', description: 'A unit creates a Codex image.' },
  { id: 'unit-motion', feature: 'unit-uthana', name: 'Motion Crew', description: 'A unit generates an Uthana motion.' },
  { id: 'blender-first', feature: 'blender', name: 'Polygon Power', description: 'Complete a Blender skill run.' },
  { id: 'inventory-index', feature: 'inventory-index', name: 'Loot Catalog', description: "Index a project's assets for the first time." },
  { id: 'assets-10', feature: 'assets', name: 'Asset Combo', description: 'Generate 10 assets.' },
  { id: 'assets-50', feature: 'assets', name: 'Asset Factory', description: 'Generate 50 assets.' },
  { id: 'quest-first', feature: 'quests', name: 'Side Quest', description: 'Add a quest.' },
  { id: 'world-first', feature: 'worlds', name: 'New Game', description: 'Register a project.' },
  { id: 'lore-first', feature: 'memory', name: 'Save Point', description: 'Save your first memory update.' },
  { feature: 'ship', id: 'first-blood', name: 'First Blood', description: 'Merge your first build.' },
  { feature: 'modeller', id: 'modeller-first', name: 'Model Citizen', description: 'Merge a Modeller build: a unit that makes a 3D model step by step.' },
  { feature: 'modeller', id: 'modeller-rewind', name: 'Take Two', description: "Revert or branch a Modeller's model from its unit page.", retired: true },
  { feature: 'generator', id: 'generator-first', name: 'Production Line', description: 'Merge a Generator build: a unit that runs asset generation jobs.' },
  { feature: 'plans', id: 'plan-first', name: 'Battle Plan', description: 'Have Genio file a plan: one job split into steps for several units.' },
  { feature: 'plans', id: 'plan-control', name: 'Hold Everything', description: 'Pause or cancel a plan from a step chip.' },
  { feature: 'plans', id: 'plan-done', name: 'According to Plan', description: 'Merge every step of a plan.' },
  { feature: 'squad', id: 'squad-up', name: 'Squad Up', description: 'Have 3 units deployed at once.' },
  { feature: 'squad', id: 'full-party', name: 'Full Party', description: 'Have 5 units deployed at once.' },
  { feature: 'scout', id: 'recon-first', name: 'Scouting Party', description: 'Complete your first recon mission.' },
  { feature: 'scout', id: 'recon-expert', name: 'Recon Expert', description: 'Complete 10 recon missions.' },
  { feature: 'squad', id: 'speedrunner', name: 'Speedrunner', description: 'A build is ready less than 15 minutes after deploy.' },
  { feature: 'move', id: 'night-owl', name: 'Night Owl', description: 'Merge a build between midnight and 5 AM.' },
  { feature: 'move', id: 'inbox-zero', name: 'Inbox Zero', description: 'Answer every open choice.' },
  { feature: 'move', id: 'ask-genio-choice', name: 'Second Opinion', description: 'Take a pending choice to Genio with Ask Genio.' },
  { feature: 'move', id: 'combo-x5', name: 'Combo x5', description: 'Merge 5 builds in a single day.' },
  { feature: 'status', id: 'on-a-roll', name: 'On a Roll', description: 'Play 7 days in a row.' },
  { feature: 'squad', id: 'janitor', name: 'Janitor', description: 'Despawn 25 units cleanly.' },
  { feature: 'systems', id: 'big-spender', name: 'Big Spender', description: 'Spend $50 of model time in total.' },
  { feature: 'squad', id: 'hardcore-hero', name: 'Hardcore Hero', description: 'Finish 10 Hardcore builds through the Gauntlet checks.' },
  { feature: 'status', id: 'title-earned', name: 'Found Your Style', description: 'Earn a playstyle title from your landed missions.' },
  { feature: 'status', id: 'title-equip', name: 'Dress the Part', description: 'Equip an earned playstyle title.' },
  { feature: 'status', id: 'trophy-pin', name: 'Trophy Case', description: 'Pin an achievement to your Character Sheet.' },
  { feature: 'status', id: 'busy-week', name: 'Busy Week', description: 'Record landings on 5 different days in one week.' }
]

interface StatsFile {
  totalXp: number
  xp: number
  level: number
  scoutsTotal: number
  /** the Shipped tiles: merged builds, not ready branches */
  mergesTotal: number
  despawnsTotal: number
  gauntletPasses: number
  costTotalUsd: number
  day: string
  mergesToday: number
  costTodayUsd: number
  activeDays: string[]
  achievements: Record<string, string>
  assetsTotal: number
  assetIds: Record<string, true>
  awarded: Record<string, string[]>
  landings: LandingLog
  /** playstyle titles ever earned -> when */
  titles: Partial<Record<PlaystyleId, string>>
  /** player preferences for the sheet */
  equippedTitle?: PlaystyleId
  pins: string[]
}

const LIVE_STATES = new Set<Task['state']>(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'stale'])

export const xpForLevel = (level: number): number => Math.round(400 * Math.pow(Math.max(1, level), 1.35))

function fresh(): StatsFile {
  return {
    totalXp: 0,
    xp: 0,
    level: 1,
    scoutsTotal: 0,
    mergesTotal: 0,
    despawnsTotal: 0,
    gauntletPasses: 0,
    costTotalUsd: 0,
    day: todayStamp(),
    mergesToday: 0,
    costTodayUsd: 0,
    activeDays: [],
    achievements: {},
    assetsTotal: 0,
    assetIds: {},
    awarded: {},
    landings: loadLandingLog(undefined),
    titles: {},
    pins: []
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
      pruneAssetIds(data)
      data.activeDays = Array.isArray(data.activeDays) ? data.activeDays : []
      data.landings = loadLandingLog(raw.landings)
      data.titles = data.titles && typeof data.titles === 'object' ? data.titles : {}
      data.pins = Array.isArray(data.pins) ? [...new Set(data.pins.filter((id) => typeof id === 'string' && data!.achievements[id]))].slice(0, MAX_PINS) : []
      if (!isPlaystyleId(data.equippedTitle) || !data.titles[data.equippedTitle]) delete data.equippedTitle
    }
    rollDay(data)
    // Genio is running today: a quiet day reads as zero landings, not unknown.
    if (observeDay(data.landings)) persist()
    return data
  }

  function rollDay(d: StatsFile): void {
    const today = todayStamp()
    if (d.day !== today) {
      d.day = today
      d.mergesToday = 0
      d.costTodayUsd = 0
    }
  }

  function persist(): void {
    try {
      writeJson(file(), data)
    } catch {
      /* stats are cosmetic */
    }
  }

  function save(): void {
    persist()
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

  /** Scorecard outcomes, oldest first; none when dispatch is not wired. */
  function outcomes(): OutcomeRecord[] {
    try {
      return getCtx().dispatch.outcomes()
    } catch {
      return []
    }
  }

  function playstyle(d: StatsFile): PlaystyleView {
    const reading = classifyPlaystyle(outcomes())
    const earned = PLAYSTYLES.flatMap((p) => (d.titles[p.id] ? [{ id: p.id, at: d.titles[p.id] as string }] : []))
    return {
      current: reading.title,
      shown: d.equippedTitle ?? reading.title,
      ...(d.equippedTitle ? { equipped: d.equippedTitle } : {}),
      why: reading.why,
      samples: reading.samples,
      counts: reading.counts,
      earned
    }
  }

  /** Keep a title the recent landings earn; earned titles are never taken away. */
  function earnTitle(d: StatsFile): boolean {
    const { title } = classifyPlaystyle(outcomes())
    if (title === 'adventurer' || d.titles[title]) return false
    d.titles[title] = nowIso()
    bus.toast('success', `TITLE EARNED // ${titleName(title).toUpperCase()}`, 'Equip it on your Character Sheet.')
    svc.unlock('title-earned')
    return true
  }

  function land(d: StatsFile, kind: 'build' | 'recon', taskId?: string): void {
    if (!recordLanding(d.landings, kind, { taskId, questId: findTask(taskId)?.backlogId })) return
    if (landedDaysInWeek(d.landings) >= 5) svc.unlock('busy-week')
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
        shippedToday: d.mergesToday,
        shippedTotal: d.mergesTotal,
        scoutsTotal: d.scoutsTotal,
        costTodayUsd: Math.round(d.costTodayUsd * 10000) / 10000,
        level: d.level,
        xp: d.xp,
        xpNext: xpForLevel(d.level),
        streakDays: streak(d),
        achievements: ACHIEVEMENTS.flatMap((a) => (d.achievements[a.id] ? [{ ...a, unlockedAt: d.achievements[a.id] }] : a.retired ? [] : [a])),
        playstyle: playstyle(d),
        landings: landingWindow(d.landings),
        pins: d.pins.filter((id) => d.achievements[id])
      }
    },

    pin(id, pinned): OpResult {
      const d = load()
      const def = ACHIEVEMENTS.find((a) => a.id === id)
      if (!def) return { ok: false, message: `Unknown achievement: ${id}` }
      const pins = d.pins.filter((p) => d.achievements[p])
      if (!pinned) {
        d.pins = pins.filter((p) => p !== id)
        save()
        return { ok: true, message: `Unpinned ${def.name}.` }
      }
      if (!d.achievements[id]) return { ok: false, message: `${def.name} is still locked.` }
      if (pins.includes(id)) return { ok: true, message: `${def.name} is already pinned.` }
      if (pins.length >= MAX_PINS) return { ok: false, message: `Only ${MAX_PINS} trophies fit; unpin one first.` }
      d.pins = [...pins, id]
      svc.unlock('trophy-pin')
      save()
      return { ok: true, message: `Pinned ${def.name}.` }
    },

    equipTitle(id): OpResult {
      const d = load()
      if (id === null) {
        delete d.equippedTitle
        save()
        return { ok: true, message: 'Title follows your playstyle.' }
      }
      if (!isPlaystyleId(id) || !d.titles[id]) return { ok: false, message: `${titleName(id)} has not been earned yet.` }
      d.equippedTitle = id
      svc.unlock('title-equip')
      save()
      return { ok: true, message: `Equipped ${titleName(id)}.` }
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
          svc.unlock('recon-first')
          if (d.scoutsTotal >= 10) svc.unlock('recon-expert')
          land(d, 'recon', taskId)
          earnTitle(d)
          break
        case 'ship':
          // a ready branch or open PR earns XP; the Shipped tiles wait for the merge
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
          if (task?.modeller) svc.unlock('modeller-first')
          else if (task?.generator) svc.unlock('generator-first')
          const h = new Date().getHours()
          if (h >= 0 && h < 5) svc.unlock('night-owl')
          if (d.mergesToday >= 5) svc.unlock('combo-x5')
          land(d, 'build', taskId)
          earnTitle(d)
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
      if (!def || def.retired) return undefined
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
        'character-sheet': 'character-sheet-open',
        'play-fullscreen': 'play-fullscreen',
        'model-picker': 'model-picker', 'model-switch': 'model-switch', screenshot: 'screenshot', world_push: 'push-first',
        rate_task: 'rating-first', 'account-login': 'account-login', 'yolo-chat': 'yolo-chat', 'usage-mode': 'usage-mode',
        quest_add: 'quest-first', world_add: 'world-first', memory_write: 'lore-first', 'inventory-index': 'inventory-index',
        plan_create: 'plan-first', 'plan-done': 'plan-done', 'shell-command': 'shell-command'
      }
      if (ids[ev.feature]) svc.unlock(ids[ev.feature])
      // titles earned by history from before this build show up on the next visit
      if (ev.feature === 'character-sheet' && earnTitle(load())) save()
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
    } else if (ev.type === 'status' && ev.event.kind === 'note' && ev.event.key === 'genio-uthana-run') {
      asset('unit-motion', ev.event.taskId + ':' + ev.event.text)
    }
  })

  function asset(achievement: string, id: string, count = 1): void {
    const d = load()
    const key = achievement + ':' + id
    if (d.assetIds[key]) return
    d.assetIds[key] = true
    pruneAssetIds(d)
    d.assetsTotal += (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0)
    svc.unlock(achievement)
    if (d.assetsTotal >= 10) svc.unlock('assets-10')
    if (d.assetsTotal >= 50) svc.unlock('assets-50')
    save()
  }

  return svc
}
