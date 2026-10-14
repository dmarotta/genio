/**
 * Engine detection v2: a bounded, asynchronous marker walk that reports every engine it finds,
 * picks one with a deterministic tie-break and honours the repository's own declaration
 * (`.genio/project.json` `{ "engineRoot": "client" }`). Detection writes the project's
 * `engine`/`engineRoot`; everything else reads them through `effectiveEngine`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Engine, EngineCandidate, EngineDetection, EngineStrength, ProjectCommands } from '@shared/types'
import { unityTestCommand } from './play-editor'
import { nowIso } from './util'

/** Strong markers are found to depth 3, medium ones to depth 2, weak ones (`main.lua`/`conf.lua`) only at the root. */
const MAX_DEPTH: Record<EngineStrength, number> = { strong: 3, medium: 2, weak: 0 }
const RANK: Record<EngineStrength, number> = { strong: 0, medium: 1, weak: 2 }
const WALK_DEPTH = 3
/** A hard bound on folders read, whatever the tree looks like. */
const MAX_DIRS = 4000
const MAX_CANDIDATES = 20
export const DECLARATION_FILE = '.genio/project.json'

// Dependencies, generated engine caches and build output, compared case-insensitively. `Packages` (Unity's
// package cache) stays exact-case: a lowercase `packages/` is a JS monorepo's workspace and can hold the game.
const SKIP = new Set(['node_modules', 'library', 'temp', 'obj', 'bin', 'build', 'builds', 'out', 'logs', 'usersettings', 'binaries', 'intermediate', 'saved', 'deriveddatacache', 'vendor', 'target', 'dist'])
const skipped = (name: string): boolean => name.startsWith('.') || name === 'Packages' || SKIP.has(name.toLowerCase())

const WEB_GAME_DEP = /^(phaser|three|pixi\.js|@pixi\/|@babylonjs\/|babylonjs|kaplay|kaboom|excalibur|playcanvas|melonjs)/

async function read(p: string): Promise<string> {
  // Windows editors save a UTF-8 BOM, which JSON.parse rejects (a web game's package.json read as 'other').
  try { return (await fs.readFile(p, 'utf8')).replace(/^﻿/, '') } catch { return '' }
}
async function isFile(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isFile() } catch { return false }
}
async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

interface Marker { engine: Engine; strength: EngineStrength; version?: string }
type PackageJson = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
const parsePackage = (text: string): PackageJson | undefined => { try { return JSON.parse(text) as PackageJson } catch { return undefined } }

/** The strongest marker in one folder, or undefined. `depth` limits which tiers count there. */
async function markerAt(dir: string, files: string[], depth: number): Promise<Marker | undefined> {
  const has = (f: string): boolean => files.includes(f)
  const any = (re: RegExp): string | undefined => files.find((f) => re.test(f))
  if (has('project.godot')) {
    const features = /^config\/features\s*=\s*PackedStringArray\(\s*"(\d+(?:\.\d+)*)"/m.exec(await read(path.join(dir, 'project.godot')))
    return { engine: 'godot', strength: 'strong', version: features?.[1] }
  }
  if (has('ProjectSettings')) {
    const text = await read(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))
    if (text || await isFile(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
      return { engine: 'unity', strength: 'strong', version: /^m_EditorVersion:\s*(\S+)/m.exec(text)?.[1] }
    }
  }
  const uproject = any(/\.uproject$/i)
  if (uproject) {
    const association = /"EngineAssociation"\s*:\s*"([^"]+)"/.exec(await read(path.join(dir, uproject)))?.[1]
    return { engine: 'unreal', strength: 'strong', version: association && /^\d/.test(association) ? association : undefined }
  }
  const yyp = any(/\.yyp$/i)
  if (yyp) return { engine: 'gamemaker', strength: 'strong', version: /"IDEVersion"\s*:\s*"([^"]+)"/.exec(await read(path.join(dir, yyp)))?.[1] }
  if (has('game.project')) return { engine: 'defold', strength: 'strong' }
  if (depth <= MAX_DEPTH.medium) {
    if (has('Cargo.toml')) {
      const cargo = await read(path.join(dir, 'Cargo.toml'))
      if (/bevy/i.test(cargo)) {
        const version = /^\s*bevy\s*=\s*(?:"([^"]+)"|\{[^}\n]*\bversion\s*=\s*"([^"]+)")/m.exec(cargo)
        return { engine: 'bevy', strength: 'medium', version: version?.[1] ?? version?.[2] }
      }
    }
    const csproj = any(/\.csproj$/i)
    if (csproj && /MonoGame/i.test(await read(path.join(dir, csproj)))) return { engine: 'monogame', strength: 'medium' }
    if (has('package.json')) {
      const pkg = parsePackage(await read(path.join(dir, 'package.json')))
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
      if (Object.keys(deps).some((d) => WEB_GAME_DEP.test(d))) return { engine: 'web', strength: 'medium' }
    }
  }
  if (depth <= MAX_DEPTH.weak && (has('main.lua') || has('conf.lua'))) return { engine: 'love2d', strength: 'weak' }
  return undefined
}

