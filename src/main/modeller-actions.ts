/**
 * What the player does to a Modeller's model from the unit page: Revert to step N, Branch from step N,
 * switch branch. Each runs the kernel's own CLI (modeller.mjs, as plain Node, under its lock,
 * so it is refused while a step runs) and returns the ping that tells the unit, so its next step
 * builds on what the player now sees. Delivery is the unit's own, as for any Build.
 */
import type { ModellerAct } from '@shared/modeller'
import { run } from './util'

/** The kernel's JSON summary of a model (modeller.mjs `summary`). */
interface Summary {
  model: string
  branch: string
  head: string | null
  steps: { id: string; caption: string }[]
  branches: Record<string, { head: string | null; from: string | null }>
}

const n = (id: string | null): string => (id ? String(Number(/^s(\d+)$/.exec(id)?.[1] ?? id)) : 'none')

/** One kernel command; its JSON result, or its own error message. */
async function kernel(script: string, dataDir: string, args: string[]): Promise<Summary> {
  const r = await run(process.execPath, [script, ...args, '--data', dataDir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 30_000 })
  if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0] || `The Modeller kernel failed (exit ${r.code}).`)
  return JSON.parse(r.stdout) as Summary
}

/** A step of the branch the player sees ("s003" or "3"), or a clear refusal. */
function onBranch(st: Summary, ref: string): Summary['steps'][number] {
  const s = st.steps.find((x) => x.id === ref || n(x.id) === n(ref))
  if (!s) throw new Error(`Step ${ref} is not on branch ${st.branch} any more. Pick a step from the list.`)
  return s
}

/** `script` is the kernel (unitskills modellerScript); `dataDir` the unit's modeller folder. */
export async function modellerAction(script: string, dataDir: string, act: ModellerAct): Promise<{ message: string; ping: string }> {
  const said = (s: { id: string; caption: string } | undefined): string => (s ? `${s.id} ("${s.caption}")` : 'no step')
  const k = (...args: string[]): Promise<Summary> => kernel(script, dataDir, args)
  switch (act.op) {
    case 'revert': {
      const r = await k('revert', act.model, act.step)
      return {
        message: `Back at step ${n(r.head)} on ${r.branch}.`,
        ping: `The player reverted model ${r.model} to ${said(r.steps.at(-1))} on branch ${r.branch} from the unit page. The steps after it left the branch (still on disk). Continue from ${r.head}; do not redo the dropped steps unless the player asks.`
      }
    }
    case 'branch': {
      const before = await k('status', act.model)
      const at = onBranch(before, act.step).id
      let name = `from-${at}`
      for (let i = 2; before.branches[name]; i++) name = `from-${at}-${i}`
      const r = await k('branch', act.model, name, '--from', at)
      return {
        message: `New branch ${name} from step ${n(r.head)}.`,
        ping: `The player started branch ${name} at ${said(r.steps.at(-1))} of model ${r.model} from the unit page and switched to it; branch ${before.branch} keeps its steps. Continue on ${name} from ${r.head}.`
      }
    }
    case 'switch': {
      const r = await k('switch', act.model, act.branch)
      return {
        message: `On branch ${r.branch}, step ${n(r.head)}.`,
        ping: `The player switched model ${r.model} to branch ${r.branch} from the unit page; its head is ${said(r.steps.at(-1))}. Continue there.`
      }
    }
  }
}
