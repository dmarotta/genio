# MCP servers in units and the chat

MCP servers give an agent extra tools (an issue tracker, a studio database, a design tool). Units and the Claude chat
run **only the MCP servers Genio passes them**: the ones you add in Settings → Advanced → Agent tools (Harnesses) → MCP
servers, and nothing else.

- **Only you add a server**, in that list. No chat tool, unit or project file can add one.
- **Claude and Codex units** and **the Claude chat** get every server in scope. Gemini, OpenCode and the other
  runtimes get none, and neither do the Bot, design chats and the Codex chat (see The Claude chat below).
- **Scope.** Each server is for all projects or for one project. A unit gets the servers of its own project; a
  project's chat gets the same ones.
- **Used by.** Each server is for **units and chat** (the default, and what servers added earlier keep) or **chat
  only**. Work tools such as mail, calendar, documents or meeting notes belong in the chat you talk to, not in every
  unit that works on code: a Chat only server reaches the Claude chat and no unit, whatever its runtime (see Chat only
  below).
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
- the **projects** it is for: all projects, or one;
- **used by**: units and chat, or chat only.

Genio installs and fetches nothing. It runs exactly the command you typed: an `npx -y <package>` command downloads that
package each time it starts.

Where things are kept (main base): the list in `data/mcp-servers.json` (names, commands, URLs, secret names, scope and
`chatOnly: true` for a Chat only server, no values); the values in `data/secrets.json`, encrypted, keyed `mcp:<server id>:<name>`. No value is written into a
project, a brief, a log, the status file or a unit's environment.

## Not supported

- **Servers that spend money.** Genio cannot see the price of an MCP call, so a paid server would bypass the spend
  grants that Genio's own paid helpers (FAL, Uthana, the Sound Studio) enforce. Do not add one; paid generation stays
  with those helpers and their approvals.
- **Unity MCP servers.** They drive whatever editor runs their package, usually your own. Units reach Unity only
  through `genio-unity`, and the Unity guards are unchanged; they do not see MCP calls.
- **Sign-in for servers without dynamic registration.** Genio signs in only where the server lets an app register
  itself (dynamic client registration). A server that accepts only pre-registered apps stays on a token in a secret
  header. Client ID metadata documents, the other way to register, need Genio's client description at a public
  `https://` address, which Genio does not have.
- A write-capable token (GitHub, for example) lets a unit's tools write with it. Prefer a read-only token.

## Sign in (OAuth)

Many hosted servers want a sign-in rather than a token. Genio does that sign-in itself, once per server, and no CLI
ever sees it (`src/main/mcp-signin.ts`, built on the MCP TypeScript SDK 1.32.1 that Genio already installs).

- **The check.** When you save a remote server, Genio sends it one unauthenticated request. If it answers 401 and its
  OAuth metadata (RFC 9728 protected resource, RFC 8414 authorization server) offers dynamic registration, the entry
  gets **Sign in**. Nothing else changes in the list. A server that could not be reached keeps what it had; save it
  again to check again. A new URL is checked again and signs the old one out.
- **Sign in** opens your system browser on the server's own consent page, never a window of Genio's. Genio waits on a
  loopback callback, `http://127.0.0.1:<random free port>/callback`, listening on loopback only, and accepts only the
  callback that carries this sign-in's `state`; another one gets an error page and the sign-in goes on waiting (up to
  five minutes). The SDK does the discovery, registers Genio (`client_name: Genio`, that redirect URI, no client
  secret), and runs the authorization code flow with PKCE S256, the resource indicator (RFC 8707) and the scope the
  server asks for in its 401 or its metadata. Each sign-in registers again, because the port is part of the registered
  redirect URI. When it ends, the button turns into **Sign out**.
- **Where the sign-in is kept.** The registration and tokens are one encrypted entry in `data/secrets.json`
  (`mcp-oauth:<server id>`, OS keychain encryption like the other secrets). They are never in the list file, a log,
  a brief, a status line, a unit's environment or what a unit reads.
- **Use and refresh.** The gateway adds `Authorization: Bearer <access token>` to every request to that server (it
  replaces an `Authorization` header you set). Main is the only refresher: a token close to its expiry is refreshed
  before use, and a 401 leads to one refresh shared by every unit that saw the same token (five simultaneous 401s make
  one refresh request), then one retry. A refresh that cannot reach the server keeps the sign-in; only that call fails.
