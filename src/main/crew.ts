/**
 * The Squad: unit lifecycle for one base (deploy, steer, control, teardown,
 * PR merge, local merge, promote,
 * state and fleet view).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Decision, DeliveryMode, LoadoutInput, Project, StatusEvent, Task, TaskCounters, TaskState, TerminalInfo } from '@shared/types'
import type { OpResult, SpawnRequest, TaskFile } from '@shared/api'
import type { AppCtx, CrewService } from './services'
import { placeWorktree, type Home } from './home'
import { bus } from './bus'
import * as git from './git'
import { appendProgressNote, doorbellLine, engineHints, kickoffPrompt, renderBrief, unitBriefSections, type BriefInput } from './brief'
import { claimConflict, claimHolderKind } from '@shared/modeller'
import { pruneModellerData } from './modeller-landing'
import { holdsCapacity } from './usage-policy'
import { autocompactOfferKey, buildArgs, CLAUDE_BYPASS_DIALOG, codexTrustDialog, TUI_WORKING } from './harness'
import { discoverCodexSession } from './codex-session'
import { answerAutoCompactOffer, claudeLaunch, claudeTrustFiles, playerSkipsBypassPrompt, setClaudeTrust, UNIT_UNSET_ENV } from './claude-home'
import { scheduleUnitArchive, unarchiveCodexThread } from './codex-archive'
import { codexLaunch, codexUnitFolders, genioCodexHome, isCodexUnitFolder, setCodexTrust } from './codex-home'
import { foldOpenDecisions, formatStatusLine, parseStatusLine, parseStatusLog } from './status'
import { createGauntlet } from './gauntlet'
import { relaunchPolicy } from './relaunch-policy'
import { QuotaDeferredError, QuotaDeferredQueue } from './quota-deferred'
import { approvalModel, unitModel, UNIT_MODEL_APPROVAL_REASON } from '@shared/unit-model-policy'
import { modeLabel } from '@shared/vocab'
import { DONE_STATES, squadOutcome } from '@shared/squad-display'
import { cheapModelsAllowed } from '@shared/dispatch'
import { questOrder } from '@shared/quest-board'
import { effectiveEngine } from '@shared/engine'
import { completeLines, decodeBytes } from '@shared/encoding'
import { engineBriefLine, engineEnv, engineFacts } from '@shared/engine-summary'
import { getSecret } from './secrets'
import { installUnitHooks } from './unithooks'
import { installUnityShims, unityGuardScript, unityPreToolHook } from './unity-guards'
import { depsEnv, depsPreToolHook, depsStateFile, installNpmShims, npmGuardScript, startWorktreeDeps, sweepWorktrees, type SweepResult } from './worktree-deps'
import { isLink, removeLinkSafely } from '../../resources/unit-skills/genio/lib/node-deps.mjs'
import { sourceRemoved, yieldSource } from './source-leases'
import { helpDocsDir } from './help'
import { blenderSkillDir, installUnitPlugin, modellerDataDir, openRouterEnv, unitLaunchExtras, unitPluginDir, unitPluginSource } from './unitskills'
import { claudeUnitMcpConfig, unitMcpLaunch, type McpRelays } from './unit-mcp'
import { mcpGateway } from './mcp-gateway'
import { unitMcpServers } from './mcp-servers'
import { findUnityCli, unityUnitConfig, unityUnitEnv } from './unity-unit'
import { artBibleBriefLines, unitArtBible, unitArtBibleEnv } from './art-bible-gen'
import { designNotesBriefLines } from './design-notes'
import { copyReferences, questReferencesDir, readReferences, referencesBriefLines, stageReferences, unitReferencesDir } from './unit-references'
import {
  appendJsonl, appendLine, ensureDir, exists, fwd, nowIso, readJson, readText, rid, slugify, stripAnsi, truncate, writeJson, writeText
} from './util'
import { checkDeployBudget, fmtUsd, grantAtDeploy, grantedUsd, grantEnv, grantsFor, spendChoice, writeUnitGrant } from './spend-grants'

/** States with an expected live process. */
const ACTIVE: TaskState[] = ['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'stale', 'validating']
/** States that end a mission's work (process may still be around). */
const FINISHED: TaskState[] = ['ready', 'merged', 'done', 'failed', 'cleaned']
/** States that put an outcome on the dispatch scorecard (a later end replaces an earlier one). */
const ENDED: TaskState[] = ['merged', 'done', 'failed', 'cleaned']

/** Claude's autocompact offer is answered once its output has been quiet this long. */
const AUTOCOMPACT_SETTLE_MS = 2_000
/** After an answer, the offer's lingering redraws are not a new appearance for this long. */
const AUTOCOMPACT_COOLDOWN_MS = 10_000
/** Codex's folder trust dialog is answered once its output has been quiet this long. */
const CODEX_TRUST_SETTLE_MS = 1_000
/** After an answer, the dialog's lingering redraws are not a new appearance for this long. */
const CODEX_TRUST_COOLDOWN_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** TUI output as whitespace-free lower-case text: cursor-positioned text loses its spaces anyway. */
const squashTui = (x: string): string => stripAnsi(x).replace(/\s+/g, '').toLowerCase()

export function createCrewService(getCtx: () => AppCtx, home: Home, canRetry: (project: string) => boolean = () => true): CrewService {
  const quotaDeferred = new QuotaDeferredQueue(home.data)
  // A record that still names the old workspaces folder is read through its new location.
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
  /** the ping seq last reported as typed but not submitted, per unit */
  const unsubmitted = new Map<string, number>()
  const controlling = new Set<string>()
  const restarting = new Set<string>()
  /** quests whose unit is being prepared: a second start path must not launch them twice */
  const launching = new Set<string>()

  /** While a whole-roster pass runs (startup reconciliation), its updates share one write of tasks.json. */
  let batching = 0, unsaved = false
  const persist = (): void => {
    if (batching) { unsaved = true; return }
    writeJson(home.tasksFile, tasks)
  }
  const batch = async (run: () => Promise<void>): Promise<void> => {
    batching++
    try { await run() } finally {
      if (--batching === 0 && unsaved) { unsaved = false; persist() }
    }
  }
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
      // a landed plan step releases the steps after it; a discarded or failed one pauses its plan
      safe(() => hc().plans?.followUnit(next))
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
  /** The brief's Art Bible lines: none without a bible, and never fatal. */
  const artBibleBrief = (main: string, wt: string, id: string): string[] => {
    try {
      return artBibleBriefLines(unitArtBible(main, wt, home.taskDir(id)), path.join(pluginDir, 'lib', 'genio-art.mjs'))
    } catch {
      return []
    }
  }
  const depsGuard = npmGuardScript(pluginDir)
  /** What Genio did about worktree dependencies and links (docs/unit-worktrees.md). */
  const depsLog = (record: Record<string, unknown>): void => safe(() => appendJsonl(path.join(mainHome.state, 'worktree-deps.jsonl'), { at: nowIso(), home: home.name, ...record }))
  /** Live units already told about a node_modules link this session. */
  const toldLinks = new Set<string>()
  /** The player's MCP servers a unit on this runtime gets in this project, by name, for its brief. */
  const mcpBriefNames = (harness: string, project: string): string[] =>
    unitMcpServers(mainHome.data, project, harness).map((s) => s.name)
  /** The brief's dependency lines for a worktree with a package.json; a Modeller's say it gets none unless it asks. */
  const nodeDeps = (id: string, wt: string, modeller = false): BriefInput['nodeDeps'] =>
    exists(path.join(wt, 'package.json')) ? { stateFile: depsStateFile(home.taskDir(id)), setup: depsGuard, ...(modeller ? { onDemand: true } : {}) } : undefined
  /** The brief's References section for the unit's copied attachments; none without any. */
  const referencesBrief = (id: string, o: { modeller?: boolean; generator?: boolean }): string[] => {
    const dir = unitReferencesDir(home.taskDir(id))
    return referencesBriefLines(dir, readReferences(dir), { taskDir: home.taskDir(id), blender: blenderSkillDir(pluginDir), ...o })
  }
  /** Background private node_modules for the unit's worktree (once; nothing to do when it already has one). */
  const startDeps = (t: Task, main: string): void => safe(() => {
    void startWorktreeDeps({ worktree: t.worktree, main, stateFile: depsStateFile(home.taskDir(t.id)), statusFile: home.statusFile(t.id), data: mainHome.data, log: depsLog })?.then(report => {
      if (report.state === 'ready' && report.from && !report.method?.startsWith('clone:')) {
        bus.publish({ type: 'unit-copy', project: t.project, ms: report.elapsedMs - (report.deferredMs ?? 0) })
      }
    }).catch(() => undefined)
  })

  /** Launch additions for unit skills; a missing install or key never blocks a launch. */
  const skillExtras = (t: Task, harnessId: string, worldPath?: string): ReturnType<typeof unitLaunchExtras> => {
    let installed: string | undefined
    try {
      installed = installUnitPlugin(unitPluginSource(getCtx().appRoot), pluginDir, [t.worktree, worldPath ?? ''])
    } catch {
      /* launch without the skills */
    }
    let falKey: string | undefined
    let uthanaKey: string | undefined
    try {
      falKey = getSecret('fal', mainHome.data)
      uthanaKey = getSecret('uthana', mainHome.data)
    } catch {
      /* no OS encryption: the skills report the key as missing */
    }
    const project = getCtx().projects.get(t.project)
    const extras = unitLaunchExtras(harnessId, { pluginDir: installed, falKey, uthanaKey, dataDir: mainHome.data, taskDataDir: home.taskDir(t.id), project: project?.name, helpDocs: helpDocsDir(getCtx().appRoot) })
    Object.assign(extras.env, project ? engineEnv(project) : {})
    // The paid helpers read the unit's signed grant; a launch re-signs it from Genio's own record.
    safe(() => {
      Object.assign(extras.env, grantEnv(mainHome.data, home.taskDir(t.id)))
      if (grantsFor(mainHome.data, t.id).length) writeUnitGrant(mainHome.data, home.taskDir(t.id), t.id, t.project)
    })
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

  const writeClaudeSettings = (t: Task, guard?: string, deps?: string): string => {
    const p = home.taskStateFile(t.id, '.claude-settings.json')
    const stamp = (file: string): string => `node -e "require('fs').writeFileSync('${fwd(file)}', String(Date.now()))"`
    const preToolUse = [...(guard ? [unityPreToolHook(guard)] : []), ...(deps ? [depsPreToolHook(deps)] : [])]
    // Genio's Claude home has no user settings of its own: carry over only the
    // player's existing bypass consent. Genio never answers that dialog itself.
    // A submitted prompt marks a new turn: work, unlike the idle CLI's own output.
    writeJson(p, { ...(playerSkipsBypassPrompt() ? { skipDangerousModePermissionPrompt: true } : {}),
      hooks: { Stop: [{ hooks: [{ type: 'command', command: stamp(turnEndedFile(t.id)) }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: stamp(home.taskStateFile(t.id, '.turn-started')) }] }],
        ...(preToolUse.length ? { PreToolUse: preToolUse } : {}) } })
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
      // Codex's folder dialog is watchCodexTrust's: it answers only for the unit's own folders.
      if (t.harness === 'codex' && codexTrustDialog(tail)) return
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

  /**
   * Claude's autocompact offer ("Keep auto (1m tokens)" / "Autocompact at …")
   * holds a unit at a turn end until a key answers it: the unit reads no
   * pings and never resumes. answerAutoCompactOffer normally keeps it away;
   * if it still shows, answer it with the key that keeps the automatic window,
   * once per appearance (fresh output after the cooldown), then ring for any
   * ping that waited.
   */
  const watchAutocompactOffer = (t: Task, terminalId: string): void => {
    const terms = getCtx().terminals
    let tail = ''
    let settle: ReturnType<typeof setTimeout> | undefined
    let answeredAt = 0
    const off = terms.onData(terminalId, (d) => {
      tail = (tail + squashTui(d)).slice(-4000)
      if (Date.now() - answeredAt < AUTOCOMPACT_COOLDOWN_MS || !autocompactOfferKey(tail)) return
      // Keys that arrive while the offer is still drawing are refused: answer once it settles.
      clearTimeout(settle)
      settle = setTimeout(() => {
        const key = autocompactOfferKey(tail)
        tail = ''
        if (!key || get(t.id)?.terminalId !== terminalId) return
        answeredAt = Date.now()
        terms.write(terminalId, key)
        setTimeout(() => {
          if (svc.unreadInbox(t.id).length) void svc.ring(t.id).catch(() => false)
        }, 1_500)
      }, AUTOCOMPACT_SETTLE_MS)
    })
    terms.onExit(terminalId, () => {
      off()
      clearTimeout(settle)
    })
  }

  /**
   * Codex's "Folder access … Trust this folder?" dialog holds a unit before its
   * first turn (a new, moved or never-seen folder). Pre-trust keeps it away in
   * Genio's home only; if it still shows, answer "Trust and continue" when the
   * folder is this unit's worktree or its registered project's root, once per
   * appearance. Any other folder is left alone with one clear stale signal.
   */
  const watchCodexTrust = (t: Task, terminalId: string, folders: string[]): void => {
    const terms = getCtx().terminals
    let tail = ''
    let settle: ReturnType<typeof setTimeout> | undefined
    let handledAt = 0
    let seenAt = 0
    let answers = 0
    let signalled = false
    const off = terms.onData(terminalId, (d) => {
      tail = (tail + squashTui(d)).slice(-4000)
      if (signalled || Date.now() - handledAt < CODEX_TRUST_COOLDOWN_MS || !codexTrustDialog(tail)) return
      // A redraw restarts the wait, but a screen that never goes quiet is answered anyway.
      if (settle && Date.now() - seenAt > 5_000) return
      if (!settle) seenAt = Date.now()
      clearTimeout(settle)
      settle = setTimeout(() => {
        settle = undefined
        const dialog = codexTrustDialog(tail)
        tail = ''
        const cur = get(t.id)
        if (!dialog || !cur || cur.terminalId !== terminalId) return
        handledAt = Date.now()
        if (dialog.onTrust && isCodexUnitFolder(dialog.folder, folders) && answers < 3) {
          answers++
          terms.write(terminalId, '\r')
          setTimeout(() => {
            if (svc.unreadInbox(t.id).length) void svc.ring(t.id).catch(() => false)
          }, 1_500)
          return
        }
        signalled = true
        const why = answers >= 3 ? 'kept asking after Genio answered it 3 times'
          : !isCodexUnitFolder(dialog.folder, folders) ? `names "${dialog.folder}", which is not this unit's worktree or its project's root`
          : 'has its pointer off "Trust and continue"'
        safe(() => hc().wakes.enqueue({ kind: 'stale', taskId: t.id, routine: false,
          reason: `${cur.kind === 'scout' ? 'RECON' : 'BUILD'} "${cur.title}" (${cur.project}): Codex's "Trust this folder?" dialog ${why}; Genio left it unanswered and the unit has not started`,
          lines: terms.tail(terminalId, 8).split('\n').filter((l) => l.trim()).map((l) => `| ${truncate(l, 200)}`) }))
      }, CODEX_TRUST_SETTLE_MS)
    })
    terms.onExit(terminalId, () => {
      off()
      clearTimeout(settle)
    })
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
      const allowed = await ctx.permissions.ask({ workspace: home.name, tool: 'unit launch',
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
    // Only Genio's own home: the player's Claude keeps its own offers.
    if (claude?.isolated) answerAutoCompactOffer(claude.configFile, [model ?? '', ...adapter.models])
    const skills = skillExtras(t, adapter.id, project?.path)
    const unityProject = project && effectiveEngine(project).engine === 'unity'
    const guard = unityProject ? unityGuardScript(pluginDir) : undefined
    if (unityProject && (!skills.env.GENIO_UNITY_CONFIG || !skills.env.GENIO_UNITY)) throw new Error('Unity units require the installed genio-unity wrapper and guard config.')
    const shimDir = path.join(home.taskDir(t.id), 'unit-bin')
    const inheritedPath = adapter.env?.PATH ?? adapter.env?.Path ?? process.env.PATH ?? process.env.Path ?? ''
    const shimEnv = guard ? installUnityShims(shimDir, skills.env.GENIO_UNITY, guard, inheritedPath) : {}
    // npm/npx/pnpm/yarn refuse installs through a linked node_modules; a missing guard never blocks a launch.
    let depsShimEnv: Record<string, string> = {}
    let deps: string | undefined
    try {
      depsShimEnv = installNpmShims(shimDir, depsGuard, inheritedPath)
      deps = depsGuard
    } catch {
      /* launch without the npm shims */
    }
    // A Modeller's tools run from the skills folder: its copy gets node_modules only if it runs setup itself.
    if (project && !t.modeller) startDeps(t, project.path)
    const settingsPath = isClaude ? writeClaudeSettings(t, guard, deps) : undefined
    // Genio's own Codex home keeps units (and any Codex image run inside a unit) out of the player's Codex app.
    // A runtime with its own CODEX_HOME keeps it; a resume follows the unit's thread.
    const isCodex = adapter.id === 'codex'
    const codex = adapter.env?.CODEX_HOME ? undefined
      : await codexLaunch({ resume: isCodex && opts.resume ? { cwd: t.worktree, home: t.codexHome } : undefined })
    const codexHome = adapter.env?.CODEX_HOME ?? codex?.codexHome
    const trustFolders = isCodex ? codexUnitFolders(t.worktree, project?.path) : []
    // Only Genio's own home: the player's Codex config is never edited.
    if (isCodex && codex?.isolated) setCodexTrust(codex.codexHome, trustFolders, true)
    let sessionId = opts.resume && isCodex
      ? await discoverCodexSession(t.worktree, codexHome, t.codexSessionId)
      : undefined
    // Codex refuses to resume an archived thread; one it will not restore starts fresh instead.
    if (sessionId && !(await unarchiveCodexThread(sessionId, { dataDir: mainHome.data, codexHome, task: t.id, cwd: t.worktree }))) sessionId = undefined
    if (isCodex) update(t.id, { codexHome, ...(opts.resume ? { codexSessionId: sessionId } : {}) })
    // Only the MCP servers Genio passes: relays to the gateway for the player's servers in this project
    // (Claude and Codex units, never a Chat only one), never the repository's or the player's own CLI servers.
    const mcpConfig = isClaude ? home.taskStateFile(t.id, '.mcp-config.json') : undefined
    const mcpServers = unitMcpServers(mainHome.data, t.project, adapter.id)
    const relays: McpRelays | undefined = mcpServers.length
      ? { command: process.execPath, script: path.join(ctx.appRoot, 'resources', 'genio-mcp-relay.mjs'), servers: mcpServers.map((m) => m.name) }
      : undefined
    if (mcpConfig) writeJson(mcpConfig, claudeUnitMcpConfig(relays))
    const mcp = unitMcpLaunch(adapter.id, { worktree: t.worktree, claudeConfig: mcpConfig, codexHome, adapterEnv: adapter.env, relays })
    const args = [
      ...skills.args,
      ...buildArgs(adapter, { model, effort: t.effort, prompt: opts.prompt, cwd: t.worktree, settings: settingsPath, resume: opts.resume, sessionId, launchArgs: mcp.args }, s)
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
      ...mcp.env,
      ...hookEnv,
      ...skills.env,
      ...shimEnv,
      ...depsShimEnv,
      ...(project ? depsEnv({ worktree: t.worktree, main: project.path, stateFile: depsStateFile(home.taskDir(t.id)), guard: depsGuard }) : {}),
      ...openRouterEnv(adapter.id, cheapModelsAllowed(project), openRouterKey),
      // The bible as of this launch: the player's uncommitted edits reach the unit without Genio committing anything.
      ...(project ? unitArtBibleEnv(project.path, t.worktree, home.taskDir(t.id)) : {}),
      GENIO_TASK_ID: t.id,
      GENIO_STATUS_FILE: fwd(home.statusFile(t.id)),
      GENIO_TASK_INBOX: fwd(inboxDir(t.id)),
      GENIO_BRIEF: fwd(t.briefPath),
      ...(exists(path.join(unitReferencesDir(home.taskDir(t.id)), 'references.json')) ? { GENIO_REFERENCES: fwd(unitReferencesDir(home.taskDir(t.id))) } : {})
    }
    await opts.check()
    // This launch's gateway secret: bound to this unit and these servers, revoked when its process ends.
    const grant = mcpServers.length ? await mcpGateway().grant({
      id: t.id, project: t.project, cwd: t.worktree, dataDir: mainHome.data, logFile: path.join(home.taskDir(t.id), 'mcp-calls.jsonl'),
      onFailure: (text) => safe(() => appendLine(home.statusFile(t.id), formatStatusLine('note', text, { key: 'mcp' }))),
      onSuccess: () => safe(() => getCtx().stats.unlock('mcp-call'))
    }, mcpServers) : undefined
    if (grant) Object.assign(env, grant.env)
    const term = ctx.terminals.create({ kind: 'worker', title: t.id, cwd: t.worktree, file: adapter.command, args, env, taskId: t.id, harness: adapter.id,
      unsetEnv: isClaude ? UNIT_UNSET_ENV : undefined })
    if (!term.alive) {
      grant?.revoke()
      throw new Error(`Could not start ${adapter.name} (${adapter.command}). Is it installed? Check SYSTEMS.`)
    }
    if (grant) ctx.terminals.onExit(term.id, () => grant.revoke())
    watchConsent(t, term.id, adapter.trustPatterns, adapter.trustResponse, isClaude)
    if (isClaude) watchAutocompactOffer(t, term.id)
    if (isCodex) watchCodexTrust(t, term.id, trustFolders)
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

  let sweeping: Promise<unknown> = Promise.resolve()
  const sweepOnce = (): Promise<SweepResult> => {
    const ctx = getCtx()
    // This base's worktrees folder and any Dev Drive one its units were placed in.
    const roots = [...new Set([home.worktrees, ...tasks.map((t) => path.dirname(path.dirname(t.worktree)))].filter((r) => path.basename(r) === 'worktrees'))]
    const lists = new Map<string, Promise<string[] | undefined>>()
    const key = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
    return sweepWorktrees({
      roots,
      units: tasks.map((t) => ({ id: t.id, worktree: t.worktree, live: terminalAlive(t) || t.state === 'spawning', state: t.state, stateReason: t.stateReason })),
      registered: async (folder, projectName) => {
        const repo = ctx.projects.get(projectName)?.path
        if (!repo) return undefined
        if (!lists.has(repo)) lists.set(repo, git.worktreeList(repo).then((l) => l.map((w) => key(w.path))).catch(() => undefined))
        const known = await lists.get(repo)!
        // An unreadable worktree list proves nothing: treat the folder as registered and leave it.
        return known ? known.includes(key(folder)) : true
      },
      notify: (id, message) => void svc.send(id, message).catch(() => undefined),
      log: depsLog,
      told: toldLinks,
      setup: depsGuard
    })
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
        safe(() => {
          const { spend, ...choice } = (e.fields.choice ? JSON.parse(e.fields.choice) : {}) as Partial<Decision> & { spend?: number }
          decisions.openForTask(t.id, e.key ?? 'default', e.text || (e.kind === 'blocked' ? 'The unit is blocked.' : 'The unit needs a choice.'), 'unit', {
            project: t.project,
            context: e.kind === 'blocked' ? 'blocked' : undefined,
            ...choice,
            ...(spend ? spendChoice(t, spend, grantedUsd(ctx.main.home.data, t.id), choice.context) : {})
          })
        })
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
    hasQuotaDeferred: () => quotaDeferred.has(),
    async retryQuotaDeferred() {
      await quotaDeferred.drain(async entry => {
        if (entry.kind === 'spawn') {
          const q = hc().backlog.get(entry.request.backlogId)
          if (!q || q.state !== 'queued' || q.hold) return true
          if (!canRetry(entry.request.project)) return false
          // Includes plan pauses, dates, dependencies and capacity. Do not bypass any gate.
          if (!hc().backlog.dispatchable().some(q => q.id === entry.request.backlogId)) return false
          try { await svc.spawn(entry.request); return true }
          catch (error) { return !(error instanceof QuotaDeferredError) && !/^deferred:/.test((error as Error).message) }
        }
        const t = get(entry.id)
        if (!t || !['exited', 'detached', 'failed', 'paused', 'stale', 'blocked', 'ready', 'working'].includes(t.state) || t.dislikePause) return true
        if (!canRetry(t.project)) return false
        if (['done', 'dropped'].includes(svc.questState(t) ?? '')) return true
        if (t.backlogId) {
          const q = hc().backlog.get(t.backlogId)
          if (q?.hold) return true
          const plan = hc().plans?.stepOf(t.backlogId)?.plan
          if (plan && plan.state !== 'active') return false
        }
        const result = await svc.control(entry.id, 'relaunch', entry.note, entry.manual)
        if (result.ok && entry.initial) safe(() => getCtx().stats.award('spawn', entry.id))
        return result.ok || !/^deferred:/.test(result.message)
      })
    },
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

      if (req.modeller && req.generator) throw new Error('A Build runs as a Modeller or as a Generator, not both.')
      if (req.approvedBudget) checkDeployBudget(ctx, project.name, req.approvedBudget.usd)

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
        if (launching.has(backlogId)) throw new Error(`Quest ${backlogId} is already starting.`)
        // every start path: a quest never starts before what it waits on landed, unless the player said so
        const waits = backlog.unresolved(backlogId)
        if (waits.length && !req.force && !b.depsOverride) {
          const names = waits.map((d) => {
            const dep = [...ctx.homes.values()].map((h) => h.backlog.get(d)).find(Boolean)
            return dep ? `${d} "${truncate(dep.title, 80)}" (${dep.state})` : `${d} (missing)`
          })
          throw new Error(`Quest ${backlogId} waits on ${names.join(', ')}: it starts once ${waits.length > 1 ? 'they land' : 'that lands'}. Deploying it with force starts it early.`)
        }
      } else {
        const b = backlog.add({
          title: req.title,
          project: project.name,
          kind: req.kind,
          notes: req.intent,
          summary: req.summary?.trim() || undefined,
          mode: req.kind === 'ship' ? posture.mode : undefined,
          yolo: req.kind === 'ship' ? posture.yolo : undefined,
          modeller: req.kind === 'ship' && req.modeller ? true : undefined,
          generator: req.kind === 'ship' && req.generator ? true : undefined,
          claims: req.kind === 'ship' && (req.modeller || req.generator) ? req.claims : undefined
        })
        backlogId = b.id
      }

      // the player's attachments stay with the quest, so a queued or deferred quest keeps them
      if (req.attachments?.length) stageReferences(questReferencesDir(home.data, backlogId!), req.attachments)

      // a follow-up on the same quest keeps the loadout of the unit that worked it before
      const quest = backlog.get(backlogId!)
      // The Modeller and Generator flags and their target paths come with the request, else from the quest.
      // The two never go together: a flag in the request replaces the quest's other one.
      const modeller = req.kind === 'ship' && Boolean(req.modeller ?? (req.generator ? false : quest?.modeller))
      const generator = req.kind === 'ship' && Boolean(req.generator ?? (req.modeller ? false : quest?.generator))
      const claims = modeller || generator ? [...new Set((req.claims ?? quest?.claims ?? []).map((c) => c.trim().replace(/\\/g, '/')).filter(Boolean))] : []
      if (modeller || generator) {
        const clash = claimConflict(claims, project.name, [...ctx.homes.values()].flatMap((h) => h.crew.list()))
        if (clash) throw new Error(`deferred: ${clash.path} is claimed by ${claimHolderKind(clash.holder)} ${clash.holder.id} ("${truncate(clash.holder.title, 80)}"). This quest stays queued until that unit lands or is despawned.`)
        const flag = modeller ? 'modeller' : 'generator'
        if (quest && (!quest[flag] || (modeller ? quest.generator : quest.modeller) || (req.claims && req.claims.length))) {
          safe(() => backlog.update(quest.id, { modeller: modeller || undefined, generator: generator || undefined, ...(claims.length ? { claims } : {}) }))
        }
      }
      const prev = quest?.taskId ? get(quest.taskId) : undefined
      const pickInput: LoadoutInput = {
        ...req,
        modeller,
        priority: quest?.priority,
        sticky: prev ? { from: prev.id, harness: prev.harness, model: prev.model, effort: prev.effort, category: prev.category } : undefined
      }
      launching.add(backlogId!)
      let reservation: Awaited<ReturnType<typeof ctx.dispatch.reserve>>
      try {
        reservation = await ctx.dispatch.reserve(pickInput)
      } catch (e) {
        launching.delete(backlogId!)
        // WorkPlan retries belong to plans.drain(), which records step releases and uses the latest spec.
        if (e instanceof QuotaDeferredError && !quest?.planId) quotaDeferred.put(`quest:${backlogId}`, { kind: 'spawn', request: { ...req, attachments: undefined, backlogId: backlogId! } })
        else quotaDeferred.remove(`quest:${backlogId}`)
        throw e
      }
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
        const references = copyReferences(questReferencesDir(home.data, backlogId!), unitReferencesDir(home.taskDir(id)))
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
            planContext: req.planContext,
            statusFile: home.statusFile(id),
            inboxDir: inboxDir(id),
            taskDataDir: home.taskDir(id),
            reportPath,
            engine: effectiveEngine(project).engine,
            engineLine: engineBriefLine(engineFacts(project)),
            engineHints: engineHints(effectiveEngine(project).engine),
            briefInclude: s.briefInclude,
            summaryWords: req.kind === 'scout' ? ctx.dispatch.reportWords(project.name, loadout.harness) : undefined,
            ...unitBriefSections({ pluginDir, taskDataDir: home.taskDir(id), helpDocs: helpDocsDir(ctx.appRoot), approvedUsd: req.approvedBudget?.usd,
              modeller, generator, engine: effectiveEngine(project).engine, engineRoot: effectiveEngine(project).root, claims }),
            artBible: artBibleBrief(project.path, wt, id),
            designNotes: designNotesBriefLines(wt),
            mcpServers: mcpBriefNames(loadout.harness, project.name),
            references: referencesBrief(id, { modeller, generator }),
            submodules,
            nodeDeps: nodeDeps(id, wt, modeller)
          })
        )

        const harness = loadout.harness
        const now = nowIso()
        const summary = req.summary?.trim() || quest?.summary?.trim()
        const task: Task = {
          id,
          kind: req.kind,
          title: req.title.trim(),
          project: project.name,
          workspace: home.name,
          backlogId,
          mode: req.kind === 'ship' ? posture.mode : undefined,
          yolo: req.kind === 'ship' ? posture.yolo : undefined,
          branchPrefix: posture.branchPrefix,
          baseBranch,
          branch,
          worktree: wt,
          briefPath,
          ...(summary ? { summary } : {}),
          reportPath,
          harness,
          model: loadout.model,
          effort: loadout.effort,
          loadout: loadout.reasons,
          category: loadout.category,
          ...(modeller ? { modeller: true, ...(claims.length ? { claims } : {}) } : {}),
          ...(generator ? { generator: true, ...(claims.length ? { claims } : {}) } : {}),
          loadoutSource: loadout.source,
          ruleId: loadout.ruleId,
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
        // The player's up-front approval becomes the unit's first spend grant, before it launches.
        if (req.approvedBudget) {
          const b = req.approvedBudget
          const how = b.via === 'dialog' ? 'approved budget in the Deploy dialog' : `approved budget at deploy, in their own words: "${truncate(b.words ?? '', 160)}"`
          try {
            const g = grantAtDeploy(ctx, task, b.usd, how)
            appendLine(home.statusFile(id), formatStatusLine('note', `spend grant from the player: USD ${fmtUsd(g.granted)} (${how})`, { key: 'spend' }))
          } catch (e) {
            appendLine(home.statusFile(id), formatStatusLine('note', `the approved budget could not be recorded (${(e as Error).message}); no spend is approved`, { key: 'spend' }))
          }
        }
        try {
          const term = await launch(task, { resume: false, prompt: kickoffPrompt(briefPath), check: reservation.check })
          update(id, { terminalId: term.id, state: 'working', stateReason: posture.warning ?? 'deployed' })
        } catch (e) {
          if (e instanceof QuotaDeferredError) {
            // Keep the prepared copy and plan step; quota deferral is not a failed mission.
            backlog.markInFlight(backlogId!, id)
            update(id, { state: 'paused', stateReason: e.message })
            quotaDeferred.put(`unit:${id}`, { kind: 'relaunch', id, manual: false, initial: true })
            quotaDeferred.remove(`quest:${backlogId}`)
          } else update(id, { state: 'failed', stateReason: (e as Error).message })
          throw e
        }
        safe(() => backlog.markInFlight(backlogId!, id))
        quotaDeferred.remove(`quest:${backlogId}`)
        ledger('task.dispatched', task, { kind: task.kind, project: task.project, harness, model: task.model ?? 'default', effort: task.effort ?? 'default', category: loadout.category, loadout: loadout.source, rule: loadout.ruleId, mode: task.mode, yolo: task.yolo })
        safe(() => ctx.stats.award('spawn', id))
        if (references.length) bus.publish({ type: 'feature-used', feature: 'unit-references', id })
        safe(() => ctx.notifier.sfx('spawn'))
        return get(id)!
      } finally {
        launching.delete(backlogId!)
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
      const ctx = getCtx()
      const adapter = ctx.settings.harness(t.harness)
      const claude = t.harness === 'claude'
      const marker = (suffix: string): number => {
        try {
          return fs.statSync(home.taskStateFile(id, suffix)).mtimeMs
        } catch {
          return 0
        }
      }
      const startedBefore = marker('.turn-started')
      // A unit in mid-turn queues the line: it starts no turn and draws no new working line, so only an idle one confirms.
      const busy = claude ? startedBefore > marker('.turn-ended') : Date.now() - (ctx.terminals.lastOutputAt(t.terminalId!) ?? 0) < 2_000
      const taken = await ctx.terminals.submit(t.terminalId!, doorbellLine(inboxDir(id)), adapter?.submitKey ?? '\r',
        (since) => busy || TUI_WORKING.test(squashTui(since)) || (claude && marker('.turn-started') > startedBefore))
      const cur = get(id)!
      // A ping delivered to a ready unit's CLI starts a new turn.
      update(id, { inbox: { ...cur.inbox, lastRingAt: nowIso(), rings: cur.inbox.rings + 1 }, ...(cur.state === 'ready' ? { resumedAt: nowIso() } : {}) })
      const seq = svc.unreadInbox(id)[0]?.seq
      if (taken === false && seq !== undefined && unsubmitted.get(id) !== seq && terminalAlive(cur)) {
        // The doorbell sits typed in the unit's input box: say so once per ping, plainly.
        unsubmitted.set(id, seq)
        safe(() => hc().wakes.enqueue({ kind: 'stale', taskId: id, routine: false,
          reason: `${cur.kind === 'scout' ? 'RECON' : 'BUILD'} "${cur.title}" (${cur.project}): ping #${seq} was typed into the unit's terminal but not submitted (Enter retried; the unit did not start on it)`,
          lines: ctx.terminals.tail(cur.terminalId!, 8).split('\n').filter((l) => l.trim()).map((l) => `| ${truncate(l, 200)}`) }))
      }
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
          quotaDeferred.remove(`unit:${id}`)
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
          quotaDeferred.remove(`unit:${id}`)
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
            harness: t.harness, model: t.model, effort: t.effort }, { respawn: { id, workspace: home.name } })
        } catch (e) {
          if (e instanceof QuotaDeferredError) quotaDeferred.put(`unit:${id}`, { kind: 'relaunch', id, note, manual })
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
            quotaDeferred.remove(`unit:${id}`)
            return {
              ok: true,
              message: `Respawned ${id}.`
            }
          } catch (e) {
            if (e instanceof QuotaDeferredError) {
              quotaDeferred.put(`unit:${id}`, { kind: 'relaunch', id, note, manual })
              if (restarting.has(id)) update(id, { state: 'paused', stateReason: e.message, automaticRelaunches: t.automaticRelaunches,
                terminalId: terminalAlive(t) ? t.terminalId : undefined })
              return { ok: false, message: e.message }
            }
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

    async cleanup(id, force = false, by): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (t.state === 'cleaned') return { ok: true, message: `${id} is already despawned.` }
      const ctx = getCtx()
      const project = ctx.projects.get(t.project)
      const repo = project?.path ?? (exists(t.worktree) ? await git.repoTop(t.worktree) : '')
      // Never the main copy or any registered project's folder, forced or not.
      const own = [repo, ...(ctx.projects.list?.() ?? []).map((p) => p.path)].find((p) => p && git.sameFolder(p, t.worktree))
      if (own) return { ok: false, message: `Refusing to despawn ${id}: its folder ${fwd(own)} is a project's own copy.` }
      const openChoices = hc().decisions.list(false).filter((d) => d.taskId === id)
      let via = 'forced'
      // force only goes past what would be lost; a landed unit despawns as without it
      let forced = force
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
          return { ok: false, message: `Refusing to despawn ${id}: unlanded work (${verdict.reasons.join('; ')}). Despawning with force discards it.${git.unlandedDetail(verdict)}` }
        }
        forced = !verdict.landed
        via = verdict.landed ? `landed (${verdict.via})` : by === 'mode' ? 'forced in YOLO' : 'forced by the player'
      } else if (!force) {
        return { ok: false, message: `Cannot verify ${id}'s work: its project is not registered. Despawning with force discards whatever it holds.` }
      }
      // The agent and every terminal tied to the unit (a terminal pane open in its copy): a shell there would block its removal.
      if (t.terminalId) ctx.terminals.kill(t.terminalId)
      const shells = ctx.terminals.list().filter((term) => term.taskId === id)
      for (const term of shells) ctx.terminals.kill(term.id)
      // Give a killed terminal a moment to release its working directory (Windows).
      if (shells.some((term) => term.alive)) await sleep(500)
      // A linked node_modules goes first, the link only: removing the worktree must never reach through it.
      const linkedDeps = path.join(t.worktree, 'node_modules')
      if (isLink(linkedDeps)) {
        try {
          depsLog({ event: 'deps.link-removed', unit: id, ...removeLinkSafely(linkedDeps) })
        } catch (e) {
          return { ok: false, message: `Refusing to despawn ${id}: could not remove the node_modules link at ${fwd(linkedDeps)} (${(e as Error).message}). Remove only the link with cmd /c rmdir, never a recursive delete.` }
        }
      }
      // A Play copy reading this worktree finishes first, or stops cleanly after a short bounded wait.
      await yieldSource(t.worktree)
      let leftover = ''
      if (repo) {
        const scratch = t.kind === 'scout' || forced
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
        await git.deleteBranch(repo, t.branch, t.kind === 'scout' || forced)
      }
      // update() closes the quest this unit was flying (followUnit); a re-queued follow-up stays queued
      const discarded = via === 'forced' || via === 'forced by the player' || via === 'forced in YOLO' || via === 'recon ended without a report'
      update(id, { state: 'cleaned', cleanedAt: nowIso(), terminalId: undefined, stateReason: `despawned: ${via}`, ...(discarded ? { discarded } : {}) })
      sourceRemoved(t.worktree)
      // A Modeller's step snapshots and GLBs go; manifests, renders and scripts stay as history.
      const pruned = (() => {
        try {
          return t.modeller ? pruneModellerData(modellerDataDir(home.taskDir(id))) : undefined
        } catch {
          return undefined
        }
      })()
      ledger('task.cleaned_up', t, { via, ...(discarded && by ? { by } : {}), ...(pruned?.files ? { modellerPruned: pruned } : {}) })
      safe(() => ctx.stats.award('cleanup', id))
      void svc.sweepWorktrees().catch(() => undefined)
      return { ok: true, message: `Despawned ${id} (${via}).${leftover}` }
    },

    sweepWorktrees(): Promise<SweepResult> {
      // One sweep at a time: a despawn during the startup sweep queues behind it.
      const next = sweeping.catch(() => undefined).then(sweepOnce)
      sweeping = next
      return next
    },

    async merge(id, approval, opts): Promise<OpResult> {
      const t = get(id)
      if (!t) return { ok: false, message: `Unknown unit: ${id}` }
      if (t.kind !== 'ship') return { ok: false, message: 'Recon missions have nothing to merge.' }
      const ctx = getCtx()
      const project = ctx.projects.get(t.project)
      if (!project) return { ok: false, message: `Project ${t.project} is not registered.` }
      let result: OpResult
      let mergeVia: 'pr' | 'local'
      let landedCommit: string | undefined
      // what the branch changed, read while it still exists: the next plan step's handoff note
      const landedFiles = (await git.changedFiles(project.path, t.baseBranch, t.branch).catch(() => [] as string[])).slice(0, 200)
      if (t.pr?.url) {
        mergeVia = 'pr'
        result = await ctx.forge.merge(t.pr.url, (await git.isWorktreeOf(project.path, t.worktree)) ? t.worktree : project.path, opts)
      } else if (t.mode === 'local-only') {
        if (t.state !== 'ready' && !opts?.override) return { ok: false, message: `${id} has not reported a ready branch yet.` }
        mergeVia = 'local'
        const r = await git.mergeLocalFastForward(project.path, t.branch, t.baseBranch)
        result = r.code === 0 ? { ok: true, message: `Landed ${t.branch} into local ${t.baseBranch}.` } : { ok: false, message: r.stderr.trim() || 'fast-forward merge failed' }
        if (result.ok) landedCommit = (await git.headSha(project.path, t.branch)) || undefined
      } else {
        return { ok: false, message: `${id} has no registered PR to merge yet.` }
      }
      if (!result.ok) return result
      update(id, { state: 'merged', landedAt: nowIso(), landedCommit, ...(landedFiles.length ? { landedFiles } : {}), stateReason: mergeVia === 'pr' ? 'PR merged' : `landed in local ${t.baseBranch}`,
        pr: t.pr ? { ...t.pr, state: 'MERGED', checkedAt: nowIso() } : undefined, ...(approval ? { mergeApproval: approval } : {}) })
      ledger('task.merged', t, { via: mergeVia, pr: t.pr?.url, ...(approval ? { approval } : {}) })
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
          engine: effectiveEngine(project).engine,
          engineLine: engineBriefLine(engineFacts(project)),
          engineHints: engineHints(effectiveEngine(project).engine),
          briefInclude: ctx.settings.get().briefInclude,
          // The same skill set as at deploy, and the grant the player approved so far.
          ...unitBriefSections({ pluginDir, taskDataDir: home.taskDir(id), helpDocs: helpDocsDir(ctx.appRoot), approvedUsd: grantedUsd(mainHome.data, id) }),
          artBible: artBibleBrief(project.path, t.worktree, id),
          designNotes: designNotesBriefLines(t.worktree),
          mcpServers: mcpBriefNames(t.harness, project.name),
          nodeDeps: nodeDeps(id, t.worktree),
          references: referencesBrief(id, {}),
          carriedReport: report || '(the recon report was empty)'
        })
      )
      update(id, { kind: 'ship', mode: posture.mode, yolo: posture.yolo, promotedFrom: id, state: 'working', stateReason: 'upgraded to Build',
        summary: 'Builds what the Recon report recommends, within the ask above.' })
      if (t.backlogId) safe(() => hc().backlog.update(t.backlogId!, { kind: 'ship', mode: posture.mode, yolo: posture.yolo }))
      const r = await svc.control(id, 'relaunch', 'Upgraded from Recon to Build: the brief now has a Build definition of done. Implement it.')
      if (!r.ok) {
        writeText(t.briefPath, oldBrief)
        update(id, { kind: t.kind, mode: t.mode, yolo: t.yolo, promotedFrom: t.promotedFrom, summary: t.summary,
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
                const msg = readText(path.join(dir, sub, f))
                const at = msg.match(/^at=(\S+)$/m)?.[1]
                parts.push(`--- ${label} ${f}${at ? ` at=${at}` : ''} ---\n${msg.split('\n--\n').slice(1).join('\n--\n').trim()}`)
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
        case 'diffstat': {
          if (!exists(t.worktree)) return '(worktree removed)'
          const project = getCtx().projects.get(t.project)
          const ref = project ? await git.baseRef(project.path, t.baseBranch, t.mode === 'local-only') : t.baseBranch
          const [stat, commits, uncommitted] = await Promise.all([git.diffStat(t.worktree, ref), git.logOneline(t.worktree, `${ref}..HEAD`, 50), git.statusPorcelain(t.worktree)])
          return JSON.stringify({ stat, commits, uncommitted })
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
      let writtenAt = 0
      try {
        const st = fs.statSync(file)
        size = st.size
        writtenAt = Math.min(st.mtimeMs, Date.now())
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
      // Whole lines only (a UTF-16 newline's NUL included), decoded however the unit's shell wrote them.
      const lines = completeLines(buf)
      if (!lines) return [] // wait for a complete line
      const chunk = decodeBytes(buf.subarray(0, lines))
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
          // A new status line after the ready one is the unit at work again (a repeated done is not).
          // Stamped with when it was written, so a turn that ended since still reads as idle.
          if (get(id)?.state === 'ready' && e.kind !== 'done') update(id, { resumedAt: new Date(writtenAt || Date.now()).toISOString() })
          applyStatus(t, e)
        } catch {
          /* one bad line never stops overwatch */
        }
        ledger('task.status', t, { state: e.kind, key: e.key, text: truncate(e.text, 2000) })
        bus.publish({ type: 'status', event: e })
      }
      update(id, { statusOffset: offset + lines, lastStatusAt: nowIso() })
      return events
    },

    statusEvents: (id) => parseStatusLog(readText(home.statusFile(id)), id),
    openDecisionKeys: (id) => resolveKeysFor(id),

    // One tasks.json write for the pass, not one per unfinished unit (each a rewrite of the whole roster).
    reconcileOnStart: (project) => batch(async () => {
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
    }),

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
