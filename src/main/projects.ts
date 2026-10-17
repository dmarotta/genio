/**
 * Worlds (project registry). companion data/projects.md + project-management
 * skill + bin/fm-project-mode.sh, as JSON with engine awareness.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DeliveryMode, Engine, EngineCandidate, EngineProposal, Forge, Project, ProjectMode } from '@shared/types'
import type { OpResult, ProjectAddRequest, ProjectInitRequest } from '@shared/api'
import { engineSummary, proposalLine } from '@shared/engine'
import { modeLabel, modeSourceOf } from '@shared/vocab'
import { settingsPath } from '@shared/settings-pages'
import type { AppCtx, ProjectsService } from './services'
import { bus } from './bus'
import { Home, defaultHomeRoot } from './home'
import { isDefaultUnityTest } from './play-editor'
import { candidateAt, cleanRoot, commandsFor, detectProject } from './engine-detect'
import * as git from './git'
import { exists, nowIso, readJson, run, slugify, which, writeJson, writeText } from './util'

export const DEFAULT_BRANCH_PREFIX = 'genio/'

export function normalisedProjectPath(folder: string, platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path
  const resolved = paths.resolve(folder).replace(/[\\/]+$/, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function uniqueProjectName(folder: string, names: string[]): string {
  const base = nameFromSource(folder) || 'world'
  let name = base
  for (let n = 2; names.some(x => x.toLowerCase() === name.toLowerCase()); n++) name = `${base}-${n}`
  return name
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * What an entry from before infer-only pinned by hand, and only that: a manual engine, a manual root,
 * or both. An entry older than `engineSource` that names an engine and was never scanned pinned its
 * engine (the old precedence).
 */
function manualPins(p: Project): { engine?: Engine; root?: string } | undefined {
  const legacy = !p.engineSource && !p.detected && p.engine !== 'other'
  const engine = p.engineSource === 'manual' || legacy ? p.engine : undefined
  const root = p.engineRootSource === 'manual' ? cleanRoot(p.engineRoot ?? '') ?? '' : undefined
  return engine === undefined && root === undefined ? undefined : { engine, root }
}

/**
 * Migration: a manual engine or root that detection does not pick is kept once as a proposal for the
 * player, never written into the repository. Equal to detection, it is dropped silently.
 */
async function proposalFor(p: Project, engine: Engine, engineRoot: string, candidates: EngineCandidate[]): Promise<EngineProposal | undefined> {
  const pins = manualPins(p)
  if (!pins || ((pins.engine ?? engine) === engine && (pins.root ?? engineRoot) === engineRoot)) return undefined
  const atRoot = pins.root === undefined ? undefined : await candidateAt(p.path, pins.root)
  const wanted = pins.engine ?? atRoot?.engine ?? p.engine
  const root = pins.root ?? candidates.find((c) => c.engine === wanted)?.root ?? cleanRoot(p.engineRoot ?? '') ?? ''
  const marker = pins.root === undefined ? candidates.find((c) => c.root === root) ?? await candidateAt(p.path, root) : atRoot
  return { engine: wanted, engineRoot: root, declarable: wanted !== 'other' && marker?.engine === wanted, notedAt: nowIso() }
}

/**
 * Re-detect a project's engine and record what the scan found in `detected`. Detection alone sets the
 * engine and its root. When either changes, only the commands the entry leaves unset are filled; a
 * default Unity test commands migrate to the managed wrapper. The retired manual flags are dropped.
 */
export async function refreshEngine(p: Project): Promise<Project> {
  const det = await detectProject(p.path)
  const { engine, engineRoot } = det
  const proposal = await proposalFor(p, engine, engineRoot, det.detected.candidates)
  const changed = engine !== p.engine || engineRoot !== (p.engineRoot ?? '')
  let commands = p.commands
  if (changed) commands = { ...Object.fromEntries(Object.entries(det.commands).filter(([, v]) => v !== undefined)), ...Object.fromEntries(Object.entries(p.commands).filter(([, v]) => v !== undefined)) }
  if (engine === 'unity' && isDefaultUnityTest(p.commands.test) && det.commands.test) commands = { ...commands, test: det.commands.test }
  const { engineSource: _engine, engineRootSource: _root, engineProposal: kept, ...rest } = p
  // A kept proposal goes once detection agrees with it (the player had Genio pin it).
  const engineProposal = proposal ?? (kept && (kept.engine !== engine || kept.engineRoot !== engineRoot) ? kept : undefined)
  return { ...rest, commands, engine, engineRoot, detected: det.detected, ...(engineProposal ? { engineProposal } : {}) }
}

