/**
 * The repo declaration escape hatch for units and the chat:
 * `.genio/project.json { "engineRoot": "client" }` is written only on the
 * player's explicit word, after checking the root holds an engine marker.
 * Detection (engine-detect.ts) reads it first on the next scan.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Decision, Project } from '@shared/types'
import { effectiveEngine, ENGINE_LABEL } from '@shared/engine'
import { engineAmbiguityChoice, engineFacts, engineProposalChoice, engineSummaryLine, PROPOSAL_KEY } from '@shared/engine-summary'
import type { AppCtx } from './services'
import type { ToolRole } from './workspace-tools'
import { candidateAt, cleanRoot, DECLARATION_FILE } from './engine-detect'

export const projectEngineSummary = (p: Project): string => engineSummaryLine(engineFacts(p))

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The root as the declaration stores it, or an error when it would leave the project. */
function declaredRoot(projectPath: string, raw: string): string {
  const root = cleanRoot(raw.trim())
  if (root === undefined) throw new Error('The engine root must be a folder inside the project')
  let base: string, target: string
  try {
    base = fs.realpathSync(projectPath)
    target = fs.realpathSync(path.join(base, root))
  } catch {
    throw new Error(`${root || 'The repository root'} does not exist in the project`)
  }
  const relative = path.relative(base, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The engine root must be a folder inside the project')
  if (!fs.statSync(target).isDirectory()) throw new Error(`${root} is not a folder`)
  return root
}

/** playerWords: the player's answer to the engine choice; approval: how the chat's request was cleared (Allow once or YOLO). */
export interface DeclareRequest { world: string; root: string; playerWords?: string; approval?: 'prompt' | 'mode'; actor: ToolRole | 'player' }

/** Pin the engine root in the repo, then rescan. Never on the Bot's or Genio's own judgment. */
export async function declareEngineRoot(ctx: AppCtx, a: DeclareRequest): Promise<string> {
  if (a.actor === 'bot') throw new Error('The Bot cannot pin the engine root; it waits for the player')
  if (!a.playerWords?.trim() && !a.approval) throw new Error("Pinning the engine root needs the player's answer or the chat's cleared request")
  const project = ctx.projects.get(a.world)
  if (!project) throw new Error(`Unknown project: ${a.world}`)
  const root = declaredRoot(project.path, a.root)
  const marker = await candidateAt(project.path, root)
  if (!marker) throw new Error(`${root ? `${root}/` : 'The repository root'} holds no game engine marker (ProjectVersion.txt, project.godot, .uproject, ...)`)
  const file = path.join(project.path, DECLARATION_FILE)
  const current = fs.existsSync(file) ? readJsonObject(file) : {}
  if (!current) throw new Error(`${DECLARATION_FILE} is not a JSON object; fix it by hand first`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...current, engineRoot: root }, null, 2) + '\n', 'utf8')
  try {
    ctx.ledger.record({ event: 'project.engine_declared', project: project.name, data: { root, engine: marker.engine, ...(a.playerWords?.trim() ? { playerWords: a.playerWords.trim() } : {}), ...(a.approval ? { approval: a.approval } : {}) } })
  } catch { /* optional */ }
  await ctx.projects.rescan(project.name).catch(() => undefined)
  const now = effectiveEngine(ctx.projects.get(project.name) ?? project)
  const pinned = `Pinned ${ENGINE_LABEL[marker.engine]} at ${root ? `${root}/` : 'the repository root'} in ${DECLARATION_FILE} (uncommitted: commit it so every copy and unit agrees).`
  return now.engine === marker.engine && now.root === root
    ? pinned
    : `${pinned} Detection still reports ${ENGINE_LABEL[now.engine]} at ${now.root ? `${now.root}/` : 'the repository root'}; it takes the declaration on its next scan.`
}

const safeHome = (ctx: AppCtx, name: string) => { try { return ctx.home(name) } catch { return undefined } }

/**
 * Open the ambiguity choice once per tied candidate set, in the chat that owns the project. A retired
 * manual root that detection does not pick (the migration's proposal) is asked first, once.
 */
export function surfaceEngineAmbiguity(ctx: AppCtx, projects: Project[] = ctx.projects.list()): void {
  for (const p of projects) {
    const choice = engineProposalChoice(p) ?? engineAmbiguityChoice(p)
    if (!choice) continue
    const owner = ctx.allies.list().find(a => !a.retiredAt && a.projects.includes(p.name))?.name
    const h = safeHome(ctx, owner ?? 'main') ?? ctx.main
    if ([...ctx.homes.values()].some(x => x.decisions.list(true).some(d => d.project === p.name && d.key === choice.key))) continue
    h.decisions.open({
      question: choice.question, options: choice.options, recommendation: choice.recommendation, context: choice.context,
      project: p.name, key: choice.key, source: 'genio', workspace: h.home.name,
      action: { kind: 'engine-root', project: p.name, roots: choice.roots }
    })
  }
}

/** The player's answer to the ambiguity choice is their explicit word: pin the root they picked. */
export async function answerEngineChoice(ctx: AppCtx, d: Decision, answer: string): Promise<string | undefined> {
  if (d.action?.kind !== 'engine-root') return undefined
  // Either answer settles the migration's proposal: pinned, detection agrees; kept detecting, it is done.
  if (d.key?.startsWith(PROPOSAL_KEY)) {
    try { ctx.projects.update(d.action.project, { engineProposal: undefined }) } catch { /* project gone */ }
  }
  const root = Object.prototype.hasOwnProperty.call(d.action.roots, answer.trim()) ? d.action.roots[answer.trim()] : undefined
  if (root === undefined) return undefined
  return declareEngineRoot(ctx, { world: d.action.project, root, playerWords: answer, actor: 'player' })
}
