import path from 'node:path'
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
    projects: s.projects.filter(p => p.name === binding.project),
    tasks: s.tasks.filter(t => t.project === binding.project),
    backlog: s.backlog.filter(t => t.project === binding.project),
    decisions: s.decisions.filter(t => t.project === binding.project || (!t.project && t.wksp === binding.wksp)),
    wksps: s.wksps.filter(m => m.name === binding.wksp),
    allies: s.allies.filter(a => a.name === binding.wksp)
  }
}

export function terminalProject(t: TerminalInfo, s: FleetSnapshot): string | undefined {
  const task = s.tasks.find(x => x.id === t.taskId || x.terminalId === t.id)
  if (task) return task.project
  const cwd = normalisedProjectPath(t.cwd)
  return [...s.projects].sort((a, b) => b.path.length - a.path.length).find(p => {
    const root = normalisedProjectPath(p.path)
    return cwd === root || cwd.startsWith(root + path.sep)
  })?.name
}

/** Hub observes the fleet; project windows receive only their own scoped events. */
export function routeProjectEvent(ev: GenioEvent, binding: WindowBinding | undefined, s: FleetSnapshot, terminalOwner?: string): GenioEvent | undefined {
  if (!binding) return ev
  const project = (name?: string): GenioEvent | undefined => name === binding.project ? ev : undefined
  const wksp = (name?: string): GenioEvent | undefined => name === binding.wksp ? ev : undefined
  switch (ev.type) {
    case 'snapshot': return { ...ev, data: projectSnapshot(ev.data, binding) }
    case 'task': return project(ev.task.project)
    case 'task-removed': return ev // deletion contains no content; may already be absent from snapshot
    case 'status': return project(s.tasks.find(t => t.id === ev.event.taskId)?.project)
    case 'chat': return wksp(ev.message.wksp)
    case 'chat-delta': return wksp(ev.wksp)
    case 'wksp': return wksp(ev.wksp.name)
    case 'permission': return wksp(ev.request.wksp)
    case 'wake': return wksp(ev.wake.wksp)
    case 'projects': return { ...ev, projects: ev.projects.filter(p => p.name === binding.project) }
    case 'allies': return { ...ev, allies: ev.allies.filter(a => a.name === binding.wksp) }
    case 'backlog': case 'decisions': return { type: 'snapshot', data: projectSnapshot(s, binding) }
    case 'terminal': return project(terminalOwner ?? terminalProject(ev.terminal, s))
    case 'terminal-removed': return project(terminalOwner)
    case 'inventory': return project(ev.state.world)
    case 'fal-run': case 'uthana-run': return project(ev.run.world ?? undefined)
    case 'navigate':
      if (ev.target.view === 'comms') return wksp(ev.target.wksp)
      if (ev.target.view === 'squad') { const taskId = ev.target.taskId; return project(s.tasks.find(t => t.id === taskId)?.project) }
      return ev
    default: return ev
  }
}
