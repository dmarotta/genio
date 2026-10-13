/**
 * Composition root. Builds every service and wires them through a lazily
 * resolved AppCtx so modules never import each other's implementations.
 *
 * Factory contract (each module exports exactly this):
 *   settings.ts     createSettingsService(home)
 *   terminals.ts    createTerminalService(getCtx)
 *   projects.ts     createProjectsService(getCtx)
 *   toolchain.ts    createToolchainService(getCtx)
 *   forge.ts        createForgeService(getCtx)
 *   crew.ts         createCrewService(getCtx, home)
 *   backlog.ts      createBacklogService(getCtx, home)
 *   decisions.ts    createDecisionService(getCtx, home)
 *   wakes.ts        createWakeService(getCtx, home)
 *   supervisor.ts   createSupervisor(getCtx, home)
 *   wksp.ts         createWkspService(getCtx, home, ally?)
 *   away.ts         createAwayService(getCtx)
 *   notifier.ts     createNotifierService(getCtx)
 *   inbox.ts        createInboxService(getCtx)
 *   ledger.ts       createLedgerService(getCtx)
 *   stats.ts        createStatsService(getCtx)
 *   statusreport.ts     createStatusReportService(getCtx)
 *   allies.ts  createAlliesService(getCtx)
 *   memory.ts       createMemoryService(getCtx)
 *   update.ts       createUpdateService(getCtx)
 *   permissions.ts  createPermissionBroker(getCtx)
 *   fal-service.ts  createFalService(getCtx)
 *   uthana-service.ts  createUthanaService(getCtx)
 *   dispatch.ts     createDispatchService(getCtx)
 */
import { agentGeneration } from './agent-generation'
import type { FleetSnapshot, Ally } from '@shared/types'
import { Home, defaultHomeRoot } from './home'
import { scrubInheritedSessionEnv } from './util'
import type { AppCtx, HomeCtx } from './services'
import { createSettingsService } from './settings'
import { createTerminalService } from './terminals'
import { createProjectsService } from './projects'
import { createToolchainService } from './toolchain'
import { createForgeService } from './forge'
import { createCrewService } from './crew'
import { createBacklogService } from './backlog'
import { createDecisionService } from './decisions'
import { createWakeService } from './wakes'
import { createSupervisor } from './supervisor'
import { createWkspService } from './wksp'
import { createAwayService } from './away'
import { createNotifierService } from './notifier'
import { createInboxService } from './inbox'
import { createLedgerService } from './ledger'
import { createStatsService } from './stats'
import { createStatusReportService } from './statusreport'
import { createAlliesService } from './allies'
import { createMemoryService } from './memory'
import { createUpdateService } from './update'
import { createPermissionBroker } from './permissions'
import { createFalService } from './fal-service'
import { createUthanaService } from './uthana-service'
import { createDispatchService } from './dispatch'
import { createInventoryService } from './inventory'
import { createThumbnailDecoder } from './inventory-thumbnails'
import { allyNameForWorld, worldAllyRequest } from '../renderer/src/lib/dock'

let current: AppCtx | undefined
const closedProjects = new WeakMap<AppCtx, Set<string>>()
const startingUnits = new WeakMap<AppCtx, Map<string, Set<Promise<unknown>>>>()

async function startProjectUnit<T>(project: string, start: () => Promise<T>): Promise<T> {
  assertProjectRunning(project)
  const ctx = getCtx()
  let projects = startingUnits.get(ctx)
  if (!projects) { projects = new Map(); startingUnits.set(ctx, projects) }
  let pending = projects.get(project)
  if (!pending) { pending = new Set(); projects.set(project, pending) }
  const operation = start()
  pending.add(operation)
  try { return await operation } finally { pending.delete(operation) }
}

function assertProjectRunning(project: string): void {
  if (closedProjects.get(getCtx())?.has(project)) throw new Error('Open the project window before starting units.')
  if (getCtx().projects.get(project)?.gitRepo === false) throw new Error('Unit creation needs a git repo.')
}

export const getCtx = (): AppCtx => {
  if (!current) throw new Error('Genio context not initialised')
  return current
}

export function makeHomeCtx(home: Home, ally?: Ally): HomeCtx {
  home.ensure()
  const hc: HomeCtx = {
    home,
    crew: createCrewService(getCtx, home),
    backlog: createBacklogService(getCtx, home),
    decisions: createDecisionService(getCtx, home),
    wakes: createWakeService(getCtx, home),
    supervisor: createSupervisor(getCtx, home),
    wksp: createWkspService(getCtx, home, ally)
  }
  // Guard service calls as well as buttons: chat tools and queued quests also spawn units.
  const spawn = hc.crew.spawn
  hc.crew.spawn = req => startProjectUnit(req.project, () => spawn(req))
  const control = hc.crew.control
  hc.crew.control = async (id, action, note, manual) => {
    if (action === 'relaunch') return startProjectUnit(hc.crew.get(id)?.project ?? '', () => control(id, action, note, manual))
    return control(id, action, note, manual)
  }
  const merge = hc.crew.merge
  hc.crew.merge = async (id) => {
    const project = hc.crew.get(id)?.project
    if (project && getCtx().projects.get(project)?.gitRepo === false) return { ok: false, message: 'Merge needs a git repo.' }
    return merge(id)
  }
  return hc
}

