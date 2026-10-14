/**
 * Unity units drive Unity only through genio-unity
 * (resources/unit-skills/genio/skills/unity). Genio writes the wrapper's config
 * in the unit's state, outside its worktree, and advertises only the unit's own
 * targets: its worktree copy, its run records and its Play session file. The
 * main checkout and the shared pool stay inside the config, where only the
 * wrapper reads them to clone and lease Play slots.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '@shared/types'
import { effectiveEngine } from '@shared/engine'
import { supportsUnitySlots } from '@shared/play'
import { editorSeatsDir } from '../../resources/unit-skills/genio/lib/unity-editors.mjs'
import { fwd } from './util'

export const UNITY_CONFIG_SCHEMA = 'genio.unity-unit.v1'

export interface UnityUnitConfig {
  schema: typeof UNITY_CONFIG_SCHEMA
  task: string
  worktree: string
  /** Repository-relative POSIX path, '' = the repository root. */
  engineRoot: string
  runs: string
  slotFile: string
  /** The `unity` CLI Genio found, '' when none: the wrapper then falls back to the Hub editor. */
  cli: string
  /** An explicit editor for the raw fallback; by default the Hub install for the project's version. */
  editor?: string
  /** Seats shared with the Gauntlet; `cap` overrides the RAM-based default. */
  editors: { dir: string; cap?: number }
  /** The Play pool, exactly as Genio's PlayService (Settings › Unity slots) builds it. */
  play: { data: string; world: string }
}

export interface UnityUnitPaths {
  task: string
  worktree: string
  /** Genio's main data dir: the Play pools and the editor seats live there. */
  data: string
  /** The unit's own data dir; its runs go under unity/. */
  taskDir: string
  cli?: string
}

/** Config for a Unity unit; undefined for every other engine. */
export function unityUnitConfig(project: Project | undefined, o: UnityUnitPaths): UnityUnitConfig | undefined {
  if (!project) return undefined
  const { engine, root } = effectiveEngine(project)
  if (!supportsUnitySlots(engine)) return undefined
  const runs = path.join(o.taskDir, 'unity')
  return {
    schema: UNITY_CONFIG_SCHEMA, task: o.task, worktree: o.worktree, engineRoot: root, runs,
    slotFile: path.join(runs, 'play-session.json'), cli: o.cli ?? '',
    editors: { dir: editorSeatsDir(o.data) }, play: { data: o.data, world: project.path }
  }
}

/** What the unit is told: its own targets and the config path, never the main checkout. */
export function unityUnitEnv(config: UnityUnitConfig, configFile: string): Record<string, string> {
  return {
    GENIO_UNITY_CONFIG: fwd(configFile),
    GENIO_UNITY_PROJECT: fwd(path.join(config.worktree, config.engineRoot)),
    GENIO_UNITY_RUNS: fwd(config.runs),
    GENIO_UNITY_SLOT_FILE: fwd(config.slotFile),
    ...(config.cli ? { GENIO_UNITY_CLI: fwd(config.cli) } : {})
  }
}

let cliCache: { key: string; found: string } | undefined

/**
 * Unity's `unity` CLI on PATH, '' when absent. lstat, not exists: the Windows
 * Store alias in WindowsApps is a reparse point that stat refuses.
 */
export function findUnityCli(env: NodeJS.ProcessEnv = process.env): string {
  const pathVar = env.PATH ?? env.Path ?? ''
  if (cliCache?.key === pathVar) return cliCache.found
  // Never a .cmd: the wrapper runs the CLI without a shell.
  const names = process.platform === 'win32' ? ['unity.exe'] : ['unity']
  let found = ''
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name)
      try { fs.lstatSync(file); found = file; break } catch { /* not here */ }
    }
    if (found) break
  }
  cliCache = { key: pathVar, found }
  return found
}
