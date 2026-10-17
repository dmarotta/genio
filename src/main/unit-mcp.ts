/**
 * MCP servers in units (docs/mcp-servers.md). A unit runs only the MCP servers
 * Genio passes it: for Claude and Codex units, one relay to Genio's gateway
 * (mcp-gateway.ts) per server the player added in Settings for this project;
 * for every other runtime, none. Servers a repository declares
 * (.mcp.json, .codex/config.toml, .gemini/settings.json, opencode.json,
 * .opencode/) and the player's own CLI servers stay off, so nothing from a
 * repository runs on its own, nothing waits at Claude's "New MCP server found"
 * dialog, and no server inherits the unit's keys (OpenCode passes its whole
 * environment, FAL_KEY included, to the servers it starts).
 *
 * Verified on claude 2.1.302, codex-cli 0.162.1, gemini 0.64.0, opencode 1.19.0:
 * - Claude: --strict-mcp-config with an empty --mcp-config file loads nothing
 *   else and never shows the dialog. The flag is variadic: only the `=` form.
 * - Codex: the unit's folders stay trusted (an untrusted folder shows a
 *   "Folder access" dialog), so each server named in the home's config.toml or
 *   the worktree's .codex/config.toml is turned off by name. Codex refuses a
 *   bare `enabled=false` for a name it does not load, so the override also
 *   gives an inert command or URL of the same kind; `-c` keys split at every
 *   dot, so a name with a dot cannot be turned off and the launch stops.
 * - Gemini: an allow-list naming no real server starts none (extensions too).
 * - OpenCode: `enabled: false` per name, merged through OPENCODE_CONFIG_CONTENT;
 *   an unknown name is ignored. OPENCODE_DISABLE_PROJECT_CONFIG would also drop
 *   the project's AGENTS.md, so it is not used.
 */
import os from 'node:os'
import path from 'node:path'
import { readText } from './util'

export interface UnitMcpLaunch {
  /** Flags after any resume subcommand, before the runtime's own arguments. */
  args: string[]
  /** Merged over the runtime's environment. */
  env: Record<string, string>
}

/** The empty server list Claude units get with --strict-mcp-config. */
export const CLAUDE_UNIT_MCP_CONFIG = { mcpServers: {} }

/**
 * The relays a unit gets: `command` runs `script` as Node (Genio's own
 * executable with ELECTRON_RUN_AS_NODE), once per server name. The gateway
 * address and per-launch secret reach each relay through the unit's
 * environment (GENIO_MCP_GATEWAY, GENIO_MCP_SECRET), never argv or a file.
 */
export interface McpRelays {
  command: string
  script: string
  servers: string[]
}

export const MCP_RELAY_ENV = ['GENIO_MCP_GATEWAY', 'GENIO_MCP_SECRET']

/** The per-unit file Claude loads with --strict-mcp-config: one stdio relay per server. */
export function claudeUnitMcpConfig(relays?: McpRelays): { mcpServers: Record<string, unknown> } {
  if (!relays?.servers.length) return CLAUDE_UNIT_MCP_CONFIG
  return {
    mcpServers: Object.fromEntries(relays.servers.map((name) => [name,
      { type: 'stdio', command: relays.command, args: [relays.script, name], env: { ELECTRON_RUN_AS_NODE: '1' } }]))
  }
}

/**
 * Codex `-c` entries, one table per relay. Codex merges a `-c` table into a
 * same-named server from a config file (codex-cli 0.162.1: a repo's `url`
 * plus the relay's `command` stops every launch), so a name a config file
 * declares (`declared`, kept off) gets the relay under `genio-<name>` instead.
 */
export function codexRelayArgs(relays: McpRelays | undefined, declared: Set<string> = new Set()): string[] {
  const q = (s: string): string => JSON.stringify(s)
  const taken = new Set(declared)
  return (relays?.servers ?? []).flatMap((name) => {
    let key = name
    while (taken.has(key)) key = `genio-${key}`
    taken.add(key)
    return ['-c', `mcp_servers.${key}={command=${q(relays!.command)},args=[${q(relays!.script)},${q(name)}],env={ELECTRON_RUN_AS_NODE="1"},env_vars=[${MCP_RELAY_ENV.map(q).join(',')}],required=false}`]
  })
}

