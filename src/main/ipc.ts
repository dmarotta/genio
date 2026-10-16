import path from 'node:path'
import { modelCatalogue, invalidateModelCatalogue } from './model-catalogue'
import { agentGeneration } from './agent-generation'
import { readWorldMetadata } from './world-metadata'
import { assertProjectWindow, playService } from './play'
import { playerCopyService } from './player-copy'
import { playerInstanceService } from './player-instance'
import { playerSources, sourceUnit } from './player-sources'
import { modelViewer } from './model-viewer'
import { readModellerLive } from './modeller-live'
import { createLiveWatch } from './modeller-watch'
import { modellerAction } from './modeller-actions'
import { unitFilePreview } from './unit-file-preview'
import { baseRef } from './git'
import { modellerDataDir, modellerScript, unitPluginSource } from './unitskills'
import { standingApprovals } from './standing-approvals'
import { readArtBibleView, writeArtBibleFile } from './art-bible'
/**
 * IPC: one ipcMain.handle per GenioApi method ('genio:<method>'). The table is
 * typed against GenioApi so a missing or mistyped method fails the build.
 */
import { bus } from './bus'
import { app, BrowserWindow, dialog, ipcMain, shell, MessageChannelMain } from 'electron'
import { createExplorerIntegration, explorerCommand } from './explorer'
import { API_PREFIX, type GenioApi, type OpResult, type WindowList } from '@shared/api'
import type { BacklogItem, Task } from '@shared/types'
import { listAccounts, openAccountSession } from './accounts'
import { answerChoice, clarifyChoice, applyRecommendations, findDecision, findTask } from './wksp-tools'
import { resolveLoadout } from './loadout'
import { sendPlayerChat } from './wksp'
import { clearSecret, secretStatus, setSecret } from './secrets'
import { usageReport } from './usage'
import { sessionCleanupPreview, sessionCleanupProgress, sessionCleanupRun, sessionCleanupUndo } from './session-migration'
import type { AppCtx, HomeCtx } from './services'
import { ownsDecision } from '@shared/decisions'
import { projectSnapshot, terminalProject, type WindowBinding } from './project-windows'
import { closePane, openPane, paneCwds, runShell } from './terminal-pane'
import { isShellCommandMessage } from '@shared/terminal-pane'

/** A '!' message is a shell command the composer runs itself: it never reaches the model as chat text. */
function refuseShellText(text: string): void {
  if (isShellCommandMessage(text)) throw new Error('Messages starting with ! are shell commands: they run in the terminal and are never sent to Genio as chat.')
}

/** Play audio rides outside the frame credits: at most AUDIO_IN_FLIGHT packets (about 250 ms) the renderer has not
 * acked with `{ type: 'audio-ack', count }`, then a short backlog that drops its oldest packet when it overflows. */
export const AUDIO_IN_FLIGHT = 12, AUDIO_BACKLOG = 4

type Handlers ={ [K in keyof GenioApi]: (...args: Parameters<GenioApi[K]>) => ReturnType<GenioApi[K]> | Awaited<ReturnType<GenioApi[K]>> }

/** The window manager as IPC sees it; sender ids are the calling window's webContents id. */
export interface IpcWindows {
  openProject(folder: string): Promise<void>
  binding(senderId: number): WindowBinding | undefined
  list(senderId: number): WindowList['windows']
  openHub(): Promise<void>
  close(senderId: number): void
}

