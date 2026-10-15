/**
 * Smart dispatch service: the live signals the loadout picker needs (who is
 * logged in, plan quota, the cheap-model gate, the Usage mode and unit caps, scorecard
 * scores), the scorecard itself, the player's verdicts and the learning loop
 * (scorecard.ts). Previews use a background cache; launches scan local evidence,
 * claim a provider reservation and recheck immediately before terminal creation.
 */
import { runtimeAccounts, type AccountStatus, type OpResult, type UsageReport } from '@shared/api'
import type { BacklogItem, Decision, Task, Verdict } from '@shared/types'
import { cheapModelsAllowed, type DispatchScoresView } from '@shared/dispatch'
import {
  MODE_PRESETS, SONNET, USAGE_MODE_LABEL, isPlan, meterRows, planStatus, planStatuses, quotaWait, reconWords, resolveChat, unitCaps,
  type PlanStatus, type QuotaWait, type UsagePolicyView
} from '@shared/usage-mode'
import { bus } from './bus'
import { listAccounts } from './accounts'
import { resolveLoadout, cheapGate, type PickEnv, type QuotaWindow } from './loadout'
import { getSecret } from './secrets'
import {
  acceptsProposal, appendLearning, applyProposal, buildOutcome, createScorecard, openProposals, outcomeOf, planProposals, planReorder,
  readLearning, scoreTable, scorecardFile, type Scorecard
} from './scorecard'
import type { AppCtx, DispatchService, HomeCtx } from './services'
import { claudeLimits, readClaudeLimits, quotaFromUsage, usageReport } from './usage'
import { expireWindow, explorationSafe } from './quota-policy'
import { SessionQuotaPolicy } from './session-usage'
import { PolicyNotices, claudeStatus, globalMode, holdsCapacity, liveUnits, worldUsage } from './usage-policy'
import { readJson } from './util'
import { claudeProbeError } from './claude-usage-probe'

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
  /** launches per world that are reserved but not yet listed as tasks (they count against the caps) */
  const launching = new Set<{ project: string }>()
  let lastReport: UsageReport | undefined

  const dataDir = (): string => getCtx().main.home.data
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
      if (file) quota.claude = stored?.windows ?? []
      return stored
    } catch (error) {
      claudeReadError = `Could not read Claude usage: ${(error as Error).message}`
      return undefined // retained history expires on its original observation clock
    }
  }

  const plansNow = (): Record<'claude' | 'codex', PlanStatus> => {
    readClaude()
    const plans = planStatuses(quota)
    // A durable chat rejection (even one without a reported window) holds Claude like a rejected window.
    if (new SessionQuotaPolicy(dataDir()).unitBlocked() && plans.claude.level !== 'out') {
      const reset = new SessionQuotaPolicy(dataDir()).limitState().resetsAt
      plans.claude = { plan: 'claude', level: 'out', known: true, rejected: true, window: 'chat rejection', resetsAt: reset ? new Date(reset).toISOString() : undefined }
    }
    return plans
  }

  /** Plans automatic units can use on this machine: installed, enabled and not logged out. */
  const automaticPlans = (): PlanStatus[] => {
    const ready = new Set(getCtx().settings.availableHarnesses().map((h) => h.id))
    const plans = plansNow()
    return (['claude', 'codex'] as const).filter((id) => ready.has(id) && logins.get(id) !== 'logged-out').map((id) => plans[id])
  }

  const queued = (): BacklogItem[] =>
    homes().flatMap((h) => h.backlog.list()).filter((i) => (i.kind === 'ship' || i.kind === 'scout') && i.state === 'queued')

  /** One notice per policy transition (toast + Systems → Usage, with cause and evidence age). */
  const transitions = (): void => {
    try {
      const low = queued().filter((i) => i.priority === 'low').length
      for (const n of new PolicyNotices(dataDir()).observe(automaticPlans(), low)) bus.toast(n.to === 'ok' ? 'info' : 'warn', n.text, n.details)
    } catch {
      /* notices are advisory */
    }
  }

  /** Global cap from the global mode, plus any lower cap of this world. Serialized with selection. */
  const capGate = (project: string, respawn = false): void => {
    const ctx = getCtx()
    const s = ctx.settings.get()
    const world = ctx.projects.get(project)
    const own = world ? worldUsage(s, world) : undefined
    const caps = unitCaps(globalMode(s), { mode: own && own.source !== 'global' ? own.mode : undefined, capacity: world?.capacity })
    // A respawn has no quest to queue: the unit simply stays as it is.
    const after = respawn ? 'The unit was not respawned and stays as it is; respawn it when a slot frees up.' : 'The quest stays queued.'
    const used = liveUnits(homes(), alive) + launchingCount()
    if (used >= caps.global)
      throw new Error(`deferred: the ${USAGE_MODE_LABEL[globalMode(s)]} usage mode allows ${caps.global} concurrent unit${caps.global === 1 ? '' : 's'} across all projects (${used} running or launching). ${after}`)
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
      ? { allowed: false, why: 'no paid-spend allowance for cheap models (Settings → Usage → Advanced)' }
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

  const unavailable = (id: string, own?: string, replacing?: Task): boolean => {
    const ctx = getCtx()
    return (id !== own && reservations.has(id)) || (id === 'claude' && new SessionQuotaPolicy(dataDir()).unitBlocked()) ||
      // Fresh 70%+: at most one unit on that plan
      (isPlan(id) && planStatus(id, quota[id]).level !== 'ok' && [...ctx.homes.values()].some((h) =>
        h.crew.list().some((t) => !(replacing && t.id === replacing.id && t.wksp === replacing.wksp) && t.harness === id && holdsCapacity(t, alive(t)))))
  }

  const svc: DispatchService = {
    signals(project, opts = {}) {
      refresh()
      const ctx = getCtx()
      readClaude()
      const s = ctx.settings.get()
      const world = ctx.projects.get(project)
      const usage = worldUsage(s, world ? { ...world, name: world.name ?? project } : undefined)
      const env: Omit<PickEnv, 'available'> = {
        loggedOut: (id) => logins.get(ACCOUNT_OF[id] ?? id) === 'logged-out',
        quota,
        unavailable,
        cheap: cheapFor(cheapModelsAllowed(world)),
        mode: usage.mode,
        modeFromWorld: usage.source !== 'global',
        dial: world?.costDial ?? MODE_PRESETS[usage.mode].dial,
        dialFromWorld: Boolean(world?.costDial),
        stats: scoreTable(scorecard().list()),
        rand: opts.preview ? undefined : Math.random,
        preview: opts.preview
      }
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
        const primary = loadout.explored ? resolveLoadout(input, getCtx().settings, { ...signals, preview: true }).harness : undefined
        reservations.add(loadout.harness)
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
            const env = { ...svc.signals(input.project), unavailable: (id: string) => unavailable(id, loadout.harness, replacing) }
            resolveLoadout({ ...input, harness: loadout.harness }, getCtx().settings, env)
            if (loadout.explored) {
              if (!explorationSafe(env.quota?.[primary!]) || !explorationSafe(env.quota?.[loadout.harness]))
                throw new Error('deferred: exploration no longer has fresh headroom on both plans.')
            }
          },
          release() { if (!released) { released = true; reservations.delete(loadout.harness); listed() } }
        }
      })
      launchQueue = result.catch(() => undefined)
      return result
    },

    usagePercent: hottest,

    pendingUnits: () => [...launching].map(launch => launch.project),

    capacity() {
      return { cap: MODE_PRESETS[globalMode(getCtx().settings.get())].unitCap, used: liveUnits(homes(), alive) + launchingCount() }
    },

    quotaWait(item) {
      if (item.kind !== 'ship' && item.kind !== 'scout') return undefined
      return quotaWait(item.priority, automaticPlans())
    },

    reportWords(project, harness) {
      const ctx = getCtx()
      const world = ctx.projects.get(project)
      return reconWords(worldUsage(ctx.settings.get(), world).mode, isPlan(harness) ? plansNow()[harness] : undefined)
    },

    view(): UsagePolicyView {
      refresh()
      const ctx = getCtx()
      const s = ctx.settings.get()
      const claude = readClaude()
      transitions()
      const plans = plansNow()
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
        chat: resolveChat(mode, { model: s.wkspModel, effort: s.wkspEffort }, plans.claude),
        bot: { model: s.botModel?.trim() || SONNET, pinned: Boolean(s.botModel?.trim()) },
        units: { defaultHarness: s.defaultHarness, model: s.defaultWorkerModel || undefined, effort: s.defaultWorkerEffort || undefined },
        unitCap: MODE_PRESETS[mode].unitCap,
        liveUnits: svc.capacity().used,
        worlds: ctx.projects.list().map((p) => {
          const u = worldUsage(s, p)
          return { ...u, cap: unitCaps(mode, { mode: u.source !== 'global' ? u.mode : undefined, capacity: p.capacity }).world }
        }),
        plans: [plans.claude, plans.codex],
        meter: meterRows(meterReport),
        notices: new PolicyNotices(dataDir()).list().slice(0, 10),
        waiting,
        cheap: cheapFor(true)
      }
    },

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
      const prev = lastReport
      lastReport = { ...r, tools: r.tools.map((t) => (t.limits.length || !prev ? t : { ...t, limits: prev.tools.find((x) => x.tool === t.tool)?.limits ?? [] })) }
      transitions()
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

    outcomes: () => scorecard().list(),

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
