# MCP servers in units

MCP servers give an agent extra tools (an issue tracker, a studio database, a design tool). Units run **only the MCP
servers Genio passes them**: the ones you add in Settings → Advanced → Agent tools (Harnesses) → MCP servers, and
nothing else.

- **Only you add a server**, in that list. No chat tool, unit or project file can add one.
- **Claude and Codex units** get every server in scope. Gemini, OpenCode and the other runtimes get none, and neither
  do the Claude chat, the Bot and the Codex chat (the Claude chat comes in a later build).
- **Scope.** Each server is for all projects or for one project. A unit gets the servers of its own project.
- Servers a project declares in its own files stay off for units: `.mcp.json` (Claude Code), `.codex/config.toml`
  (Codex), `.gemini/settings.json` (Gemini CLI), `opencode.json` and `.opencode/` (OpenCode). A unit can work in a
  project that has these files; it simply does not start their servers.
- Your own servers in each CLI's normal config (`~/.codex/config.toml`, `~/.gemini/settings.json`, OpenCode's global
  config, Claude's user and local scopes) stay off for units too.
- A Claude unit never stops at Claude Code's "New MCP server found in this project" dialog.

## The list

Each entry has:
- a **name**: lower-case letters, digits and dashes, at most 32 characters, unique, not `genio`. Units see the tools as
  `mcp__<name>__<tool>`;
- either a **command and arguments** (a server Genio starts on this PC; quote an argument that has spaces) or a **URL**
  (a remote server over streamable HTTP; `https://`, or `http://` only on this PC);
- **secrets**: environment variables for a command, headers for a URL (for example `Authorization` with the value
  `Bearer <token>`). Values are masked, encrypted with your OS keychain like the FAL and Uthana keys, and never shown
  again. Leave a value empty to keep the stored one;
- the **projects** it is for: all projects, or one.

Genio installs and fetches nothing. It runs exactly the command you typed: an `npx -y <package>` command downloads that
package each time it starts.

Where things are kept (main base): the list in `data/mcp-servers.json` (names, commands, URLs, secret names and scope,
no values); the values in `data/secrets.json`, encrypted, keyed `mcp:<server id>:<name>`. No value is written into a
project, a brief, a log, the status file or a unit's environment.

## Not supported

- **Servers that spend money.** Genio cannot see the price of an MCP call, so a paid server would bypass the spend
  grants that Genio's own paid helpers (FAL, Uthana, the Sound Studio) enforce. Do not add one; paid generation stays
  with those helpers and their approvals.
- **Unity MCP servers.** They drive whatever editor runs their package, usually your own. Units reach Unity only
  through `genio-unity`, and the Unity guards are unchanged; they do not see MCP calls.
- **Sign-in (OAuth).** In this build a remote server needs a token in a secret header. Genio's own sign-in per server
  comes in a later build.
- A write-capable token (GitHub, for example) lets a unit's tools write with it. Prefer a read-only token.

## The gateway

Genio's main process is the only MCP client of your servers (`src/main/mcp-gateway.ts`):

1. At launch, a Claude or Codex unit gets one **relay** per server (`resources/genio-mcp-relay.mjs`, run by Genio's own
   executable as Node). The relay is a pipe from stdio to a loopback port in Genio, with a per-launch secret bound to
   that unit and those servers. It holds no server secret and starts nothing.
2. The gateway checks the secret and that the server is still in the list and in the unit's project, then:
   - **command**: starts the server itself, with the unit's worktree as its folder and an environment of system
     variables (`PATH`, `SYSTEMROOT`, `TEMP`, `USERPROFILE` and similar) plus that server's own secrets. It never gets
     the unit's environment: no FAL, Uthana or OpenRouter key, no Genio variable;
   - **URL**: calls it with the secret headers from the store.
3. Every tool call is logged in the unit's data folder (`mcp-calls.jsonl`: time, server, tool, ok, duration), plus each
   server's tool count when a unit lists its tools. Arguments and results are never logged. A failed call adds one
   plain line to the unit's timeline (once per tool until it works again).
