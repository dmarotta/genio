/**
 * Dispatch service: the live signals the loadout picker needs (who is logged
 * in, plan quota, the cheap-model gate, unit caps), the scorecard itself, the
 * player's verdicts and the scorecard's proposals (scorecard.ts), which never
 * change a model without the player. Previews use a background cache; launches scan local evidence,
 * claim a provider reservation and recheck immediately before terminal creation.
 */
import { runtimeAccounts, type AccountStatus, type OpResult, type UsageReport } from '@shared/api'
import type { BacklogItem, Decision, Task, Verdict } from '@shared/types'
import { cheapModelsAllowed, type DispatchScoresView } from '@shared/dispatch'
import {
  isPlan, meterRows, planStatus, planStatuses, quotaWait, reconWords,
  type PlanStatus, type QuotaWait, type UsagePolicyView
} from '@shared/usage-mode'
import { unitCaps } from '@shared/unit-capacity'
import { bus } from './bus'
import { listAccounts } from './accounts'
import { resolveLoadout, cheapGate, type PickEnv, type QuotaWindow } from './loadout'
import { getSecret } from './secrets'
import {
  acceptsProposal, appendLearning, applyProposal, buildOutcome, createScorecard, openProposals, outcomeOf, planProposals,
  readLearning, scoreTable, scorecardFile, type Scorecard
} from './scorecard'
import type { AppCtx, DispatchService, HomeCtx } from './services'
import { claudeLimits, readClaudeLimits, quotaFromUsage, usageReport } from './usage'
import { expireWindow } from './quota-policy'
import { SessionQuotaPolicy } from './session-usage'
import { PolicyNotices, chatSettings, globalMode, holdsCapacity, liveUnits, worldUsage } from './usage-policy'
import { readJson } from './util'
import { claudeProbeError } from './claude-usage-probe'
import { codexSignedOut } from './codex-home'
import { settingsPath } from '@shared/settings-pages'
import { usageRefreshLoop } from './usage-refresh'
import { currentSignIns } from './sign-in-watch'
import { QuotaDeferredQueue } from './quota-deferred'

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
  const reservations = new Set<{ harness: string }>()
  /** launches per world that are reserved but not yet listed as tasks (they count against the caps) */
  const launching = new Set<{ project: string }>()
  let lastReport: UsageReport | undefined
  let lastPolicy = ''
  let watching = false
  let offSettings: (() => void) | undefined
  const unreadable = new Set<string>()

  const dataDir = (): string => getCtx().main.home.data
  const protection = (): boolean => getCtx().settings.get().quotaProtection !== false
  const scorecard = (): Scorecard => (card ??= createScorecard(scorecardFile(dataDir())))
  const homes = (): HomeCtx[] => [...getCtx().homes.values()]
  const alive = (t: Task): boolean => !!t.terminalId && !!getCtx().terminals.get(t.terminalId)?.alive
  const launchingCount = (project?: string): number =>
    project !== undefined ? [...launching].filter(launch => launch.project === project).length : launching.size
  const publishLaunching = (): void => {
    try { bus.publish({ type: 'pending-units', projects: svc.pendingUnits() }) } catch { /* UI observers must not leak a reservation. */ }
  }

  /** Claude evidence lives in a file every chat session writes; re-read it on every decision. */
  let claudeReadError: string | undefined
  const readClaude = (): ReturnType<typeof claudeLimits> => {
    try {
      const file = readClaudeLimits(dataDir())
      const stored = claudeLimits(file)
      claudeReadError = claudeProbeError(dataDir())
      if (file && !unreadable.has('claude') && !claudeReadError) quota.claude = stored?.windows ?? []
      if (unreadable.has('claude') || claudeReadError) quota.claude = []
      return stored
    } catch (error) {
      claudeReadError = `Could not read Claude usage: ${(error as Error).message}`
      quota.claude = []
      return undefined
    }
  }

  const plansNow = (): Record<'claude' | 'codex', PlanStatus> => {
    readClaude()
    const plans = planStatuses(quota)
    // A durable chat rejection (even one without a reported window) holds Claude like a rejected window.
    if (!unreadable.has('claude') && !claudeReadError && new SessionQuotaPolicy(dataDir()).unitBlocked() && plans.claude.level !== 'out') {
      const reset = new SessionQuotaPolicy(dataDir()).limitState().resetsAt
      plans.claude = { plan: 'claude', level: 'out', known: true, rejected: true, window: 'chat rejection', resetsAt: reset ? new Date(reset).toISOString() : undefined }
    }
    return plans
  }

  /** Codex counts as logged out whenever Genio's own Codex home is not signed in, even before the account list refreshes. */
  const loggedOut = (id: string): boolean => (id === 'codex' && codexSignedOut()) || logins.get(ACCOUNT_OF[id] ?? id) === 'logged-out'

  /** Plans automatic units can use on this machine: installed, enabled and not logged out. */
  const automaticPlans = (): PlanStatus[] => {
    const ready = new Set(getCtx().settings.availableHarnesses().map((h) => h.id))
    const plans = plansNow()
    return (['claude', 'codex'] as const).filter((id) => ready.has(id) && !loggedOut(id)).map((id) => plans[id])
  }

  const queued = (): BacklogItem[] =>
    homes().flatMap((h) => h.backlog.list()).filter((i) => (i.kind === 'ship' || i.kind === 'scout') && i.state === 'queued')

  /** Keep transition history for diagnostics; active protection is shown quietly in chat. */
  const transitions = (): void => {
    try {
      const low = queued().filter((i) => i.priority === 'low').length
      if (protection()) new PolicyNotices(dataDir()).observe(automaticPlans(), low)
    } catch {
      /* notices are advisory */
    }
  }

  /** Independent global setting plus any lower project capacity. Serialized with selection. */
  const capGate = (project: string, respawn = false): void => {
    const ctx = getCtx()
    const s = ctx.settings.get()
    const world = ctx.projects.get(project)
    const caps = unitCaps(s.unitsAtOnce, world)
    // A respawn has no quest to queue: the unit simply stays as it is.
    const after = respawn ? 'The unit was not respawned and stays as it is; respawn it when a slot frees up.' : 'The quest stays queued.'
    const used = liveUnits(homes(), alive) + launchingCount()
    if (used >= caps.global)
      throw new Error(`deferred: Units at once allows ${caps.global} concurrent unit${caps.global === 1 ? '' : 's'} across all projects (${used} running or launching). ${after}`)
    if (caps.world !== undefined) {
      const mine = liveUnits(homes(), alive, project) + launchingCount(project)
      if (mine >= caps.world) throw new Error(`deferred: ${project} allows ${caps.world} concurrent unit${caps.world === 1 ? '' : 's'} (${mine} running or launching). ${after}`)
    }
  }

  const cheapFor = (worldAllows: boolean): { allowed: boolean; why: string } => {
    const ctx = getCtx()
    let keySet = false
    try {
      keySet = Boolean(getSecret('openrouter', dataDir()))
    } catch {
      /* no OS encryption: no key */
    }
    const opencode = ctx.settings.availableHarnesses().some((h) => h.id === 'opencode')
    const gate = cheapGate({ worldAllows, keySet, opencodeReady: opencode })
    // A Usage mode never grants paid spend: that needs the explicit allowance.
    return gate.allowed && !ctx.settings.get().cheapSpendAllowed
      ? { allowed: false, why: `no paid-spend allowance for cheap models (${settingsPath('usage')})` }
      : gate
  }

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

  /** Protection holds a plan (never switches it): a chat rejection, or fresh 70%+ with a unit already running or reserved on it. */
  const unavailable = (id: string, own?: { harness: string }, replacing?: Task): boolean => {
    if (!protection()) return false
    const ctx = getCtx()
    return (id === 'claude' && !unreadable.has(id) && !claudeReadError && new SessionQuotaPolicy(dataDir()).unitBlocked()) ||
      // Fresh 70%+: at most one unit on that plan
      (isPlan(id) && planStatus(id, quota[id]).level !== 'ok' && ([...reservations].some(r => r !== own && r.harness === id) || [...ctx.homes.values()].some((h) =>
        h.crew.list().some((t) => !(replacing && t.id === replacing.id && t.wksp === replacing.wksp) && t.harness === id && holdsCapacity(t, alive(t))))))
  }

  const watcher = usageRefreshLoop(async () => {
    const report = await usageReport(getCtx())
    if (!watching) return true
    svc.noteUsage(report)
    // Retried operations still pass through normal caps, dependencies and permissions, with the loadout they asked for.
    for (const h of homes()) void h.crew.retryQuotaDeferred().catch(() => undefined)
    return !report.tools.some(t => t.error)
  }, () => queued().length > 0 || homes().some(h => h.crew.hasQuotaDeferred() || h.wakes.pending().length > 0) ||
    Object.values(plansNow()).some(p => p.level !== 'ok'))

  const svc: DispatchService = {
    start() {
      if (watching) return
      watching = true
      let enabled = protection()
      offSettings = bus.onEvent(event => {
        if (event.type !== 'settings' || (event.settings.quotaProtection !== false) === enabled) return
        enabled = event.settings.quotaProtection !== false
        for (const h of homes()) {
          h.supervisor?.poke(true)
          if (!enabled) void h.crew.retryQuotaDeferred().catch(() => undefined)
        }
      })
      watcher.start()
    },
    stop() { watching = false; watcher.stop(); offSettings?.(); offSettings = undefined },
    signals(project) {
      refresh()
      const ctx = getCtx()
      readClaude()
      const world = ctx.projects.get(project)
      const env: Omit<PickEnv, 'available'> = { loggedOut, quota, unavailable, cheap: cheapFor(cheapModelsAllowed(world)) }
      return env
    },

    reserve(input, opts = {}) {
      // The single main-process dispatcher owns selection + reservation. No await
      // separates the final policy evaluation (caps included) from claiming the slot.
      const result = launchQueue.then(async () => {
        const plans = plansNow()
        svc.noteUsage(await usageReport(getCtx(), { forceClaude: plans.claude.level !== 'ok', forceCodex: plans.codex.level !== 'ok' }))
        const replacing = opts.respawn ? getCtx().homes.get(opts.respawn.wksp)?.crew.get(opts.respawn.id) : undefined
        if (opts.respawn && (!replacing || replacing.project !== input.project)) throw new Error('Unknown respawn target')
        const occupies = !!replacing && holdsCapacity(replacing, alive(replacing))
        // Only a genuinely live/spawning replacement already owns a slot.
        if (!occupies) capGate(input.project, !!opts.respawn)
        const signals = { ...svc.signals(input.project), unavailable: (id: string) => unavailable(id, undefined, replacing) }
        const loadout = resolveLoadout(input, getCtx().settings, signals)
        const reservation = { harness: loadout.harness }
        reservations.add(reservation)
        let released = false
        const launch = { project: input.project }
        if (!occupies) {
          launching.add(launch)
          publishLaunching()
        }
        // Each reservation removes only its own pending slot. Listing and release
        // are independently idempotent, including deferred/failed respawns.
        const listed = (): void => {
          if (launching.delete(launch)) publishLaunching()
        }
        return {
          loadout,
          listed,
          async check() {
            if (released) throw new Error('Launch reservation was already released.')
            const plans = plansNow()
            svc.noteUsage(await usageReport(getCtx(), { forceClaude: plans.claude.level !== 'ok', forceCodex: plans.codex.level !== 'ok' }))
            const env = { ...svc.signals(input.project), unavailable: (id: string) => unavailable(id, reservation, replacing) }
            resolveLoadout({ ...input, harness: loadout.harness }, getCtx().settings, env)
          },
          release() { if (!released) { released = true; reservations.delete(reservation); listed() } }
        }
      })
      launchQueue = result.catch(() => undefined)
      return result
    },

    usagePercent: hottest,

    pendingUnits: () => [...launching].map(launch => launch.project),

    capacity() {
      return { cap: unitCaps(getCtx().settings.get().unitsAtOnce).global, used: liveUnits(homes(), alive) + launchingCount() }
    },

    quotaWait(item) {
      if (!protection()) return undefined
      if (item.kind !== 'ship' && item.kind !== 'scout') return undefined
      return quotaWait(item.priority, automaticPlans())
    },

    reportWords(project, harness) {
      const ctx = getCtx()
      const world = ctx.projects.get(project)
      return reconWords(worldUsage(ctx.settings.get(), world).mode, protection() && isPlan(harness) ? plansNow()[harness] : undefined)
    },

    view(): UsagePolicyView {
      refresh()
      const ctx = getCtx()
      const s = ctx.settings.get()
      const claude = readClaude()
      transitions()
      const plans = plansNow()
      // Use the same durable queue that retries launches, including after a restart.
      const heldLaunches: UsagePolicyView['heldLaunches'] = []
      const pendingQuests = new Set(queued().filter(q => !q.hold).map(q => q.id))
      if (protection()) for (const h of homes()) {
        if (!h.home?.data) continue
        for (const entry of new QuotaDeferredQueue(h.home.data).list()) {
          const launch = entry.kind === 'spawn' ? entry.request : h.crew.get(entry.id)
          const plan = launch?.harness
          if (launch && plan && isPlan(plan) && plans[plan].level !== 'ok')
            heldLaunches.push({ project: launch.project, title: launch.title, plan })
        }
        // Plan steps retry through plans.drain(), rather than the standalone launch queue.
        for (const work of h.plans?.list() ?? []) if (work.state === 'active') {
          for (const step of work.steps) {
            const plan = step.harness
            if (plan && isPlan(plan) && plans[plan].level !== 'ok' && pendingQuests.has(step.questId) &&
              /quota protection/i.test(step.lastAttempt?.message ?? ''))
              heldLaunches.push({ project: work.world, title: step.title, plan })
          }
        }
      }
      const mode = globalMode(s)
      const codex = lastReport?.tools.find((t) => t.tool === 'codex')
      const meterReport = {
        tools: [
          { tool: 'claude', limits: claude ? [claude] : [], error: claudeReadError, note: 'Current Claude usage unknown; ordinary dispatch is allowed with quota unverified.' },
          codex ? { ...codex, limits: codex.limits.map((l) => ({ ...l, windows: l.windows.map((w) => expireWindow(w)) })) }
            : { tool: 'codex', limits: [], note: lastReport ? undefined : 'Reading Codex session logs…' }
        ]
      }
      const waiting: UsagePolicyView['waiting'] = []
      for (const i of queued()) {
        const wait = svc.quotaWait(i)
        if (wait) waiting.push({ id: i.id, title: i.title, wait })
      }
      return {
        generatedAt: new Date().toISOString(),
        mode,
        quotaProtection: protection(),
        heldLaunches,
        chat: (({ wkspModel, wkspEffort }) => ({ model: wkspModel, effort: wkspEffort }))(chatSettings(s, currentSignIns())),
        units: { defaultHarness: s.defaultHarness, model: s.defaultWorkerModel || undefined, effort: s.defaultWorkerEffort || undefined },
        unitCap: svc.capacity().cap,
        liveUnits: svc.capacity().used,
        worlds: ctx.projects.list().map((p) => {
          const u = worldUsage(s, p)
          return { ...u, cap: unitCaps(s.unitsAtOnce, p).world }
        }),
        plans: [plans.claude, plans.codex],
        // Codex not signed in: nothing to show for it (the Accounts row says Sign in).
        meter: meterRows(meterReport).filter((r) => r.plan !== 'codex' || !codexSignedOut()),
        notices: new PolicyNotices(dataDir()).list().slice(0, 10),
        waiting,
        cheap: cheapFor(true)
      }
    },

    noteUsage(r: UsageReport) {
      const observed = quotaFromUsage(r)
      // Keep diagnostic history in the meter, but unavailable sources cannot hold work.
      for (const t of r.tools) {
        if (t.error) { unreadable.add(t.tool); quota[t.tool] = [] }
        else unreadable.delete(t.tool)
      }
      for (const t of r.tools) quota[t.tool] = unreadable.has(t.tool) ? [] : observed[t.tool] ?? []
      quotaAt = Date.now()
      const prev = lastReport
      lastReport = { ...r, tools: r.tools.map((t) => (t.limits.length || !prev ? t : { ...t, limits: prev.tools.find((x) => x.tool === t.tool)?.limits ?? [] })) }
      transitions()
      // A Settings scan also re-evaluates supervision; the background loop does not need a window.
      const policy = Object.values(plansNow()).map(p => `${p.level}:${p.known}`).join('|')
      if (policy !== lastPolicy) {
        lastPolicy = policy
        for (const h of homes()) h.supervisor?.poke(true)
      }
    },

    noteLogins(list: AccountStatus[]) {
      // Codex units run in Genio's own home once it is signed in: that login is the one that counts.
      logins = new Map(runtimeAccounts(list).filter((a) => a.installed).map((a) => [a.tool, a.state]))
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
      // The scorecard never changes a model by itself: it only proposes a change to the player's own rows and rules.
      const ctx = getCtx()
      const rows = scoreTable(scorecard().list())
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