/** Reuse the world-ally creation contract, but never adopt an unrelated same-name ally. */
export async function ensureProjectBase(ctx: AppCtx, project: string): Promise<string> {
  closedProjects.get(ctx)?.delete(project)
  const allAllies = ctx.allies.list()
  const allies = allAllies.filter(a => !a.retiredAt)
  let ally = allies.find(a => a.projects.length === 1 && a.projects[0] === project)
  if (!ally) {
    const req = worldAllyRequest(project)
    const base = allyNameForWorld(project)
    // Retired bases still contain chat history; never recycle one for a different project.
    for (let n = 2; allAllies.some(a => a.name === req.name); n++) req.name = `${base.slice(0, 26)}-${n}`
    ally = await ctx.allies.create(req)
  }
  ctx.home(ally.name).supervisor.start()
  return ally.name
}

export async function stopProjectBase(ctx: AppCtx, project: string, wksp: string): Promise<void> {
  let closed = closedProjects.get(ctx)
  if (!closed) { closed = new Set(); closedProjects.set(ctx, closed) }
  closed.add(project)
  const home = ctx.home(wksp)
  home.supervisor.stop()
  await home.wksp.stop()
  // A spawn may be preparing its worktree and not have a terminal yet.
  await Promise.allSettled([...(startingUnits.get(ctx)?.get(project) ?? [])])
  await Promise.all([...ctx.homes.values()].flatMap(h => h.crew.list()
    .filter(t => t.project === project && t.terminalId && ctx.terminals.get(t.terminalId)?.alive)
    .map(t => h.crew.control(t.id, 'exit').then(r => { if (!r.ok) throw new Error(r.message) }))))
}

export function createApp(appRoot: string, homeRoot = defaultHomeRoot()): AppCtx {
  scrubInheritedSessionEnv()
  const mainHome = new Home(homeRoot, 'main')
  mainHome.ensure()
  const homes = new Map<string, HomeCtx>()

  const ctx = {
    appRoot,
    homes,
    settings: createSettingsService(mainHome)
  } as unknown as AppCtx
  current = ctx

  ctx.terminals = createTerminalService(getCtx)
  ctx.toolchain = createToolchainService(getCtx)
  ctx.forge = createForgeService(getCtx)
  ctx.projects = createProjectsService(getCtx)
  ctx.notifier = createNotifierService(getCtx)
  ctx.ledger = createLedgerService(getCtx)
  ctx.stats = createStatsService(getCtx)
  ctx.away = createAwayService(getCtx)
  ctx.inbox = createInboxService(getCtx)
  ctx.statusReport = createStatusReportService(getCtx)
  ctx.memory = createMemoryService(getCtx)
  ctx.update = createUpdateService(getCtx)
  ctx.permissions = createPermissionBroker(getCtx)
  ctx.allies = createAlliesService(getCtx)
  ctx.fal = createFalService(getCtx)
  ctx.uthana = createUthanaService(getCtx)
  ctx.dispatch = createDispatchService(getCtx)
  const thumbnailDecoder = createThumbnailDecoder()
  ctx.inventory = createInventoryService(getCtx, thumbnailDecoder.decode)
  const stopInventory = ctx.inventory.stop
  ctx.inventory.stop = () => { stopInventory(); thumbnailDecoder.stop() }

  ctx.main = makeHomeCtx(mainHome)
  homes.set('main', ctx.main)
  for (const sm of ctx.allies.list()) {
    if (sm.retiredAt) continue
    homes.set(sm.name, makeHomeCtx(new Home(sm.home, sm.name, mainHome), sm))
  }

  ctx.home = (name: string): HomeCtx => {
    const h = homes.get(name || 'main')
    if (!h) throw new Error(`unknown home: ${name}`)
    return h
  }

  ctx.snapshot = (): FleetSnapshot => {
    const all = [...homes.values()]
    return {
      tasks: all.flatMap((h) => h.crew.list()),
      backlog: all.flatMap((h) => h.backlog.list()),
      decisions: all.flatMap((h) => h.decisions.list(false)),
      projects: ctx.projects.list(),
      wksps: all.map((h) => h.wksp.info()),
      allies: ctx.allies.list(),
      away: ctx.away.state(),
      inbox: ctx.inbox.list(),
      stats: ctx.stats.get()
    }
  }

  return ctx
}

/** Start supervision and agents for every home (after the window exists). */
export async function startApp(ctx: AppCtx): Promise<void> {
  ctx.inbox.configure()
  agentGeneration(ctx)
  ctx.fal.resume()
  ctx.uthana.resume()
  // a world's remote may have changed while Genio was closed: auto modes follow it
  void ctx.projects.refreshRemotes().catch(() => undefined)
  for (const h of ctx.homes.values()) {
    await h.crew.reconcileOnStart()
    h.supervisor.start()
  }
}

export async function stopApp(ctx: AppCtx): Promise<void> {
  agentGeneration(ctx).stop()
  ctx.inventory.stop()
  for (const h of ctx.homes.values()) {
    h.supervisor.stop()
    await h.wksp.stop().catch(() => undefined)
  }
}
