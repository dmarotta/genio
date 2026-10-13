/**
 * Smart dispatch service: the live signals the loadout picker needs (who is
 * logged in, plan quota, the cheap-model gate, the cost dial, scorecard
 * scores), the scorecard itself, the player's verdicts and the learning loop
 * (scorecard.ts). Previews use a background cache; launches scan local evidence,
 * claim a provider reservation and recheck immediately before terminal creation.
 */
import type { AccountStatus, OpResult, UsageReport } from '@shared/api'
import type { Decision, Task, Verdict } from '@shared/types'
import { cheapModelsAllowed, type DispatchScoresView } from '@shared/dispatch'
import { bus } from './bus'
import { listAccounts } from './accounts'
import { resolveLoadout, cheapGate, type PickEnv, type QuotaWindow } from './loadout'
import { getSecret } from './secrets'
import {
  acceptsProposal, appendLearning, applyProposal, buildOutcome, createScorecard, openProposals, outcomeOf, planProposals, planReorder,
  readLearning, scoreTable, scorecardFile, type Scorecard
} from './scorecard'
import type { AppCtx, DispatchService } from './services'
import { claudeLimits, claudeLimitsFile, quotaFromUsage, usageReport, type ClaudeLimitsFile } from './usage'
import { expireWindow, explorationSafe } from './quota-policy'
import { SessionQuotaPolicy } from './session-usage'
import { readJson } from './util'

const USAGE_TTL = 5 * 60_000
const LOGIN_TTL = 30 * 60_000

/** account rows name the CLI; harness ids name the adapter */
const ACCOUNT_OF: Record<string, string> = { cursor: 'cursor-agent' }

