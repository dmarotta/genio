import type { Task } from '@shared/types'

/** A changed model-written note is not evidence that a failed task has recovered. */
export function relaunchPolicy(task: Pick<Task, 'automaticRelaunches' | 'relaunches'>, manual: boolean): { allowed: boolean; nextAttempts: number } {
  const attempts = task.automaticRelaunches ?? Math.min(task.relaunches, 1)
  return { allowed: manual || attempts < 1, nextAttempts: manual ? 0 : attempts + 1 }
}
