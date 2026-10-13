# Shared chat tool bridge

`src/main/wksp-tools.ts` now owns Genio's names, Zod schemas, handlers and existing role guards. `wksp-sdk-tools.ts` contains the extracted Claude SDK adapter; `wksp-tools.ts` re-exports it for existing callers. Keeping the registrations at their original source location also preserves the existing achievement coverage check unchanged. Both adapters validate arguments and invoke the same service handlers in the existing `AppCtx`. No second application, fleet manager or worker harness is started.

`chat-tool-policy.ts` owns the existing Claude policy and the common asynchronous `enforceTool` interface. It reads the current approval mode at call time and uses `AppCtx.permissions.ask`, so the existing permission UI and Ask / Auto-approve shell / YOLO behavior are preserved. Registered Genio tools retain their handler-owned consent checks; YOLO does not bypass merge or placement guards.

## Opening a runtime session

The next chat driver calls `openChatToolBridge(() => ctx, { home, role, worlds, signal })` inside Electron. `home` must be the existing chat's `Home`; `role` is `genio`, `ally` or `bot`. `worlds` is an immutable snapshot of permitted project names; only the main base may request `'*'`. Ally scopes must be a subset of the configured ally's projects. The driver owns the abort signal and aborts it when replacing or closing its runtime session.

The returned `entry` is `resources/genio-chat-mcp.mjs`. Launch it with Node (or Electron with `ELECTRON_RUN_AS_NODE=1`) and the returned `env`, which contains a loopback endpoint and a random per-session token. Keep these values in the child environment, never command arguments, model context, logs, settings or saved MCP configuration. The helper has no package dependencies. Include `resources/` in the application distribution, as with existing bundled helpers.

The helper implements newline-delimited stdio MCP initialize, ping, tool discovery and calls. It forwards requests to the app; it does not execute tools. It never retries a request whose outcome is uncertain. EOF and normal shutdown revoke the endpoint. A heartbeat exits the helper after app-side closure. The app also revokes every bridge belonging to a chat during `WkspService.stop` and `restart`; ally retirement and app shutdown already use that lifecycle. Closing prevents new calls but cannot undo a service action that has already started.

## Authority and transport boundaries

- The transport binds only `127.0.0.1` on an ephemeral port. Every request requires the session's 256-bit bearer token, compared in constant time. Browser-origin requests are rejected. There is no network URL or scope override in tool arguments.
- Unknown tools and unknown top-level arguments are rejected. Target worlds, task ownership, quest dependencies, choices and generation ownership are checked before the original handler executes. World-limited image requests accept chat attachment references, not arbitrary absolute file references.
- World-limited sessions receive filtered world/quest/choice lists. Services with no safe scoped interface (fleet/status aggregates, global dispatch profiles, mail, cross-ally routing, presence and world creation) are unavailable to those connections. Sync must name a permitted world. Scoped connections cannot silently acquire newly added worlds.
- Bridge Bot sessions expose reads and `escalate` only, and reject report filing. This is intentionally stricter than the legacy Claude Bot's supervision actions; this step preserves the existing Claude behavior. Bridge Bot cannot deploy, merge (even with Auto-loot), answer choices, change memory or generate/place assets. The next Bot driver must inherit the selected main-chat runtime without weakening this boundary.
- The server bounds requests (120/minute per session, including failures), concurrent requests (8), sockets (32), headers, body size (1 MiB) and request receipt time. Audit records contain only fixed events and registry-owned tool names, never tokens, arguments, results or exception messages. The optional audit sink replaces the default sanitized console records.

## Driver capability gate

`chatDriverCapabilities` feeds the catalogue's `canDrive` gate. Claude remains the only chat driver. Codex, Gemini and OpenCode are `consultation-only` capabilities until their native tool confinement is implemented and tested. This does not add a consultation launcher.

The common enforcer denies **every** non-Claude native identity, including shell/edit/subagent/plugin aliases and names impersonating `mcp__genio__*`, even under YOLO. A future adapter must prove that native tools and global plugins cannot bypass the enforcer before enabling its driver capability. Merely installing this MCP server is insufficient. Never copy launch settings from `harness.ts`: those are worker settings, not chat settings.

No provider switch, transcript transfer, automatic paid fallback, new model selection or achievement is introduced in this prerequisite. The next driver owns provider sessions, bounded handoff and AFK inheritance.

## Verification

`tests/chat-tool-bridge.test.ts` exercises real loopback HTTP and the shipped stdio process, authentication, token rotation, scope forgery, Bot denial, merge and placement guards, SDK result parity, approval modes, native-tool denial, rate/body limits and chat shutdown. Existing SDK tool and policy tests run unchanged.
