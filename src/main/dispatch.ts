/**
 * Smart dispatch service: the live signals the loadout picker needs (who is
 * logged in, plan quota, the cheap-model gate, the cost dial, scorecard
 * scores), the scorecard itself, the player's verdicts and the learning loop
 * (scorecard.ts). Login and usage checks are slow, so the picker reads the
 * last known values and a stale cache refreshes in the background.
 */
import type { AccountStatus, OpResult, UsageReport } from '@shared/api'
import type { Decision, Task, Verdict } from '@shared/types'
import { cheapModelsAllowed, type DispatchScoresView } from '@shared/dispatch'
import { bus } from './bus'
import { listAccounts } from './accounts'
import { cheapGate, type PickEnv, type QuotaWindow } from './loadout'
import { getSecret } from './secrets'
import {
  acceptsProposal, appendLearning, applyProposal, buildOutcome, createScorecard, openProposals, outcomeOf, planProposals, planReorder,
  readLearning, scoreTable, scorecardFile, type Scorecard
} from './scorecard'
import type { AppCtx, DispatchService } from './services'
import { quotaFromUsage, usageReport } from './usage'

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
    const w = quota[harness]
    return w?.length ? Math.max(...w.map((x) => x.usedPercent)) : undefined
  }

  const svc: DispatchService = {
    signals(project, opts = {}) {
      refresh()
      const ctx = getCtx()
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
        cheap: cheapGate({ worldAllows: cheapModelsAllowed(world), keySet, opencodeReady: opencode }),
        dial: world?.costDial ?? s.costDial,
        dialFromWorld: Boolean(world?.costDial),
        stats: scoreTable(scorecard().list()),
        rand: opts.preview ? undefined : Math.random,
        preview: opts.preview
      }
      return env
    },

    usagePercent: hottest,

    noteUsage(r: UsageReport) {
      quota = quotaFromUsage(r)
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
