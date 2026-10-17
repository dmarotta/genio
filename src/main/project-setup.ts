/**
 * Project setup in the chat (docs/project-setup.md): the steps, the facts that tick them, and the small
 * state/setup.json in the project's base. Done is never stored: every read derives it from the registry,
 * the project folder and the quest log, so anything done on a screen ticks its step. The file keeps only
 * what the player skipped, whether setup runs, and how many openings in a row went unanswered.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '@shared/types'
import type { AppCtx } from './services'
import { forgeFromRemote } from './projects'
import { nowIso, readJson, writeJsonAtomic } from './util'

export const SETUP_STEPS = [
  { id: 'git', title: 'git repo' },
  { id: 'pitch', title: 'the game in a sentence' },
  { id: 'engine', title: 'engine' },
  { id: 'landing', title: 'how work lands' },
  { id: 'art', title: 'art direction' },
  { id: 'design', title: 'design one-pager' },
  { id: 'tools', title: 'tools' },
  { id: 'unity', title: 'Unity and Play' },
  { id: 'spend', title: 'paid generation' },
  { id: 'first-work', title: 'first work' }
] as const

export type SetupStepId = typeof SETUP_STEPS[number]['id']
export const SETUP_STEP_IDS = SETUP_STEPS.map(s => s.id) as [SetupStepId, ...SetupStepId[]]

/** state/setup.json */
export interface SetupState {
  v: 1
  /** the folder was empty or had no git repo when Genio first opened it */
  new: boolean
  startedAt?: string
  skipped: SetupStepId[]
  /** openings in a row that asked and got no answer; two stop setup */
  ignoredOpens: number
  /** the open steps and skips the last opening saw: unchanged at the next one means it went unanswered */
  seen?: string
  /** Play has started once in this project */
  played?: boolean
  stoppedAt?: string
  finishedAt?: string
}

/** What is true in the project now, one entry per step; `applies: false` leaves a step out for this project. */
export type SetupFacts = Record<SetupStepId, { done: boolean; fact: string; applies?: boolean }>

export interface SetupStepView { id: SetupStepId; title: string; done: boolean; skipped: boolean; fact: string }
export interface SetupView {
  status: 'not started' | 'running' | 'stopped' | 'finished'
  next?: SetupStepView
  steps: SetupStepView[]
  skipped: string[]
}

const IGNORED_OPENS_STOP = 2

export function emptySetup(): SetupState {
  return { v: 1, new: false, skipped: [], ignoredOpens: 0 }
}

export const setupFile = (state: string): string => path.join(state, 'setup.json')

export function readSetup(file: string): SetupState | undefined {
  const s = readJson<Partial<SetupState> | undefined>(file, undefined)
  if (!s || typeof s !== 'object') return undefined
  return { ...emptySetup(), ...s, skipped: (s.skipped ?? []).filter(id => SETUP_STEP_IDS.includes(id)), ignoredOpens: Number(s.ignoredOpens) || 0 }
}

export function writeSetup(file: string, s: SetupState): void {
  writeJsonAtomic(file, s)
}

const running = (s: SetupState | undefined): s is SetupState => !!s?.startedAt && !s.stoppedAt && !s.finishedAt

export function setupView(s: SetupState | undefined, facts: SetupFacts): SetupView {
  const steps = SETUP_STEPS.filter(step => facts[step.id].applies !== false).map(step => ({
    id: step.id, title: step.title, done: facts[step.id].done, skipped: !!s?.skipped.includes(step.id), fact: facts[step.id].fact
  }))
  const status = !s?.startedAt ? 'not started' : s.finishedAt ? 'finished' : s.stoppedAt ? 'stopped' : 'running'
  return { status, steps, next: status === 'running' ? steps.find(x => !x.done && !x.skipped) : undefined, skipped: steps.filter(x => x.skipped && !x.done).map(x => x.title) }
}

/** A setup with nothing left to ask is finished. */
function finish(s: SetupState, view: SetupView, now: string): SetupState {
  return running(s) && !view.next ? { ...s, finishedAt: now } : s
}