/** The toast for a retired manual engine that differs from detection. */
export function engineProposalNotice(p: Project): string | undefined {
  const line = proposalLine(p)
  return line && `${p.name}: ${line}`
}

/** A one-line toast when a refresh moved the engine or its root, undefined otherwise. */
export function engineChangeNotice(prev: Project, next: Project): string | undefined {
  if (prev.engine === next.engine && (prev.engineRoot ?? '') === (next.engineRoot ?? '')) return undefined
  const version = next.detected?.candidates.find((c) => c.engine === next.engine && c.root === (next.engineRoot ?? ''))?.version
  return `${next.name}: ${engineSummary(prev.engine, prev.engineRoot)} → ${engineSummary(next.engine, next.engineRoot, version)}.`
}

export function forgeFromRemote(remote?: string): Forge {
  if (!remote) return 'none'
  if (/github\.com/i.test(remote)) return 'github'
  if (/gitlab/i.test(remote)) return 'gitlab'
  return 'none'
}

/**
 * The app's default delivery mode: it follows the remote. No remote → Offline; a GitHub remote →
 * Standard (PRs); any other remote (GitLab, Gitea, self-hosted) → Offline with local landing and
 * push on demand (world_push), since Genio only drives PRs through GitHub.
 */
export function autoModeFor(remote?: string): ProjectMode {
  return forgeFromRemote(remote) === 'github' ? 'direct-PR' : 'local-only'
}

/** Forge recorded for a mode: Offline worlds never use one. */
function forgeFor(mode: ProjectMode, remote?: string): Forge {
  return mode === 'local-only' ? 'none' : forgeFromRemote(remote)
}

/**
 * Re-read a world's remote. When it changed, record it; an auto mode follows the new remote,
 * a manual one is kept. Returns the updated entry and a one-line notice, or undefined if unchanged.
 */
export function applyRemoteChange(p: Project, remote: string | undefined): { next: Project; notice: string } | undefined {
  if ((remote ?? '') === (p.remote ?? '')) return undefined
  const auto = modeSourceOf(p) === 'auto'
  const mode = auto ? autoModeFor(remote) : p.mode
  const next: Project = { ...p, remote, mode, modeSource: auto ? 'auto' : 'manual', forge: forgeFor(mode, remote) }
  const what = remote ? (p.remote ? `remote changed to ${remote}` : `gained remote ${remote}`) : 'lost its remote'
  const how =
    mode !== p.mode
      ? `delivery ${modeLabel(p.mode)} → ${modeLabel(mode)} (follows the remote)`
      : auto
        ? `delivery stays ${modeLabel(mode)}`
        : `delivery stays ${modeLabel(mode)} (set by hand)`
  return { next, notice: `${p.name} ${what}: ${how}.` }
}

const GITIGNORE: Record<Engine, string> = {
  godot: '.godot/\n.import/\nexport.cfg\nexport_presets.cfg\n*.translation\n',
  unity: '/[Ll]ibrary/\n/[Tt]emp/\n/[Oo]bj/\n/[Bb]uild/\n/[Bb]uilds/\n/[Ll]ogs/\n/[Uu]ser[Ss]ettings/\n*.csproj\n*.sln\n.vs/\n',
  unreal: 'Binaries/\nIntermediate/\nSaved/\nDerivedDataCache/\n.vs/\n*.sln\n',
  bevy: '/target\n',
  web: 'node_modules/\ndist/\n.vite/\n',
  love2d: '*.love\n',
  gamemaker: 'tmp/\n*.resource_order\n',
  defold: '/build\n/.internal\n',
  monogame: 'bin/\nobj/\n',
  other: ''
}

