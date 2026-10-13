import type { Task, TerminalInfo } from './types'

export type SquadState = 'WORKING' | 'READY TO MERGE' | 'DONE'
export type SquadTone = 'blue' | 'violet' | 'volt' | 'alert' | 'amber'

/** Display only: lifecycle and capacity policies deliberately stay unchanged. */
export function squadState(task: Task, terminal?: TerminalInfo): SquadState {
  if (['merged', 'done', 'failed', 'exited', 'cleaned'].includes(task.state)) return 'DONE'
  if (task.state !== 'ready' || task.validation?.state === 'running') return 'WORKING'
  // A surviving idle CLI is allowed. Output after the final status means work
  // has resumed; never let its old PR/ready label override that evidence.
  const output = Math.max(Date.parse(task.lastOutputAt ?? '') || 0, Date.parse(terminal?.lastOutputAt ?? '') || 0)
  const ready = Date.parse(task.readyAt ?? task.lastStatusAt ?? task.updatedAt) || 0
  if (terminal?.alive && (!ready || output > ready)) return 'WORKING'
  return 'READY TO MERGE'
}

export function squadTone(task: Task, terminal?: TerminalInfo, attention = false): SquadTone {
  const abnormalExit = task.state === 'exited' && (terminal?.exitCode !== undefined
    ? terminal.exitCode !== 0 : !/\bcode 0\b/.test(task.stateReason ?? ''))
  if (task.state === 'failed' || abnormalExit ||
      (terminal?.alive === false && terminal.exitCode !== undefined && terminal.exitCode !== 0)) return 'alert'
  if (squadState(task, terminal) === 'DONE') return 'volt'
  if (attention || task.state === 'needs-decision' || task.state === 'blocked') return 'amber'
  if (squadState(task, terminal) === 'READY TO MERGE') return 'volt'
  return task.kind === 'scout' ? 'violet' : 'blue'
}
