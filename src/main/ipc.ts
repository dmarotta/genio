import { readWorldMetadata } from './world-metadata'
/**
 * IPC: one ipcMain.handle per GenioApi method ('genio:<method>'). The table is
 * typed against GenioApi so a missing or mistyped method fails the build.
 */
import fs from 'node:fs'
import { bus } from './bus'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { API_PREFIX, type GenioApi } from '@shared/api'
import { UTHANA_CHARACTER_EXTS, UTHANA_VIDEO_EXTS } from '@shared/uthana'
import type { Task } from '@shared/types'
import { listAccounts, openAccountSession } from './accounts'
import { answerChoice, findDecision, findTask } from './wksp-tools'
import { resolveLoadout } from './loadout'
import { sendPlayerChat } from './wksp'
import { clearSecret, secretStatus, setSecret } from './secrets'
import { usageReport } from './usage'
import { isSubPath } from './util'
import type { AppCtx, HomeCtx } from './services'

const FILE_EXTS: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'],
  audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
  video: ['mp4', 'webm', 'mov'],
  model: ['glb', 'gltf', 'obj', 'fbx', 'ply', 'stl']
}

type Handlers ={ [K in keyof GenioApi]: (...args: Parameters<GenioApi[K]>) => ReturnType<GenioApi[K]> | Awaited<ReturnType<GenioApi[K]>> }

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
      if (feature === 'screenshot' || feature === 'dock-split') bus.publish({ type: 'feature-used', feature })
    },
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
    falCatalogue: (world, refresh) => ctx().fal.catalogue(world, refresh),
    falModel: (endpoint) => ctx().fal.model(endpoint),
    falSearch: (q) => ctx().fal.search(q),
    falWorld: (world) => ctx().fal.world(world),
    falWorldConfig: (world, config) => ctx().fal.saveWorldConfig(world, config),
    falRecipeSave: (world, recipe) => ctx().fal.saveRecipe(world, recipe),
    falRecipeDelete: (world, id) => ctx().fal.deleteRecipe(world, id),
    falPickFile: async (world, kind) => {
      const proj = world ? ctx().projects.get(world) : undefined
      if (world && !proj) throw new Error(`No world named ${world}.`)
      const exts = kind ? FILE_EXTS[kind] : undefined
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts: OpenDialogOptions = {
        title: proj ? `File in ${proj.name}` : 'Pick a file',
        defaultPath: proj?.path,
        properties: ['openFile'],
        filters: exts ? [{ name: kind!, extensions: exts }, { name: 'All files', extensions: ['*'] }] : undefined
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      if (proj && !isSubPath(r.filePaths[0], proj.path)) throw new Error(`Pick a file inside ${proj.name} (${proj.path}).`)
      return r.filePaths[0]
    },

    // ---- Animation (Uthana)
    uthanaRuns: () => ctx().uthana.runs(),
    uthanaWorld: (world) => ctx().uthana.world(world),
    uthanaWorldConfig: (world, config) => ctx().uthana.saveWorldConfig(world, config),
    uthanaAccount: () => ctx().uthana.account(),
    uthanaCharacters: () => ctx().uthana.characters(),
    uthanaForgetCharacter: (world, id) => ctx().uthana.forgetCharacter(world, id),
    uthanaPickFile: async (world, kind) => {
      const proj = world ? ctx().projects.get(world) : undefined
      if (world && !proj) throw new Error(`No world named ${world}.`)
      const exts = kind === 'character' ? UTHANA_CHARACTER_EXTS : UTHANA_VIDEO_EXTS
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts: OpenDialogOptions = {
        title: kind === 'character' ? `Character model${proj ? ` in ${proj.name}` : ''}` : 'Video of the motion',
        defaultPath: proj?.path,
        properties: ['openFile'],
        filters: [{ name: kind === 'character' ? 'FBX / glTF' : 'Video', extensions: exts }]
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      return ctx().uthana.inspect(r.filePaths[0], kind, world)
    },
    uthanaInspect: (p, kind, world) => ctx().uthana.inspect(p, kind, world),
    uthanaUpload: (req) => ctx().uthana.upload(req),
    uthanaGenerate: (req) => ctx().uthana.generate(req),
    uthanaCancel: async (id) => ctx().uthana.cancel(id),
    uthanaDelete: async (id) => ctx().uthana.remove(id),
    uthanaPreview: (req) => ctx().uthana.preview(req),
    uthanaExport: async (req) => {
      if (req.dest === 'world') return ctx().uthana.saveToWorld(req)
      const { file } = await ctx().uthana.fetchExport(req)
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts = { title: 'Export animation', defaultPath: req.fileName, filters: [{ name: req.format.toUpperCase(), extensions: [req.format] }] }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: false, message: 'Export cancelled.' }
      // the system dialog already asked before replacing an existing file
      fs.copyFileSync(file.localPath, r.filePath)
      return { ok: true, path: r.filePath, message: `Exported ${path.basename(r.filePath)}` }
    },

    // ---- comms
    chatHistory: (wksp, limit) => ctx().home(wksp).wksp.history(limit),
    sendChat: (wksp, text, images) => sendPlayerChat(ctx(), wksp, text, images),
    unqueueChat: async (wksp, id) => ctx().home(wksp).wksp.unqueue(id),
    interruptWksp: (wksp) => ctx().home(wksp).wksp.interrupt(),
    restartWksp: (wksp, fresh) => ctx().home(wksp).wksp.restart(fresh),
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
    allyUpdate: async (name, patch) => ctx().allies.update(name, patch),

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