4. When the unit's process ends, its secret stops working and its relays and servers close. Removing a server in
   Settings stops its tools at once, even for running units; edits apply from the unit's next launch.

A server that refuses its credentials (HTTP 401 or 403) tells the unit not to retry and to ask you with
`needs-decision [key=mcp-auth]`. Because no CLI sees an HTTP server, Claude's and Codex's own OAuth never runs and
nothing is written to your `~/.claude` or the Windows credential store.

**Tool-schema cost.** Codex sends every tool's schema with every request; Claude probably defers them behind its tool
search. A server with many tools makes every request of every unit in its scope larger: the tool counts are in each
unit's `mcp-calls.jsonl`. The project scope is the control.

## How each runtime is launched

`src/main/unit-mcp.ts` builds the additions; `crew.ts` passes them on every deploy and respawn, whatever the runtime's
saved arguments in Settings say. The gateway address and per-launch secret (`GENIO_MCP_GATEWAY`, `GENIO_MCP_SECRET`)
are in the unit's environment, never in argv or a file.

| Runtime | What Genio adds | Why this way |
|---|---|---|
| Claude Code | `--strict-mcp-config --mcp-config=<unit state>/.mcp-config.json`, the file holding one stdio relay entry per server (`{"mcpServers":{}}` when there are none) | Strict mode loads only that file: no `.mcp.json`, user or local servers, and no approval dialog. `--mcp-config` takes several values, so only the `=` form is safe before the prompt. Claude passes its whole environment to stdio servers, which is why the real server is started by the gateway, not by Claude. |
| Codex | `--disable skill_mcp_dependency_install`, then for each server named in the Codex home's `config.toml` or the worktree's `.codex/config.toml`: `-c mcp_servers.<name>.enabled=false`, `required=false`, and an inert `command` (stdio) or `url` (HTTP). Then one `-c mcp_servers.<name>={command=…,args=[…],env_vars=["GENIO_MCP_GATEWAY","GENIO_MCP_SECRET"],…}` relay table per server | Codex has no "no MCP" switch. The unit's folder stays trusted, because an untrusted folder shows a "Folder access … Open restricted" dialog before the first turn. Codex refuses `enabled=false` alone for a name it does not load, so the same-kind inert entry keeps the launch valid either way. Codex merges a `-c` table into a same-named server from a config file, so a server name a config file also declares gets its relay under `genio-<name>` (tools `mcp__genio_<name>`) while the file's server stays off. |
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
`.opencode/opencode.jsonc`), and the relay entries Claude and Codex units get.

The list and the gateway (2026-10-17): `tests/mcp-servers.test.ts` covers add, edit, remove, scope, validation and
that no secret value reaches the list file, the views or the brief. `tests/mcp-gateway.test.ts` runs the relay and the
gateway against a local stdio test server (`tests/fixtures/mcp-env-server.mjs`) and a local HTTP one: tools listed and
called, the server's environment dump (its own secret and system variables only, no `FAL_KEY`, cwd the worktree), the
header secret, the call log, failures on the timeline, refused secrets and scopes, removal and revocation.
`tests/e2e/mcp-gateway.e2e.ts` (`npm run test:e2e -- mcp-gateway`) does the round trip with the real Claude Code
2.1.302 and codex-cli 0.162.1, launched with a unit's exact MCP flags through Genio's PTY spawn, against fake model
endpoints in throwaway homes: both listed and called the test server through the relay, the server saw no unit key,
and neither home got a credentials file.

To repeat the live check, use a throwaway home for each CLI and set its variable in the same command: `CLAUDE_CONFIG_DIR`
and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME` (a short path: Codex's socket path has a length limit),
`GEMINI_CLI_HOME`, and OpenCode's `XDG_*` folders. Set `general.enableAutoUpdate: false` in the throwaway Gemini
settings, or Gemini updates its global install during the run. Never run login commands.
