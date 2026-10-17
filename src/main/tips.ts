import fs from 'node:fs'
import path from 'node:path'
import type { GenioEvent, Task } from '@shared/types'
import { askingDecision, ownsDecision } from '@shared/decisions'
import { pickTip, TIPS, tipDay, type TipHistory, type TipMoment, type TipSignals } from '@shared/tips'
import { probeClone } from '../../resources/unit-skills/genio/skills/play/scripts/clone.mjs'
import { bus } from './bus'
import { readSetup, setupFile } from './project-setup'
import type { AppCtx } from './services'
import { readJson, writeJsonAtomic } from './util'

export interface TipWindow {
  project: string
  wksp: string
  active: boolean
  dialogOpen: boolean
}
export interface TipsOptions {
  focused(): TipWindow | undefined
  playing(): boolean
  /** Final read of renderer dialogs; does not add or alter any UI. */
  canShow?(project: string): Promise<boolean>
  now?: () => number
  volumes?: typeof tipVolumes
}

/** Read-only probes of mounted volumes, only after an unusually slow copy. */
export async function tipVolumes(source: string): Promise<{ projectBlockClone: boolean; cloneVolumeMounted: boolean }> {
  if (process.platform !== 'win32') return { projectBlockClone: false, cloneVolumeMounted: false }
  const roots = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter(root => fs.existsSync(root))
  const probes = await Promise.all([source, ...roots].map(root => probeClone(root, root)))
  return { projectBlockClone: probes[0].capable, cloneVolumeMounted: probes.slice(1).some(p => p.capable) }
}

interface UsageSignals { day: string; generations: string[]; standingUsed: boolean; visited?: string[] }

