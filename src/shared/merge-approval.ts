import type { MergeApproval } from './types'

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** One line for the unit page, the Done column and the merge tool result: what authorized a merge. */
export function mergeApprovalLabel(a: MergeApproval | undefined, max = 120): string | undefined {
  if (!a) return undefined
  if (a.kind === 'autoloot') return 'Merged by Auto-loot'
  if (a.kind === 'ui-button') return 'Merged by you (Merge button)'
  if (a.kind === 'prompt') return 'Merged by you (Allow once)'
  if (a.kind === 'mode') return 'Merged by Genio in YOLO'
  const words = a.words ? `: "${clip(a.words, max)}"` : ''
  return a.kind === 'standing' ? `Merged on your standing word${words}` : `Merged on your word${words}`
}
