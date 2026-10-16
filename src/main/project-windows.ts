import path from 'node:path'
import { ownsDecision } from '@shared/decisions'
import type { FleetSnapshot, GenioEvent, TerminalInfo } from '@shared/types'
import { normalisedProjectPath } from './projects'

export interface WindowBinding { project: string; wksp: string }

/** Electron adds the application entry before user arguments in development. */
export function projectFromArgv(argv: string[], cwd: string, development: boolean): string | undefined {
  const args = argv.slice(development ? 2 : 1)
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!literal && arg === '--') { literal = true; continue }
    if (!literal && arg.startsWith('-')) {
      if (['--inspect', '--inspect-brk', '--remote-debugging-port', '--user-data-dir'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) i++
      continue
    }
    return path.resolve(cwd, arg)
  }
  return undefined
}

export function projectSnapshot(s: FleetSnapshot, binding?: WindowBinding): FleetSnapshot {
  if (!binding) return s
  return { ...s,
    pendingUnits: s.pendingUnits?.filter(project => project === binding.project),
    projects: s.projects.filter(p => p.name === binding.project),
    tasks: s.tasks.filter(t => t.project === binding.project),
    backlog: s.backlog.filter(t => t.project === binding.project),
    plans: s.plans?.filter(p => p.world === binding.project),
    decisions: s.decisions.filter(t => ownsDecision(t, binding)),
    wksps: s.wksps.filter(m => m.name === binding.wksp),
    allies: s.allies.filter(a => a.name === binding.wksp),
    standing: s.standing?.filter(a => a.project === binding.project)
  }
}

export function terminalProject(t: TerminalInfo, s: FleetSnapshot): string | undefined {
  // The terminal pane belongs to its window, whichever folder (main checkout or a unit's copy) it runs in.
  if (t.project) return t.project
  const task = s.tasks.find(x => x.id === t.taskId || x.terminalId === t.id)
  if (task) return task.project
  const cwd = normalisedProjectPath(t.cwd)
  return [...s.projects].sort((a, b) => b.path.length - a.path.length).find(p => {
    const root = normalisedProjectPath(p.path)
    return cwd === root || cwd.startsWith(root + path.sep)
  })?.name
}

/** Chat traffic belongs to a project window; the Hub has no chat screen and never carries it. */
const CHAT_ONLY = new Set<GenioEvent['type']>(['chat', 'chat-delta', 'generation'])

/**
 * Hub observes the fleet; project windows receive only their own scoped events.
 * The snapshot may be passed as a getter: it is only built for the few event kinds that need it.
 */
export function routeProjectEvent(ev: GenioEvent, binding: WindowBinding | undefined, s: FleetSnapshot | (() => FleetSnapshot), terminalOwner?: string): GenioEvent | undefined {
  if (!binding) return CHAT_ONLY.has(ev.type) ? undefined : ev
  const snap = (): FleetSnapshot => (typeof s === 'function' ? s() : s)
  const project = (name?: string): GenioEvent | undefined => name === binding.project ? ev : undefined
  const wksp = (name?: string): GenioEvent | undefined => name === binding.wksp ? ev : undefined
  switch (ev.type) {
    case 'pending-units': return { ...ev, projects: ev.projects.filter(project => project === binding.project) }
    case 'snapshot': return { ...ev, data: projectSnapshot(ev.data, binding) }
    case 'task': return project(ev.task.project)
    case 'task-removed': return ev // deletion contains no content; may already be absent from snapshot
    case 'status': return project(snap().tasks.find(t => t.id === ev.event.taskId)?.project)
    case 'chat': return wksp(ev.message.wksp)
    case 'chat-delta': case 'generation': return wksp(ev.wksp)
    case 'wksp': return wksp(ev.wksp.name)
    case 'permission': return wksp(ev.request.wksp)
    case 'wake': return wksp(ev.wake.wksp)
    case 'projects': return { ...ev, projects: ev.projects.filter(p => p.name === binding.project) }
    case 'allies': return { ...ev, allies: ev.allies.filter(a => a.name === binding.wksp) }
    case 'standing-approvals': return { ...ev, approvals: ev.approvals.filter(a => a.project === binding.project) }
    case 'plans': return { ...ev, plans: ev.plans.filter(p => p.world === binding.project) }
    case 'backlog': case 'decisions': return { type: 'snapshot', data: projectSnapshot(snap(), binding) }
    case 'terminal': return project(terminalOwner ?? terminalProject(ev.terminal, snap()))
    case 'terminal-removed': return project(terminalOwner)
    case 'inventory': return project(ev.state.world)
    case 'fal-run': case 'uthana-run': return project(ev.run.world ?? undefined)
    case 'navigate':
      if (ev.target.view === 'comms') return wksp(ev.target.wksp)
      if (ev.target.view === 'squad') { const taskId = ev.target.taskId; return project(snap().tasks.find(t => t.id === taskId)?.project) }
      if (ev.target.view === 'move') return ev.target.project ? project(ev.target.project) : wksp(ev.target.wksp)
      // Settings › Accounts & keys lives in every project window and holds nothing project-specific.
      if (ev.target.view === 'accounts') return ev
      return undefined
    default: return ev
  }
}