/** A name no Gemini server has: the allow-list then matches nothing (an empty list allows all). */
export const GEMINI_NO_MCP = 'genio-none'

const CODEX_OFF_COMMAND = 'genio-mcp-off'
const CODEX_OFF_URL = 'http://127.0.0.1:9/genio-mcp-off'
const CODEX_HTTP_FIELDS = new Set(['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'oauth', 'oauth_resource', 'scopes'])

type Transport = 'stdio' | 'http'

/** A TOML key path (`a."b.c".'d'`), or undefined when it is not one. */
function tomlPath(s: string): string[] | undefined {
  const out: string[] = []
  let i = 0
  const ws = (): void => { while (s[i] === ' ' || s[i] === '\t') i++ }
  for (;;) {
    ws()
    if (s[i] === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      if (j >= s.length) return undefined
      try { out.push(JSON.parse(s.slice(i, j + 1)) as string) } catch { return undefined }
      i = j + 1
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return undefined
      out.push(s.slice(i + 1, j))
      i = j + 1
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i))
      if (!m) return undefined
      out.push(m[0])
      i += m[0].length
    }
    ws()
    if (i >= s.length) return out
    if (s[i] !== '.') return undefined
    i++
  }
}

interface ValueState { depth: number; multi?: string }

/** Walk a value's text: open brackets and an unfinished multi-line string carry to the next line. */
function scanValue(text: string, st: ValueState): ValueState {
  let { depth, multi } = st
  let i = 0
  while (i < text.length) {
    if (multi) {
      const end = text.indexOf(multi, i)
      if (end < 0) return { depth, multi }
      i = end + 3
      multi = undefined
      continue
    }
    const c = text[i]
    if (c === '#') break
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      multi = text.slice(i, i + 3)
      i += 3
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1
      i = j + 1
    } else {
      if (c === '[' || c === '{') depth++
      if (c === ']' || c === '}') depth--
      i++
    }
  }
  return { depth: Math.max(0, depth), multi }
}

/** Index of the first `=` outside quotes, or -1. */
function keyEnd(line: string): number {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '=') return i
    else if (c === '#') return -1
  }
  return -1
}

/**
 * The MCP servers a Codex config.toml declares, with their kind: tables
 * (`[mcp_servers.x]`, `[mcp_servers.x.env]`), keys under `[mcp_servers]` and
 * dotted keys. A server with any HTTP field counts as HTTP.
 */