- **Expired or revoked.** When the server refuses the refresh, or refuses a token it has just issued, Genio forgets
  the sign-in and the entry shows **Sign in** again. From then on every call to that server answers at once, without
  contacting it: "`<server>` needs the player to sign in to it again in Settings. Do not retry this server: append
  needs-decision [key=mcp-auth] naming `<server>`, then stop." The unit's timeline gets one line, `MCP server
  <server>: <tool> failed (sign-in needed).` After you sign in again, a running unit's next call works.
- **Sign out** deletes the sign-in at once; running units get the same "sign in again" answer. Removing the server
  deletes it too. Genio does not ask the server to revoke its tokens.

## The gateway

Genio's main process is the only MCP client of your servers (`src/main/mcp-gateway.ts`):

1. At launch, a Claude or Codex unit gets one **relay** per server (`resources/genio-mcp-relay.mjs`, run by Genio's own
   executable as Node). The relay is a pipe from stdio to a loopback port in Genio, with a per-launch secret bound to
   that unit and those servers. It holds no server secret and starts nothing.
2. The gateway checks the secret and that the server is still in the list and in the unit's project, then:
   - **command**: starts the server itself, with the unit's worktree as its folder and an environment of system
     variables (`PATH`, `SYSTEMROOT`, `TEMP`, `USERPROFILE` and similar) plus that server's own secrets. It never gets
     the unit's environment: no FAL, Uthana or OpenRouter key, no Genio variable;
   - **URL**: calls it with the secret headers from the store, and with the access token of Genio's sign-in when the
     server asks for one.
3. Every tool call is logged in the unit's data folder (`mcp-calls.jsonl`: time, server, tool, ok, duration), plus each
   server's tool count when a unit lists its tools. Arguments and results are never logged. A failed call adds one
   plain line to the unit's timeline (once per tool until it works again).
4. When the unit's process ends, its secret stops working and its relays and servers close. Removing a server in
   Settings stops its tools at once, even for running units; edits apply from the unit's next launch.

A server that refuses its credentials (HTTP 401 or 403) tells the unit not to retry and to ask you with
`needs-decision [key=mcp-auth]`; a server with Genio's sign-in does the same when the sign-in no longer works (see
Sign in above). Because no CLI sees an HTTP server, Claude's and Codex's own OAuth never runs and
nothing is written to your `~/.claude` or the Windows credential store.

**Tool-schema cost.** Codex sends every tool's schema with every request; Claude defers them behind its tool search
when that is on (checked for the chat, see Verified; whether it is on by default against Anthropic's API was not
tested). A server with many tools makes every request of every unit in its scope larger: the tool counts are in each
unit's `mcp-calls.jsonl`. The project scope is the control.

## The Claude chat

When the chat runs on a Claude model, it gets the same relays as a Claude unit (`src/main/chat-mcp.ts`, called from
`buildOptions` in `src/main/wksp.ts`): one `mcpServers` entry per server for all projects or for the chat's project,
beside Genio's own `genio` server. The gateway's caller is `chat:<base>`; local servers start in the chat's folder (its
project's folder) with the same scrubbed environment; calls are logged in the chat's data folder
(`mcp-calls.jsonl`). Each new chat session gets a fresh per-launch secret, and the previous one stops working. Tools
reach the chat as `mcp__<server>__<tool>`.

- **Approval** (`src/main/chat-tool-policy.ts`). Your tools follow the chat's approval mode: in Ask and Auto-approve shell
  they go to the permission prompt every time; in YOLO they run. Only `mcp__genio__*` carries Genio's authority
  (deploy, merge, discard, spend, placement), and no server may be called `genio`, so a server's tool never stands in
  for Genio's guarded tools; the chat's rules say not to use one to bypass a guard.
- **Subagent guard.** The chat denies Claude Code's own delegation tools (Agent, Task, Workflow, Cron, RemoteTrigger,
  SendMessage, Monitor and similar). That word match applies to Claude Code's tool names only, so a server tool such as
  `list_workflow_runs`, `get_remote_config` or `monitor_list` is an ordinary tool.
- **Tool search.** Genio's own server is always loaded. Your servers' tools are deferred behind Claude Code's tool
  search when it is on: their schemas are not in each request until the model searches for them.
- **Sign-in and refused credentials.** The chat's model gets a plain instruction to tell you, for example: "`<server>`
  needs the player to sign in to it again. Do not retry this server; tell the player in plain words to sign in to
  `<server>` again in Settings → Advanced → Agent tools (Harnesses)." No keyed choice is opened and nothing is added
  to a timeline.
- **The Bot** keeps only its guarded bridge: no server, and its policy denies any other tool.
- **The Codex chat** gets none. It blocks every tool that is not one of Genio's own, MCP included, even in YOLO, by
  design; after a switch to a Codex model your tools are simply absent. To use a server from a Codex chat, ask it to
  deploy a unit: units have the servers.
- **Design chats** get none; they only read and talk.

The chat can always hand the work to a unit instead ("check Linear for X and fix it"): the unit gets the same
servers, except Chat only ones.

## Chat only

A server set to **Chat only** in its row is for the Claude chat and never for a unit, so no unit can read your mail or
documents through it. Main enforces it in three places, all from one filter (`mcpServersFor(list, project, 'unit' |
'chat')` in `src/shared/mcp.ts`):

- **Launch.** `unitMcpServers` (`src/main/mcp-servers.ts`) gives `crew.ts` the list for a unit's launch and its
  brief: a Chat only server is not in a Claude unit's `--mcp-config` file, not in a Codex unit's `mcp_servers` tables
  and not named in the brief.
- **Grant.** The gateway drops a Chat only server from any grant whose caller is not the chat, even when the caller
  passes it.
- **Connection.** When a relay connects and on every tool call, the gateway reads the list again for the caller's
  kind: a unit that asks for a Chat only server by name gets its relay closed, and a running unit whose server you set
  to Chat only gets its next call refused ("… no longer applies to this project or to units") and its relay closed.

The Claude chat gets Chat only servers like the others (with the same approval prompts); the Bot, design chats and
the Codex chat still get none.

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

The sign-in (2026-10-17): `tests/mcp-signin.test.ts` runs against a local mock MCP server with its own OAuth 2.1
authorization server (`tests/fixtures/mcp-oauth-server.ts`, trimmed from the MCP Recon's: RFC 9728 and 8414 metadata,
dynamic registration, PKCE S256 and resource checks, rotating refresh tokens, expiry and revocation). It covers the
check on save (no registration endpoint means no Sign in), discovery, registration, PKCE, the scope and resource, a
wrong or missing `state` refused, the callback unreachable from the machine's network address, a fresh registration
per sign-in, decline, sign-out and timeout, one refresh for five simultaneous 401s (directly and through five units'
relays), refresh before expiry, a network failure that keeps the sign-in, a revoked sign-in giving one failed refresh
and then answers with no server traffic, and that no issued token appears in the call log, the timeline, what the unit
reads, the list file, the views, the console or the store in clear. The browser is simulated: no real browser, no
real vendor server and no real account was tested, and Electron's `safeStorage` is mocked in the tests.

The Claude chat (2026-10-17): `tests/chat-mcp.test.ts` starts the chat's relay entries exactly as Claude Code does
and lists and calls the local test server through the gateway (scope, cwd, no unit key, the call log, a new session
revoking the old secret), checks the plain-words sign-in answer, the Ask, Auto-approve shell and YOLO paths, the Bot's
denial, the narrower subagent guard and that Genio's own tools are unaffected. `tests/e2e/mcp-chat.e2e.ts`
(`npm run test:e2e -- mcp-chat`) runs the chat's shape with the real Agent SDK (Claude Code 2.1.302) against a fake
model endpoint in a throwaway home, with `ENABLE_TOOL_SEARCH=true`: the first request offered `ToolSearch` and
Genio's tool but not the server's; after a search the server's tool came with `defer_loading`, went through Genio's
policy (asked in Ask mode, not in YOLO) and was called through the gateway.

Chat only (2026-10-17): `tests/mcp-servers.test.ts` checks that the choice persists through save and edit, that a
server saved before it existed stays for units and chat, and that units on every runtime get none.
`tests/unit-mcp.test.ts` builds a Claude unit's file, a Codex unit's tables and the brief from the unit list and finds
no Chat only server, and checks that `crew.ts` takes every unit list from `unitMcpServers`. `tests/mcp-gateway.test.ts`
tries it as a unit: a grant handed the whole list, a relay asking for the Chat only server by name, and a running
unit's server switched to Chat only; each is refused, while a chat caller lists and calls it.
`tests/chat-mcp.test.ts` checks that the chat gets and calls it.

To repeat the live check, use a throwaway home for each CLI and set its variable in the same command: `CLAUDE_CONFIG_DIR`
and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME` (a short path: Codex's socket path has a length limit),
`GEMINI_CLI_HOME`, and OpenCode's `XDG_*` folders. Set `general.enableAutoUpdate: false` in the throwaway Gemini
settings, or Gemini updates its global install during the run. Never run login commands.
