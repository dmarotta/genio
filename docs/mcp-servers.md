# MCP servers in units

MCP servers give an agent extra tools (an issue tracker, a studio database, a design tool). Units run **only the MCP
servers Genio passes them**. Today that is none: the list you add in Settings comes in a later build. Until then:

- Servers a project declares in its own files stay off for units: `.mcp.json` (Claude Code), `.codex/config.toml`
  (Codex), `.gemini/settings.json` (Gemini CLI), `opencode.json` and `.opencode/` (OpenCode). A unit can work in a
  project that has these files; it simply does not start their servers.
- Your own servers in each CLI's normal config (`~/.codex/config.toml`, `~/.gemini/settings.json`, OpenCode's global
  config, Claude's user and local scopes) stay off for units too.
- No server receives a unit's keys. OpenCode passed its whole environment, FAL and Uthana keys included, to the servers
  it starts; with none started, nothing is passed.
- A Claude unit never stops at Claude Code's "New MCP server found in this project" dialog. Before this change a
  committed `.mcp.json` left a Claude unit waiting there with nobody to answer.

The Claude chat and the Bot are unchanged: they already load no project or user settings (`settingSources: []`), only
Genio's own tool server. The Codex chat turns off every inherited server by name (`docs/chat-drivers.md`).

## How each runtime is launched

`src/main/unit-mcp.ts` builds the additions; `crew.ts` passes them on every deploy and respawn, whatever the runtime's
saved arguments in Settings say.

| Runtime | What Genio adds | Why this way |
|---|---|---|
| Claude Code | `--strict-mcp-config --mcp-config=<unit state>/.mcp-config.json`, the file holding `{"mcpServers":{}}` | Strict mode loads only that file: no `.mcp.json`, user or local servers, and no approval dialog. `--mcp-config` takes several values, so only the `=` form is safe before the prompt. |
| Codex | `--disable skill_mcp_dependency_install`, then for each server named in the Codex home's `config.toml` or the worktree's `.codex/config.toml`: `-c mcp_servers.<name>.enabled=false`, `required=false`, and an inert `command` (stdio) or `url` (HTTP) | Codex has no "no MCP" switch. The unit's folder stays trusted, because an untrusted folder shows a "Folder access … Open restricted" dialog before the first turn. Codex refuses `enabled=false` alone for a name it does not load, so the same-kind inert entry keeps the launch valid either way. |
| Gemini CLI | `--allowed-mcp-server-names genio-none` | An allow-list that names no real server starts none, extension servers included. An empty list would allow all. |
| OpenCode | `OPENCODE_CONFIG_CONTENT` with `"enabled": false` for each server named in the global config, `OPENCODE_CONFIG`, the worktree's `opencode.json[c]`, its `.opencode/` folder and `~/.opencode/` | OpenCode merges that content last. `OPENCODE_DISABLE_PROJECT_CONFIG` would also drop the project's AGENTS.md, so it is not used. A name it does not know is ignored. |

Cursor, Grok, Aider and custom runtimes get nothing added; their MCP behaviour is their own.

**Limits.**
- Codex splits `-c` keys at every dot, so a server whose name contains a dot cannot be turned off. The launch stops
  and names the file. Rename the server, or deploy that unit on another runtime.
- Codex names are read from the TOML tables, dotted keys and `[mcp_servers]` entries; a whole `mcp_servers = { … }`
  inline table at the top level is not read.
- OpenCode's remote organisation config (`.well-known/opencode`) is not read.

## Verified

Checked on 2026-10-17 on Claude Code 2.1.302, codex-cli 0.162.1, Gemini CLI 0.64.0 and OpenCode 1.19.0. Each ran in
a real pseudo-terminal, started the way Genio starts a unit, in throwaway homes against fake model endpoints. There
was no sign-in and no real model. The test repository declared a server for every runtime and a second one in each
home; every server wrote a line when it started.

| Runtime | Before | After |
|---|---|---|
| Claude Code | Stopped at "New MCP server found"; no model request in 30 s | No dialog; model reached; neither server started; nothing written to the worktree |
| Codex | Repository and home servers started and were offered to the model | Neither started; model reached; the repository's AGENTS.md still loaded |
| Gemini CLI | Repository and home servers started | Neither started ("2 MCP servers, 2 Blocked"); model reached |
| OpenCode | Repository, `.opencode/` and global servers started | None started; model reached |

`tests/unit-mcp.test.ts` checks the launch arguments of each runtime against the fixture repository
`tests/fixtures/mcp-repo` (`.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`,
`.opencode/opencode.jsonc`).

To repeat the live check, use a throwaway home for each CLI and set its variable in the same command: `CLAUDE_CONFIG_DIR`
and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME` (a short path: Codex's socket path has a length limit),
`GEMINI_CLI_HOME`, and OpenCode's `XDG_*` folders. Set `general.enableAutoUpdate: false` in the throwaway Gemini
settings, or Gemini updates its global install during the run. Never run login commands.