export function codexMcpServers(toml: string): Map<string, Transport> {
  const out = new Map<string, Transport>()
  const note = (keys: string[], value: string): void => {
    if (keys[0] !== 'mcp_servers' || keys.length < 2) return
    const http = (keys.length > 2 && CODEX_HTTP_FIELDS.has(keys[2])) || (keys.length === 2 && /(^|[{,\s])url\s*=/.test(value))
    if (http || !out.has(keys[1])) out.set(keys[1], http ? 'http' : 'stdio')
  }
  let table: string[] = []
  let st: ValueState = { depth: 0 }
  for (const line of toml.split(/\r?\n/)) {
    if (st.depth || st.multi) {
      st = scanValue(line, st)
      continue
    }
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const header = /^\[\[?(.*?)\]\]?\s*(#.*)?$/.exec(t)
    if (header) {
      table = tomlPath(header[1]) ?? ['']
      note(table, '')
      continue
    }
    const eq = keyEnd(t)
    if (eq < 0) continue
    const value = t.slice(eq + 1)
    const keys = tomlPath(t.slice(0, eq))
    if (keys) note([...table, ...keys], value)
    st = scanValue(value, st)
  }
  return out
}

/**
 * Codex flags that keep every server named in `configs` off, plus no MCP
 * dependency installs from skills. Throws for a name `-c` cannot address.
 */
export function codexMcpOffArgs(configs: { label: string; toml: string }[]): string[] {
  const servers = new Map<string, Transport>()
  for (const c of configs) {
    for (const [name, kind] of codexMcpServers(c.toml)) {
      if (!/^[A-Za-z0-9_:@/-]+$/.test(name)) {
        throw new Error(`${c.label} declares the MCP server "${name}". Codex units cannot keep a server with that name off; rename it, or deploy this unit on another runtime.`)
      }
      if (kind === 'http' || !servers.has(name)) servers.set(name, kind)
    }
  }
  const args = ['--disable', 'skill_mcp_dependency_install']
  for (const [name, kind] of servers) {
    const key = `mcp_servers.${name}`
    args.push('-c', `${key}.enabled=false`, '-c', `${key}.required=false`,
      '-c', kind === 'http' ? `${key}.url="${CODEX_OFF_URL}"` : `${key}.command="${CODEX_OFF_COMMAND}"`)
  }
  return args
}

/** JSON with comments and trailing commas, as OpenCode reads its config; undefined when unreadable. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else out += c
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

/** Every config file OpenCode 1.19 reads for a session started at the root of `worktree`. */
export function opencodeConfigFiles(worktree: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const global = env.OPENCODE_CONFIG_DIR?.trim() || path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'opencode')
  const pair = (dir: string): string[] => [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')]
  return [path.join(global, 'config.json'), ...pair(global), env.OPENCODE_CONFIG?.trim() ?? '',
    ...pair(worktree), ...pair(path.join(worktree, '.opencode')), ...pair(path.join(home, '.opencode'))].filter(Boolean)
}

const mcpNames = (config: unknown): string[] => {
  const mcp = (config as { mcp?: unknown } | undefined)?.mcp
  return mcp && typeof mcp === 'object' && !Array.isArray(mcp) ? Object.keys(mcp) : []
}

/**
 * OPENCODE_CONFIG_CONTENT with every server named in `files` (and in the
 * content itself) set to `enabled: false`. Throws when the runtime's own
 * content is not JSON: Genio cannot merge into it.
 */
export function opencodeMcpOffContent(content: string | undefined, files: string[]): string {
  const base = content?.trim() ? parseJsonc(content) : {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('OpenCode\'s OPENCODE_CONFIG_CONTENT in SYSTEMS › Runtimes is not a JSON object; fix it before deploying an OpenCode unit.')
  const names = new Set(mcpNames(base))
  for (const f of files) for (const n of mcpNames(parseJsonc(readText(f)))) names.add(n)
  const prev = (base as { mcp?: Record<string, unknown> }).mcp ?? {}
  const mcp: Record<string, unknown> = {}
  for (const n of names) mcp[n] = { ...(prev[n] && typeof prev[n] === 'object' ? prev[n] as object : {}), enabled: false }
  return JSON.stringify(names.size ? { ...base, mcp } : base)
}

/** Runtimes that get the player's servers through relays; every other runtime gets none. */
export const MCP_RELAY_HARNESSES = ['claude', 'codex']

/**
 * What a unit launch adds so it runs only the MCP servers Genio passes.
 * `claudeConfig` is the per-unit file holding claudeUnitMcpConfig(relays);
 * Codex gets the relays as `-c` entries after the flags that turn the rest off.
 */
export function unitMcpLaunch(harnessId: string, o: { worktree: string; claudeConfig?: string; codexHome?: string; adapterEnv?: Record<string, string>; env?: NodeJS.ProcessEnv; home?: string; relays?: McpRelays }): UnitMcpLaunch {
  switch (harnessId) {
    case 'claude':
      return { args: o.claudeConfig ? ['--strict-mcp-config', `--mcp-config=${o.claudeConfig}`] : ['--strict-mcp-config'], env: {} }
    case 'codex': {
      const configs = [
        ...(o.codexHome ? [{ label: 'The Codex home\'s config.toml', toml: readText(path.join(o.codexHome, 'config.toml')) }] : []),
        { label: 'This project\'s .codex/config.toml', toml: readText(path.join(o.worktree, '.codex', 'config.toml')) }
      ]
      const declared = new Set(configs.flatMap((c) => [...codexMcpServers(c.toml).keys()]))
      return { args: [...codexMcpOffArgs(configs), ...codexRelayArgs(o.relays, declared)], env: {} }
    }
    case 'gemini':
      return { args: ['--allowed-mcp-server-names', GEMINI_NO_MCP], env: {} }
    case 'opencode': {
      const env = o.env ?? process.env
      return { args: [], env: { OPENCODE_CONFIG_CONTENT: opencodeMcpOffContent(o.adapterEnv?.OPENCODE_CONFIG_CONTENT ?? env.OPENCODE_CONFIG_CONTENT, opencodeConfigFiles(o.worktree, env, o.home)) } }
    }
    default:
      return { args: [], env: {} }
  }
}