/** Character Creation: this change finished setup, and its first work exists. */
function unlockIfFinished(ctx: AppCtx, before: SetupState | undefined, after: SetupState | undefined, facts: SetupFacts): void {
  if (before?.finishedAt || !after?.finishedAt || !facts['first-work'].done) return
  try { ctx.stats.unlock('project-setup') } catch { /* stats optional */ }
}

const progressKey = (view: SetupView): string => view.steps.filter(x => !x.done && !x.skipped).map(x => x.id).join(',')

/**
 * One opening of the project window. A new folder starts setup; a running setup is asked once per opening,
 * and two unanswered openings in a row stop it without a word. Away (DND or AFK), nothing is asked or counted.
 * Returns the next state and the recap line, if any.
 */
export function atOpening(s: SetupState | undefined, isNew: boolean, facts: SetupFacts, opts: { now: string; online: boolean }): { state?: SetupState; line?: string } {
  let state = !s && isNew ? { ...emptySetup(), new: true, startedAt: opts.now } : s
  if (!running(state)) return { state }
  const view = setupView(state, facts)
  state = finish(state, view, opts.now)
  if (!running(state) || !opts.online) return { state }
  // Never asked yet (a new folder, or setup resumed in words): ask the step. Otherwise ask once whether to pick it up.
  const first = state.seen === undefined
  const key = progressKey(view)
  const ignored = state.seen === key ? state.ignoredOpens + 1 : 0
  if (ignored >= IGNORED_OPENS_STOP) return { state: { ...state, ignoredOpens: ignored, stoppedAt: opts.now } }
  state = { ...state, ignoredOpens: ignored, seen: key }
  return { state, line: recapLine(view, first ? (state.new ? 'new project' : 'started') : 'reopened') }
}

/** `Setup: new project; next: git repo.` on the first opening, `Setup: reopened; next: …; skipped: ….` after. */
export function recapLine(view: SetupView, how: string): string | undefined {
  if (!view.next) return undefined
  return `Setup: ${how}; next: ${view.next.title}${view.skipped.length ? `; skipped: ${view.skipped.join(', ')}` : ''}.`
}

/** project_setup's write actions. skip takes the next open step when none is named; resume re-asks skipped steps. */
export function applySetupAction(s: SetupState | undefined, action: 'skip' | 'stop' | 'resume', facts: SetupFacts, opts: { now: string; step?: SetupStepId }): SetupState {
  const state = s ?? emptySetup()
  if (action === 'resume') return { ...state, startedAt: state.startedAt ?? opts.now, skipped: [], ignoredOpens: 0, seen: undefined, stoppedAt: undefined, finishedAt: undefined }
  if (action === 'stop') return { ...state, stoppedAt: opts.now, ignoredOpens: 0 }
  if (!running(state)) throw new Error('Setup is not running: resume it first if the player wants it.')
  const step = opts.step ?? setupView(state, facts).next?.id
  if (!step) throw new Error('No setup step is left to skip.')
  return { ...state, skipped: state.skipped.includes(step) ? state.skipped : [...state.skipped, step], ignoredOpens: 0 }
}

// ------------------------------------------------------------ facts from the project

/** Empty (a bare .git aside) or not a git repo: a folder Genio sets up. */
export function isNewFolder(p: Project): boolean {
  if (p.gitRepo === false) return true
  try {
    return fs.readdirSync(p.path).every(name => name === '.git')
  } catch {
    return false
  }
}

const nonEmptyFile = (file: string): boolean => {
  try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0 } catch { return false }
}
const hasNotes = (dir: string): boolean => {
  try { return fs.readdirSync(dir).some(name => name.endsWith('.md')) } catch { return false }
}
const monthlyCap = (root: string): number | undefined => {
  const cap = readJson<{ budget?: { monthly_usd?: unknown } }>(path.join(root, '.genio', 'fal', 'config.json'), {}).budget?.monthly_usd
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : undefined
}