async function listNames(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir) } catch { return [] }
}

/** Tie-break: strongest, then shallowest, then alphabetical by root, then by engine. */
export function compareCandidates(a: EngineCandidate, b: EngineCandidate): number {
  return RANK[a.strength] - RANK[b.strength] || depthOf(a.root) - depthOf(b.root) || a.root.localeCompare(b.root, 'en') || a.engine.localeCompare(b.engine, 'en')
}
const depthOf = (root: string): number => (root ? root.split('/').length : 0)

/** Every engine marker within the bounds, in tie-break order. Never follows symbolic links or junctions. */
export async function scanCandidates(dir: string): Promise<EngineCandidate[]> {
  const found: EngineCandidate[] = []
  let level = [''], visited = 0
  for (let depth = 0; depth <= WALK_DEPTH && level.length && visited < MAX_DIRS; depth++) {
    const next: string[] = []
    for (const root of level) {
      if (visited++ >= MAX_DIRS) break
      const full = path.join(dir, root)
      let entries: import('node:fs').Dirent[]
      try { entries = await fs.readdir(full, { withFileTypes: true }) } catch { continue }
      const marker = await markerAt(full, entries.map((e) => e.name), depth)
      if (marker) found.push({ engine: marker.engine, root, strength: marker.strength, ...(marker.version ? { version: marker.version } : {}) })
      if (depth === WALK_DEPTH) continue
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (e.isDirectory() && !e.isSymbolicLink() && !skipped(e.name)) next.push(root ? `${root}/${e.name}` : e.name)
      }
    }
    level = next
  }
  return found.sort(compareCandidates)
}

/** The engine marker at one repository-relative root, whatever its depth or tier (a declared or pinned root). */
export async function candidateAt(dir: string, root: string): Promise<EngineCandidate | undefined> {
  const full = path.join(dir, root)
  const marker = await markerAt(full, await listNames(full), 0)
  return marker && { engine: marker.engine, root, strength: marker.strength, ...(marker.version ? { version: marker.version } : {}) }
}

/** A repository-relative POSIX root that stays inside the project, or undefined. */
export function cleanRoot(value: string): string | undefined {
  const root = value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (root === '.') return ''
  if (root.startsWith('/') || /^[A-Za-z]:/.test(root) || /[\x00-\x1f]/.test(root) || root.split('/').includes('..')) return undefined
  return root
}

