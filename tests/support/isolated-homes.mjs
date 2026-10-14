// Also used by standalone capture scripts; keep this helper independent of Vitest.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'

const HOME_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'GENIO_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']

export function assertTempPath(value, label = 'home', root = process.env.GENIO_TEST_RUN_ROOT || os.tmpdir()) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute temp path`)
  const relative = path.relative(fs.realpathSync(root), path.resolve(value))
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    throw new Error(`${label} resolves outside a private temp directory: ${value}`)
  // Check existing ancestors too: a junction/symlink must not escape the temp tree.
  let ancestor = path.resolve(value)
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error(`${label} has no accessible ancestor: ${value}`)
    ancestor = parent
  }
  const real = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor))
  if (real === '..' || real.startsWith(`..${path.sep}`) || path.isAbsolute(real))
    throw new Error(`${label} links outside the temp directory: ${value}`)
}

export function assertIsolatedHomes(env = process.env) {
  const root = env.GENIO_TEST_RUN_ROOT
  if (!root) throw new Error('Missing unique test run root')
  assertTempPath(root, 'test run root', env.GENIO_TEST_SYSTEM_TMP || os.tmpdir())
  for (const key of HOME_KEYS) assertTempPath(env[key], key, root)
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assertTempPath(env[key], key, root)
}

export function createIsolatedHomes(prefix = 'genio-test-', runRoot = process.env.GENIO_TEST_RUN_ROOT) {
  const systemTmp = process.env.GENIO_TEST_SYSTEM_TMP || os.tmpdir()
  const root = fs.mkdtempSync(path.join(runRoot || systemTmp, prefix))
  const home = path.join(root, 'home')
  const env = {
    GENIO_TEST_RUN_ROOT: runRoot || root, GENIO_TEST_SYSTEM_TMP: systemTmp,
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, '.claude'),
    GENIO_HOME: path.join(home, '.genio'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache')
  }
  for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true })
  // Scaffolding tests need a Git identity without reading the player's global config.
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Genio Test\n\temail = test@genio.local\n')
  const saved = new Map()
  return {
    root, env,
    install() {
      for (const [key, value] of Object.entries(env)) { saved.set(key, process.env[key]); process.env[key] = value }
      assertIsolatedHomes()
      assertTempPath(os.homedir(), 'os.homedir()')
    },
    dispose() {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

/** Prove the environment actually inherited by a child, including native HOME resolution. */
export function assertChildHomes(env) {
  assertIsolatedHomes(env)
  const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import os from 'node:os';
    const keys = ${JSON.stringify([...HOME_KEYS, 'GENIO_TEST_RUN_ROOT', 'GENIO_TEST_SYSTEM_TMP', 'TEMP', 'TMP', 'TMPDIR'])};
    console.log(JSON.stringify({ ...Object.fromEntries(keys.map(key => [key, process.env[key]])), HOME: os.homedir() }));
  `], { env, cwd: env.GENIO_HOME, encoding: 'utf8', windowsHide: true }))
  assertIsolatedHomes(report)
  for (const key of HOME_KEYS) if (path.resolve(report[key]) !== path.resolve(env[key])) throw new Error(`Child resolved an unexpected ${key}`)
}

/** Copy a purpose-built capture Base, remapping its own paths and rejecting live external paths. */
export function copyFixtureBase(source, destination, env) {
  const from = fs.realpathSync(source)
  assertTempPath(destination, 'fixture destination')
  const rewrite = (value, key = '') => {
    if (Array.isArray(value)) return value.map(item => rewrite(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]))
    if (HOME_KEYS.includes(key)) return env[key]
    if (typeof value === 'string' && ['home', 'path', 'worktree', 'briefPath'].includes(key) && path.isAbsolute(value)) {
      const relative = path.relative(from, value)
      if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return path.join(destination, relative)
      throw new Error(`Capture fixture ${key} points outside its Base: ${value}`)
    }
    return value
  }
  fs.cpSync(from, destination, { recursive: true, dereference: true })
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.json')) fs.writeFileSync(file, JSON.stringify(rewrite(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2))
    }
  }
  walk(destination)
}

// Capture locations once in the coordinator, before workers replace HOME. Never read credentials.
export function realAgentHomes(env = process.env, home = os.homedir()) {
  const codex = [...new Set([path.join(home, '.codex'), env.CODEX_HOME].filter(Boolean))]
  const claude = [...new Set([path.join(home, '.claude'), env.CLAUDE_CONFIG_DIR].filter(Boolean))]
  return {
    folders: [...codex.flatMap(p => [path.join(p, 'sessions'), path.join(p, 'archived_sessions')]), ...claude.map(p => path.join(p, 'projects'))],
    databases: codex.map(p => path.join(p, 'state_5.sqlite'))
  }
}

/** Fail only on this run's token, so concurrent player/Genio activity is harmless. */
export function assertNoAgentLeaks(homes, token) {
  if (!token || token.length < 12) throw new Error('Leak checks require a unique run token')
  const leaks = []
  const scan = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) scan(file)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // cwd/session metadata and initial prompt are at the start. Bound reads of large live logs.
        let fd
        try {
          fd = fs.openSync(file, 'r')
          const head = Buffer.alloc(64 * 1024)
          const n = fs.readSync(fd, head, 0, head.length, 0)
          if (head.subarray(0, n).toString('utf8').includes(token)) leaks.push(file)
        } catch (error) { if (error.code !== 'ENOENT') throw error } finally { if (fd !== undefined) fs.closeSync(fd) }
      }
    }
  }
  for (const folder of homes.folders) scan(folder)
  for (const file of homes.databases) {
    if (!fs.existsSync(file)) continue
    const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
    try {
      const columns = db.prepare('PRAGMA table_info(threads)').all().map(c => c.name)
        .filter(name => ['cwd', 'rollout_path', 'title', 'first_user_message'].includes(name))
      if (!columns.length) continue
      const where = columns.map(name => `instr("${name}", ?) > 0`).join(' OR ')
      if (db.prepare(`SELECT 1 FROM threads WHERE ${where} LIMIT 1`).get(...columns.map(() => token))) leaks.push(`${file}: attributable thread`)
    } finally { db.close() }
  }
  if (leaks.length) throw new Error(`Test run leaked agent artifacts:\n${leaks.join('\n')}`)
}
