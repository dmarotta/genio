import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildArgs, BUILTIN_HARNESSES } from '../src/main/harness'
import {
  CLAUDE_UNIT_MCP_CONFIG, claudeUnitMcpConfig, codexMcpOffArgs, codexMcpServers, codexRelayArgs, GEMINI_NO_MCP, MCP_RELAY_HARNESSES, opencodeConfigFiles,
  opencodeMcpOffContent, parseJsonc, unitMcpLaunch
} from '../src/main/unit-mcp'

/** A repository that declares MCP servers for every runtime (.mcp.json, .codex/config.toml, .gemini, opencode.json, .opencode/). */
const REPO = path.join(__dirname, 'fixtures', 'mcp-repo')
const harness = (id: string) => BUILTIN_HARNESSES.find(h => h.id === id)!
const bypass = { claudePermissionMode: 'bypass' as const }

const temps: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unit-mcp-'))
  temps.push(d)
  return d
}
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('the fixture repository', () => {
  it('declares servers for every runtime', () => {
    for (const f of ['.mcp.json', '.codex/config.toml', '.gemini/settings.json', 'opencode.json', '.opencode/opencode.jsonc']) {
      expect(fs.existsSync(path.join(REPO, f)), f).toBe(true)
    }
  })
})

describe('Claude units', () => {
  it('load only the empty server file Genio passes, in the = form', () => {
    const mcp = unitMcpLaunch('claude', { worktree: REPO, claudeConfig: 'C:/state/u1/.mcp-config.json' })
    expect(mcp).toEqual({ args: ['--strict-mcp-config', '--mcp-config=C:/state/u1/.mcp-config.json'], env: {} })
    expect(CLAUDE_UNIT_MCP_CONFIG).toEqual({ mcpServers: {} })
    const argv = buildArgs(harness('claude'), { model: 'm1', prompt: 'go', settings: 's.json', launchArgs: mcp.args }, bypass)
    expect(argv).toEqual(['--strict-mcp-config', '--mcp-config=C:/state/u1/.mcp-config.json', '--dangerously-skip-permissions', '--settings', 's.json', '--model', 'm1', 'go'])
    // --mcp-config is variadic: a separate value element would swallow the prompt.
    expect(argv).not.toContain('--mcp-config')
    expect(buildArgs(harness('claude'), { resume: true, launchArgs: mcp.args }, bypass))
      .toEqual(['--strict-mcp-config', '--mcp-config=C:/state/u1/.mcp-config.json', '--dangerously-skip-permissions', '--continue'])
  })
})