export function setupFacts(ctx: AppCtx, p: Project, s: SetupState | undefined): SetupFacts {
  const homes = [...ctx.homes.values()]
  const work = homes.some(h => h.backlog.list().some(q => q.project === p.name) || h.crew.list().some(t => t.project === p.name))
  const missing = [...(p.engine === 'godot' ? ['godot'] : []), ...(forgeFromRemote(p.remote) === 'github' ? ['gh'] : [])]
    .filter(name => !ctx.toolchain.has(name))
  const cap = monthlyCap(p.path)
  const art = nonEmptyFile(path.join(p.path, '.genio', 'art-bible.md'))
  return {
    git: { done: p.gitRepo !== false, fact: p.gitRepo === false ? 'no git repo: units cannot start' : `git repo on ${p.defaultBranch || 'main'}` },
    pitch: { done: !!p.description?.trim(), fact: p.description?.trim() || 'no pitch yet' },
    engine: { done: p.engine !== 'other', fact: p.engine === 'other' ? 'no engine files yet' : `${p.engine} detected` },
    landing: { done: !!p.yolo || p.modeSource === 'manual', fact: `${p.mode}${p.yolo ? ', Auto-loot on' : ''}` },
    art: { done: art, fact: art ? 'Art Bible exists' : 'no Art Bible' },
    design: { done: hasNotes(path.join(p.path, '.genio', 'design')), fact: 'Lore notes in .genio/design/' },
    tools: { done: !missing.length, fact: missing.length ? `missing: ${missing.join(', ')}` : 'nothing missing' },
    unity: { done: !!s?.played, fact: s?.played ? 'Play has started here' : 'Play not started yet', applies: p.engine === 'unity' },
    spend: { done: cap !== undefined, fact: cap !== undefined ? `monthly cap $${cap}` : 'no monthly cap' },
    'first-work': { done: work, fact: work ? 'quests or units exist' : 'no quests yet' }
  }
}

/** The base that owns a project's chat (one per project). */
function baseOf(ctx: AppCtx, project: string): string | undefined {
  return ctx.allies.list().find(a => !a.retiredAt && a.projects.length === 1 && a.projects[0] === project)?.name
}

/** Record that Play started in a project: it ticks the Unity step. */
export function notePlayed(ctx: AppCtx, project: string): void {
  const base = baseOf(ctx, project)
  if (!base) return
  const file = setupFile(ctx.home(base).home.state)
  const s = readSetup(file)
  if (s && !s.played) writeSetup(file, { ...s, played: true })
}

/** At a project window's opening: update the state and return the recap line, if setup asks something. */
export function openSetup(ctx: AppCtx, project: string, state: string): string | undefined {
  const p = ctx.projects.get(project)
  if (!p) return undefined
  const file = setupFile(state)
  const before = readSetup(file)
  const facts = setupFacts(ctx, p, before)
  const r = atOpening(before, isNewFolder(p), facts, { now: nowIso(), online: ctx.away.state().mode === 'online' })
  unlockIfFinished(ctx, before, r.state, facts)
  // A folder that is not new and never started setup gets no file: nothing to remember.
  if (r.state && JSON.stringify(r.state) !== JSON.stringify(before)) writeSetup(file, r.state)
  return r.line
}

/** project_setup: read, skip, stop or resume, for one project. */
export function setupTool(ctx: AppCtx, project: string, state: string, action: 'read' | 'skip' | 'stop' | 'resume', step?: SetupStepId): SetupView {
  const p = ctx.projects.get(project)
  if (!p) throw new Error(`No project named ${project}`)
  const file = setupFile(state)
  const before = readSetup(file)
  let next = action === 'read' ? before : applySetupAction(before, action, setupFacts(ctx, p, before), { now: nowIso(), step })
  const facts = setupFacts(ctx, p, next)
  if (next) next = finish(next, setupView(next, facts), nowIso())
  unlockIfFinished(ctx, before, next, facts)
  if (next && JSON.stringify(next) !== JSON.stringify(before)) writeSetup(file, next)
  return setupView(next, facts)
}
