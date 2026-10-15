import { modelCatalogue, invalidateModelCatalogue } from './model-catalogue'
import { agentGeneration } from './agent-generation'
import { readWorldMetadata } from './world-metadata'
import { assertProjectWindow, playService } from './play'
import { playerCopyService } from './player-copy'
import { playerInstanceService } from './player-instance'
import { playerSources, sourceUnit } from './player-sources'
/**
 * IPC: one ipcMain.handle per GenioApi method ('genio:<method>'). The table is
 * typed against GenioApi so a missing or mistyped method fails the build.
 */
import { bus } from './bus'
import { app, BrowserWindow, dialog, ipcMain, shell, MessageChannelMain } from 'electron'
import { createExplorerIntegration, explorerCommand } from './explorer'
import { API_PREFIX, type GenioApi, type WindowList } from '@shared/api'
import type { Task } from '@shared/types'
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
  const backlogHome = (id: string): HomeCtx => {
    for (const hc of ctx().homes.values()) if (hc.backlog.get(id)) return hc
    throw new Error(`no quest ${id}`)
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
    playerInstanceStop: world => playerInstanceService(ctx()).stop(world),
    playerInstanceQuit: world => playerInstanceService(ctx()).quit(world),
    playerInstanceRestart: (world, visible) => playerInstanceService(ctx()).restart(world, visible),
    playerInstanceKeepAlive: world => playerInstanceService(ctx()).keepAlive(world),
    playerInstanceDetach: world => playerInstanceService(ctx()).detach(world),
    playerInstanceSettings: (world, patch) => playerInstanceService(ctx()).configure(world, patch),
    playerInstanceMachine: world => playerInstanceService(ctx()).machine(world),
    playerInstanceConsole: (world, cursor, session) => playerInstanceService(ctx()).console(world, cursor, session),
    playerInstanceStream: async () => { throw new Error('Streaming requires the owning project window') },
    playerInstanceDialogShot: async world => playerInstanceService(ctx()).dialogScreenshot(world),
    playerSources: world => playerSources(ctx(), world),
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
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
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
    sendChat: (wksp, text, images, context) => sendPlayerChat(ctx(), wksp, text, images, context),
    unqueueChat: async (wksp, id) => ctx().home(wksp).wksp.unqueue(id),
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
    // A click on MERGE is the player's explicit word for this merge.
    mergeTask: (id) => taskHome(id).hc.crew.merge(id),
    promoteScout: (id, intent) => taskHome(id).hc.crew.promote(id, intent),
    readTaskFile: (id, which) => taskHome(id).hc.crew.readFile(id, which),

    // ---- terminals
    terminals: () => ctx().terminals.list(),
    terminalAttach: (id) => ctx().terminals.scrollback(id),
    terminalWrite: (id, data) => ctx().terminals.write(id, data),
    terminalResize: (id, cols, rows) => ctx().terminals.resize(id, cols, rows),
    terminalOpenShell: (cwd, taskId) => {
      if (!taskId) return ctx().terminals.create({ kind: 'shell', title: 'Shell', cwd: cwd || ctx().main.home.root })
      const t = taskHome(taskId).hc.crew.get(taskId)
      if (!t || t.state === 'cleaned') throw new Error(`${taskId} was despawned; its copy is gone.`)
      // Tied to the unit, so Despawn closes it before removing the copy.
      return ctx().terminals.create({ kind: 'shell', title: `Shell · ${t.title}`, cwd: t.worktree, taskId: t.id })
    },
    terminalKill: (id) => ctx().terminals.kill(id),

    // ---- quest log
    backlogAdd: (item) => ctx().main.backlog.add(item),
    backlogUpdate: (id, patch) => backlogHome(id).backlog.update(id, patch),
    backlogHold: (id, reason, until) => backlogHome(id).backlog.hold(id, reason, until),
    backlogRelease: (id) => backlogHome(id).backlog.release(id),
    backlogDispatch: async (id) => {
      const hc = backlogHome(id)
      const item = hc.backlog.get(id)!
      if (item.hold) return { ok: false, message: 'this quest is held for you; release it first' }
      // Writing the brief needs judgment: hand the quest to Genio.
      await hc.wksp.send(
        `Dispatch quest ${id} ("${item.title}"${item.project ? ` in ${item.project}` : ''}) now: resolve its posture, write the unit's intent from the quest notes, and deploy it with quest_id=${id}.`,
        'system'
      )
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
        if (windows && !binding && ['sendChat', 'recap', 'save', 'restartWksp', 'interruptWksp', 'unqueueChat', 'reactToMessage', 'approveGeneration'].includes(method)) throw new Error('Open a project window to use its chat.')
        if (method.startsWith('playPool') || method === 'playCloseSlotEditor' || method.startsWith('playerCopy')) assertProjectWindow(binding, args[0])
        if (method.startsWith('playerInstance') || method === 'playerSources') assertProjectWindow(binding, args[0])
        if (['playerInstancePlay', 'playerInstanceStop', 'playerInstanceQuit', 'playerInstanceRestart', 'playerInstanceDetach'].includes(method)) playConnections.get(args[0] as string)?.()
        if (method === 'playerInstanceStream') {
          const [world, enabled, width = 1280, height = 720] = args as [string, boolean, number?, number?]
          playConnections.get(world)?.()
          if (!enabled) { await playerInstanceService(ctx()).detach(world); return }
          const { port1, port2 } = new MessageChannelMain()
          let credit = false, closed = false, latest: Buffer | undefined, framed = false, handsOn = false
          const send = (): void => {
            if (!credit || !latest || closed) return
            credit = false; port1.postMessage({ type: 'frame', bytes: new Uint8Array(latest) }); latest = undefined
            if (!framed) { framed = true; unlockQuietly('play-stream') }
          }
          const close = (): void => {
            if (closed) return
            closed = true; latest = undefined
            try { port1.postMessage({ type: 'closed' }); port1.close(); port2.close() } catch { /* window gone */ }
            _e.sender.removeListener('destroyed', detach)
            if (playConnections.get(world) === close) playConnections.delete(world)
          }
          const detach = (): void => { if (closed) return; close(); void playerInstanceService(ctx()).detach(world).catch(() => {}) }
          playConnections.set(world, close)
          port1.on('message', ({ data }) => {
            if (closed) return
            if (data?.type === 'ready') { credit = true; send() }
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
            await playerInstanceService(ctx()).stream(world, width, height, frame => { latest = frame; send() }, detach)
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
          if (method === 'snapshot') return projectSnapshot(ctx().snapshot(), binding)
          if (method === 'terminals') return ctx().terminals.list().filter(t => terminalProject(t, ctx().snapshot()) === binding.project)
          // A login started in a project window runs in that project's folder, so its terminal is routed back to it.
          if (method === 'accountSession') return openAccountSession(ctx(), String(args[0]), args[1] as 'login' | 'logout', ctx().projects.get(binding.project)?.path)
          if (method === 'recap' || method === 'save') return ctx().home(binding.wksp).wksp.send('/' + method, 'player')
          if (method === 'backlogDispatch') {
            const quest = backlogHome(String(args[0])).backlog.get(String(args[0]))!
            if (quest.project !== binding.project) throw new Error('Quest is outside this project.')
            if (quest.hold) return { ok: false, message: 'Release this quest first.' }
            await ctx().home(binding.wksp).wksp.send(`Dispatch quest ${quest.id} (${quest.title}): ${quest.notes}`, 'system')
            return { ok: true, message: 'Sent to project chat.' }
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
          if (['chatHistory', 'sendChat', 'interruptWksp', 'restartWksp', 'unqueueChat', 'reactToMessage', 'approveGeneration', 'allyUpdate'].includes(method) && args[0] !== binding.wksp) {
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
