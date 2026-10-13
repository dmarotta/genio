import { modelCatalogue, invalidateModelCatalogue } from './model-catalogue'
import { agentGeneration } from './agent-generation'
import { readWorldMetadata } from './world-metadata'
import { assertPlayWindow, playService } from './play'
/**
 * IPC: one ipcMain.handle per GenioApi method ('genio:<method>'). The table is
 * typed against GenioApi so a missing or mistyped method fails the build.
 */
import { bus } from './bus'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { API_PREFIX, type GenioApi } from '@shared/api'
import type { Task } from '@shared/types'
import { listAccounts, openAccountSession } from './accounts'
import { answerChoice, findDecision, findTask } from './wksp-tools'
import { resolveLoadout } from './loadout'
import { sendPlayerChat } from './wksp'
import { clearSecret, secretStatus, setSecret } from './secrets'
import { usageReport } from './usage'
import type { AppCtx, HomeCtx } from './services'
import { projectSnapshot, terminalProject, type WindowBinding } from './project-windows'

type Handlers ={ [K in keyof GenioApi]: (...args: Parameters<GenioApi[K]>) => ReturnType<GenioApi[K]> | Awaited<ReturnType<GenioApi[K]>> }

export function registerIpc(getCtx: () => AppCtx, windows?: { openProject(folder: string): Promise<void>; binding(senderId: number): WindowBinding | undefined }): void {
  const ctx = (): AppCtx => getCtx()
  const inventoryClients = new Map<number, Set<string>>()
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
    playStatus: world => playService(ctx()).status(world),
    playScenes: world => playService(ctx()).scenes(world),
    playAction: (world, action) => playService(ctx()).act(world, action, 'player'),
    playFrame: (world, width, height) => playService(ctx()).frame(world, width, height),
    playConsole: (world, cursor, session) => playService(ctx()).adapter(world).console(cursor, session),
    playStats: world => playService(ctx()).adapter(world).stats(),
    playOpenUnity: world => playService(ctx()).open(world),
    playScreenshot: world => playService(ctx()).screenshot(world),
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
      if (feature === 'screenshot' || feature === 'dock-split' || feature === 'model-picker') bus.publish({ type: 'feature-used', feature })
    },
    snapshot: () => ctx().snapshot(),
    homePath: () => ctx().main.home.root,
    getSettings: () => ctx().settings.get(),
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
    validateTask: (id) => taskHome(id).hc.crew.validate(id),
    readTaskFile: (id, which) => taskHome(id).hc.crew.readFile(id, which),
    crewState: (id) => taskHome(id).hc.crew.crewState(id),
    playtest: (target) => {
      if (target.taskId) return taskHome(target.taskId).hc.crew.playtest(target)
      return ctx().main.crew.playtest(target)
    },

    // ---- terminals
    terminals: () => ctx().terminals.list(),
    terminalAttach: (id) => ctx().terminals.scrollback(id),
    terminalWrite: (id, data) => ctx().terminals.write(id, data),
    terminalResize: (id, cols, rows) => ctx().terminals.resize(id, cols, rows),
    terminalOpenShell: (cwd) =>
      ctx().terminals.create({ kind: 'shell', title: 'Shell', cwd: cwd || ctx().main.home.root }),
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

    // ---- choices
    answerDecision: (id, answer) => answerChoice(ctx(), id, answer),
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
    projectMetadata: (name) => readWorldMetadata(ctx().projects.get(name)),
    projectPushStatus: (name) => ctx().projects.pushStatus(name),
    projectPush: (name, branch) => ctx().projects.push(name, branch),

    // ---- status / presence / memory / mail
    statusReport: (opts) => ctx().statusReport.generate(opts),
    setAway: async (mode) => {
      const c = ctx()
      const prev = c.away.state().mode
      if (prev === 'afk' && mode !== 'afk') {
        // returning from AFK through the presence switch: same welcome-back flow as /online
        await c.main.wksp.send('/online', 'player')
        return c.away.state()
      }
      if (mode === 'afk') {
        await c.main.wksp.send('/afk', 'player')
        return c.away.state()
      }
      return c.away.set(mode)
    },
    readMemory: (which) => ctx().memory.read(which),
    writeMemory: (which, content) => ctx().memory.write(which, content),
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
        const binding = windows?.binding(_e.sender.id)
        if (method.startsWith('play') && method !== 'playtest') assertPlayWindow(binding, args[0])
        if (binding) {
          if (method === 'snapshot') return projectSnapshot(ctx().snapshot(), binding)
          if (method === 'terminals') return ctx().terminals.list().filter(t => terminalProject(t, ctx().snapshot()) === binding.project)
          if (method === 'recap' || method === 'save') return ctx().home(binding.wksp).wksp.send('/' + method, 'player')
          if (method === 'spawnTask') args[0] = { ...(args[0] as object), project: binding.project, wksp: binding.wksp }
          if (method === 'wakes') return ctx().home(binding.wksp).wakes.recent(args[0] as number)
          // Chat history, sends and controls cannot switch this window to another base.
          if (['chatHistory', 'sendChat', 'interruptWksp', 'restartWksp', 'unqueueChat', 'approveGeneration', 'allyUpdate'].includes(method) && args[0] !== binding.wksp) {
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
