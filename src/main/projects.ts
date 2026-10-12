/**
 * Worlds (project registry). companion data/projects.md + project-management
 * skill + bin/fm-project-mode.sh, as JSON with engine awareness.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DeliveryMode, Engine, Forge, Project, ProjectCommands } from '@shared/types'
import type { OpResult, ProjectAddRequest, ProjectCreateRequest } from '@shared/api'
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
export function detectEngine(dir: string): { engine: Engine; commands: ProjectCommands } {
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

export function forgeFromRemote(remote?: string): Forge {
  if (!remote) return 'none'
  if (/github\.com/i.test(remote)) return 'github'
  if (/gitlab/i.test(remote)) return 'gitlab'
  return 'none'
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
      mode: req.mode ?? (remote ? 'no-mistakes' : 'local-only'),
      yolo: req.yolo ?? false,
      branchPrefix: req.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
      forge: req.forge ?? forgeFromRemote(remote),
      capacity: req.capacity,
      engine: det.engine,
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
      return register(dir, name, { mode: req.mode }, true)
    },

    update(name, patch) {
      const list = load()
      const i = list.findIndex((p) => p.name === name)
      if (i < 0) throw new Error(`Unknown world: ${name}`)
      const next: Project = { ...list[i], ...patch, name: list[i].name, commands: { ...list[i].commands, ...(patch.commands ?? {}) } }
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

    async sync(name): Promise<OpResult> {
      const targets = name ? load().filter((p) => p.name === name) : load()
      if (name && !targets.length) return { ok: false, message: `Unknown world: ${name}` }
      const lines: string[] = []
      let ok = true
      for (const p of targets) {
        if (!exists(p.path)) {
          lines.push(`${p.name}: clone missing at ${p.path}`)
          ok = false
          continue
        }
        if (p.mode === 'local-only' || !(await git.hasRemote(p.path))) {
          lines.push(`${p.name}: offline world, nothing to sync`)
          continue
        }
        const r = await git.syncClone(p.path, p.defaultBranch)
        if (!r.ok) ok = false
        lines.push(`${p.name}: ${r.message}${r.pruned.length ? ` (pruned ${r.pruned.join(', ')})` : ''}`)
      }
      return { ok, message: lines.join('\n') || 'No worlds registered.' }
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
