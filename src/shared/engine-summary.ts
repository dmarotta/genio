import type { Engine, Project } from './types'
import { effectiveEngine, ENGINE_LABEL } from './engine'

export interface EngineCandidateFact { engine: Engine; root: string; version?: string }

/** What units and the chat are told about a project's engine. */
export interface EngineFacts {
  engine: Engine
  /** Repository-relative POSIX path, '' = the repository root. */
  root: string
  version?: string
  /** The root comes from the repo's .genio/project.json, not from the scan. */
  declared: boolean
  /** The top two candidates tied on strength and depth. */
  ambiguous: boolean
  /** Every other candidate the scan found, in tie-break order. */
  others: EngineCandidateFact[]
  /** Why a .genio/project.json declaration was ignored. */
  warning?: string
}

/** Read from detection's `detected` record; an entry not yet scanned reads as a plain detection with no other candidates. */
export function engineFacts(p: Pick<Project, 'engine' | 'engineRoot' | 'detected'>): EngineFacts {
  const { engine, root } = effectiveEngine(p)
  const d = p.detected
  const others: EngineCandidateFact[] = []
  for (const c of Array.isArray(d?.candidates) ? d.candidates : []) {
    if (!c || c.engine === 'other' || !(c.engine in ENGINE_LABEL)) continue
    const fact = { engine: c.engine, root: effectiveEngine({ engine: c.engine, engineRoot: c.root }).root, ...(c.version ? { version: c.version } : {}) }
    if ((fact.engine !== engine || fact.root !== root) && !others.some(x => x.engine === fact.engine && x.root === fact.root)) others.push(fact)
  }
  return {
    engine, root, others,
    version: engine === 'other' ? undefined : d?.version?.trim() || undefined,
    declared: d?.declared === true,
    ambiguous: d?.ambiguous === true,
    ...(d?.warning ? { warning: d.warning } : {})
  }
}

const at = (root: string): string => root ? `${root}/` : 'the repository root'
const named = (c: EngineCandidateFact): string => `${ENGINE_LABEL[c.engine]} at ${at(c.root)}`
const label = (f: EngineFacts): string => `${ENGINE_LABEL[f.engine]}${f.version ? ` ${f.version}` : ''}`
const origin = (f: EngineFacts): string => f.declared ? 'set in .genio/project.json' : 'detected'

/** One line for the project listing: the engine, where it lives, other candidates and any ambiguity. */
export function engineSummaryLine(f: EngineFacts): string {
  const also = f.others.length ? ` Also found: ${f.others.map(named).join('; ')}.` : ''
  const warning = f.warning ? ` ${f.warning}` : ''
  if (f.engine === 'other') return `No game engine detected; Genio treats this as a code project.${also}${warning}`
  const tie = f.ambiguous
    ? ' Ambiguous: the top candidates tie, so the pick above is only the alphabetical tie-break. Ask the player which one to use and pin it with world_engine_root.'
    : ''
  return `${label(f)} at ${at(f.root)} (${origin(f)}).${also}${tie}${warning}`
}

/** Opens a unit brief's Engine notes. */
export function engineBriefLine(f: EngineFacts): string {
  if (f.engine === 'other') return '- Project engine: none detected; treat this as a code project.'
  const also = f.others.length ? ` Also found: ${f.others.map(named).join('; ')}. Stay in the root above unless the mission names another.` : ''
  return `- Project engine: ${label(f)} at ${at(f.root)} (${origin(f)}). Run engine commands there.${also}`
}

/** Unit environment for every engine. GENIO_ENGINE_ROOT is relative to the worktree, '.' for its root. */
export function engineEnv(p: Pick<Project, 'engine' | 'engineRoot'>): { GENIO_ENGINE: Engine; GENIO_ENGINE_ROOT: string } {
  const { engine, root } = effectiveEngine(p)
  return { GENIO_ENGINE: engine, GENIO_ENGINE_ROOT: root || '.' }
}

export const KEEP_DETECTING = 'Keep detecting automatically'

export interface EngineChoice {
  key: string
  question: string
  options: string[]
  recommendation: string
  context: string
  /** option -> engine root it pins */
  roots: Record<string, string>
}

/**
 * The one-time choice for an ambiguous detection. Its key names the tied candidates, so the same
 * ambiguity is asked once and a different one asks again. A declared root is never ambiguous.
 */
export function engineAmbiguityChoice(p: Pick<Project, 'name' | 'engine' | 'engineRoot' | 'detected'>): EngineChoice | undefined {
  const f = engineFacts(p)
  if (!f.ambiguous || f.declared || f.engine === 'other' || !f.others.length) return undefined
  const all = [{ engine: f.engine, root: f.root }, ...f.others]
  const roots = Object.fromEntries(all.map(c => [named(c), c.root]))
  const options = [...Object.keys(roots), KEEP_DETECTING]
  return {
    key: `engine-root:${all.map(c => `${c.engine}@${c.root || '.'}`).sort().join('|')}`,
    question: `${p.name} holds more than one game project. Which one should Genio work in?`,
    options,
    recommendation: options[0],
    context: `Detection found ${all.map(named).join(' and ')} and they tie, so Genio picked ${at(f.root)} alphabetically. Your pick is saved in the project as .genio/project.json; commit it so every copy agrees.`,
    roots
  }
}