export function registerIpc(getCtx: () => AppCtx, windows?: IpcWindows): void {
  const ctx = (): AppCtx => getCtx()
  const explorer = createExplorerIntegration(explorerCommand(process.execPath, process.defaultApp ? app.getAppPath() : undefined))
  const inventoryClients = new Map<number, Set<string>>()
  const playConnections = new Map<string, () => void>()
  // Play achievements are best effort: a stats problem never breaks a stream, input or a Play.
  const unlockQuietly = (id: string): void => { try { ctx().stats.unlock(id) } catch { /* stats unavailable */ } }
  const closeUnusedInventory = (world: string): void => {
    if (![...inventoryClients.values()].some(worlds => worlds.has(world))) ctx().inventory.close(world)
  }
  const taskHome = (id: string): { hc: HomeCtx; task: Task } => {
    const f = findTask(ctx(), id)
    if (!f) throw new Error(`no unit/mission ${id}`)
    return f
  }
  /** A unit's model as the live view reads it, step files served through its one viewer grant. */
  const unitModel = (hc: HomeCtx, task: Task): ReturnType<typeof readModellerLive> => {
    const data = modellerDataDir(hc.home.taskDir(task.id))
    return readModellerLive(data, () => modelViewer().grantUnit(task.id, { modeller: data, worktree: task.worktree }), task.worktree)
  }
  // While a page reads a unit's model, a change on disk is pushed at once; its poll is the fallback.
  const liveWatch = createLiveWatch()
  const pushed = new Map<string, string | undefined>()
  const watchUnitModel = (hc: HomeCtx, task: Task, stamp: string | undefined): void => {
    pushed.set(task.id, stamp)
    liveWatch.touch(task.id, [modellerDataDir(hc.home.taskDir(task.id)), path.join(task.worktree, '.genio', 'modeller')], () => {
      const f = findTask(ctx(), task.id)
      if (!f) return
      const live = unitModel(f.hc, f.task)
      if (live?.stamp === pushed.get(task.id)) return
      pushed.set(task.id, live?.stamp)
      bus.publish({ type: 'modeller-live', taskId: task.id, live })
    })
  }
  const projectRoot = (world: string): string => {
    const root = ctx().projects.get(world)?.path
    if (!root) throw new Error(`Project not loaded: ${world}`)
    return root
  }
  const backlogHome = (id: string): HomeCtx => {
    for (const hc of ctx().homes.values()) if (hc.backlog.get(id)) return hc
    throw new Error(`no quest ${id}`)
  }
  const planHome = (id: string): HomeCtx => {
    for (const hc of ctx().homes.values()) if (hc.plans?.get(id)) return hc
    throw new Error(`no plan ${id}`)
  }
  /**
   * The quest page Dispatch button: a quest that waits on unlanded dependencies
   * is refused, unless the player chose Dispatch anyway. That click is their word
   * for this one early start, recorded on the quest for the launch to honour.
   */
  const dependencyGate = (hc: HomeCtx, id: string, force?: boolean): OpResult | undefined => {
    const waits = hc.backlog.unresolved(id)
    if (!waits.length) return undefined
    if (force) {
      hc.backlog.update(id, { depsOverride: { at: new Date().toISOString(), via: 'ui-button' } })
      return undefined
    }
    const names = waits.map((d) => [...ctx().homes.values()].map((x) => x.backlog.get(d)).find(Boolean)?.title ?? d)
    return { ok: false, message: `This quest waits on ${names.map((n) => `"${n}"`).join(', ')}: it starts once ${waits.length > 1 ? 'they land' : 'that lands'}. Use Dispatch anyway to start it now.` }
  }
  const dispatchMessage = (hc: HomeCtx, item: BacklogItem, force?: boolean): string => {
    const step = hc.plans?.stepOf(item.id)
    const how = step
      ? `it is step ${step.step.index} of plan ${step.plan.id}: deploy it with quest_id=${item.id}; the plan supplies its spec, loadout and handoff note`
      : `resolve its posture, write the unit's intent from the quest notes, and deploy it with quest_id=${item.id}`
    return `Dispatch quest ${item.id} ("${item.title}"${item.project ? ` in ${item.project}` : ''}) now: ${how}.${force ? ' The player chose Dispatch anyway: it starts before the quests it waits on land (Genio recorded their click on the quest).' : ''}${step ? '' : `\nQuest notes: ${item.notes}`}`
  }

  const h: Handlers = {
    playPool: world => playService(ctx()).poolState(world),
    playPoolCap: (world, cap) => playService(ctx()).configurePool(world, cap),
    playPoolLaunch: (world, visible) => playService(ctx()).configureLaunch(world, visible),
    playPoolEstimate: world => playService(ctx()).pool(world).estimate(),
    playPoolDisk: world => playService(ctx()).pool(world).disk(),
    playCloseSlotEditor: (world, id) => playService(ctx()).closeSlotEditor(world, id, 'player'),
    playerCopies: async () => playerCopyService(ctx()).list(),
    playerCopyStatus: async world => playerCopyService(ctx()).status(world),
    playerCopyEnsure: world => playerInstanceService(ctx()).ensureCopy(world),
    playerCopySync: (world, source) => playerInstanceService(ctx()).syncCopy(world, source),
    playerCopyCancel: async world => playerCopyService(ctx()).cancel(world),
    playerCopyDelete: world => playerInstanceService(ctx()).deleteCopy(world),
    playerCopySizes: world => playerCopyService(ctx()).sizes(world),
    playerInstanceStatus: async world => { await playerInstanceService(ctx()).start(); return playerInstanceService(ctx()).status(world) },
    playerInstancePlay: async (world, source, options) => {
      const status = await playerInstanceService(ctx()).play(world, source, options)
      try { if (sourceUnit(ctx(), world, source)) unlockQuietly('play-unit') } catch { /* achievements never fail a Play */ }
      return status
    },
    playerInstanceStartUnity: (world, source, options) => playerInstanceService(ctx()).startUnity(world, source, options),
    playerInstanceEnterPlay: async (world, source, options) => {
      const status = await playerInstanceService(ctx()).enterPlay(world, source, options)
      try { if (sourceUnit(ctx(), world, source)) unlockQuietly('play-unit') } catch { /* achievements never fail a Play */ }
      return status
    },
    playerInstanceExitPlay: world => playerInstanceService(ctx()).exitPlay(world),
    playerInstanceStopUnity: world => playerInstanceService(ctx()).stopUnity(world),
    playerInstancePause: (world, paused) => playerInstanceService(ctx()).pause(world, paused),
    playerInstanceStep: async world => { const status = await playerInstanceService(ctx()).step(world); unlockQuietly('play-step'); return status },
    playerInstanceScenes: world => playerInstanceService(ctx()).scenes(world),
    playerInstanceSetScene: (world, scene) => playerInstanceService(ctx()).setScene(world, scene),
    playerInstanceResize: async (world, width, height) => { const status = await playerInstanceService(ctx()).resize(world, width, height); unlockQuietly('play-resolution'); return status },
    playerInstanceStop: world => playerInstanceService(ctx()).stop(world),
    playerInstanceQuit: world => playerInstanceService(ctx()).quit(world),
    playerInstanceRestart: (world, visible) => playerInstanceService(ctx()).restart(world, visible),
    playerInstanceDetach: world => playerInstanceService(ctx()).detach(world),
    playerInstanceSettings: (world, patch) => playerInstanceService(ctx()).configure(world, patch),
    playerInstanceMachine: world => playerInstanceService(ctx()).machine(world),
    playerInstanceConsole: (world, cursor, session) => playerInstanceService(ctx()).console(world, cursor, session),
    playerInstanceStream: async () => { throw new Error('Streaming requires the owning project window') },
    playerSources: world => playerSources(ctx(), world),
    playerSourceAvailable: (world, source) => playerInstanceService(ctx()).sourceAvailable(world, source),
    inventoryOpen: async (world) => {
      const state = await ctx().inventory.open(world)
      ctx().stats.unlock('inventory-open')
      return state
    },
    inventoryClose: (world) => ctx().inventory.close(world),
    inventoryRefresh: (world) => ctx().inventory.refresh(world),
    inventoryList: (world, query) => ctx().inventory.list(world, query),
    inventoryInfo: async (world, asset, verifyHash) => {
      const info = await ctx().inventory.info(world, asset, verifyHash)
      if (info) ctx().stats.unlock('inventory-preview')
      return info
    },
    inventoryModelUrl: (world, asset) => modelViewer().grant(world, asset, true),
    inventoryModelRelease: async (url, completeOnly) => modelViewer().revoke(url, completeOnly === true),
    modellerLive: (id) => {
      const { hc, task } = taskHome(id)
      const live = unitModel(hc, task)
      // A Generator stays a Generator (never both), even when it made a model with the kernel.
      if (live && !task.modeller && !task.generator && task.kind === 'ship') hc.crew.update(id, { modeller: true })
      if (!task.generator && task.state !== 'cleaned') watchUnitModel(hc, task, live?.stamp)
      return live
    },
    modellerAct: async (id, act) => {
      const { hc, task } = taskHome(id)
      if (task.state === 'cleaned') return { ok: false, message: 'This unit was despawned; its model can no longer change.' }
      const done = await modellerAction(modellerScript(unitPluginSource(ctx().appRoot)), modellerDataDir(hc.home.taskDir(id)), act)
      const told = await hc.crew.send(id, done.ping)
      if (act.op === 'revert' || act.op === 'branch') unlockQuietly('modeller-rewind')
      return { ok: true, message: told.ok ? done.message : `${done.message} The unit was not told: ${told.message}` }
    },
    unitFilePreview: async (id, file) => {
      const { hc, task } = taskHome(id)
      const project = ctx().projects.get(task.project)
      const ref = project ? await baseRef(project.path, task.baseBranch, task.mode === 'local-only') : task.baseBranch
      return unitFilePreview({ worktree: task.worktree, ref, file, projectRoot: project?.path, world: project ? task.project : undefined, modeller: () => unitModel(hc, task) })
    },
    artBibleRead: async (world) => readArtBibleView(world, projectRoot(world)),
    artBibleWrite: async (world, file, text) => {
      const view = writeArtBibleFile(world, projectRoot(world), file, text)
      unlockQuietly('art-bible-edit')
      return view
    },
    featureUsed: async (feature) => {
      if (feature === 'screenshot' || feature === 'model-picker' || feature === 'character-sheet' || feature === 'play-fullscreen') bus.publish({ type: 'feature-used', feature })
    },
    trophyPin: (id, pinned) => ctx().stats.pin(String(id), pinned === true),
    titleEquip: (id) => ctx().stats.equipTitle(id ?? null),
    snapshot: () => ctx().snapshot(),
    homePath: () => ctx().main.home.root,
    getSettings: () => ctx().settings.get(),
    explorerStatus: () => explorer.status(),
    explorerSet: async enabled => {
      const state = await explorer.set(enabled)
      if (enabled && state.installed) ctx().stats.unlock('explorer-install')
      return state
    },
    saveSettings: (patch) => {
      const previousModel = ctx().settings.get().wkspModel
      const previousMode = ctx().settings.get().usageMode
      const s = ctx().settings.save(patch)
      if ('wkspModel' in patch && previousModel !== s.wkspModel) bus.publish({ type: 'feature-used', feature: 'model-switch' })
      if ('usageMode' in patch && previousMode !== s.usageMode) bus.publish({ type: 'feature-used', feature: 'usage-mode' })
      if ('claudePath' in patch) invalidateModelCatalogue()
      if ('inboxServer' in patch || 'inboxPort' in patch || 'inboxToken' in patch) ctx().inbox.configure()
      return s
    },
    toolchain: () => ctx().toolchain.check(),
    installTool: (name) => ctx().toolchain.install(name),
    pickDirectory: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(w => w.isFocusable())
      const r = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    // The caller's window is resolved from the IPC sender below.
    windowList: () => ({ projects: ctx().projects.list().map(({ name, path, addedAt }) => ({ name, path, addedAt })), windows: [] }),
    windowOpenHub: async () => {
      if (!windows) throw new Error('Hub window manager is unavailable. Restart Genio and try again.')
      await windows.openHub()
    },
    windowClose: async () => { throw new Error('Closing requires the calling window') },
    openPath: async (p) => {
      await shell.openPath(p)
    },
    revealPath: async (p) => {
      shell.showItemInFolder(p)
    },
    openExternal: async (url) => {
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
    },

    modelCatalogue: (refresh) => modelCatalogue(ctx().main.home.data, refresh, ctx().settings.get().claudePath),
    // ---- accounts
    accounts: async () => {
      const list = await listAccounts()
      ctx().dispatch.noteLogins(list)
      return list
    },
    accountSession: (tool, action) => openAccountSession(ctx(), tool, action),
    accountUsage: async () => {
      const r = await usageReport(ctx())
      ctx().dispatch.noteUsage(r)
      return r
    },
    usagePolicy: async () => ctx().dispatch.view(),
    apiKeys: () => secretStatus(ctx().main.home.data),
    apiKeySet: (id, key) => {
      setSecret(id, key, ctx().main.home.data)
      invalidateModelCatalogue()
      return { ok: true, message: 'Key saved (encrypted).' }
    },
    apiKeyClear: (id) => {
      clearSecret(id, ctx().main.home.data)
      invalidateModelCatalogue()
      return { ok: true, message: 'Key cleared.' }
    },
    // Housekeeping runs only from these Settings clicks, never automatically.
    sessionCleanupPreview: () => sessionCleanupPreview(ctx()),
    sessionCleanupRun: (keys) => sessionCleanupRun(ctx(), Array.isArray(keys) ? keys.map(String) : []),
    sessionCleanupProgress: () => sessionCleanupProgress(),
    sessionCleanupUndo: () => sessionCleanupUndo(ctx()),

    // Per-world generation settings; generation itself is driven by agent tools.
    falWorld: (world) => ctx().fal.world(world),
    falWorldConfig: (world, config) => ctx().fal.saveWorldConfig(world, config),
    uthanaWorld: (world) => ctx().uthana.world(world),
    uthanaWorldConfig: (world, config) => ctx().uthana.saveWorldConfig(world, config),

    // ---- comms
    approveGeneration: (wksp, run) => agentGeneration(ctx()).approve(run, wksp, 'Approved this exact quote in chat'),
    chatHistory: (wksp, limit) => ctx().home(wksp).wksp.history(limit),
    sendChat: (wksp, text, images, context) => { refuseShellText(text); return sendPlayerChat(ctx(), wksp, text, images, context) },
    unqueueChat: async (wksp, id) => ctx().home(wksp).wksp.unqueue(id),
    steerChat: (wksp, text, images, context) => { refuseShellText(text); return ctx().home(wksp).wksp.steer(text, images, context) },
    sendQueuedNow: async (wksp, id) => ctx().home(wksp).wksp.sendNow(id),
    reactToMessage: (wksp, id, kind) => ctx().home(wksp).reactions.react(id, kind),
    interruptWksp: (wksp) => ctx().home(wksp).wksp.interrupt(),
    restartWksp: (wksp, fresh, role) => ctx().home(wksp).wksp.restart(fresh, role),
    resolvePermission: (id, allow) => ctx().permissions.resolve(id, allow),
    recap: () => ctx().main.wksp.send('/recap', 'player'),
    save: () => ctx().main.wksp.send('/save', 'player'),

    // ---- squad
    spawnTask: (req) => ctx().home(req.wksp ?? 'main').crew.spawn(req),
    previewLoadout: async (req) => resolveLoadout(req, ctx().settings, ctx().dispatch.signals(req.project, { preview: true })),
    rateTask: async (id, verdict, note) => ctx().dispatch.rate(id, verdict, note),
    dispatchScores: async () => ctx().dispatch.scores(),
    sendToTask: async (id, text, resolveKey) => {
      const { hc } = taskHome(id)
      const r = await hc.crew.send(id, text, resolveKey ? [resolveKey] : undefined)
      if (r.ok && resolveKey) hc.decisions.resolveKey(id, resolveKey, text)
      return r
    },
    controlTask: (id, action) => taskHome(id).hc.crew.control(id, action, undefined, true),
    cleanupTask: (id, force) => taskHome(id).hc.crew.cleanup(id, force),
    // A click on MERGE is the player's explicit word for this merge. Only this renderer path records ui-button;
    // the model's merge tool never reaches it.
    mergeTask: (id) => taskHome(id).hc.crew.merge(id, { kind: 'ui-button', at: new Date().toISOString() }),
    revokeStandingApproval: async (id) => {
      const gone = standingApprovals(ctx()).revoke(id)
      return gone ? { ok: true, message: `Standing merge approval for ${gone.project} revoked.` } : { ok: false, message: 'That standing approval already ended.' }
    },
    promoteScout: (id, intent) => taskHome(id).hc.crew.promote(id, intent),
    readTaskFile: (id, which) => taskHome(id).hc.crew.readFile(id, which),

    // ---- terminals
    terminals: () => ctx().terminals.list(),
    terminalAttach: (id) => ctx().terminals.scrollback(id),
    terminalWrite: (id, data) => ctx().terminals.write(id, data),
    terminalResize: (id, cols, rows) => ctx().terminals.resize(id, cols, rows),
    terminalKill: (id) => ctx().terminals.kill(id),
    // The player's own terminal pane (project windows only; see the binding checks below).
    paneCwds: async (world) => paneCwds(ctx(), world),
    paneOpen: async (world, cwd, restart, size) => openPane(ctx(), world, cwd, restart, size),
    paneClose: async (world) => closePane(ctx(), world),
    paneRun: async (world, wksp, command, cwd, size) => runShell(ctx(), world, wksp, command, cwd, size),

    // ---- quest log
    backlogAdd: (item) => ctx().main.backlog.add(item),
    backlogUpdate: (id, patch) => backlogHome(id).backlog.update(id, patch),
    backlogHold: (id, reason, until) => backlogHome(id).backlog.hold(id, reason, until),
    backlogRelease: (id) => backlogHome(id).backlog.release(id),
    backlogDispatch: async (id, force) => {
      const hc = backlogHome(id)
      const item = hc.backlog.get(id)!
      if (item.hold) return { ok: false, message: 'this quest is held for you; release it first' }
      const waits = dependencyGate(hc, id, force)
      if (waits) return waits
      // Writing the brief needs judgment: hand the quest to Genio.
      await hc.wksp.send(dispatchMessage(hc, item, force), 'system')
      return { ok: true, message: 'Genio is deploying this quest' }
    },
    backlogRemove: (id) => backlogHome(id).backlog.remove(id),
    backlogReorder: (patches) => {
      const byHome = new Map<HomeCtx, typeof patches>()
      for (const p of patches) {
        const h = backlogHome(p.id)
        byHome.set(h, [...(byHome.get(h) ?? []), p])
      }
      return [...byHome].flatMap(([h, list]) => h.backlog.reorder(list))
    },
    planControl: async (id, action) => {
      const hc = planHome(id)
      const plan = hc.plans.get(id)!
      if (action === 'pause' && plan.state !== 'active') return { ok: false, message: `This plan is already ${plan.state}.` }
      if (action === 'cancel' && (plan.state === 'cancelled' || plan.state === 'done')) return { ok: false, message: `This plan is already ${plan.state}.` }
      const r = await hc.plans.update(id, action === 'pause' ? { op: 'pause', by: 'player' } : { op: 'cancel', by: 'player' })
      unlockQuietly('plan-control')
      return { ok: true, message: r.message.charAt(0).toUpperCase() + r.message.slice(1) }
    },

    // ---- choices
    answerDecision: (id, answer) => answerChoice(ctx(), id, answer),
    clarifyDecision: (id, question) => clarifyChoice(ctx(), id, question),
    applyRecommendations: (review) => applyRecommendations(ctx(), review),
    deferDecision: (id, until) => {
      const f = findDecision(ctx(), id)
      if (!f) throw new Error(`no choice ${id}`)
      f.hc.decisions.defer(id, until)
    },
    addDecision: (d) => ctx().home(d.wksp ?? 'main').decisions.open(d),

    // ---- worlds
    projectAdd: (req) => ctx().projects.add(req),
    projectOpen: (folder) => {
      if (!windows) throw new Error('Project windows are unavailable.')
      return windows.openProject(folder)
    },
    projectCreate: (req) => ctx().projects.create(req),
    projectUpdate: (name, patch) => ctx().projects.update(name, patch),
    projectRemove: (name, deleteClone) => ctx().projects.remove(name, deleteClone),
    projectSync: (name) => ctx().projects.sync(name),
    projectRescan: async (name) => (await ctx().projects.rescan(name))[0] ?? ctx().projects.get(name)!,
    projectMetadata: (name) => readWorldMetadata(ctx().projects.get(name)),
    projectPushStatus: (name) => ctx().projects.pushStatus(name),
    projectPush: (name, branch) => ctx().projects.push(name, branch),

    // ---- status / presence / memory / mail
    statusReport: (opts) => ctx().statusReport.generate(opts),
    setAway: (mode) => ctx().away.set(mode),
    readMemory: (which) => ctx().memory.read(which),
    writeMemory: (which, content) => ctx().memory.write(which, content),
    memoryReport: () => ctx().memory.report(),
    memoryArchive: (entries, reason) => ctx().memory.archive(entries, reason),
    inboxSubmit: (text, from) => ctx().inbox.submit(text, from),
    inboxAck: (id) => ctx().inbox.ack(id),
    ledgerTail: (n) => ctx().ledger.tail(n),
    wakes: (n) => ctx().main.wakes.recent(n),

    // ---- allies
    allyCreate: (req) => ctx().allies.create(req),
    allyRetire: (name) => ctx().allies.retire(name),
    allyUpdate: async (name, patch) => {
      const previous = ctx().allies.list().find(a => a.name === name && !a.retiredAt)?.model
      const ally = ctx().allies.update(name, patch)
      if ('model' in patch && previous !== ally.model) bus.publish({ type: 'feature-used', feature: 'model-switch' })
      return ally
    },

    // ---- patch
    checkUpdate: () => ctx().update.check(),
    applyUpdate: () => ctx().update.apply()
  }

  for (const [method, fn] of Object.entries(h)) {
    ipcMain.removeHandler(API_PREFIX + method)
    ipcMain.handle(API_PREFIX + method, async (_e, ...args: unknown[]) => {
      try {
        if (method === 'inventoryOpen' || method === 'inventoryClose') {
          const world = args[0] as string
          const sender = _e.sender
          let worlds = inventoryClients.get(sender.id)
          if (!worlds) {
            worlds = new Set(); inventoryClients.set(sender.id, worlds)
            sender.once('destroyed', () => {
              const opened = inventoryClients.get(sender.id) ?? []
              inventoryClients.delete(sender.id)
              for (const world of opened) closeUnusedInventory(world)
            })
          }
          if (method === 'inventoryClose') {
            worlds.delete(world); closeUnusedInventory(world); return
          }
          worlds.add(world)
          try { return await h.inventoryOpen(world) }
          catch (error) { worlds.delete(world); throw error }
          finally { closeUnusedInventory(world) }
        }
        if (windows && method === 'windowList') return { ...(await h.windowList()), windows: windows.list(_e.sender.id) }
        if (windows && method === 'windowClose') return windows.close(_e.sender.id)
        const binding = windows?.binding(_e.sender.id)
        if (windows && !binding && ['sendChat', 'steerChat', 'sendQueuedNow', 'recap', 'save', 'restartWksp', 'interruptWksp', 'unqueueChat', 'reactToMessage', 'approveGeneration'].includes(method)) throw new Error('Open a project window to use its chat.')
        if (method.startsWith('playPool') || method === 'playCloseSlotEditor' || method.startsWith('playerCopy')) assertProjectWindow(binding, args[0])
        if (method.startsWith('playerInstance') || method === 'playerSources' || method === 'playerSourceAvailable') assertProjectWindow(binding, args[0])
        if (windows && method.startsWith('artBible') && (!binding || args[0] !== binding.project)) throw new Error('The Art Bible belongs to its project window.')
        // The pane lives in its project window only; a '!' result goes to that window's own chat.
        if (windows && method.startsWith('pane') && (!binding || args[0] !== binding.project || (method === 'paneRun' && args[1] !== binding.wksp))) {
          throw new Error('The terminal belongs to its project window.')
        }
        // These end the stream; Pause, Step, Resize and the scene list keep the port (a resize swaps Unity's session behind it).
        if (['playerInstancePlay', 'playerInstanceEnterPlay', 'playerInstanceExitPlay', 'playerInstanceStopUnity', 'playerInstanceSetScene', 'playerInstanceStop', 'playerInstanceQuit', 'playerInstanceRestart', 'playerInstanceDetach'].includes(method)) playConnections.get(args[0] as string)?.()
        if (method === 'playerInstanceStream') {
          const [world, enabled, width = 1280, height = 720] = args as [string, boolean, number?, number?]
          playConnections.get(world)?.()
          if (!enabled) { await playerInstanceService(ctx()).detach(world); return }
          const { port1, port2 } = new MessageChannelMain()
          let credit = false, closed = false, latest: Buffer | undefined, framed = false, handsOn = false, heard = false
          const send = (): void => {
            if (!credit || !latest || closed) return
            credit = false; port1.postMessage({ type: 'frame', bytes: new Uint8Array(latest) }); latest = undefined
            if (!framed) { framed = true; unlockQuietly('play-stream') }
          }
          // A renderer that falls behind hears the newest sound, not a growing delay.
          const audio: Buffer[] = []
          let unacked = 0
          const sendAudio = (): void => {
            while (!closed && audio.length && unacked < AUDIO_IN_FLIGHT) { unacked++; port1.postMessage({ type: 'audio', bytes: new Uint8Array(audio.shift()!) }) }
          }
          const queueAudio = (packet: Buffer): void => {
            if (closed) return
            audio.push(packet); sendAudio()
            if (audio.length > AUDIO_BACKLOG) audio.splice(0, audio.length - AUDIO_BACKLOG)
          }
          const close = (): void => {
            if (closed) return
            closed = true; latest = undefined; audio.length = 0
            try { port1.postMessage({ type: 'closed' }); port1.close(); port2.close() } catch { /* window gone */ }
            _e.sender.removeListener('destroyed', detach)
            if (playConnections.get(world) === close) playConnections.delete(world)
          }
          const detach = (): void => { if (closed) return; close(); void playerInstanceService(ctx()).detach(world).catch(() => {}) }
          playConnections.set(world, close)
          port1.on('message', ({ data }) => {
            if (closed) return
            if (data?.type === 'ready') { credit = true; send() }
            else if (data?.type === 'audio-ack') {
              if (Number.isInteger(data.count) && data.count > 0) { unacked = Math.max(0, unacked - data.count); sendAudio() }
              // acks come while muted too; only sound that played unmuted counts as heard
              if (data.heard === true && !heard) { heard = true; unlockQuietly('play-audio') }
            }
            else if (data?.type === 'input') {
              try {
                playerInstanceService(ctx()).input(world, data.input)
                const held = data.input?.type === 'state' && (data.input.keys?.length || data.input.buttons || data.input.gamepadButtons)
                if (held && !handsOn) { handsOn = true; unlockQuietly('play-input') }
              } catch { detach() }
            } else if (data?.type === 'release') {
              try { playerInstanceService(ctx()).input(world, { type: 'release' }) } catch { /* stopped */ }
            }
          })
          port1.on('close', detach); port1.start()
          _e.sender.once('destroyed', detach)
          try {
            await playerInstanceService(ctx()).stream(world, width, height, frame => { latest = frame; send() }, detach, queueAudio)
            if (closed || _e.sender.isDestroyed()) throw new Error('Play window closed')
            _e.sender.postMessage('genio:play-port', { world }, [port2])
          } catch (error) { close(); throw error }
          return
        }
        if (method === 'playerCopies' && binding) return playerCopyService(ctx()).list(binding.project)
        if (binding) {
          if (['answerDecision', 'clarifyDecision', 'deferDecision', 'applyRecommendations'].includes(method)) {
            const ids = method === 'applyRecommendations' ? (args[0] as { id: string }[]).map(r => r.id) : [String(args[0])]
            for (const id of ids) {
              const found = findDecision(ctx(), id)
              if ((!found && method !== 'applyRecommendations') || (found && !ownsDecision(found.d, binding))) throw new Error('Choice is outside this project.')
            }
          }
          if (method === 'readMemory') return ctx().memory.read(args[0] as Parameters<GenioApi['readMemory']>[0], ctx().home(binding.wksp).home)
          if (method === 'writeMemory') return ctx().memory.write(args[0] as Parameters<GenioApi['writeMemory']>[0], String(args[1]), ctx().home(binding.wksp).home)
          if (method === 'memoryReport') return ctx().memory.report(ctx().home(binding.wksp).home)
          if (method === 'memoryArchive') return ctx().memory.archive((args[0] as unknown[]).map(String), String(args[1]), ctx().home(binding.wksp).home)
          if (method === 'addDecision') args[0] = { ...(args[0] as object), project: binding.project, wksp: binding.wksp }
          if (method === 'revokeStandingApproval' && standingApprovals(ctx()).list().find(a => a.id === args[0])?.project !== binding.project) {
            return { ok: false, message: 'That standing approval belongs to another project.' }
          }
          if (method === 'snapshot') return projectSnapshot(ctx().snapshot(), binding)
          if (method === 'terminals') return ctx().terminals.list().filter(t => terminalProject(t, ctx().snapshot()) === binding.project)
          // A login started in a project window runs in that project's folder, so its terminal is routed back to it.
          if (method === 'accountSession') return openAccountSession(ctx(), String(args[0]), args[1] as 'login' | 'logout', ctx().projects.get(binding.project)?.path)
          if (method === 'recap' || method === 'save') return ctx().home(binding.wksp).wksp.send('/' + method, 'player')
          if (method === 'backlogDispatch') {
            const quest = backlogHome(String(args[0])).backlog.get(String(args[0]))!
            if (quest.project !== binding.project) throw new Error('Quest is outside this project.')
            if (quest.hold) return { ok: false, message: 'Release this quest first.' }
            const waits = dependencyGate(backlogHome(quest.id), quest.id, Boolean(args[1]))
            if (waits) return waits
            await ctx().home(binding.wksp).wksp.send(dispatchMessage(backlogHome(quest.id), quest, Boolean(args[1])), 'system')
            return { ok: true, message: 'Sent to project chat.' }
          }
          if (method === 'planControl' && planHome(String(args[0])).plans.get(String(args[0]))?.world !== binding.project) {
            throw new Error('Plan is outside this project.')
          }
          if (method === 'backlogReorder') {
            for (const p of args[0] as { id: string }[]) {
              if (backlogHome(p.id).backlog.get(p.id)?.project !== binding.project) throw new Error('Quest is outside this project.')
            }
          }
          if (method === 'spawnTask') args[0] = { ...(args[0] as object), project: binding.project, wksp: binding.wksp }
          if (method === 'backlogAdd') return ctx().home(binding.wksp).backlog.add({ ...(args[0] as Parameters<GenioApi['backlogAdd']>[0]), project: binding.project })
          if (method === 'wakes') return ctx().home(binding.wksp).wakes.recent(args[0] as number)
          // Chat history, sends and controls cannot switch this window to another base.
          if (['chatHistory', 'sendChat', 'steerChat', 'sendQueuedNow', 'interruptWksp', 'restartWksp', 'unqueueChat', 'reactToMessage', 'approveGeneration', 'allyUpdate'].includes(method) && args[0] !== binding.wksp) {
            throw new Error('This window is bound to its project chat.')
          }
        }
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (e) {
        // rethrow as a plain Error so the renderer gets a readable message
        throw new Error((e as Error)?.message ?? String(e))
      }
    })
  }
}