/** Event-driven engine. Input events, never a timer, check a waiting choice's age. */
export function createTipsService(getCtx: () => AppCtx, options: TipsOptions): { stop(): void } {
  const ctx = getCtx()
  const now = options.now ?? Date.now
  const file = path.join(ctx.main.home.data, 'tips.json')
  const usageFile = path.join(ctx.main.home.data, 'tip-signals.json')
  const saved = readJson<Partial<TipHistory> | null>(file, {}) ?? {}
  const history: TipHistory = { shown: saved.shown && typeof saved.shown === 'object' ? saved.shown : {}, lastShownAt: saved.lastShownAt }
  const rawUsage = readJson<Partial<UsageSignals> | null>(usageFile, {}) ?? {}
  const usage: UsageSignals = { day: rawUsage.day ?? tipDay(now()), standingUsed: !!rawUsage.standingUsed,
    generations: Array.isArray(rawUsage.generations) ? rawUsage.generations : [], visited: Array.isArray(rawUsage.visited) ? rawUsage.visited : [] }
  const tasks = (): Task[] => [...ctx.homes.values()].flatMap(h => h.crew.list())
  const states = new Map(tasks().map(t => [t.id, t.state]))
  const opened = new Set(usage.visited ?? [])
  const pending = new Map<string, { moment: TipMoment; at: number; extra: Partial<TipSignals> }[]>()
  let stopped = false

  function generation(id: string): void {
    if (usage.day !== tipDay(now())) { usage.day = tipDay(now()); usage.generations = [] }
    if (!usage.generations.includes(id)) usage.generations.push(id)
    writeJsonAtomic(usageFile, usage)
  }

  function consider(moment: TipMoment, project: string, extra: Partial<TipSignals> = {}, checkedDialog = false): void {
    if (stopped) return
    const win = options.focused()
    if (!win || win.project !== project) return
    const p = ctx.projects.get(project)
    if (!p) return
    const all = tasks()
    if (!usage.standingUsed && all.some(t => t.mergeApproval?.kind === 'standing')) {
      usage.standingUsed = true
      writeJsonAtomic(usageFile, usage)
    }
    const home = ctx.home(win.wksp)
    const decisions = [...ctx.homes.values()].flatMap(h => h.decisions.list(true))
    const visible = decisions.filter(d => ownsDecision(d, win) && askingDecision(d, now()))
    const replying = [...ctx.homes.values()].some(h =>
      ['starting', 'thinking', 'tool'].includes(h.wksp.info().activity) ||
      h.design?.list().some(c => ['starting', 'thinking', 'tool'].includes(c.activity)))
    const signals: TipSignals = {
      enabled: ctx.settings.get().featureTips, presence: ctx.away.state().mode,
      playing: options.playing(), replying, dialogOpen: win.dialogOpen || ctx.permissions.pending().length > 0,
      // Only the single choice being explained may remain open for the Ask Genio hint.
      choiceOpen: visible.length > 0, active: win.active,
      achievements: ctx.stats.get().achievements.filter(a => a.unlockedAt).map(a => a.id),
      unity: p.engine === 'unity', mergesTotal: ctx.stats.get().shippedTotal,
      choicesAnswered: decisions.filter(d => d.resolvedAt && d.answeredVia).length,
      choiceAgeMs: visible.length === 1 ? now() - Date.parse(visible[0].createdAt) : 0,
      approvalsInWords: all.filter(t => t.project === project && (t.state === 'merged' || !!t.landedAt) && t.mergeApproval?.kind === 'specific' &&
        !!t.mergeApproval.words && now() - Date.parse(t.mergeApproval.at) >= 0 && now() - Date.parse(t.mergeApproval.at) <= 2 * 60 * 60_000).length,
      autoLoot: !!p.yolo, standingUsed: usage.standingUsed,
      artBible: fs.existsSync(path.join(p.path, '.genio', 'art-bible.md')),
      designNotes: (() => { try { return fs.readdirSync(path.join(p.path, '.genio', 'design')).some(f => f.endsWith('.md')) } catch { return false } })(),
      setupStarted: !!readSetup(setupFile(home.home.state))?.startedAt,
      generationsToday: usage.day === tipDay(now()) ? usage.generations.length : 0,
      copyMs: 0, projectBlockClone: false, cloneVolumeMounted: false, firstOpening: false,
      ...extra
    }
    // Completion inside a tool turn waits for replies to finish. Gates and focus are
    // checked again on delivery; idle alone invents no moment.
    if (replying && signals.enabled && signals.presence === 'online' && !signals.playing && !signals.dialogOpen && !signals.choiceOpen) {
      const waiting = pending.get(project) ?? []
      pending.set(project, [...waiting.filter(p => p.moment !== moment), { moment, at: now(), extra }])
    }
    const tip = pickTip(moment, signals, history, now())
    if (!tip) return
    if (options.canShow && !checkedDialog) {
      void options.canShow(project).then(allowed => {
        // Rebuild signals after the asynchronous read: focus, Play, replies, use and
        // caps may all have changed. Concurrent candidates still consume only one cap.
        if (allowed) consider(moment, project, extra, true)
      }).catch(() => undefined)
      return
    }
    const at = new Date(now()).toISOString()
    // Commit before publishing: a failed durable write must never produce a repeatable tip.
    const shown = { ...history.shown, [tip.id]: at }
    writeJsonAtomic(file, { shown, lastShownAt: at })
    Object.assign(history, { shown, lastShownAt: at, shownThisSession: true })
    bus.publish({ type: 'tip', project, tip: { id: tip.id, line: tip.line, question: tip.question } })
  }

  const off = bus.onEvent(event => {
    try { onEvent(event) } catch { /* optional hints must never interrupt real work */ }
  })
  function onEvent(e: GenioEvent): void {
    if (e.type === 'achievement') {
      const at = Date.parse(e.achievement.unlockedAt ?? '')
      if (TIPS.some(t => t.usedAchievements.includes(e.achievement.id) && history.shown[t.id] &&
        at >= Date.parse(history.shown[t.id]) && at - Date.parse(history.shown[t.id]) <= 24 * 60 * 60_000)) ctx.stats.unlock('tip-taken')
    } else if (e.type === 'stats-award' && e.event === 'merge' && e.project) {
      consider('merge', e.project)
    } else if (e.type === 'task') {
      if (e.task.mergeApproval?.kind === 'standing' && !usage.standingUsed) {
        usage.standingUsed = true
        writeJsonAtomic(usageFile, usage)
      }
      const before = states.get(e.task.id)
      states.set(e.task.id, e.task.state)
      if (e.task.kind === 'ship' && e.task.state === 'ready' && before !== 'ready') consider('build-ready', e.task.project)
    } else if (e.type === 'feature-used' && e.project && e.id) {
      if (e.feature === 'chat-image' && (e.count ?? 1) > 0) {
        generation(`image:${e.id}`)
        consider('generated', e.project)
        consider('generation-approved', e.project)
      } else if (e.feature === 'spend-approve') {
        generation(`spend:${e.id}`)
        consider('generation-approved', e.project)
      }
    } else if (e.type === 'fal-run' && e.run.status === 'completed' && e.run.outputs.length && e.run.world) {
      consider('generated', e.run.world)
    } else if (e.type === 'uthana-run' && e.run.status === 'completed' && e.run.world) {
      consider('generated', e.run.world)
    } else if (e.type === 'unit-copy' && e.ms > 60_000) {
      const p = ctx.projects.get(e.project)
      if (p) void (options.volumes ?? tipVolumes)(p.path).then(volumes => {
        try { consider('copy', e.project, { copyMs: e.ms, ...volumes }) } catch { /* optional */ }
      }).catch(() => undefined)
    } else if (e.type === 'player-active') {
      consider('choice-wait', e.project)
      if (!opened.has(e.project)) {
        opened.add(e.project)
        usage.visited = [...opened]
        writeJsonAtomic(usageFile, usage)
        consider('project-open', e.project, { firstOpening: true })
      }
    } else if (e.type === 'wksp' && e.wksp.activity === 'idle') {
      const win = options.focused()
      for (const [project, waiting] of pending) {
        pending.delete(project)
        if (win?.project === project) for (const p of waiting) {
          if (now() - p.at <= 10 * 60_000) consider(p.moment, project, p.extra)
        }
      }
    } else if ((e.type === 'away' && e.away.mode !== 'online') || (e.type === 'settings' && !e.settings.featureTips)) {
      pending.clear()
    } else if (e.type === 'task-removed') {
      states.delete(e.id)
    } else if (e.type === 'status' && e.event.kind === 'note' && e.event.key === 'genio-codex-image') {
      const t = tasks().find(t => t.id === e.event.taskId)
      if (t) consider('generated', t.project)
    }
  }
  return { stop() { stopped = true; off() } }
}
