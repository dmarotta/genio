# Shared chat tool bridge

`src/main/wksp-tools.ts` now owns Genio's names, Zod schemas, handlers and existing role guards. `wksp-sdk-tools.ts` contains the extracted Claude SDK adapter; `wksp-tools.ts` re-exports it for existing callers. Keeping the registrations at their original source location also preserves the existing achievement coverage check unchanged. Both adapters validate arguments and invoke the same service handlers in the existing `AppCtx`. No second application, fleet manager or worker harness is started.

`chat-tool-policy.ts` owns the existing Claude policy and the common asynchronous `enforceTool` interface. It reads the current approval mode at call time and uses `AppCtx.permissions.ask`, so the existing permission UI and Ask / Auto-approve shell / YOLO behavior are preserved. Registered Genio tools clear their own destructive and outward-facing steps through `clearAction`, which asks the same broker according to the same mode, whichever runtime called them ([chat authority](chat-authority.md)); spend and placement keep their own approvals, which YOLO does not bypass.

## Opening a runtime session

The next chat driver calls `openChatToolBridge(() => ctx, { home, role, worlds, signal })` inside Electron. `home` must be the existing chat's `Home`; `role` is `genio`, `ally`, `bot` or `design` (a Lore chat, see [Lore chats](design-chats.md); its bridge also carries the chat's conversation id so it closes with that chat only). `worlds` is an immutable snapshot of permitted project names; only the main base may request `'*'`. Ally scopes must be a subset of the configured ally's projects. The driver owns the abort signal and aborts it when replacing or closing its runtime session.

The returned `entry` is `resources/genio-chat-mcp.mjs`. Launch it with Node (or Electron with `ELECTRON_RUN_AS_NODE=1`) and the returned `env`, which contains a loopback endpoint and a random per-session token. Keep these values in the child environment, never command arguments, model context, logs, settings or saved MCP configuration. The helper has no package dependencies. Include `resources/` in the application distribution, as with existing bundled helpers.

The helper implements newline-delimited stdio MCP initialize, ping, tool discovery and calls. It forwards requests to the app; it does not execute tools. It never retries a request whose outcome is uncertain. EOF and normal shutdown revoke the endpoint. A heartbeat exits the helper after app-side closure. The app also revokes every bridge belonging to a chat during `WkspService.stop` and `restart`; ally retirement and app shutdown already use that lifecycle. Closing prevents new calls but cannot undo a service action that has already started.

## Authority and transport boundaries

- The transport binds only `127.0.0.1` on an ephemeral port. Every request requires the session's 256-bit bearer token, compared in constant time. Browser-origin requests are rejected. There is no network URL or scope override in tool arguments.
- Unknown tools and unknown top-level arguments are rejected. Target projects, task ownership, quest dependencies, choices and generation ownership are checked before the original handler executes. Project-limited image requests accept chat attachment references, not arbitrary absolute file references.
- Project-limited sessions receive filtered project/quest/choice lists. Services with no safe scoped interface (fleet/status aggregates, global dispatch profiles, mail, cross-ally routing, presence and project creation) are unavailable to those connections. Sync must name a permitted project. Scoped connections cannot silently acquire newly added projects.
- Bridge Bot sessions expose reads and `escalate` only, and reject report filing. This is intentionally stricter than the legacy Claude Bot's supervision actions; this step preserves the existing Claude behavior. Bridge Bot cannot deploy, merge (even with Auto-loot), answer choices, change memory or generate/place assets. The provider drivers now use this boundary for both Claude and Codex Bot sessions; the Bot inherits the main chat selection.
- Design sessions expose only `DESIGN_TOOLS` (reads, `art_bible` read, `design_notes` and chat-only `generate_image`). A `design_notes` write checks `player_words` against that Lore chat's own transcript. They refuse an Art Bible write and an image placed in a project, and cannot deploy, merge, file quests or plans, touch choices or events, change settings or memory, or call paid tools.
- The server bounds requests (120/minute per session, including failures), concurrent requests (8), sockets (32), headers, body size (1 MiB) and request receipt time. Audit records contain only fixed events and registry-owned tool names, never tokens, arguments, results or exception messages. The optional audit sink replaces the default sanitized console records.

## Driver capability gate

`chatDriverCapabilities` feeds the catalogue's `canDrive` gate. Claude and Codex are drivers; Codex discovery/startup validate authentication and native confinement before sending any prompt. Gemini and OpenCode remain consultation-only capabilities. See [chat drivers](chat-drivers.md) for lifecycle and release gates.

The common enforcer denies **every** non-Claude native identity, including shell/edit/subagent/plugin aliases and names impersonating `mcp__genio__*`, even under YOLO. The Codex chat reaches commands and edits through Genio's own `run_command` and `write_file`, under the approval mode like the Claude chat's native tools. A future adapter must prove that native tools and global plugins cannot bypass the enforcer before enabling its driver capability. Merely installing this MCP server is insufficient. Never copy launch settings from `harness.ts`: those are worker settings, not chat settings.

The driver layer owns provider sessions, bounded handoff, achievements and AFK inheritance. The bridge never selects a provider or introduces a paid fallback.

## Verification

`tests/chat-tool-bridge.test.ts` exercises real loopback HTTP and the shipped stdio process, authentication, token rotation, scope forgery, Bot denial, merge clearance by approval mode, placement guards, SDK result parity, approval modes, native-tool denial, rate/body limits and chat shutdown. `tests/chat-authority.test.ts` covers every guarded action in each mode.
