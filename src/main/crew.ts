/**
 * The Squad: unit lifecycle for one base (companion fm-spawn, ag-send,
 * fm-control, fm-teardown, fm-pr-merge, fm-merge-local, fm-promote,
 * fm-crew-state, fm-fleet-view).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DeliveryMode, LoadoutInput, Project, StatusEvent, Task, TaskCounters, TaskState, TerminalInfo } from '@shared/types'
import type { OpResult, SpawnRequest, TaskFile } from '@shared/api'
import type { AppCtx, CrewService } from './services'
import { placeWorktree, type Home } from './home'
import { bus } from './bus'
import * as git from './git'
import { appendProgressNote, doorbellLine, engineHints, kickoffPrompt, renderBrief } from './brief'
import { holdsCapacity } from './usage-policy'
import { buildArgs, CLAUDE_BYPASS_DIALOG } from './harness'
import { discoverCodexSession } from './codex-session'
import { claudeLaunch, claudeTrustFiles, playerSkipsBypassPrompt, setClaudeTrust, UNIT_UNSET_ENV } from './claude-home'
import { scheduleUnitArchive, unarchiveCodexThread } from './codex-archive'
import { codexLaunch, genioCodexHome, setCodexTrust } from './codex-home'
import { foldOpenDecisions, formatStatusLine, parseStatusLine, parseStatusLog } from './status'
import { createGauntlet } from './gauntlet'
import { relaunchPolicy } from './relaunch-policy'
import { approvalModel, unitModel, UNIT_MODEL_APPROVAL_REASON } from '@shared/unit-model-policy'
import { modeLabel } from '@shared/vocab'
import { DONE_STATES, squadOutcome } from '@shared/squad-display'
import { cheapModelsAllowed } from '@shared/dispatch'
import { questOrder } from '@shared/quest-board'
import { effectiveEngine } from '@shared/engine'
import { engineBriefLine, engineEnv, engineFacts } from '@shared/engine-summary'
import { getSecret } from './secrets'
import { installUnitHooks } from './unithooks'
import { installUnityShims, unityGuardScript, unityPreToolHook } from './unity-guards'
import { installUnitPlugin, openRouterEnv, unitLaunchExtras, unitPluginDir, unitPluginSource, unitToolsBrief } from './unitskills'
import { findUnityCli, unityUnitConfig, unityUnitEnv } from './unity-unit'
import {
  appendLine, ensureDir, exists, fwd, nowIso, readJson, readText, rid, slugify, stripAnsi, truncate, writeJson, writeText
} from './util'

/** States with an expected live process. */
const ACTIVE: TaskState[] = ['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'stale', 'validating']
/** States that end a mission's work (process may still be around). */
const FINISHED: TaskState[] = ['ready', 'merged', 'done', 'failed', 'cleaned']
/** States that put an outcome on the dispatch scorecard (a later end replaces an earlier one). */
const ENDED: TaskState[] = ['merged', 'done', 'failed', 'cleaned']

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createCrewService(getCtx: () => AppCtx, home: Home): CrewService {
  let tasks: Task[] = readJson<Task[]>(home.tasksFile, [])
  // Preserve a legacy ready signal before restart bookkeeping updates timestamps.
  let readyMigrated = false
  for (const task of tasks) {
    if (task.state === 'ready' && !task.readyAt) {
      task.readyAt = task.lastStatusAt ?? task.updatedAt
      readyMigrated = true
    }
  }
  if (readyMigrated) writeJson(home.tasksFile, tasks)
  for (const task of tasks) if (task.storageRoot) home.setTaskStorage(task.id, task.storageRoot)
  const gauntlet = createGauntlet(getCtx, home)
  const inboxDir = (id: string): string => home.taskStateFile(id, '.inbox')
  const turnEndedFile = (id: string): string => home.taskStateFile(id, '.turn-ended')
  const bypassWarned = new Set<string>()
  const controlling = new Set<string>()
  const restarting = new Set<string>()

  const persist = (): void => writeJson(home.tasksFile, tasks)
  const hc = () => getCtx().home(home.name)
  const safe = (fn: () => void): void => {
    try {
      fn()
    } catch {
      /* optional collaborators never break the engine */
    }
  }
  const ledger = (event: Parameters<AppCtx['ledger']['record']>[0]['event'], t: Task, data?: Record<string, unknown>): void =>
    safe(() => getCtx().ledger.record({ event, task: t.id, project: t.project, home: home.name, data }))

  const withLive = (t: Task): Task => {
    if (!t.terminalId) return t
    const at = getCtx().terminals.lastOutputAt(t.terminalId)
    return at ? { ...t, lastOutputAt: new Date(at).toISOString() } : t
  }

  const get = (id: string): Task | undefined => tasks.find((t) => t.id === id)
  const must = (id: string): Task => {
    const t = get(id)
    if (!t) throw new Error(`Unknown unit: ${id}`)
    return t
  }

  const update = (id: string, patch: Partial<Task>): Task | undefined => {
    const i = tasks.findIndex((t) => t.id === id)
    if (i < 0) return undefined
    const prev = tasks[i]
    const next: Task = { ...prev, ...patch, updatedAt: nowIso() }
    if (patch.state === 'ready') next.readyAt = next.updatedAt
    // Squad history: stamp the first finish (a landing re-stamps it); a respawn makes the unit active again.
    const wasDone = DONE_STATES.includes(prev.state), isDone = DONE_STATES.includes(next.state)
    if (isDone && (!wasDone || (next.state === 'merged' && prev.outcome !== 'merged'))) {
      next.finishedAt = next.updatedAt
      next.outcome = squadOutcome({ ...next, outcome: undefined })
    } else if (!isDone && wasDone) {
      delete next.finishedAt
      delete next.outcome
    }
    tasks[i] = next
    persist()
    bus.publish({ type: 'task', task: withLive(next) })
    if (patch.state && patch.state !== prev.state) {
      ledger('task.status', next, { state: patch.state, reason: patch.stateReason })
      // scorecard: a unit that never launched says nothing about its tool
      const launched = Boolean(prev.terminalId || next.terminalId || next.relaunches)
      if (ENDED.includes(next.state) && (next.state !== 'failed' || launched)) safe(() => getCtx().dispatch.record(next))
      // the quest follows its unit: landed, delivered or despawned closes it
      if (next.backlogId) safe(() => hc().backlog.followUnit(next))
    }
    return next
  }

  /** Rework signals for the scorecard. */
  const bump = (id: string, k: keyof TaskCounters): void => {
    const t = get(id)
    if (!t) return
    const c = t.counters ?? { pings: 0, lagging: 0, stopped: 0, fixRounds: 0 }
    update(id, { counters: { ...c, [k]: c[k] + 1 } })
  }

  const terminalAlive = (t: Task): boolean => Boolean(t.terminalId && getCtx().terminals.get(t.terminalId)?.alive)

  const uniqueId = (title: string): string => {
    for (;;) {
      const id = `${slugify(title, 40)}-${rid(2)}`.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 64)
      if (!get(id) && !exists(home.taskDir(id))) return id
    }
  }

  /** Per-task git hooks dir that chains the world's own hooks, strips AI trailers and adds Genio's. */
  const writeHooks = (t: Task, repo: string): Promise<Record<string, string>> =>
    installUnitHooks(home.taskStateFile(t.id, '.git-hooks'), repo, getCtx().settings.get())

  /** Bundled unit skills live in the main base, outside every world. */
  const mainHome = home.parent ?? home
  const pluginDir = unitPluginDir(mainHome.root)
  const toolsBrief = (): string => unitToolsBrief(pluginDir)

  /** Launch additions for unit skills; a missing install or key never blocks a launch. */
  const skillExtras = (t: Task, harnessId: string, worldPath?: string): ReturnType<typeof unitLaunchExtras> => {
    let installed: string | undefined
    try {
      installed = installUnitPlugin(unitPluginSource(getCtx().appRoot), pluginDir, [t.worktree, worldPath ?? ''])
    } catch {
      /* launch without the skills */
    }
    let falKey: string | undefined
    try {
      falKey = getSecret('fal', mainHome.data)
    } catch {
      /* no OS encryption: the skill reports the key as missing */
    }
    const extras = unitLaunchExtras(harnessId, { pluginDir: installed, falKey, dataDir: mainHome.data, taskDataDir: home.taskDir(t.id) })
    const project = getCtx().projects.get(t.project)
    Object.assign(extras.env, project ? engineEnv(project) : {})
    // genio-unity shares the player's Play pool; the unit sees only its own targets.
    const unity = unityUnitConfig(project, { task: t.id, worktree: t.worktree, data: mainHome.data, taskDir: home.taskDir(t.id), cli: findUnityCli() })
    if (unity) {
      const file = home.taskStateFile(t.id, '.unity.json')
      try {
        writeJson(file, unity)
        Object.assign(extras.env, unityUnitEnv(unity, file))
      } catch {
        /* launch below requires this config for a Unity project */
      }
    }
    return extras
  }

  const writeClaudeSettings = (t: Task, guard?: string): string => {
    const p = home.taskStateFile(t.id, '.claude-settings.json')
    const marker = fwd(turnEndedFile(t.id))
    const command = `node -e "require('fs').writeFileSync('${marker}', String(Date.now()))"`
    // Genio's Claude home has no user settings of its own: carry over only the
    // player's existing bypass consent. Genio never answers that dialog itself.
    writeJson(p, { ...(playerSkipsBypassPrompt() ? { skipDangerousModePermissionPrompt: true } : {}),
      hooks: { Stop: [{ hooks: [{ type: 'command', command }] }], ...(guard ? { PreToolUse: [unityPreToolHook(guard)] } : {}) } })
    return p
  }

  /** Watch early output: answer trust dialogs, flag the bypass dialog. */
  const watchConsent = (t: Task, terminalId: string, trust: string[], response: string, isClaude: boolean): void => {
    const terms = getCtx().terminals
    // TUIs position text with cursor moves, so stripped output often loses its
    // spaces: match on whitespace-free, lower-cased text.
    const squash = (x: string): string => x.replace(/\s+/g, '').toLowerCase()
    const patterns = trust.map(squash).filter(Boolean)
    let tail = ''
    let answered = 0
    let lastAnswer = 0
    const off = terms.onData(terminalId, (d) => {
      tail = (tail + squash(stripAnsi(d))).slice(-4000)
      if (isClaude && CLAUDE_BYPASS_DIALOG.test(tail) && !bypassWarned.has(t.id)) {
        bypassWarned.add(t.id)
        safe(() =>
          hc().decisions.openForTask(
            t.id,
            'bypass-consent',
            `Claude Code needs a one-time acceptance of its bypass-permissions mode before unit ${t.id} can work. Open the unit's terminal in SQUAD and accept it, or switch the Claude permission mode to "auto" in SYSTEMS and respawn.`,
            'system',
            { project: t.project, options: ['I accepted it in the terminal', 'Switch to auto mode'] }
          )
        )
        return
      }
      if (answered < 3 && Date.now() - lastAnswer > 2000 && patterns.some((p) => tail.includes(p))) {
        answered++
        lastAnswer = Date.now()
        // Newer Claude Code pre-selects "No, exit": move to the "Yes" option first.
        const noFirst = /[❯>]no,?exit/.test(tail) && tail.indexOf('no,exit') < tail.lastIndexOf('yes')
        tail = ''
        setTimeout(() => {
          if (noFirst) {
            terms.write(terminalId, '[B')
            setTimeout(() => terms.write(terminalId, response), 250)
          } else {
            terms.write(terminalId, response)
          }
        }, 300)
      }
    })
    setTimeout(off, 90_000)
  }

  const launch = async (t: Task, opts: { resume: boolean; prompt: string; check(): Promise<void>; prepare?(): Promise<void> }): Promise<TerminalInfo> => {
    const ctx = getCtx()
    const s = ctx.settings.get()
    const adapter = ctx.settings.harness(t.harness)
    if (!adapter) throw new Error(`Unknown unit runtime "${t.harness}". Pick one in SYSTEMS › Runtimes.`)
    if (!adapter.enabled) throw new Error(`Unit runtime "${adapter.name}" is disabled.`)
    const model = unitModel(t.harness, t.model)
    if ((t.harness === 'codex' || t.harness === 'claude') && !adapter.modelArgs?.some(arg => arg.includes('{model}'))) {
      throw new Error(`Unit runtime "${adapter.name}" must pass an explicit model; restore its model arguments in SYSTEMS.`)
    }
    if (approvalModel(model)) {
      await opts.check()
      // Always the player-facing broker, never chat shell mode, a tool argument,
      // a persisted pin or a previous launch's consent. No reusable grant exists.
      const allowed = await ctx.permissions.ask({ wksp: home.name, tool: 'unit launch',
        input: `${opts.resume ? 'Respawn' : 'Deploy'} ${t.kind === 'ship' ? 'Build' : 'Recon'} ${t.id}: ${t.title}\nWorld: ${t.project}\nRuntime: ${t.harness}\nModel: ${model}\nEffort: ${t.effort ?? 'default'}`,
        reason: UNIT_MODEL_APPROVAL_REASON })
      if (!allowed) throw new Error(`Launch refused: explicit approval for ${model} was denied or expired.`)
    }
    const current = get(t.id)
    if (!current || current.state === 'cleaned' || current.harness !== t.harness || current.model !== t.model || current.effort !== t.effort || current.kind !== t.kind) {
      throw new Error('Launch changed while awaiting approval; retry with the current loadout.')
    }
    await opts.check()
    await opts.prepare?.()
    if (model !== t.model) update(t.id, { model })
    const project = ctx.projects.get(t.project)
    const isClaude = adapter.id === 'claude'
    // Genio's own Claude home keeps units out of the player's Claude apps; --continue follows the unit's conversation.
    const claude = isClaude ? await claudeLaunch(opts.resume ? { cwd: t.worktree } : undefined) : undefined
    if (claude) setClaudeTrust(claude.configFile, [t.worktree], true)
    const skills = skillExtras(t, adapter.id, project?.path)
    const unityProject = project && effectiveEngine(project).engine === 'unity'
    const guard = unityProject ? unityGuardScript(pluginDir) : undefined
    if (unityProject && (!skills.env.GENIO_UNITY_CONFIG || !skills.env.GENIO_UNITY)) throw new Error('Unity units require the installed genio-unity wrapper and guard config.')
    const shimEnv = guard ? installUnityShims(path.join(home.taskDir(t.id), 'unit-bin'), skills.env.GENIO_UNITY, guard,
      adapter.env?.PATH ?? adapter.env?.Path ?? process.env.PATH ?? process.env.Path ?? '') : {}
    const settingsPath = isClaude ? writeClaudeSettings(t, guard) : undefined
    // Genio's own Codex home keeps units (and any Codex image run inside a unit) out of the player's Codex app.
    // A runtime with its own CODEX_HOME keeps it; a resume follows the unit's thread.
    const isCodex = adapter.id === 'codex'
    const codex = adapter.env?.CODEX_HOME ? undefined
      : await codexLaunch({ resume: isCodex && opts.resume ? { cwd: t.worktree, home: t.codexHome } : undefined, visible: isCodex })
    const codexHome = adapter.env?.CODEX_HOME ?? codex?.codexHome
    if (isCodex && codex?.isolated) setCodexTrust(codex.codexHome, [t.worktree, project?.path ?? ''], true)
    let sessionId = opts.resume && isCodex ? await discoverCodexSession(t.worktree, codexHome, t.codexSessionId) : undefined
    // Codex refuses to resume an archived thread; one it will not restore starts fresh instead.
    if (sessionId && !(await unarchiveCodexThread(sessionId, { dataDir: mainHome.data, codexHome, task: t.id, cwd: t.worktree }))) sessionId = undefined
    if (isCodex) update(t.id, { codexHome, ...(opts.resume ? { codexSessionId: sessionId } : {}) })
    const args = [
      ...skills.args,
      ...buildArgs(adapter, { model, effort: t.effort, prompt: opts.prompt, cwd: t.worktree, settings: settingsPath, resume: opts.resume, sessionId }, s)
    ]
    const hookEnv = project ? await writeHooks(t, project.path) : {}
    let openRouterKey: string | undefined
    if (adapter.id === 'opencode' && cheapModelsAllowed(project)) {
      try {
        openRouterKey = getSecret('openrouter', mainHome.data)
      } catch {
        /* no OS encryption: no key */
      }
    }
    const env: Record<string, string> = {
      ...(claude?.env ?? {}),
      ...(codex?.env ?? {}),
      ...(adapter.env ?? {}),
      ...hookEnv,
      ...skills.env,
      ...shimEnv,
      ...openRouterEnv(adapter.id, cheapModelsAllowed(project), openRouterKey),
      GENIO_TASK_ID: t.id,
      GENIO_STATUS_FILE: fwd(home.statusFile(t.id)),
      GENIO_TASK_INBOX: fwd(inboxDir(t.id)),
      GENIO_BRIEF: fwd(t.briefPath)
    }
    await opts.check()
    const term = ctx.terminals.create({ kind: 'worker', title: t.id, cwd: t.worktree, file: adapter.command, args, env, taskId: t.id,
      unsetEnv: isClaude ? UNIT_UNSET_ENV : undefined })
    if (!term.alive) throw new Error(`Could not start ${adapter.name} (${adapter.command}). Is it installed? Check SYSTEMS.`)
    watchConsent(t, term.id, adapter.trustPatterns, adapter.trustResponse, isClaude)
    ctx.terminals.onExit(term.id, (code) => {
      const cur = get(t.id)
      if (!cur || cur.terminalId !== term.id) return
      if (restarting.has(t.id)) return // replacement keeps its reserved slot during recall
      if (ACTIVE.includes(cur.state)) {
        update(t.id, { state: 'exited', stateReason: `unit process exited (code ${code}) without a final status` })
        bump(t.id, 'stopped')
      }
    })
    if (adapter.promptDelivery === 'type') {
      // wait for the TUI to settle, then type the kickoff
      void (async () => {
        const start = Date.now()
        while (Date.now() - start < 20_000) {
          await sleep(1000)
          const last = ctx.terminals.lastOutputAt(term.id) ?? 0
          if (last && Date.now() - last > 2500) break
        }
        await ctx.terminals.submit(term.id, opts.prompt, adapter.submitKey)
      })()
    }
    return term
  }

  const resolveKeysFor = (id: string): string[] => [...foldOpenDecisions(svc.statusEvents(id)).keys()]

  const nextSeq = (id: string): number => {
    const dir = inboxDir(id)
    let max = 0
    for (const d of [dir, path.join(dir, 'handled')]) {
      try {
        for (const f of fs.readdirSync(d)) {
          const m = f.match(/^(\d+)\.msg$/)
          if (m) max = Math.max(max, parseInt(m[1], 10))
        }
      } catch {
        /* missing dir */
      }
    }
    return max + 1
  }

  const applyStatus = (t: Task, e: StatusEvent): void => {
    const ctx = getCtx()
    const decisions = hc().decisions
    const cur = get(t.id) ?? t
    const late = FINISHED.includes(cur.state) && cur.state !== 'failed'
    switch (e.kind) {
      case 'working':
        if (!late && cur.state !== 'validating') update(t.id, { state: 'working', stateReason: e.text })
        break
      case 'needs-decision':
      case 'blocked':
        safe(() =>
          decisions.openForTask(t.id, e.key ?? 'default', e.text || (e.kind === 'blocked' ? 'The unit is blocked.' : 'The unit needs a choice.'), 'unit', {
            project: t.project,
            context: e.kind === 'blocked' ? 'blocked' : undefined,
            ...(e.fields.choice ? JSON.parse(e.fields.choice) : {})
          })
        )
        update(t.id, { state: e.kind, stateReason: e.text })
        break
      case 'paused':
        if (!late) update(t.id, { state: 'paused', stateReason: e.fields.until ? `${e.text} (until ${e.fields.until})` : e.text })
        break
      case 'resolved':
      case 'player-held': {
        safe(() => decisions.resolveKey(t.id, e.key ?? 'default', e.text))
        const stillOpen = resolveKeysFor(t.id)
        if (!stillOpen.length && (cur.state === 'needs-decision' || cur.state === 'blocked')) {
          update(t.id, { state: e.kind === 'player-held' ? 'paused' : 'working', stateReason: e.text })
        }
        break
      }
      case 'done': {
        // A completed turn ends the recovery streak; progress notes alone do not.
        update(t.id, { automaticRelaunches: 0 })
        if (t.kind === 'scout') {
          update(t.id, { state: 'done', stateReason: e.text })
          safe(() => ctx.stats.award('scout', t.id))
          safe(() => ctx.notifier.sfx('ready'))
          break
        }
        if (e.fields.pr) {
          // PR lookup is asynchronous. Persist the completed-work wait now so
          // startup cannot mistake this replayed outcome for a detached unit.
          update(t.id, { state: 'paused', stateReason: `Completion reported; refreshing PR status: ${e.fields.pr}` })
          void svc.registerPr(t.id, e.fields.pr)
          break
        }
        const mode: DeliveryMode = t.mode ?? 'no-mistakes'
        if (mode === 'local-only') {
          update(t.id, { state: 'ready', stateReason: e.text })
          ledger('task.pr_ready', t, { branch: e.fields.branch ?? t.branch })
          safe(() => ctx.stats.award('ship', t.id))
          safe(() => ctx.notifier.sfx('ready'))
        } else if (mode === 'no-mistakes') {
          update(t.id, { state: 'validating', stateReason: 'Gauntlet starting' })
          void gauntlet.run(t.id).then(r => {
            if (!r.ok && svc.get(t.id)?.state === 'validating' && !gauntlet.running(t.id)) {
              update(t.id, { state: 'blocked', stateReason: r.message })
            }
          }).catch(e => {
            update(t.id, { state: 'blocked', stateReason: `Gauntlet error: ${(e as Error).message}` })
          })
        } else {
          update(t.id, { state: 'paused', stateReason: 'Completion reported; checking for a PR' })
          void (async () => {
            const url = await ctx.forge.findPrForBranch(t.worktree, t.branch).catch(() => undefined)
            if (url) await svc.registerPr(t.id, url)
            else update(t.id, { state: 'blocked', stateReason: 'declared done without a PR url; ask the unit for the full PR link' })
          })()
        }
        break
      }
      case 'failed':
        update(t.id, { state: 'failed', stateReason: e.text })
        safe(() => ctx.notifier.sfx('error'))
        break
      case 'unknown':
        if (e.fields.pr) void svc.registerPr(t.id, e.fields.pr)
        break
      default:
        break
    }
  }

  const svc: CrewService = {
    list: () => tasks.map(withLive),
    get: (id) => {
      const t = get(id)
      return t ? withLive(t) : undefined
    },
    update,
    bump,

    async spawn(req: SpawnRequest): Promise<Task> {
      const ctx = getCtx()
      const s = ctx.settings.get()
      const project = ctx.projects.get(req.project)
      if (!project) throw new Error(`Unknown project "${req.project}". Add it in PROJECTS first.`)
      if (!exists(project.path)) throw new Error(`The clone of ${project.name} is missing at ${project.path}.`)
      if (!req.title?.trim()) throw new Error('A mission needs a title.')
      if (!req.intent?.trim()) throw new Error("A mission needs the player's intent.")
      if (/^\s*(player|captain)\b[,:]/i.test(req.intent)) throw new Error("The intent must be the player's words without a speaker label or direct address.")

      const posture = ctx.projects.resolvePosture(project.name, { mode: req.mode, yolo: req.yolo })
      if (req.kind === 'ship' && posture.mode !== 'local-only' && !(await git.hasRemote(project.path))) {
        throw new Error(`${project.name} has no remote, so ${modeLabel(posture.mode)} mode cannot open a PR. Use Offline mode for this project.`)
      }

      // capacity across every base
      if (project.capacity && project.capacity > 0) {
        let used = 0
        for (const h of ctx.homes.values()) used += h.crew.capacityUsed(project.name)
        if (used >= project.capacity) {
          throw new Error(`deferred: ${project.name} is at capacity (${used}/${project.capacity} units). The quest stays queued.`)
        }
      }

      // quest log gate
      const backlog = hc().backlog
      let backlogId = req.backlogId
      if (backlogId) {
        const b = backlog.get(backlogId)
        if (!b) throw new Error(`Quest ${backlogId} does not exist in this base.`)
        if (b.hold) throw new Error(`Quest ${backlogId} is waiting on the player (${b.hold.reason}).`)
        if (b.state === 'done' || b.state === 'dropped') throw new Error(`Quest ${backlogId} is already ${b.state}.`)
        if (b.state === 'in-flight' && b.taskId && get(b.taskId) && get(b.taskId)!.state !== 'cleaned') {
          throw new Error(`Quest ${backlogId} is already in flight as ${b.taskId}.`)
        }
      } else {
        const b = backlog.add({
          title: req.title,
          project: project.name,
          kind: req.kind,
          notes: req.intent,
          mode: req.kind === 'ship' ? posture.mode : undefined,
          yolo: req.kind === 'ship' ? posture.yolo : undefined
        })
        backlogId = b.id
      }

      // a follow-up on the same quest keeps the loadout of the unit that worked it before
      const quest = backlog.get(backlogId!)
      const prev = quest?.taskId ? get(quest.taskId) : undefined
      const pickInput: LoadoutInput = {
        ...req,
        priority: quest?.priority,
        sticky: prev ? { from: prev.id, harness: prev.harness, model: prev.model, effort: prev.effort, category: prev.category } : undefined
      }
      const reservation = await ctx.dispatch.reserve(pickInput)
      const loadout = reservation.loadout
      try {
        const id = uniqueId(req.title)
        const branch = `${posture.branchPrefix}${id}`
        const baseBranch = req.baseBranch?.trim() || project.defaultBranch
        // A Dev Drive project keeps its worktrees on that drive, so copies there can block clone.
        const wt = await placeWorktree(home, project, id)
        // Offline worlds land locally and push on demand: branch from the local default, not origin's.
        const add = await git.addWorktree(project.path, wt, branch, baseBranch, posture.mode === 'local-only')
        if (add.code !== 0) throw new Error(`Could not create the isolated worktree: ${add.stderr.trim()}`)
        const iso = await git.assertIsolated(project.path, wt)
        if (!iso.ok) {
          await git.removeWorktree(project.path, wt, true)
          throw new Error(`Isolation check failed (${iso.reason}); the mission was stopped.`)
        }
        // Never fatal: a missing submodule is a warning in the brief and the status log.
        const submodules = await git.initWorktreeSubmodules(project.path, wt).catch((e) => ({ submodules: [], problems: [(e as Error).message], ok: false, elapsedMs: 0 }))

        ensureDir(home.taskDir(id))
        ensureDir(path.join(inboxDir(id), 'handled'))
        if (!exists(home.statusFile(id))) writeText(home.statusFile(id), '')
        if (submodules.problems.length) {
          appendLine(home.statusFile(id), formatStatusLine('note', `git submodules missing from the worktree: ${truncate(submodules.problems.join('; '), 400)}`, { key: 'submodules' }))
        }
        const reportPath = req.kind === 'scout' ? home.reportFile(id) : undefined
        const briefPath = home.briefFile(id)
        writeText(
          briefPath,
          renderBrief({
            taskId: id,
            kind: req.kind,
            project: project.name,
            worktree: wt,
            branch,
            baseBranch,
            mode: req.kind === 'ship' ? posture.mode : undefined,
            yolo: posture.yolo,
            intent: req.intent,
            spec: req.spec,
            statusFile: home.statusFile(id),
            inboxDir: inboxDir(id),
            taskDataDir: home.taskDir(id),
            reportPath,
            engine: effectiveEngine(project).engine,
            engineLine: engineBriefLine(engineFacts(project)),
            engineHints: engineHints(effectiveEngine(project).engine),
            briefInclude: s.briefInclude,
            summaryWords: req.kind === 'scout' ? ctx.dispatch.reportWords(project.name, loadout.harness) : undefined,
            tools: toolsBrief(),
            submodules
          })
        )

        const harness = loadout.harness
        const now = nowIso()
        const task: Task = {
          id,
          kind: req.kind,
          title: req.title.trim(),
          project: project.name,
          wksp: home.name,
          backlogId,
          mode: req.kind === 'ship' ? posture.mode : undefined,
          yolo: req.kind === 'ship' ? posture.yolo : undefined,
          branchPrefix: posture.branchPrefix,
          baseBranch,
          branch,
          worktree: wt,
          briefPath,
          reportPath,
          harness,
          model: loadout.model,
          effort: loadout.effort,
          loadout: loadout.reasons,
          category: loadout.category,
          loadoutSource: loadout.source,
          ruleId: loadout.ruleId,
          explored: loadout.explored,
          counters: { pings: 0, lagging: 0, stopped: 0, fixRounds: 0 },
          usageAtStart: ctx.dispatch.usagePercent(harness),
          state: 'spawning',
          stateReason: posture.warning,
          createdAt: now,
          updatedAt: now,
          inbox: { seq: 0, acked: 0, rings: 0 },
          statusOffset: 0,
          relaunches: 0
        }
        tasks.push(task)
        reservation.listed()
        persist()
        bus.publish({ type: 'task', task })
        try {
          const term = await launch(task, { resume: false, prompt: kickoffPrompt(briefPath), check: reservation.check })
          update(id, { terminalId: term.id, state: 'working', stateReason: posture.warning ?? 'deployed' })
        } catch (e) {
          update(id, { state: 'failed', stateReason: (e as Error).message })
          throw e
        }
        safe(() => backlog.markInFlight(backlogId!, id))
        ledger('task.dispatched', task, { kind: task.kind, project: task.project, harness, model: task.model ?? 'default', effort: task.effort ?? 'default', category: loadout.category, loadout: loadout.source, rule: loadout.ruleId, explored: loadout.explored, mode: task.mode, yolo: task.yolo })
        safe(() => ctx.stats.award('spawn', id))
        safe(() => ctx.notifier.sfx('spawn'))
        return get(id)!
      } finally {
        reservation.release()
      }
    },

    async send(id, text, resolveKeys = []): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (t.state === 'cleaned') return { ok: false, message: `${id} was despawned.` }
      if (!text.trim()) return { ok: false, message: 'Nothing to send.' }
      const open = new Set(resolveKeysFor(id))
      const openDecisionKeys = new Set(hc().decisions.list(false).filter((d) => d.taskId === id).map((d) => d.key))
      for (const k of resolveKeys) {
        if (!open.has(k) && !openDecisionKeys.has(k)) return { ok: false, message: `No open choice with key "${k}" on ${id}.` }
      }
      const dir = inboxDir(id)
      ensureDir(path.join(dir, 'handled'))
      const seq = nextSeq(id)
      const file = path.join(dir, `${String(seq).padStart(3, '0')}.msg`)
      writeText(file, `schema=genio-task-inbox.v1\nat=${nowIso()}\n--\n${text.trim()}\n`)
      for (const k of resolveKeys) {
        svc.appendStatus(id, formatStatusLine('resolved', `answered: ${truncate(text.replace(/\s+/g, ' '), 200)}`, { key: k }))
        safe(() => hc().decisions.resolveKey(id, k, text))
      }
      update(id, { inbox: { ...t.inbox, seq, rings: 0, lastRingAt: nowIso() } })
      bump(id, 'pings')
      safe(() => getCtx().notifier.sfx('send'))
      // The inbox is already durable. A failed terminal nudge does not undo delivery.
      const rang = await svc.ring(id).catch(() => false)
      return {
        ok: true,
        message: rang ? `Pinged ${id} (message ${seq}).` : `Saved ping ${seq} for ${id}; the unit is not running, so it will read it after a respawn.`
      }
    },

    unreadInbox(id) {
      const dir = inboxDir(id)
      const out: { seq: number; ageSec: number }[] = []
      try {
        for (const f of fs.readdirSync(dir)) {
          const m = f.match(/^(\d+)\.msg$/)
          if (!m) continue
          const full = path.join(dir, f)
          const at = readText(full).match(/^at=(.+)$/m)?.[1]
          const ts = at ? Date.parse(at) : fs.statSync(full).mtimeMs
          out.push({ seq: parseInt(m[1], 10), ageSec: Math.max(0, (Date.now() - (Number.isFinite(ts) ? ts : Date.now())) / 1000) })
        }
      } catch {
        /* no inbox */
      }
      return out.sort((a, b) => a.seq - b.seq)
    },

    async ring(id) {
      const t = get(id)
      if (!t || !terminalAlive(t)) return false
      const adapter = getCtx().settings.harness(t.harness)
      await getCtx().terminals.submit(t.terminalId!, doorbellLine(inboxDir(id)), adapter?.submitKey ?? '\r')
      const cur = get(id)!
      update(id, { inbox: { ...cur.inbox, lastRingAt: nowIso(), rings: cur.inbox.rings + 1 } })
      return true
    },

    async control(id, action, note, manual = false): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (controlling.has(id)) return { ok: false, message: `A lifecycle action is already in progress for ${id}.` }
      controlling.add(id)
      try {
        const ctx = getCtx()
        const adapter = ctx.settings.harness(t.harness)
        const terms = ctx.terminals
        if (action === 'interrupt') {
          if (!terminalAlive(t)) return { ok: false, message: `${id} is not running.` }
          terms.write(t.terminalId!, adapter?.interrupt ?? '\x1b')
          return { ok: true, message: `Interrupted ${id}.` }
        }
        const recall = async (): Promise<void> => {
          if (!terminalAlive(t)) return
          const tid = t.terminalId!
          await terms.submit(tid, adapter?.exitSequence ?? '/exit', adapter?.submitKey ?? '\r')
          for (let i = 0; i < 20 && terms.get(tid)?.alive; i++) await sleep(500)
          if (terms.get(tid)?.alive) terms.kill(tid)
        }
        if (action === 'exit') {
          const was = t.state
          await recall()
          // a recalled unit is no longer held by a dislike: it is stopped
          if (ACTIVE.includes(was)) update(id, { state: 'exited', stateReason: 'recalled', dislikePause: undefined })
          else if (t.dislikePause) update(id, { dislikePause: undefined })
          return { ok: true, message: `Recalled ${id}.` }
        }
        // respawn
        if (t.state === 'cleaned') return { ok: false, message: `${id} was despawned; deploy a new mission instead.` }
        if (!exists(t.worktree)) return { ok: false, message: `The worktree for ${id} is gone; cannot respawn.` }
        const policy = relaunchPolicy(t, manual)
        if (!policy.allowed) {
          update(id, { state: 'paused', stateReason: 'Automatic relaunch limit reached. Use Respawn to resume manually.' })
          return { ok: false, message: 'Held after one automatic relaunch. Use the unit Respawn action to resume manually.' }
        }
        let reservation: Awaited<ReturnType<typeof ctx.dispatch.reserve>>
        try {
          reservation = await ctx.dispatch.reserve({ kind: t.kind, project: t.project, title: t.title, intent: '',
            harness: t.harness, model: t.model, effort: t.effort }, { respawn: { id, wksp: home.name } })
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
        try {
          // Recheck after reservation acquisition: another caller may have relaunched meanwhile.
          const currentPolicy = relaunchPolicy(get(id)!, manual)
          if (!currentPolicy.allowed) return { ok: false, message: 'Held after one automatic relaunch. Use Respawn to resume manually.' }
          const prompt = `Genio respawned you. Re-read your brief at ${fwd(t.briefPath)} (see the latest Progress note), check your ping inbox, then continue.`
          try {
            const term = await launch(t, { resume: true, prompt, check: reservation.check, prepare: async () => {
              update(id, { automaticRelaunches: currentPolicy.nextAttempts })
              appendProgressNote(t.briefPath, note ?? '')
              restarting.add(id)
              update(id, { state: 'spawning', stateReason: 'restarting in the existing copy' })
              reservation.listed()
              await recall()
            } })
            if (t.terminalId && t.terminalId !== term.id) terms.kill(t.terminalId)
            update(id, {
              terminalId: term.id,
              state: 'working',
              stateReason: 'respawned',
              relaunches: t.relaunches + 1,
              automaticRelaunches: currentPolicy.nextAttempts,
              dislikePause: undefined
            })
            ledger('task.relaunched', t, { relaunches: t.relaunches + 1 })
            return {
              ok: true,
              message: `Respawned ${id}.`
            }
          } catch (e) {
            if (!restarting.has(id)) return { ok: false, message: (e as Error).message }
            update(id, { state: terminalAlive(t) ? t.state : 'failed', stateReason: (e as Error).message,
              terminalId: terminalAlive(t) ? t.terminalId : undefined })
            return { ok: false, message: (e as Error).message }
          }
        } finally { reservation.release() }
      } catch (e) {
        // Preparation and recall can fail too. Never discard the copy/branch,
        // claim a successful restart, or leave a phantom spawning slot behind.
        if (restarting.has(id)) update(id, { state: terminalAlive(t) ? t.state : 'failed', stateReason: (e as Error).message,
          terminalId: terminalAlive(t) ? t.terminalId : undefined })
        return { ok: false, message: (e as Error).message }
      } finally {
        controlling.delete(id)
        restarting.delete(id)
      }
    },

    async cleanup(id, force = false): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (t.state === 'cleaned') return { ok: true, message: `${id} is already despawned.` }
      const ctx = getCtx()
      const project = ctx.projects.get(t.project)
      const repo = project?.path ?? (exists(t.worktree) ? await git.repoTop(t.worktree) : '')
      const openChoices = hc().decisions.list(false).filter((d) => d.taskId === id)
      let via = 'forced'
      if (t.kind === 'scout') {
        const reportOk = exists(t.reportPath ?? home.reportFile(id))
        // A recalled or exited Recon (often a duplicate) has nothing left to report.
        const ended = !terminalAlive(t) && ['exited', 'failed', 'detached'].includes(t.state)
        const reasons: string[] = []
        if (!reportOk && !ended) reasons.push('the recon report has not been written')
        if (openChoices.length) reasons.push(`${openChoices.length} open choice(s) from this recon are unanswered`)
        if (reasons.length && !force) return { ok: false, message: `Refusing to despawn ${id}: ${reasons.join('; ')}.` }
        via = reportOk ? 'recon scratch' : 'recon ended without a report'
      } else if (repo) {
        const verdict = await git.landedVerdict(repo, t.worktree, t.branch, t.baseBranch, t.pr?.state === 'MERGED', t.mode === 'local-only')
        if (!verdict.landed && !force) {
          return { ok: false, message: `Refusing to despawn ${id}: unlanded work (${verdict.reasons.join('; ')}). Only the player can authorise discarding it.${git.unlandedDetail(verdict)}` }
        }
        via = verdict.landed ? `landed (${verdict.via})` : 'forced by the player'
      } else if (!force) {
        return { ok: false, message: `Cannot verify ${id}'s work: its project is not registered. Force only with the player's word.` }
      }
      // The agent and every terminal tied to the unit (its shells): a shell open in the copy would block its removal.
      if (t.terminalId) ctx.terminals.kill(t.terminalId)
      const shells = ctx.terminals.list().filter((term) => term.taskId === id)
      for (const term of shells) ctx.terminals.kill(term.id)
      // Give a killed shell a moment to release its working directory (Windows).
      if (shells.some((term) => term.alive)) await sleep(500)
      let leftover = ''
      if (repo) {
        const scratch = t.kind === 'scout' || force
        // A folder git no longer knows ("not a working tree") or one already gone is already clean.
        let registered = await git.isWorktreeOf(repo, t.worktree)
        if (registered) {
          let r = await git.removeWorktree(repo, t.worktree, scratch)
          if (r.code !== 0 && !scratch) {
            // Forcing past ignored or locked leftovers is fine; never past real changes.
            const dirty = await git.statusPorcelain(t.worktree)
            if (dirty.length) {
              return { ok: false, message: `Refusing to despawn ${id}: the worktree changed during despawn.${git.unlandedDetail({ files: dirty, commits: [] })}` }
            }
            r = await git.removeWorktree(repo, t.worktree, true)
          }
          registered = await git.isWorktreeOf(repo, t.worktree)
          if (r.code !== 0 && registered) return { ok: false, message: `Could not remove the worktree: ${r.stderr.trim()}` }
        } else {
          await git.pruneWorktrees(repo)
        }
        if (exists(t.worktree)) leftover = ` Left the unregistered folder ${fwd(t.worktree)} untouched.`
      }
      // despawned worktree: drop its trust entry so no .claude.json accumulates dead paths
      if (t.harness === 'claude') for (const file of claudeTrustFiles()) setClaudeTrust(file, [t.worktree], false)
      // Finished Codex units leave the player's Codex app: archive (never delete) their threads once the process is gone.
      if (t.harness === 'codex') {
        const genioHome = genioCodexHome()
        if (genioHome) setCodexTrust(genioHome, [t.worktree], false)
        scheduleUnitArchive(t.worktree, { dataDir: mainHome.data, codexHome: t.codexHome ?? ctx.settings.harness(t.harness)?.env?.CODEX_HOME, task: t.id })
      }
      if (repo && (await git.branchExists(repo, t.branch))) {
        await git.deleteBranch(repo, t.branch, t.kind === 'scout' || force)
      }
      // update() closes the quest this unit was flying (followUnit); a re-queued follow-up stays queued
      update(id, { state: 'cleaned', cleanedAt: nowIso(), terminalId: undefined, stateReason: `despawned: ${via}` })
      ledger('task.cleaned_up', t, { via })
      safe(() => ctx.stats.award('cleanup', id))
      return { ok: true, message: `Despawned ${id} (${via}).${leftover}` }
    },

    async merge(id): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (t.kind !== 'ship') return { ok: false, message: 'Recon missions have nothing to merge.' }
      const ctx = getCtx()
      const project = ctx.projects.get(t.project)
      if (!project) return { ok: false, message: `Project ${t.project} is not registered.` }
      let result: OpResult
      let mergeVia: 'pr' | 'local'
      let landedCommit: string | undefined
      if (t.pr?.url) {
        mergeVia = 'pr'
        result = await ctx.forge.merge(t.pr.url, (await git.isWorktreeOf(project.path, t.worktree)) ? t.worktree : project.path)
      } else if (t.mode === 'local-only') {
        if (t.state !== 'ready') return { ok: false, message: `${id} has not reported a ready branch yet.` }
        mergeVia = 'local'
        const r = await git.mergeLocalFastForward(project.path, t.branch, t.baseBranch)
        result = r.code === 0 ? { ok: true, message: `Landed ${t.branch} into local ${t.baseBranch}.` } : { ok: false, message: r.stderr.trim() || 'fast-forward merge failed' }
        if (result.ok) landedCommit = (await git.headSha(project.path, t.branch)) || undefined
      } else {
        return { ok: false, message: `${id} has no registered PR to merge yet.` }
      }
      if (!result.ok) return result
      update(id, { state: 'merged', landedAt: nowIso(), landedCommit, stateReason: mergeVia === 'pr' ? 'PR merged' : `landed in local ${t.baseBranch}`,
        pr: t.pr ? { ...t.pr, state: 'MERGED', checkedAt: nowIso() } : undefined })
      ledger('task.merged', t, { via: mergeVia, pr: t.pr?.url })
      safe(() => ctx.stats.award('merge', id))
      safe(() => ctx.notifier.sfx('merge'))
      if (mergeVia === 'pr') await ctx.projects.sync(project.name).catch(() => undefined)
      const c = await svc.cleanup(id)
      return { ok: true, message: `${result.message} ${c.ok ? c.message : `Despawn deferred, nothing was discarded: ${c.message}`}`.trim() }
    },

    async promote(id, intent): Promise<Task> {
      const t = must(id)
      if (t.kind !== 'scout') throw new Error(`${id} is not a Recon mission.`)
      if (!exists(t.worktree)) throw new Error(`The worktree for ${id} is gone.`)
      const ctx = getCtx()
      const project = ctx.projects.get(t.project)
      if (!project) throw new Error(`Project ${t.project} is not registered.`)
      const posture = ctx.projects.resolvePosture(project.name)
      const report = readText(t.reportPath ?? home.reportFile(id))
      const oldBrief = readText(t.briefPath)
      writeText(path.join(home.taskDir(id), 'brief-recon.md'), oldBrief)
      const priorIntent = oldBrief.match(/## Player's intent\s+([\s\S]*?)\n## /)?.[1]?.trim() ?? t.title
      // make sure the worktree sits on the build branch
      const onBranch = await git.currentBranch(t.worktree)
      if (onBranch !== t.branch) {
        const co = (await git.branchExists(project.path, t.branch))
          ? await git.git(t.worktree, ['checkout', t.branch])
          : await git.git(t.worktree, ['checkout', '-b', t.branch])
        if (co.code !== 0) throw new Error(`Could not switch the worktree to ${t.branch}: ${co.stderr.trim()}`)
      }
      writeText(
        t.briefPath,
        renderBrief({
          taskId: id,
          kind: 'ship',
          project: project.name,
          worktree: t.worktree,
          branch: t.branch,
          baseBranch: t.baseBranch,
          mode: posture.mode,
          yolo: posture.yolo,
          intent: intent?.trim() || priorIntent,
          spec: 'Implement the recommendations of the recon report below. Stay within the intent.',
          statusFile: home.statusFile(id),
          inboxDir: inboxDir(id),
          taskDataDir: home.taskDir(id),
          engine: project.engine,
          briefInclude: ctx.settings.get().briefInclude,
          tools: toolsBrief(),
          carriedReport: report || '(the recon report was empty)'
        })
      )
      update(id, { kind: 'ship', mode: posture.mode, yolo: posture.yolo, promotedFrom: id, state: 'working', stateReason: 'upgraded to Build' })
      if (t.backlogId) safe(() => hc().backlog.update(t.backlogId!, { kind: 'ship', mode: posture.mode, yolo: posture.yolo }))
      const r = await svc.control(id, 'relaunch', 'Upgraded from Recon to Build: the brief now has a Build definition of done. Implement it.')
      if (!r.ok) {
        writeText(t.briefPath, oldBrief)
        update(id, { kind: t.kind, mode: t.mode, yolo: t.yolo, promotedFrom: t.promotedFrom,
          state: terminalAlive(t) || get(id)!.state === 'working' ? t.state : get(id)!.state, stateReason: r.message })
        if (t.backlogId) safe(() => hc().backlog.update(t.backlogId!, { kind: t.kind, mode: t.mode, yolo: t.yolo }))
        throw new Error(r.message)
      }
      return get(id)!
    },

    validate: (id) => gauntlet.run(id),

    async readFile(id, which: TaskFile): Promise<string> {
      const t = must(id)
      switch (which) {
        case 'brief':
          return readText(t.briefPath, '(no brief)')
        case 'report':
          return readText(t.reportPath ?? home.reportFile(id), '(no report yet)')
        case 'status':
          return readText(home.statusFile(id), '')
        case 'validation':
          return readText(home.validationLog(id), '(the Gauntlet has not run)')
        case 'inbox': {
          const dir = inboxDir(id)
          const parts: string[] = []
          for (const [sub, label] of [['', 'PENDING'], ['handled', 'READ']] as const) {
            try {
              for (const f of fs.readdirSync(path.join(dir, sub)).filter((x) => x.endsWith('.msg')).sort()) {
                parts.push(`--- ${label} ${f} ---\n${readText(path.join(dir, sub, f)).split('\n--\n').slice(1).join('\n--\n').trim()}`)
              }
            } catch {
              /* none */
            }
          }
          return parts.join('\n\n') || '(no pings)'
        }
        case 'diff': {
          if (!exists(t.worktree)) return '(worktree removed)'
          const project = getCtx().projects.get(t.project)
          const ref = project ? await git.baseRef(project.path, t.baseBranch, t.mode === 'local-only') : t.baseBranch
          return (await git.diff(t.worktree, ref)) || '(no changes)'
        }
        case 'log':
          return t.terminalId ? getCtx().terminals.tail(t.terminalId, 400) || '(no output yet)' : '(unit terminal not running)'
        default:
          return ''
      }
    },

    async crewState(id): Promise<string> {
      const t = get(id)
      if (!t) return `state: unknown · source: none · no such unit ${id}`
      const detailParts = [t.stateReason, t.pr?.url, ...resolveKeysFor(id).map((k) => `open choice: ${k}`)].filter(Boolean)
      const detail = detailParts.join(' · ') || t.state
      if (gauntlet.running(id) || t.validation?.state === 'running') return `state: working · source: gauntlet · round ${t.validation?.round ?? 1}`
      const alive = terminalAlive(t)
      const last = t.terminalId ? getCtx().terminals.lastOutputAt(t.terminalId) : undefined
      const evs = svc.statusEvents(id).filter((e) => e.kind !== 'note' && e.kind !== 'unknown')
      const lastEv = evs[evs.length - 1]
      const map: Record<string, string> = {
        working: 'working',
        'needs-decision': 'parked',
        blocked: 'blocked',
        paused: 'paused',
        done: 'done',
        failed: 'failed',
        resolved: 'working',
        'player-held': 'paused'
      }
      if (t.state === 'ready' || t.state === 'merged' || t.state === 'done') return `state: done · source: status-log · ${detail}`
      if (alive && last && Date.now() - last < 15_000 && (!lastEv || ['working', 'resolved'].includes(lastEv.kind))) {
        return `state: working · source: terminal · ${detail}`
      }
      if (lastEv) return `state: ${map[lastEv.kind] ?? 'unknown'} · source: status-log · ${detail}`
      if (alive) return `state: working · source: terminal · ${detail}`
      return `state: unknown · source: none · ${detail}`
    },

    async fleetView(): Promise<string> {
      const lines: string[] = []
      const live = tasks.filter((t) => t.state !== 'cleaned')
      lines.push(`## In Progress (base: ${home.name})`)
      if (!live.length) lines.push('(no units deployed)')
      else {
        lines.push('| ID | Current | Kind | Project | Mode | Terminal | Artifact | Worktree |')
        lines.push('|---|---|---|---|---|---|---|---|')
        for (const t of live) {
          const cs = (await svc.crewState(t.id)).replace(/\|/g, '/')
          const term = t.terminalId ? (terminalAlive(t) ? 'present' : 'exited') : 'absent'
          const art = t.pr?.url ?? (t.kind === 'scout' && exists(t.reportPath ?? '') ? fwd(t.reportPath!) : t.state === 'ready' ? t.branch : '-')
          lines.push(
            `| ${t.id} | ${t.state} — ${cs} | ${t.kind === 'ship' ? 'build' : 'recon'} | ${t.project} | ${t.mode ?? '-'}${t.yolo ? '+autoloot' : ''} | ${term} | ${art} | ${exists(t.worktree) ? fwd(t.worktree) : '(absent)'} |`
          )
        }
      }
      const backlog = hc().backlog
      const queued = backlog.list().filter((b) => b.state === 'queued' || b.state === 'blocked').sort(questOrder)
      lines.push('', '## Quest Log (queued, in dispatch order)')
      if (!queued.length) lines.push('(nothing queued)')
      else {
        lines.push('| ID | Title | Project | Kind | Priority | Blocked by | Waiting for the player |')
        lines.push('|---|---|---|---|---|---|---|')
        for (const b of queued) {
          const waits = b.hold ? `${backlog.bucket(b)}: ${b.hold.reason}${b.hold.until ? ` until ${b.hold.until}` : ''}` : b.duplicateOf ? `duplicate of ${b.duplicateOf}?` : '-'
          lines.push(`| ${b.id} | ${b.title} | ${b.project ?? '-'} | ${b.kind} | ${b.priority}${b.rank ? ` #${b.rank}` : ''} | ${b.dependsOn.join(', ') || '-'} | ${waits} |`)
        }
      }
      const done = tasks.filter((t) => t.state === 'cleaned').slice(-10)
      lines.push('', '## Recently done')
      if (!done.length) lines.push('(none)')
      else for (const t of done) lines.push(`- ${t.id} — ${t.title} (${t.project}) ${t.pr?.url ?? t.stateReason ?? ''}`)
      return lines.join('\n')
    },

    async registerPr(id, url): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (!/^https:\/\//.test(url)) return { ok: false, message: 'PR links must be full https:// URLs.' }
      const ctx = getCtx()
      const v = await ctx.forge.view(url, exists(t.worktree) ? t.worktree : undefined).catch(() => undefined)
      if (v?.ok && v.isDraft) {
        update(id, { state: 'paused', stateReason: `PR is a draft: ${url}` })
        return { ok: false, message: `Refusing a draft PR: ${url}` }
      }
      const pr = {
        url,
        number: parseInt(url.match(/\/(\d+)$/)?.[1] ?? '', 10) || undefined,
        state: v?.state,
        checks: v?.checks,
        mergeable: v?.mergeable,
        reviewDecision: v?.reviewDecision,
        checkedAt: nowIso()
      }
      const merged = v?.state === 'MERGED'
      update(id, { pr, state: merged ? 'merged' : 'ready', stateReason: merged ? 'PR merged' : 'PR open, waiting on merge authority' })
      ledger('task.pr_ready', t, { pr: url })
      if (!t.pr) {
        safe(() => ctx.stats.award('ship', id))
        safe(() => ctx.notifier.sfx('ready'))
      }
      // An already-merged PR is a landing: the Shipped tiles and heatmap count merges, not readiness.
      if (merged) safe(() => ctx.stats.award('merge', id))
      return { ok: true, message: `Registered ${url}` }
    },

    appendStatus(id, line) {
      appendLine(home.statusFile(id), line.replace(/\r?\n/g, ' '))
    },

    readNewStatus(id, beforeConsume): StatusEvent[] {
      const t = get(id)
      if (!t) return []
      const file = home.statusFile(id)
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        return []
      }
      let offset = t.statusOffset ?? 0
      if (size < offset) offset = 0 // truncated/rewritten
      if (size === offset) return []
      let buf: Buffer
      try {
        const fd = fs.openSync(file, 'r')
        buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
      } catch {
        return []
      }
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl < 0) return [] // wait for a complete line
      const chunk = buf.subarray(0, lastNl + 1).toString('utf8')
      const events = chunk
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => parseStatusLine(l, id))
      // Overwatch persists actionable events before advancing the durable read
      // cursor. Failed queue writes leave the lines available for the next pass;
      // a restart cannot lose events in an in-memory coalescing window.
      beforeConsume?.(events)
      for (const e of events) {
        try {
          applyStatus(t, e)
        } catch {
          /* one bad line never stops overwatch */
        }
        ledger('task.status', t, { state: e.kind, key: e.key, text: truncate(e.text, 2000) })
        bus.publish({ type: 'status', event: e })
      }
      update(id, { statusOffset: offset + lastNl + 1, lastStatusAt: nowIso() })
      return events
    },

    statusEvents: (id) => parseStatusLog(readText(home.statusFile(id)), id),
    openDecisionKeys: (id) => resolveKeysFor(id),

    async reconcileOnStart(project) {
      const ctx = getCtx()
      for (const t of [...tasks]) {
        if (project && t.project !== project) continue
        if (t.state === 'cleaned') continue
        const alive = t.terminalId ? ctx.terminals.get(t.terminalId)?.alive : false
        if (alive) continue
        const patch: Partial<Task> = { terminalId: undefined, automaticRelaunches: 0 }
        // a landed unit whose despawn was deferred still closes the quest it flew
        if (t.backlogId) safe(() => hc().backlog.followUnit(t))
        const quest = svc.questState(t)
        if (!exists(t.worktree)) {
          if (!FINISHED.includes(t.state)) {
            patch.state = 'failed'
            patch.stateReason = 'worktree missing after restart'
          }
        } else if (quest === 'done' || quest === 'dropped') {
          // Never resume a unit whose quest the player already closed.
          if (ACTIVE.includes(t.state) || t.state === 'detached') {
            patch.state = 'exited'
            patch.stateReason = `quest ${quest}; not resumed after restart`
          }
        } else if ((ACTIVE.includes(t.state) && !['blocked', 'needs-decision', 'paused'].includes(t.state)) || t.state === 'exited') {
          patch.state = 'detached'
          patch.stateReason = 'Genio restarted; respawn to resume'
        }
        if (t.validation?.state === 'running') patch.validation = { ...t.validation, state: 'cancelled', endedAt: nowIso() }
        update(t.id, patch)
      }
    },

    capacityUsed(project) {
      return tasks.filter((t) => t.project === project && holdsCapacity(t, terminalAlive(t))).length
    },

    questState(t) {
      if (!t.backlogId) return undefined
      try {
        return hc().backlog.get(t.backlogId)?.state
      } catch {
        return undefined // no quest log in this base
      }
    }
  }

  return svc
}
