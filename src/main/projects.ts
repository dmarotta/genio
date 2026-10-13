/**
 * Worlds (project registry). companion data/projects.md + project-management
 * skill + bin/fm-project-mode.sh, as JSON with engine awareness.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DeliveryMode, Engine, Forge, Project, ProjectCommands, ProjectMode } from '@shared/types'
import type { OpResult, ProjectAddRequest, ProjectCreateRequest } from '@shared/api'
import { modeLabel, modeSourceOf } from '@shared/vocab'
import type { AppCtx, ProjectsService } from './services'
import { bus } from './bus'
import { Home, defaultHomeRoot } from './home'
import * as git from './git'
import { exists, nowIso, readJson, run, slugify, which, writeJson, writeText } from './util'

export const DEFAULT_BRANCH_PREFIX = 'genio/'

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function readSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** Detect the game engine of a folder and propose default commands. */
function detectAtRoot(dir: string): { engine: Engine; commands: ProjectCommands } {
  const files = listDir(dir)
  const has = (f: string): boolean => files.includes(f)
  const any = (re: RegExp): string | undefined => files.find((f) => re.test(f))
  if (has('project.godot')) {
    const gut = exists(path.join(dir, 'addons', 'gut'))
    return {
      engine: 'godot',
      commands: {
        build: 'godot --headless --path . --quit',
        test: gut ? 'godot --headless -s addons/gut/gut_cmdln.gd -gexit' : undefined,
        run: 'godot --path .'
      }
    }
  }
  if (exists(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
    return { engine: 'unity', commands: { test: 'Unity -batchmode -projectPath . -runTests -testPlatform EditMode -logFile -', run: undefined } }
  }
  const uproject = any(/\.uproject$/i)
  if (uproject) return { engine: 'unreal', commands: {} }
  if (has('Cargo.toml') && /bevy/i.test(readSafe(path.join(dir, 'Cargo.toml')))) {
    return { engine: 'bevy', commands: { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings', run: 'cargo run' } }
  }
  if (has('main.lua') || has('conf.lua')) return { engine: 'love2d', commands: { run: 'love .' } }
  if (any(/\.yyp$/i)) return { engine: 'gamemaker', commands: {} }
  if (has('game.project')) return { engine: 'defold', commands: {} }
  const csproj = any(/\.csproj$/i)
  if (csproj && /MonoGame/i.test(readSafe(path.join(dir, csproj)))) {
    return { engine: 'monogame', commands: { build: 'dotnet build', test: 'dotnet test', run: 'dotnet run' } }
  }
  if (has('package.json')) {
    const pkgText = readSafe(path.join(dir, 'package.json'))
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const scripts = pkg.scripts ?? {}
      const isGame = Object.keys(deps).some((d) => /^(phaser|three|pixi\.js|@pixi\/|@babylonjs\/|babylonjs|kaplay|kaboom|excalibur|playcanvas|melonjs)/.test(d))
      const cmds: ProjectCommands = {
        setup: exists(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install',
        build: scripts.build ? 'npm run build' : undefined,
        test: scripts.test && !/no test specified/.test(scripts.test) ? 'npm test' : undefined,
        lint: scripts.lint ? 'npm run lint' : undefined,
        run: scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : undefined
      }
      return { engine: isGame ? 'web' : 'other', commands: cmds }
    } catch {
      return { engine: 'other', commands: {} }
    }
  }
  if (has('Cargo.toml')) return { engine: 'other', commands: { build: 'cargo build', test: 'cargo test', run: 'cargo run' } }
  return { engine: 'other', commands: {} }
}

// Breadth-first, stable ordering: the repository root wins, then the nearest project.
// Do not traverse symlinks, dependencies, generated engine caches or hidden metadata.
const ENGINE_SCAN_SKIP = new Set(['node_modules', 'Library', 'Temp', 'Obj', 'Build', 'Builds', 'Logs', 'UserSettings', 'Packages', 'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'vendor', 'target', 'dist'])
export function detectEngine(dir: string): { engine: Engine; engineRoot: string; commands: ProjectCommands } {
  const queue = [{ root: '', depth: 0 }]
  for (const item of queue) {
    const full = path.join(dir, item.root)
    const detected = detectAtRoot(full)
    if (['unity', 'godot', 'unreal'].includes(detected.engine)) {
      const commands = { ...detected.commands }
      if (item.root) {
        // Commands execute from the checkout root. Quote the relative engine path.
        const quoted = JSON.stringify(item.root)
        if (commands.run) commands.run = `godot --path ${quoted}`
        if (detected.engine === 'unity') commands.test = `Unity -batchmode -projectPath ${quoted} -runTests -testPlatform EditMode -logFile -`
        if (detected.engine === 'godot') {
          commands.build = `godot --headless --path ${quoted} --quit`
          if (commands.test) commands.test = `godot --headless --path ${quoted} -s addons/gut/gut_cmdln.gd -gexit`
        }
      }
      return { ...detected, engineRoot: item.root, commands }
    }
    if (item.depth === 2) continue
    try {
      for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !ENGINE_SCAN_SKIP.has(entry.name)) {
          queue.push({ root: item.root ? `${item.root}/${entry.name}` : entry.name, depth: item.depth + 1 })
        }
      }
    } catch { /* Missing or unreadable checkout: leave fallback detection intact. */ }
  }
  return { ...detectAtRoot(dir), engineRoot: '' }
}

/** Legacy 'other' was the root-only detector's fallback; preserve specific legacy choices. */
export function refreshEngine(p: Project): Project {
  const det = detectEngine(p.path)
  const manual = p.engineSource === 'manual' || (!p.engineSource && p.engine !== 'other')
  return {
    ...p,
    engine: manual ? p.engine : det.engine,
    engineSource: manual ? 'manual' : 'auto',
    engineRoot: !manual || det.engine === p.engine ? det.engineRoot : p.engineRoot ?? ''
  }
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
  const base = s.replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? 'world'
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

  const register = async (dir: string, name: string, req: Partial<ProjectAddRequest>, managed: boolean): Promise<Project> => {
    const remote = await git.remoteUrl(dir)
    const det = detectEngine(dir)
    const p: Project = {
      name,
      path: path.resolve(dir),
      remote,
      defaultBranch: await git.defaultBranch(dir),
      mode: req.mode ?? autoModeFor(remote),
      modeSource: req.mode ? 'manual' : 'auto',
      yolo: req.yolo ?? false,
      branchPrefix: req.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
      forge: req.forge ?? forgeFromRemote(remote),
      capacity: req.capacity,
      engine: det.engine,
      engineRoot: det.engineRoot,
      engineSource: 'auto',
      commands: det.commands,
      managed,
      addedAt: nowIso()
    }
    if (p.mode === 'local-only' && p.forge !== 'none') p.forge = 'none'
    const list = load().filter((x) => x.name !== name)
    save([...list, p])
    try {
      getCtx().ledger.record({ event: 'project.added', project: name, data: { engine: p.engine, mode: p.mode } })
    } catch {
      /* ledger optional */
    }
    return p
  }

  const liveStates = new Set(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'ready', 'stale', 'detached', 'exited', 'merged', 'failed'])

  const svc: ProjectsService = {
    list: () => [...load()],
    get: (name) => load().find((p) => p.name === name),

    async add(req) {
      const src = req.source.trim().replace(/^"|"$/g, '')
      if (!src) throw new Error('Give a git URL, owner/repo, or a local folder.')
      const isLocal = exists(src) && fs.statSync(src).isDirectory()
      if (isLocal) {
        const dir = path.resolve(src)
        if (!(await git.isRepo(dir))) throw new Error(`${dir} is not a git repository. Run git init there or create a new world instead.`)
        const top = await git.repoTop(dir)
        const name = req.name ? slugify(req.name, 48) : nameFromSource(top || dir)
        if (svc.get(name)) throw new Error(`A world named "${name}" already exists.`)
        if (req.inPlace !== false) return register(top || dir, name, req, false)
        const dest = path.join(mainHome().projects, name)
        const c = await git.clone(dir, dest)
        if (c.code !== 0) throw new Error(`Clone failed: ${c.stderr.trim()}`)
        return register(dest, name, req, true)
      }
      if (!looksLikeUrl(src)) throw new Error(`"${src}" is neither an existing folder nor a git URL.`)
      const url = normaliseUrl(src)
      const name = req.name ? slugify(req.name, 48) : nameFromSource(url)
      if (svc.get(name)) throw new Error(`A world named "${name}" already exists.`)
      const dest = path.join(mainHome().projects, name)
      if (exists(dest)) {
        if (await git.isRepo(dest)) return register(dest, name, req, true)
        throw new Error(`${dest} exists and is not a git repository.`)
      }
      bus.toast('info', 'Cloning world', url)
      const c = await git.clone(url, dest)
      if (c.code !== 0) throw new Error(`Clone failed: ${c.stderr.trim()}`)
      return register(dest, name, req, true)
    },

    async create(req: ProjectCreateRequest) {
      const name = slugify(req.name, 48)
      if (!name) throw new Error('A world needs a name.')
      if (svc.get(name)) throw new Error(`A world named "${name}" already exists.`)
      const dir = path.join(mainHome().projects, name)
      if (exists(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty.`)
      const init = await git.initRepo(dir, 'main')
      if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`)
      writeText(path.join(dir, '.gitignore'), `# Genio world: ${name}\n${GITIGNORE[req.engine] ?? ''}`)
      writeText(path.join(dir, 'README.md'), `# ${req.name}\n\n${req.description ?? ''}\n\nEngine: ${req.engine}\n`)
      writeText(
        path.join(dir, 'AGENTS.md'),
        `# ${req.name}\n\nGuidance for coding agents working on this game.\n\n- Engine: ${req.engine}\n${req.description ? `- Pitch: ${req.description}\n` : ''}`
      )
      const c = await git.commitAll(dir, 'Initial commit')
      if (c.code !== 0) {
        // commit may fail without git identity configured; surface clearly
        throw new Error(`Initial commit failed: ${(c.stderr || c.stdout).trim()}`)
      }
      if (req.createRemote) {
        if (!which('gh')) throw new Error('Creating a GitHub repo needs the gh CLI. Install it from SYSTEMS first.')
        const vis = req.privateRemote === false ? '--public' : '--private'
        const r = await run(which('gh')!, ['repo', 'create', name, vis, '--source', '.', '--push'], { cwd: dir, timeoutMs: 300_000 })
        if (r.code !== 0) bus.toast('warn', 'GitHub repo not created', (r.stderr || r.stdout).trim())
      }
      await register(dir, name, { mode: req.mode }, true)
      return svc.update(name, { engine: req.engine })
    },

    update(name, patch) {
      const list = load()
      const i = list.findIndex((p) => p.name === name)
      if (i < 0) throw new Error(`Unknown world: ${name}`)
      const next: Project = { ...list[i], ...patch, name: list[i].name, commands: { ...list[i].commands, ...(patch.commands ?? {}) } }
      if (patch.engine !== undefined) {
        next.engineSource = 'manual'
        const det = detectEngine(next.path)
        next.engineRoot = det.engine === next.engine ? det.engineRoot : ''
      }
      // Choosing a mode pins it; asking for 'auto' hands it back to the remote.
      if (patch.modeSource === 'auto') next.mode = autoModeFor(next.remote)
      else if (patch.mode !== undefined) next.modeSource = 'manual'
      if (patch.mode !== undefined || patch.modeSource === 'auto') next.forge = forgeFor(next.mode, next.remote)
      if (next.mode === 'local-only') next.forge = 'none'
      list[i] = next
      save([...list])
      return next
    },

    async remove(name, deleteClone): Promise<OpResult> {
      const p = svc.get(name)
      if (!p) return { ok: false, message: `Unknown world: ${name}` }
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
      let engineChanged = false
      for (let i = 0; i < list.length; i++) {
        const p = list[i]
        if ((name && p.name !== name) || !exists(p.path) || !(await git.isRepo(p.path))) continue
        const refreshed = refreshEngine(p)
        if (JSON.stringify(refreshed) !== JSON.stringify(p)) engineChanged = true
        list[i] = refreshed
        const change = applyRemoteChange(refreshed, await git.remoteUrl(p.path))
        if (!change) continue
        list[i] = change.next
        notices.push(change.notice)
        try {
          getCtx().ledger.record({ event: 'project.remote_changed', project: p.name, data: { from: p.remote, to: change.next.remote, modeFrom: p.mode, mode: change.next.mode } })
        } catch {
          /* ledger optional */
        }
        bus.toast('info', 'World remote changed', change.notice)
      }
      if (notices.length || engineChanged) save(list)
      return notices
    },

    async sync(name): Promise<OpResult> {
      const notices = await svc.refreshRemotes(name)
      const targets = name ? load().filter((p) => p.name === name) : load()
      if (name && !targets.length) return { ok: false, message: `Unknown world: ${name}` }
      const lines: string[] = [...notices]
      let ok = true
      for (const p of targets) {
        if (!exists(p.path)) {
          lines.push(`${p.name}: clone missing at ${p.path}`)
          ok = false
          continue
        }
        if (!(await git.hasRemote(p.path))) {
          lines.push(`${p.name}: offline world, nothing to sync`)
          continue
        }
        if (p.mode === 'local-only') {
          // Offline with a remote: landings are local, so only refresh origin's refs; never touch local branches.
          const f = await git.fetch(p.path)
          const st = f.code === 0 ? await git.pushStatus(p.path, p.defaultBranch) : undefined
          lines.push(
            f.code !== 0
              ? `${p.name}: offline world; could not reach origin (${f.stderr.trim()})`
              : `${p.name}: offline world; ${st && st.ahead ? `${st.ahead} commit(s) on ${p.defaultBranch} not pushed` : `${p.defaultBranch} has nothing to push`}${st && st.behind ? `, ${st.behind} on origin not local` : ''}`
          )
          continue
        }
        const r = await git.syncClone(p.path, p.defaultBranch)
        if (!r.ok) ok = false
        lines.push(`${p.name}: ${r.message}${r.pruned.length ? ` (pruned ${r.pruned.join(', ')})` : ''}`)
      }
      await svc.refreshRemotes(name)
      return { ok, message: lines.join('\n') || 'No worlds registered.' }
    },

    async pushStatus(name) {
      const p = svc.get(name)
      if (!p || p.mode !== 'local-only' || !exists(p.path)) return undefined
      return git.pushStatus(p.path, p.defaultBranch)
    },

    async push(name, branch): Promise<OpResult> {
      const p = svc.get(name)
      if (!p) return { ok: false, message: `Unknown world: ${name}` }
      if (!exists(p.path)) return { ok: false, message: `The clone of ${name} is missing at ${p.path}.` }
      if (!(await git.hasRemote(p.path))) return { ok: false, message: `${name} has no remote: work lands locally and there is nothing to push to.` }
      if (p.mode !== 'local-only') {
        return { ok: false, message: `${name} is ${modeLabel(p.mode)}: work reaches origin through PRs. Push on demand is for Offline worlds.` }
      }
      const target = branch?.trim() || p.defaultBranch
      const r = await git.pushOnDemand(p.path, target)
      try {
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
          warning: `World "${name}" is not registered: defaulting to Hardcore with Auto-loot off.`
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
        warning = 'The gh CLI is not installed: PR steps will fail until it is (SYSTEMS › Install).'
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