export function createDispatchService(getCtx: () => AppCtx): DispatchService {
  let quota: Record<string, QuotaWindow[]> = {}
  let quotaAt = 0
  let logins = new Map<string, AccountStatus['state']>()
  let loginsAt = 0
  let refreshing = false
  let card: Scorecard | undefined
  let launchQueue: Promise<unknown> = Promise.resolve()
  const reservations = new Set<string>()

  const dataDir = (): string => getCtx().main.home.data
  const scorecard = (): Scorecard => (card ??= createScorecard(scorecardFile(dataDir())))

  const refresh = (): void => {
    const now = Date.now()
    if (refreshing || (now - quotaAt < USAGE_TTL && now - loginsAt < LOGIN_TTL)) return
    refreshing = true
    const jobs: Promise<unknown>[] = []
    if (now - quotaAt >= USAGE_TTL) jobs.push(usageReport(getCtx()).then(svc.noteUsage))
    if (now - loginsAt >= LOGIN_TTL) jobs.push(listAccounts().then(svc.noteLogins))
    void Promise.allSettled(jobs).finally(() => {
      refreshing = false
    })
  }

  const hottest = (harness: string): number | undefined => {
    const values = (quota[harness] ?? []).map((w) => expireWindow(w).usedPercent).filter((v): v is number => typeof v === 'number')
    return values.length ? Math.max(...values) : undefined
  }

  const unavailable = (id: string, own?: string): boolean => {
    const ctx = getCtx()
    return (id !== own && reservations.has(id)) || (id === 'claude' && new SessionQuotaPolicy(dataDir()).unitBlocked()) ||
      ((hottest(id) ?? 0) >= 70 && [...ctx.homes.values()].some((h) =>
        h.crew.list().some((t) => t.harness === id && !!t.terminalId && ctx.terminals.get(t.terminalId)?.alive)))
  }

  const svc: DispatchService = {
    signals(project, opts = {}) {
      refresh()
      const ctx = getCtx()
      const stored = claudeLimits(readJson<ClaudeLimitsFile | undefined>(claudeLimitsFile(dataDir()), undefined))
      if (stored) quota.claude = stored.windows
      const s = ctx.settings.get()
      const world = ctx.projects.get(project)
      let keySet = false
      try {
        keySet = Boolean(getSecret('openrouter', dataDir()))
      } catch {
        /* no OS encryption: no key */
      }
      const opencode = ctx.settings.availableHarnesses().some((h) => h.id === 'opencode')
      const env: Omit<PickEnv, 'available'> = {
        loggedOut: (id) => logins.get(ACCOUNT_OF[id] ?? id) === 'logged-out',
        quota,
        unavailable,
        cheap: cheapGate({ worldAllows: cheapModelsAllowed(world), keySet, opencodeReady: opencode }),
        dial: world?.costDial ?? s.costDial,
        dialFromWorld: Boolean(world?.costDial),
        stats: scoreTable(scorecard().list()),
        rand: opts.preview ? undefined : Math.random,
        preview: opts.preview
      }
      return env
    },

    reserve(input) {
      // The single main-process dispatcher owns selection + reservation. No await
      // separates the final policy evaluation from claiming the provider slot.
      const result = launchQueue.then(async () => {
        svc.noteUsage(await usageReport(getCtx()))
        const signals = svc.signals(input.project)
        const loadout = resolveLoadout(input, getCtx().settings, signals)
        const primary = loadout.explored ? resolveLoadout(input, getCtx().settings, { ...signals, preview: true }).harness : undefined
        reservations.add(loadout.harness)
        let released = false
        return {
          loadout,
          async check() {
            if (released) throw new Error('Launch reservation was already released.')
            svc.noteUsage(await usageReport(getCtx()))
            const env = { ...svc.signals(input.project), unavailable: (id: string) => unavailable(id, loadout.harness) }
            resolveLoadout({ ...input, harness: loadout.harness }, getCtx().settings, env)
            if (loadout.explored) {
              if (!explorationSafe(env.quota?.[primary!]) || !explorationSafe(env.quota?.[loadout.harness]))
                throw new Error('deferred: exploration no longer has fresh headroom on both plans.')
            }
          },
          release() { if (!released) { released = true; reservations.delete(loadout.harness) } }
        }
      })
      launchQueue = result.catch(() => undefined)
      return result
    },

    usagePercent: hottest,

    noteUsage(r: UsageReport) {
      const observed = quotaFromUsage(r)
      // A scan error/missing bucket is not provider evidence of recovery.
      for (const [tool, windows] of Object.entries(observed)) {
        const merged = new Map((quota[tool] ?? []).map((w) => [w.label, w]))
        for (const w of windows) {
          const old = merged.get(w.label)
          if (!old || (w.observedAt ?? '') >= (old.observedAt ?? '')) merged.set(w.label, w)
        }
        quota[tool] = [...merged.values()]
      }
      quotaAt = Date.now()
    },

    noteLogins(list: AccountStatus[]) {
      logins = new Map(list.filter((a) => a.installed).map((a) => [a.tool, a.state]))
      loginsAt = Date.now()
    },

    record(t: Task) {
      const outcome = outcomeOf(t)
      if (!outcome) return
      scorecard().upsert(buildOutcome(t, outcome, Date.now(), hottest(t.harness)))
      svc.learn()
    },

    rate(taskId: string, verdict: Verdict, note?: string): OpResult {
      const ctx = getCtx()
      let task: Task | undefined
      for (const h of ctx.homes.values()) {
        task = h.crew.get(taskId)
        if (task) {
          h.crew.update(taskId, { verdict, verdictNote: note?.trim() || undefined })
          break
        }
      }
      const recorded = scorecard().rate(taskId, verdict, note?.trim())
      if (!task && !recorded) return { ok: false, message: `No unit ${taskId}.` }
      bus.publish({ type: 'feature-used', feature: 'rate_task' })
      if (recorded) svc.learn()
      return { ok: true, message: `Recorded ${verdict === 'up' ? '👍' : '👎'} for ${taskId}${recorded ? '' : '; it goes on the scorecard when the unit ends'}.` }
    },

    scores(): DispatchScoresView {
      const recent = scorecard().list().slice(-25).reverse()
      return { rows: scoreTable(scorecard().list()), recent, log: readLearning(dataDir()) }
    },

    learn() {
      const ctx = getCtx()
      const s = ctx.settings.get()
      const rows = scoreTable(scorecard().list())
      if (s.autoReorder) {
        const plan = planReorder(s, rows)
        if (plan) {
          ctx.settings.save({ categoryPools: plan.categoryPools, dispatchRules: plan.dispatchRules })
          for (const c of plan.changes) appendLearning(dataDir(), 'reorder', c)
          bus.toast('info', 'Dispatch learned', plan.changes[0])
        }
      }
      const opened = openProposals(ctx.main.decisions, planProposals(ctx.settings.get(), rows), ctx.settings.get())
      for (const d of opened) appendLearning(dataDir(), 'proposal', d.question)
    },

    answered(d: Decision, answer: string) {
      if (d.action?.kind !== 'dispatch-proposal' || !acceptsProposal(d, answer)) return
      const ctx = getCtx()
      const patch = applyProposal(ctx.settings.get(), d.action.proposal)
      if (!patch) {
        appendLearning(dataDir(), 'applied', `${d.question} — nothing to change (already done, or the row is locked)`)
        return
      }
      ctx.settings.save(patch)
      appendLearning(dataDir(), 'applied', d.question)
    }
  }
  return svc
}
