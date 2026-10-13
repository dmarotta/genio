/**
 * IPC: one ipcMain.handle per GenioApi method ('genio:<method>'). The table is
 * typed against GenioApi so a missing or mistyped method fails the build.
 */
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { API_PREFIX, type GenioApi } from '@shared/api'
import type { Task } from '@shared/types'
import { listAccounts, openAccountSession } from './accounts'
import { answerChoice, findDecision, findTask } from './wksp-tools'
import { resolveLoadout } from './loadout'
import { clearSecret, secretStatus, setSecret } from './secrets'
import { usageReport } from './usage'
import { isSubPath } from './util'
import type { AppCtx, HomeCtx } from './services'

type Handlers = { [K in keyof GenioApi]: (...args: Parameters<GenioApi[K]>) => ReturnType<GenioApi[K]> | Awaited<ReturnType<GenioApi[K]>> }

export function registerIpc(getCtx: () => AppCtx): void {
  const ctx = (): AppCtx => getCtx()
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
    snapshot: () => ctx().snapshot(),
    homePath: () => ctx().main.home.root,
    getSettings: () => ctx().settings.get(),
    saveSettings: (patch) => {
      const s = ctx().settings.save(patch)
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

    // ---- accounts
    accounts: () => listAccounts(),
    accountSession: (tool, action) => openAccountSession(ctx(), tool, action),
    accountUsage: () => usageReport(ctx()),
    apiKeys: () => secretStatus(ctx().main.home.data),
    apiKeySet: (id, key) => {
      setSecret(id, key, ctx().main.home.data)
      return { ok: true, message: 'Key saved (encrypted).' }
    },
    apiKeyClear: (id) => {
      clearSecret(id, ctx().main.home.data)
      return { ok: true, message: 'Key cleared.' }
    },

    // ---- FAL.ai
    falRuns: () => ctx().fal.runs(),
    falRun: (req) => ctx().fal.run(req),
    falCancel: (id) => ctx().fal.cancel(id),
    falDelete: (id) => ctx().fal.remove(id),
    falSave: (req) => ctx().fal.save(req),
    falPickFolder: async (project) => {
      const proj = ctx().projects.get(project)
      if (!proj) throw new Error(`No world named ${project}.`)
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts: OpenDialogOptions = { title: `Folder in ${proj.name}`, defaultPath: proj.path, properties: ['openDirectory', 'createDirectory'] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      if (!isSubPath(r.filePaths[0], proj.path)) throw new Error(`Pick a folder inside ${proj.name} (${proj.path}).`)
      return path.relative(proj.path, r.filePaths[0]).replace(/\\/g, '/')
    },

    // ---- comms
    chatHistory: (wksp, limit) => ctx().home(wksp).wksp.history(limit),
    sendChat: (wksp, text) => ctx().home(wksp).wksp.send(text, 'player'),
    interruptWksp: (wksp) => ctx().home(wksp).wksp.interrupt(),
    restartWksp: (wksp, fresh) => ctx().home(wksp).wksp.restart(fresh),
    resolvePermission: (id, allow) => ctx().permissions.resolve(id, allow),
    recap: () => ctx().main.wksp.send('/recap', 'player'),
    save: () => ctx().main.wksp.send('/save', 'player'),

    // ---- squad
    spawnTask: (req) => ctx().home(req.wksp ?? 'main').crew.spawn(req),
    previewLoadout: async (req) => resolveLoadout(req, ctx().settings),
    sendToTask: async (id, text, resolveKey) => {
      const { hc } = taskHome(id)
      const r = await hc.crew.send(id, text, resolveKey ? [resolveKey] : undefined)
      if (r.ok && resolveKey) hc.decisions.resolveKey(id, resolveKey, text)
      return r
    },
    controlTask: (id, action) => taskHome(id).hc.crew.control(id, action),
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
    projectCreate: (req) => ctx().projects.create(req),
    projectUpdate: (name, patch) => ctx().projects.update(name, patch),
    projectRemove: (name, deleteClone) => ctx().projects.remove(name, deleteClone),
    projectSync: (name) => ctx().projects.sync(name),

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

    // ---- patch
    checkUpdate: () => ctx().update.check(),
    applyUpdate: () => ctx().update.apply()
  }

  for (const [method, fn] of Object.entries(h)) {
    ipcMain.removeHandler(API_PREFIX + method)
    ipcMain.handle(API_PREFIX + method, async (_e, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (e) {
        // rethrow as a plain Error so the renderer gets a readable message
        throw new Error((e as Error)?.message ?? String(e))
      }
    })
  }
}