function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s)
}

function normaliseUrl(s: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !exists(s)) return `https://github.com/${s}.git`
  return s
}

function nameFromSource(s: string): string {
  const base = s.replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? 'project'
  return slugify(base.replace(/\.git$/i, ''), 48)
}

export function createProjectsService(getCtx: () => AppCtx): ProjectsService {
  const mainHome = (): Home => {
    try {
      return getCtx().main.home
    } catch {
      return new Home(defaultHomeRoot())
    }
  }
  let cache: Project[] | undefined
  const load = (): Project[] => {
    if (!cache) cache = readJson<Project[]>(mainHome().projectsFile, [])
    return cache
  }
  const save = (list: Project[]): void => {
    cache = list
    writeJson(mainHome().projectsFile, list)
    bus.publish({ type: 'projects', projects: list })
  }
  /** Toast a saved refresh that moved the engine, retired a differing manual engine, or newly ignored the repository's declaration. */
  const announceEngine = (prev: Project, next: Project): string | undefined => {
    const warning = next.detected?.warning
    if (warning && warning !== prev.detected?.warning) bus.toast('warn', 'Engine declaration ignored', `${next.name}: ${warning}`)
    const proposal = next.engineProposal && next.engineProposal !== prev.engineProposal ? engineProposalNotice(next) : undefined
    const notice = proposal ?? engineChangeNotice(prev, next)
    if (!notice) return undefined
    if (proposal) bus.toast('warn', 'Engine set by hand retired', proposal)
    else bus.toast('info', 'Project engine changed', notice)
    try {
      getCtx().ledger.record({ event: 'project.engine_changed', project: next.name, data: { from: prev.engine, to: next.engine, rootFrom: prev.engineRoot ?? '', root: next.engineRoot ?? '', ...(proposal ? { proposal: next.engineProposal } : {}) } })
    } catch {
      /* ledger optional */
    }
    return notice
  }

  const register = async (dir: string, name: string, req: Partial<ProjectAddRequest>, managed: boolean): Promise<Project> => {
    const gitRepo = await git.isRepo(dir)
    const remote = gitRepo ? await git.remoteUrl(dir) : undefined
    const det = await detectProject(dir)
    const p: Project = {
      name,
      path: path.resolve(dir),
      gitRepo,
      remote,
      defaultBranch: gitRepo ? await git.defaultBranch(dir) : '',
      mode: gitRepo ? req.mode ?? autoModeFor(remote) : 'local-only',
      modeSource: req.mode ? 'manual' : 'auto',
      yolo: req.yolo ?? false,
      branchPrefix: req.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
      forge: req.forge ?? forgeFromRemote(remote),
      capacity: req.capacity,
      engine: det.engine,
      engineRoot: det.engineRoot,
      detected: det.detected,
      commands: det.commands,
      managed,
      addedAt: nowIso()
    }
    if (p.mode === 'local-only' && p.forge !== 'none') p.forge = 'none'
    const list = load().filter((x) => x.name !== name)
    save([...list, p])
    try {
      bus.publish({ type: 'feature-used', feature: 'world_add' })
      getCtx().ledger.record({ event: 'project.added', project: name, data: { engine: p.engine, mode: p.mode } })
    } catch {
      /* ledger optional */
    }
    return p
  }

  const liveStates = new Set(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'ready', 'stale', 'detached', 'exited', 'merged', 'failed'])
  // Serialize registration, including different paths whose folder names collide.
  let opening: Promise<unknown> = Promise.resolve()

  const svc: ProjectsService = {
    list: () => [...load()],
    get: (name) => load().find((p) => p.name === name),

    openFolder(folder) {
      const operation = opening.then(async () => {
        const requested = path.resolve(folder)
        if (!fs.statSync(requested).isDirectory()) throw new Error('Open a folder, not a file.')
        const gitRepo = await git.isRepo(requested)
        const dir = gitRepo ? await git.repoTop(requested) || requested : requested
        const known = load().find(p => normalisedProjectPath(p.path) === normalisedProjectPath(dir))
          ?? load().find(p => normalisedProjectPath(p.path) === normalisedProjectPath(requested))
        if (!known) return { project: await register(dir, uniqueProjectName(dir, load().map(p => p.name)), {}, false), registered: true }
        const remote = gitRepo ? await git.remoteUrl(dir) : undefined
        const mode = !gitRepo ? 'local-only' : modeSourceOf(known) === 'auto' ? autoModeFor(remote) : known.mode
        const project = await refreshEngine({ ...known, path: dir, gitRepo, remote, defaultBranch: gitRepo ? await git.defaultBranch(dir) : '', mode, forge: forgeFor(mode, remote) })
        save(load().map(p => p.name === known.name ? project : p))
        announceEngine(known, project)
        return { project, registered: false }
      })
      opening = operation.catch(() => undefined)
      return operation
    },

    async add(req) {
      const src = req.source.trim().replace(/^"|"$/g, '')
      if (!src) throw new Error('Give a git URL, owner/repo, or a local folder.')
      const isLocal = exists(src) && fs.statSync(src).isDirectory()
      if (isLocal) {
        const dir = path.resolve(src)
        if (req.inPlace !== false && !req.name) return (await svc.openFolder(dir)).project
        if (req.inPlace === false && !(await git.isRepo(dir))) throw new Error('Cloning needs a git repo.')
        const top = await git.repoTop(dir)
        const name = req.name ? slugify(req.name, 48) : nameFromSource(top || dir)
        if (svc.get(name)) throw new Error(`A project named "${name}" already exists.`)
        if (req.inPlace !== false) return register(top || dir, name, req, false)
        const dest = path.join(mainHome().projects, name)
        const c = await git.clone(dir, dest)
        if (c.code !== 0) throw new Error(`Clone failed: ${c.stderr.trim()}`)
        return register(dest, name, req, true)
      }
      if (!looksLikeUrl(src)) throw new Error(`"${src}" is neither an existing folder nor a git URL.`)
      const url = normaliseUrl(src)
      const name = req.name ? slugify(req.name, 48) : nameFromSource(url)
      if (svc.get(name)) throw new Error(`A project named "${name}" already exists.`)
      const dest = path.join(mainHome().projects, name)
      if (exists(dest)) {
        if (await git.isRepo(dest)) return register(dest, name, req, true)
        throw new Error(`${dest} exists and is not a git repository.`)
      }
      bus.toast('info', 'Cloning project', url)
      const c = await git.clone(url, dest)
      if (c.code !== 0) throw new Error(`Clone failed: ${c.stderr.trim()}`)
      return register(dest, name, req, true)
    },

    async init(name, req: ProjectInitRequest) {
      const p = svc.get(name)
      if (!p) throw new Error(`Unknown project: ${name}`)
      const dir = p.path
      if (!exists(dir)) throw new Error(`${dir} is missing.`)
      // A repo with no commit yet (an earlier init stopped before its commit) is finished, never redone.
      if (await git.isRepo(dir) && (await git.git(dir, ['rev-parse', '--verify', 'HEAD'])).code === 0) throw new Error(`${name} already has a git repo.`)
      if (req.createRemote && !which('gh')) throw new Error(`Creating a GitHub repo needs the gh CLI (${settingsPath('toolchain', 'Install')}).`)
      if (!(await git.isRepo(dir))) {
        const init = await git.initRepo(dir, 'main')
        if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`)
      }
      // The player's own .gitignore and AGENTS.md are kept as they are.
      const engine = req.engine ?? p.engine
      const pitch = req.pitch?.trim() || p.description?.trim()
      if (!exists(path.join(dir, '.gitignore'))) writeText(path.join(dir, '.gitignore'), `# Genio project: ${name}\n${GITIGNORE[engine] ?? ''}`)
      if (!exists(path.join(dir, 'AGENTS.md'))) {
        writeText(path.join(dir, 'AGENTS.md'), `# ${name}\n\nGuidance for coding agents working on this game.\n\n- Engine: ${engine}\n${pitch ? `- Pitch: ${pitch}\n` : ''}`)
      }
      const c = await git.commitAll(dir, 'Initial commit')
      // commit may fail without git identity configured; surface clearly
      if (c.code !== 0) throw new Error(`Initial commit failed: ${(c.stderr || c.stdout).trim()}`)
      if (req.createRemote) {
        const vis = req.privateRemote === false ? '--public' : '--private'
        const r = await run(which('gh')!, ['repo', 'create', name, vis, '--source', '.', '--push'], { cwd: dir, timeoutMs: 300_000 })
        if (r.code !== 0) bus.toast('warn', 'GitHub repo not created', (r.stderr || r.stdout).trim())
      }
      if (pitch && !p.description?.trim()) svc.update(name, { description: pitch })
      try {
        getCtx().ledger.record({ event: 'project.initialized', project: name, data: { engine, remote: !!req.createRemote } })
      } catch {
        /* ledger optional */
      }
      // Re-read the folder: git present, delivery follows the remote. The engine choice only picked the .gitignore.
      return (await svc.openFolder(dir)).project
    },
    update(name, patch) {
      const list = load()
      const i = list.findIndex((p) => p.name === name)
      if (i < 0) throw new Error(`Unknown project: ${name}`)
      const has = (k: keyof Project): boolean => Object.prototype.hasOwnProperty.call(patch, k)
      // Genio infers the engine: only detection writes it. The repository's .genio/project.json is the one way to pin a root.
      if ((['engine', 'engineRoot', 'engineSource', 'engineRootSource'] as const).some(has)) {
        throw new Error('The engine is detected, not set: ask Genio to pin its root in the repository\'s .genio/project.json, then Rescan')
      }
      if (has('engineProposal') && patch.engineProposal !== undefined) throw new Error('An engine proposal can only be dismissed')
      // Only detection writes what the scan found.
      const next: Project = { ...list[i], ...patch, name: list[i].name, detected: list[i].detected, commands: { ...list[i].commands, ...(patch.commands ?? {}) } }
      if (has('engineProposal')) delete next.engineProposal
      // Choosing a mode pins it; asking for 'auto' hands it back to the remote.
      if (patch.modeSource === 'auto') next.mode = autoModeFor(next.remote)
      else if (patch.mode !== undefined) next.modeSource = 'manual'
      if (patch.mode !== undefined || patch.modeSource === 'auto') next.forge = forgeFor(next.mode, next.remote)
      if (next.mode === 'local-only') next.forge = 'none'
      if (next.gitRepo === false) { next.mode = 'local-only'; next.forge = 'none'; next.remote = undefined; next.defaultBranch = '' }
      list[i] = next
      save([...list])
      return next
    },

    async remove(name, deleteClone): Promise<OpResult> {
      const p = svc.get(name)
      if (!p) return { ok: false, message: `Unknown project: ${name}` }
      const ctx = getCtx()
      const reasons: string[] = []
      for (const h of ctx.homes.values()) {
        for (const t of h.crew.list()) {
          if (t.project !== name) continue
          if (liveStates.has(t.state)) reasons.push(`unit ${t.id} (${t.state}) in base ${h.home.name}`)
          else if (t.state !== 'cleaned' && exists(t.worktree)) reasons.push(`worktree for ${t.id} still exists`)
        }
        for (const b of h.backlog.list()) {
          if (b.project === name && (b.state === 'queued' || b.state === 'in-flight' || b.state === 'held' || b.state === 'blocked')) {
            reasons.push(`quest ${b.id} (${b.state}) in base ${h.home.name}`)
          }
        }
      }
      if (deleteClone && p.managed && exists(p.path)) {
        const dirty = await git.statusPorcelain(p.path)
        if (dirty.length) reasons.push(`the clone has ${dirty.length} uncommitted change(s)`)
        if (await git.hasRemote(p.path)) {
          const unpushed = await run('git', ['log', '--branches', '--not', '--remotes', '--oneline'], { cwd: p.path })
          const n = unpushed.stdout.trim().split(/\r?\n/).filter(Boolean).length
          if (n) reasons.push(`${n} local commit(s) not on any remote`)
        } else {
          reasons.push('the clone has no remote: deleting it would lose the only copy')
        }
      }
      if (reasons.length) return { ok: false, message: `Refusing to remove ${name}: ${reasons.join('; ')}.` }
      if (deleteClone && p.managed && exists(p.path)) {
        try {
          fs.rmSync(p.path, { recursive: true, force: true, maxRetries: 3 })
        } catch (e) {
          return { ok: false, message: `Could not delete the clone: ${(e as Error).message}` }
        }
      }
      save(load().filter((x) => x.name !== name))
      try {
        ctx.ledger.record({ event: 'project.removed', project: name })
      } catch {
        /* ignore */
      }
      return { ok: true, message: `${name} removed${deleteClone && p.managed ? ' and its clone deleted' : ''}.` }
    },

    async refreshRemotes(name) {
      const notices: string[] = []
      const list = [...load()]
      const originals = new Map(list.map(p => [p.name, p]))
      let engineChanged = false
      for (let i = 0; i < list.length; i++) {
        const p = list[i]
        if ((name && p.name !== name) || !exists(p.path)) continue
        const refreshed = await refreshEngine(p)
        if (JSON.stringify(refreshed) !== JSON.stringify(p)) engineChanged = true
        list[i] = refreshed
        // Ordinary folders refresh their engine too; only git repos have a remote to follow.
        if (!(await git.isRepo(p.path))) continue
        const change = applyRemoteChange(refreshed, await git.remoteUrl(p.path))
        if (!change) continue
        list[i] = change.next
        notices.push(change.notice)
        try {
          getCtx().ledger.record({ event: 'project.remote_changed', project: p.name, data: { from: p.remote, to: change.next.remote, modeFrom: p.mode, mode: change.next.mode } })
        } catch {
          /* ledger optional */
        }
        bus.toast('info', 'Project remote changed', change.notice)
      }
      // An open/register/update can complete while git is being queried. Preserve those edits.
      const current = load()
      if (notices.length || engineChanged) save(current.map(p => p === originals.get(p.name) ? list.find(x => x.name === p.name)! : p))
      for (const p of current) {
        const next = list.find(x => x.name === p.name)
        const notice = next && p === originals.get(p.name) ? announceEngine(p, next) : undefined
        if (notice) notices.push(notice)
      }
      return notices
    },

    async rescan(name) {
      if (name && !svc.get(name)) throw new Error(`Unknown project: ${name}`)
      const before = load().filter(p => (!name || p.name === name) && exists(p.path))
      const scanned = await Promise.all(before.map(refreshEngine))
      // A scan is asynchronous: an entry edited meanwhile keeps the edit and is scanned next time.
      const kept = new Map(scanned.filter((next, i) => load().includes(before[i])).map(next => [next.name, next]))
      if (kept.size) save(load().map(p => kept.get(p.name) ?? p))
      for (const [i, p] of before.entries()) if (kept.has(p.name)) announceEngine(p, scanned[i])
      return [...kept.values()]
    },

    async sync(name): Promise<OpResult> {
      const notices = await svc.refreshRemotes(name)
      const targets = name ? load().filter((p) => p.name === name) : load()
      if (name && !targets.length) return { ok: false, message: `Unknown project: ${name}` }
      const lines: string[] = [...notices]
      let ok = true
      for (const p of targets) {
        if (p.gitRepo === false) { lines.push(`${p.name}: sync needs a git repo.`); if (name) ok = false; continue }
        if (!exists(p.path)) {
          lines.push(`${p.name}: clone missing at ${p.path}`)
          ok = false
          continue
        }
        if (!(await git.hasRemote(p.path))) {
          lines.push(`${p.name}: offline project, nothing to sync`)
          continue
        }
        if (p.mode === 'local-only') {
          // Offline with a remote: landings are local, so only refresh origin's refs; never touch local branches.
          const f = await git.fetch(p.path)
          const st = f.code === 0 ? await git.pushStatus(p.path, p.defaultBranch) : undefined
          lines.push(
            f.code !== 0
              ? `${p.name}: offline project; could not reach origin (${f.stderr.trim()})`
              : `${p.name}: offline project; ${st && st.ahead ? `${st.ahead} commit(s) on ${p.defaultBranch} not pushed` : `${p.defaultBranch} has nothing to push`}${st && st.behind ? `, ${st.behind} on origin not local` : ''}`
          )
          continue
        }
        const r = await git.syncClone(p.path, p.defaultBranch)
        if (!r.ok) ok = false
        lines.push(`${p.name}: ${r.message}${r.pruned.length ? ` (pruned ${r.pruned.join(', ')})` : ''}`)
      }
      await svc.refreshRemotes(name)
      return { ok, message: lines.join('\n') || 'No projects registered.' }
    },

    async pushStatus(name) {
      const p = svc.get(name)
      if (!p || p.gitRepo === false || p.mode !== 'local-only' || !exists(p.path)) return undefined
      return git.pushStatus(p.path, p.defaultBranch)
    },

    async push(name, branch): Promise<OpResult> {
      const p = svc.get(name)
      if (!p) return { ok: false, message: `Unknown project: ${name}` }
      if (p.gitRepo === false) return { ok: false, message: `${name}: needs a git repo.` }
      if (!exists(p.path)) return { ok: false, message: `The clone of ${name} is missing at ${p.path}.` }
      if (!(await git.hasRemote(p.path))) return { ok: false, message: `${name} has no remote: work lands locally and there is nothing to push to.` }
      if (p.mode !== 'local-only') {
        return { ok: false, message: `${name} is ${modeLabel(p.mode)}: work reaches origin through PRs. Push on demand is for Offline projects.` }
      }
      const target = branch?.trim() || p.defaultBranch
      const r = await git.pushOnDemand(p.path, target)
      try {
        if (r.ok) bus.publish({ type: 'feature-used', feature: 'world_push' })
        getCtx().ledger.record({ event: r.ok ? 'project.pushed' : 'project.push_refused', project: name, data: { branch: target, ahead: r.ahead, behind: r.behind } })
      } catch {
        /* ledger optional */
      }
      return { ok: r.ok, message: `${name}: ${r.message}` }
    },

    resolvePosture(name, opts = {}) {
      const p = svc.get(name)
      if (!p) {
        return {
          mode: opts.mode ?? 'no-mistakes',
          yolo: opts.yolo ?? false,
          branchPrefix: DEFAULT_BRANCH_PREFIX,
          warning: `Project "${name}" is not registered: defaulting to Hardcore with Auto-loot off.`
        }
      }
      let mode: DeliveryMode
      if (opts.mode) mode = opts.mode
      else if (p.mode === 'no-mistakes-prod-only') mode = opts.surface === 'internal' ? 'direct-PR' : 'no-mistakes'
      else mode = p.mode
      let warning: string | undefined
      if (mode !== 'local-only' && !p.remote) {
        warning = `${p.name} has no remote, so a PR cannot be opened: use Offline mode or add a remote.`
      } else if (mode !== 'local-only' && p.forge === 'none') {
        warning = `${p.name} has no supported forge (GitHub/GitLab); PR steps may fail.`
      } else if (mode !== 'local-only' && !getCtx().forge.available()) {
        warning = `The gh CLI is not installed: PR steps will fail until it is (${settingsPath('toolchain', 'Install')}).`
      }
      return { mode, yolo: opts.yolo ?? p.yolo, branchPrefix: p.branchPrefix ?? DEFAULT_BRANCH_PREFIX, warning }
    },

    async reconcile() {
      const dir = mainHome().projects
      const known = new Set(load().map((p) => path.resolve(p.path)))
      for (const entry of listDir(dir)) {
        const full = path.join(dir, entry)
        try {
          if (!fs.statSync(full).isDirectory() || known.has(path.resolve(full))) continue
        } catch {
          continue
        }
        if (await git.isRepo(full)) {
          const name = slugify(entry, 48)
          if (!svc.get(name)) await register(full, name, {}, true)
        }
      }
    }
  }
  return svc
}