describe('Codex units', () => {
  it('turn off every server the repository and the home declare, by name and with a same-kind inert entry', () => {
    const home = tmp()
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "m"\n\n[mcp_servers.home_srv]\ncommand = "node"\n\n[projects.\'C:\\\\x\']\ntrust_level = "trusted"\n')
    const mcp = unitMcpLaunch('codex', { worktree: REPO, codexHome: home })
    expect(mcp.env).toEqual({})
    expect(mcp.args).toEqual([
      '--disable', 'skill_mcp_dependency_install',
      '-c', 'mcp_servers.home_srv.enabled=false', '-c', 'mcp_servers.home_srv.required=false', '-c', 'mcp_servers.home_srv.command="genio-mcp-off"',
      '-c', 'mcp_servers.repo_codex.enabled=false', '-c', 'mcp_servers.repo_codex.required=false', '-c', 'mcp_servers.repo_codex.command="genio-mcp-off"',
      '-c', 'mcp_servers.repo-web.enabled=false', '-c', 'mcp_servers.repo-web.required=false', '-c', 'mcp_servers.repo-web.url="http://127.0.0.1:9/genio-mcp-off"',
      '-c', 'mcp_servers.inline_srv.enabled=false', '-c', 'mcp_servers.inline_srv.required=false', '-c', 'mcp_servers.inline_srv.command="genio-mcp-off"',
      '-c', 'mcp_servers.inline_web.enabled=false', '-c', 'mcp_servers.inline_web.required=false', '-c', 'mcp_servers.inline_web.url="http://127.0.0.1:9/genio-mcp-off"'
    ])
  })

  it('still disable MCP dependency installs when nothing declares a server', () => {
    expect(unitMcpLaunch('codex', { worktree: tmp(), codexHome: tmp() }).args).toEqual(['--disable', 'skill_mcp_dependency_install'])
  })

  it('put the flags after a resume subcommand and before the template', () => {
    const launchArgs = codexMcpOffArgs([{ label: 'x', toml: '[mcp_servers.a]\ncommand = "n"\n' }])
    expect(buildArgs(harness('codex'), { resume: true, sessionId: 'sid', prompt: 'go', model: 'm', launchArgs }, bypass)).toEqual([
      'resume', 'sid', ...launchArgs, '--dangerously-bypass-approvals-and-sandbox', '--model', 'm', 'go'
    ])
    expect(buildArgs(harness('codex'), { prompt: 'go', launchArgs }, bypass)).toEqual([...launchArgs, '--dangerously-bypass-approvals-and-sandbox', 'go'])
  })

  it('stop the launch for a name -c cannot address', () => {
    expect(() => codexMcpOffArgs([{ label: "This project's .codex/config.toml", toml: '[mcp_servers."dot.name"]\ncommand = "n"\n' }]))
      .toThrow(/This project's \.codex\/config\.toml declares the MCP server "dot\.name"/)
    expect(codexMcpOffArgs([{ label: 'x', toml: '[mcp_servers."a:b@c/d"]\ncommand = "n"\n' }])).toContain('mcp_servers.a:b@c/d.enabled=false')
  })

  it('read server names the way TOML declares them', () => {
    const toml = [
      '# [mcp_servers.commented]',
      'mcp_servers.dotted.command = "n"',
      'description = """',
      '[mcp_servers.in_multiline_string]',
      '"""',
      '[mcp_servers.\'literal-name\']',
      'command = "n"',
      '[mcp_servers.literal-name.env]',
      'K = "[mcp_servers.in_value]"',
      '[mcp_servers.web2]',
      'command = "n"',
      '[mcp_servers.web2.http_headers]',
      'X = "y"',
      '[[mcp_servers.arr.tools]]',
      '[profiles.p]',
      'mcp_servers = "not a table"',
      '[other]',
      'mcp = { mcp_servers = 1 }'
    ].join('\n')
    expect([...codexMcpServers(toml)]).toEqual([['dotted', 'stdio'], ['literal-name', 'stdio'], ['web2', 'http'], ['arr', 'stdio']])
    expect(codexMcpServers('')).toEqual(new Map())
  })
})

describe('Gemini units', () => {
  it('allow only a server name nobody has', () => {
    const mcp = unitMcpLaunch('gemini', { worktree: REPO })
    expect(mcp).toEqual({ args: ['--allowed-mcp-server-names', GEMINI_NO_MCP], env: {} })
    expect(buildArgs(harness('gemini'), { prompt: 'go', model: 'g', launchArgs: mcp.args }, bypass))
      .toEqual(['--allowed-mcp-server-names', 'genio-none', '-y', '-m', 'g', 'go'])
  })
})

describe('OpenCode units', () => {
  it('turn off the repository, project-folder and player servers while keeping the runtime config', () => {
    const home = tmp()
    const xdg = path.join(home, 'xdg')
    fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.jsonc'), '{ // the player\'s own\n "mcp": { "player-srv": { "type": "remote", "url": "https://x" } } }')
    const env = { XDG_CONFIG_HOME: xdg }
    const adapterEnv = harness('opencode').env!
    const mcp = unitMcpLaunch('opencode', { worktree: REPO, adapterEnv, env, home })
    expect(mcp.args).toEqual([])
    expect(JSON.parse(mcp.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      permission: { '*': 'allow' },
      mcp: { 'player-srv': { enabled: false }, 'repo-oc': { enabled: false }, 'repo-oc-dir': { enabled: false } }
    })
  })

  it('read every config file OpenCode reads', () => {
    const files = opencodeConfigFiles('W', { XDG_CONFIG_HOME: 'X', OPENCODE_CONFIG: 'C.json' }, 'H').map(f => f.replace(/\\/g, '/'))
    expect(files).toEqual(['X/opencode/config.json', 'X/opencode/opencode.json', 'X/opencode/opencode.jsonc', 'C.json',
      'W/opencode.json', 'W/opencode.jsonc', 'W/.opencode/opencode.json', 'W/.opencode/opencode.jsonc', 'H/.opencode/opencode.json', 'H/.opencode/opencode.jsonc'])
    expect(opencodeConfigFiles('W', { OPENCODE_CONFIG_DIR: 'D' }, 'H')[0].replace(/\\/g, '/')).toBe('D/config.json')
    expect(opencodeConfigFiles('W', {}, 'H')[0].replace(/\\/g, '/')).toBe('H/.config/opencode/config.json')
  })

  it('keep a server the runtime content defines, turned off, and refuse content that is not JSON', () => {
    expect(JSON.parse(opencodeMcpOffContent('{"mcp":{"own":{"type":"local","command":["x"]}}}', []))).toEqual({ mcp: { own: { type: 'local', command: ['x'], enabled: false } } })
    expect(opencodeMcpOffContent('{"permission":{"*":"allow"}}', [path.join(tmp(), 'missing.json')])).toBe('{"permission":{"*":"allow"}}')
    expect(() => opencodeMcpOffContent('not json', [])).toThrow(/OPENCODE_CONFIG_CONTENT/)
  })

  it('parse JSON with comments and trailing commas, keeping slashes inside strings', () => {
    expect(parseJsonc('{ "u": "https://x//y", /* c */ "a": [1, 2,], // end\n }')).toEqual({ u: 'https://x//y', a: [1, 2] })
    expect(parseJsonc('{ broken')).toBeUndefined()
  })
})

describe('other runtimes', () => {
  it('get nothing added', () => {
    for (const id of ['cursor', 'grok', 'aider', 'custom']) expect(unitMcpLaunch(id, { worktree: REPO })).toEqual({ args: [], env: {} })
  })
})

describe("the player's servers through relays", () => {
  const relays = { command: 'C:/Genio/Genio.exe', script: 'C:/Genio/resources/genio-mcp-relay.mjs', servers: ['linear', 'repo-web'] }

  it('reach Claude units as stdio relays in the strict per-unit file, with no secret and no gateway address in it', () => {
    expect(claudeUnitMcpConfig()).toEqual(CLAUDE_UNIT_MCP_CONFIG)
    expect(claudeUnitMcpConfig(relays)).toEqual({ mcpServers: {
      linear: { type: 'stdio', command: 'C:/Genio/Genio.exe', args: ['C:/Genio/resources/genio-mcp-relay.mjs', 'linear'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      'repo-web': { type: 'stdio', command: 'C:/Genio/Genio.exe', args: ['C:/Genio/resources/genio-mcp-relay.mjs', 'repo-web'], env: { ELECTRON_RUN_AS_NODE: '1' } }
    } })
    expect(JSON.stringify(claudeUnitMcpConfig(relays))).not.toMatch(/GENIO_MCP_(SECRET|GATEWAY)/)
    expect(unitMcpLaunch('claude', { worktree: REPO, claudeConfig: 'C:/state/u1/.mcp-config.json', relays }).args).toEqual(['--strict-mcp-config', '--mcp-config=C:/state/u1/.mcp-config.json'])
  })

  it('reach Codex units as -c relay tables after the flags that keep the rest off; a name a config declares gets its own key', () => {
    const args = unitMcpLaunch('codex', { worktree: REPO, codexHome: tmp(), relays }).args
    const relayArgs = (key: string, name: string) => ['-c', `mcp_servers.${key}={command="C:/Genio/Genio.exe",args=["C:/Genio/resources/genio-mcp-relay.mjs","${name}"],env={ELECTRON_RUN_AS_NODE="1"},env_vars=["GENIO_MCP_GATEWAY","GENIO_MCP_SECRET"],required=false}`]
    expect(args.slice(-4)).toEqual([...relayArgs('linear', 'linear'), ...relayArgs('genio-repo-web', 'repo-web')])
    // The repository's own repo-web stays off.
    expect(args).toContain('mcp_servers.repo-web.enabled=false')
    expect(args.slice(0, -4)).toEqual(unitMcpLaunch('codex', { worktree: REPO, codexHome: tmp() }).args)
    expect(codexRelayArgs(undefined)).toEqual([])
    expect(codexRelayArgs({ ...relays, servers: ['a'] }, new Set(['a', 'genio-a']))[1]).toMatch(/^mcp_servers\.genio-genio-a=/)
  })

  it('never reach Gemini, OpenCode or other runtimes', () => {
    expect(MCP_RELAY_HARNESSES).toEqual(['claude', 'codex'])
    expect(unitMcpLaunch('gemini', { worktree: REPO, relays })).toEqual(unitMcpLaunch('gemini', { worktree: REPO }))
    for (const id of ['cursor', 'grok', 'aider', 'custom']) expect(unitMcpLaunch(id, { worktree: REPO, relays })).toEqual({ args: [], env: {} })
    const adapterEnv = harness('opencode').env!
    expect(unitMcpLaunch('opencode', { worktree: REPO, adapterEnv, relays, env: {}, home: tmp() })).toEqual(unitMcpLaunch('opencode', { worktree: REPO, adapterEnv, env: {}, home: tmp() }))
  })

  it('reach only unit launches and the Claude chat: never the Bot, design chats or the Codex chat', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8')
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'main'))) {
      if (!/\.ts$/.test(f) || ['crew.ts', 'ipc.ts', 'mcp-gateway.ts', 'mcp-servers.ts', 'mcp-signin.ts', 'chat-mcp.ts', 'wksp.ts'].includes(f)) continue
      expect(src(f), f).not.toMatch(/from '\.\/(mcp-(gateway|servers)|chat-mcp)'/)
    }
    expect(src('crew.ts')).toMatch(/MCP_RELAY_HARNESSES\.includes\(adapter\.id\) \? mcpServersFor\(readMcpServers/)
    // wksp.ts: only the Claude chat's options read the list, and only for a role that is not the Bot (tests/chat-mcp.test.ts).
    expect(src('wksp.ts').match(/chatMcpServers\(/g)).toHaveLength(1)
    expect(src('wksp.ts')).not.toMatch(/readMcpServers|mcpServersFor/)
  })
})