/** The repository's declaration, validated: a root inside the checkout (links resolved) that holds an engine marker. */
async function readDeclaration(dir: string): Promise<{ candidate?: EngineCandidate; warning?: string } | undefined> {
  const file = path.join(dir, DECLARATION_FILE)
  if (!(await isFile(file))) return undefined
  const ignored = (why: string) => ({ warning: `Ignored ${DECLARATION_FILE}: ${why}.` })
  let data: unknown
  try { data = JSON.parse(await read(file)) } catch { return ignored('it is not valid JSON') }
  const value = (data as { engineRoot?: unknown } | null)?.engineRoot
  if (typeof value !== 'string') return ignored('engineRoot must be a folder path')
  const root = cleanRoot(value)
  if (root === undefined) return ignored(`engineRoot "${value}" leaves the repository`)
  try {
    const [top, real] = await Promise.all([fs.realpath(dir), fs.realpath(path.join(dir, root))])
    const rel = path.relative(top, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return ignored(`engineRoot "${value}" leaves the repository`)
  } catch { return ignored(`engineRoot "${value}" does not exist`) }
  if (!(await isDir(path.join(dir, root)))) return ignored(`engineRoot "${value}" is not a folder`)
  const candidate = await candidateAt(dir, root)
  return candidate ? { candidate } : ignored(`no game engine marker in "${value || '.'}"`)
}

/** Default commands for an engine at a root. They run from the checkout root, so nested roots are quoted into them. */
export async function commandsFor(dir: string, engine: Engine, root: string): Promise<ProjectCommands> {
  const full = path.join(dir, root)
  const q = JSON.stringify(root)
  switch (engine) {
    case 'godot': {
      const gut = await isDir(path.join(full, 'addons', 'gut'))
      const at = root ? ` --path ${q}` : ' --path .'
      return { build: `godot --headless${at} --quit`, test: gut ? `godot --headless${root ? at : ''} -s addons/gut/gut_cmdln.gd -gexit` : undefined, run: `godot${at}` }
    }
    case 'unity': return { test: root ? unityTestCommand(full, root) : unityTestCommand(full), run: undefined }
    case 'bevy': {
      const m = root ? ` --manifest-path ${JSON.stringify(`${root}/Cargo.toml`)}` : ''
      return { build: `cargo build${m}`, test: `cargo test${m}`, lint: `cargo clippy${m} -- -D warnings`, run: `cargo run${m}` }
    }
    case 'love2d': return { run: 'love .' }
    case 'monogame': return root
      ? { build: `dotnet build ${q}`, test: `dotnet test ${q}`, run: `dotnet run --project ${q}` }
      : { build: 'dotnet build', test: 'dotnet test', run: 'dotnet run' }
    case 'web': return npmCommands(full, root)
    case 'other': return otherCommands(dir)
    default: return {}
  }
}

async function npmCommands(full: string, root: string): Promise<ProjectCommands> {
  const pkg = parsePackage(await read(path.join(full, 'package.json')))
  if (!pkg) return {}
  const scripts = pkg.scripts ?? {}
  const npm = root ? `npm --prefix ${JSON.stringify(root)}` : 'npm'
  return {
    setup: `${npm} ${(await isFile(path.join(full, 'package-lock.json'))) ? 'ci' : 'install'}`,
    build: scripts.build ? `${npm} run build` : undefined,
    test: scripts.test && !/no test specified/.test(scripts.test) ? `${npm} test` : undefined,
    lint: scripts.lint ? `${npm} run lint` : undefined,
    run: scripts.dev ? `${npm} run dev` : scripts.start ? `${npm} start` : undefined
  }
}

/** No game: a code project still gets its npm or cargo commands from the root. */
async function otherCommands(dir: string): Promise<ProjectCommands> {
  const names = await listNames(dir)
  if (names.includes('package.json')) return npmCommands(dir, '')
  if (names.includes('Cargo.toml')) return { build: 'cargo build', test: 'cargo test', run: 'cargo run' }
  return {}
}

export interface ProjectDetectionResult {
  engine: Engine
  engineRoot: string
  commands: ProjectCommands
  detected: EngineDetection
}

/**
 * Detect a checkout's engine. The declaration in `.genio/project.json` wins when it names a root that
 * holds a marker; an invalid one is ignored with a warning. Otherwise the tie-break picks among every
 * candidate, and `ambiguous` records that the top two tie on strength and depth.
 */
export async function detectProject(dir: string): Promise<ProjectDetectionResult> {
  const [scanned, declaration] = await Promise.all([scanCandidates(dir), readDeclaration(dir)])
  const declared = declaration?.candidate
  const candidates = declared ? [declared, ...scanned.filter((c) => c.root !== declared.root)] : scanned
  const top = candidates[0]
  const ambiguous = !declared && candidates.length > 1 && RANK[candidates[0].strength] === RANK[candidates[1].strength] && depthOf(candidates[0].root) === depthOf(candidates[1].root)
  const engine = top?.engine ?? 'other'
  const engineRoot = top?.root ?? ''
  return {
    engine,
    engineRoot,
    commands: await commandsFor(dir, engine, engineRoot),
    detected: {
      candidates: candidates.slice(0, MAX_CANDIDATES),
      ambiguous,
      ...(top?.version ? { version: top.version } : {}),
      declared: !!declared,
      ...(declaration?.warning ? { warning: declaration.warning } : {}),
      scannedAt: nowIso()
    }
  }
}
