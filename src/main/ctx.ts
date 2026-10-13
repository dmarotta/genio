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
 *   dispatch.ts     createDispatchService(getCtx)
 */
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
import { createSpriteService } from './sprites'
import { createDispatchService } from './dispatch'

let current: AppCtx | undefined

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
  return hc
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
  ctx.sprites = createSpriteService(getCtx)
  ctx.dispatch = createDispatchService(getCtx)

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
  ctx.fal.resume()
  // a world's remote may have changed while Genio was closed: auto modes follow it
  void ctx.projects.refreshRemotes().catch(() => undefined)
  for (const h of ctx.homes.values()) {
    await h.crew.reconcileOnStart()
    h.supervisor.start()
  }
}

export async function stopApp(ctx: AppCtx): Promise<void> {
  for (const h of ctx.homes.values()) {
    h.supervisor.stop()
    await h.wksp.stop().catch(() => undefined)
  }
}
