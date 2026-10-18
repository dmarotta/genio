# Chat providers

`ChatDriver` defines start/send/interrupt/resume, capability information and normalized text, tool, usage and lifecycle events. `claude-chat-driver.ts` contains the previous SDK queue, parser, model controls and limit handling. `workspace.ts` retains the public compatibility exports. `ProviderChatSession` owns the queue above the drivers and freezes each turn's selected model/effort, including while a runtime starts asynchronously.

The picker stores Claude IDs as before and Codex selections as `codex:OpenAI:<model>`. Catalogue discovery checks ChatGPT authentication and native-capability confinement before offering Codex rows. Hidden models are excluded. Gemini and OpenCode remain unavailable as drivers. Every Codex connection repeats those checks and verifies its returned model, provider, sandbox, approval policy and effort before sending a prompt. Unsupported effort returns to the selected model's advertised default; Ultra is excluded from chat.

## Codex authority

This adapter uses `codex app-server --listen stdio://`, independently of worker launch settings. It disables native shell/unified execution, multi-agent features, plugins, apps, hooks, browser/computer use, image generation and automatic tool installation. It requests read-only execution, no network, user review, empty environment/capability selections and no provider-model fallback. Custom OpenAI provider overrides and configurations it cannot safely isolate fail closed. API-key accounts are refused and API-key environment variables are removed from the child.

Every inherited MCP server is explicitly disabled, and the player's MCP servers from Settings are not offered: a Codex chat has only Genio's own tools, by design (the Claude chat gets them, [mcp-servers.md](mcp-servers.md)). Genio's registered schemas are supplied as app-server dynamic tools. Their calls go through the authenticated loopback bridge and its bound role/project scope; the driver never invokes service handlers directly. Native command/edit approval requests are declined, permission expansion grants nothing, and unknown tools/servers cannot impersonate bridge authority. Recognized boolean consent forms from the Genio bridge use the existing permission broker (Ask and Auto-shell ask; All can accept); handler-owned consent checks still apply. No credentials or bridge tokens enter prompts or process arguments.

Runtime APIs follow the [official app-server interface](https://learn.chatgpt.com/docs/app-server) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). The installed 0.162.1 runtime was checked with metadata-only probes and one low-effort `gpt-6-luna` turn: reply `OK`, no tools, 5,195 subscription tokens (1,792 cached input tokens, five output tokens). No inference is required by the test suite.

## Transcript and recovery

Provider/session/model tags accompany messages in the same visible log. A provider change waits for completion or cancellation, records a visible marker, and saves both providers' session IDs. Returning to a provider resumes its old session with a fresh bounded handoff. The handoff contains visible prose, attachment references, app-owned task/decision state and current permissions. It excludes native tool blocks and private reasoning. Opted-out projects are omitted; ambiguous unscoped history is also omitted when any project opted out.

Dynamic call IDs are deduplicated within each turn. Requests from old turns are rejected, including during thread resume. Interruption revokes the bridge before waiting for the runtime, persists partial output, and never requeues the cancelled turn. A lost turn/start reply has an unknown outcome and is not replayed. A login/limit/connection failure pauses work, preserves pending messages, exposes an Accounts action, and requires deliberate restart. Known unavailable routes reject new sends before clearing the draft. There is no automatic provider or API-credit fallback. Cancelled or failed service actions already in progress cannot be undone by disconnecting.

Lore chats ([Lore chats](design-chats.md)) run their own `ProviderChatSession` each, with their own model, effort, transcript and handoff; Claude gets the design prompt as a custom system prompt and Codex as its base instructions.

The AFK Bot inherits the main chat's provider/model. Both its Claude MCP connection and Codex dynamic tools use the bridge's read-only Bot registry. The stored `botModel` field and legacy `sessionConfig('bot')` helper remain compatible with old data/callers but do not select the active Bot runtime.

`usage.ts` records Codex chat token totals separately from cash, computes deltas with its existing session parser, deduplicates native logs for those chat IDs, and records account plan windows. Successful Codex turns contribute zero cash cost. The first provider switch and first successful Codex chat turn have feature-tagged achievements.

## Quiet event turns

An events batch, the session start and the Bot's turns are turns Genio starts itself. When nothing in them needs the player, the contract says to end the turn after its tool calls with no text at all. A turn with no final text is a normal success on both runtimes: the Claude Agent SDK ends it with a `result` of subtype `success` (and the CLI may write a synthetic `(no content)` or `No response requested.` message), and a Codex `turn/completed` with status `completed` need not carry any `agentMessage` item (checked against the 0.162.1 app-server JSON schema, where `items` is just a list). Neither driver retries it, and the batch is acknowledged like any successful turn.

What the model still produces is dropped before it can reach the player. `QuietTurn` (`quiet-turn.ts`, matcher in `shared/quiet-reply.ts`) sits between a session's driver and its transcript, for event turns only:

- a reply that is exactly the old no-op sentence (`All clear` or `All clear, <player>`, any case, quotes, emphasis or closing punctuation, with an optional `GG,`), empty, whitespace, or one of the CLI placeholders is never recorded, published, spoken or given a sound, and the stream is held back while it could still become that sentence, so no bubble flashes;
- a message that only starts like the sentence, or any other text however short ("Done."), streams and shows as written;
- a tool trace stays and the sentence beside it goes;
- a reply to the player's own message, a player message with the same words, and every Lore chat message are never touched (a Lore chat has no event turns).

The drivers also never emit a message with no text and no tool calls (a thinking-only block, an empty Codex `agentMessage`), so no turn leaves an empty bubble. The unread dot of the floating panel follows the last message, so a dropped reply cannot raise it. The Bot's log (`data/bot.jsonl`) skips them too, and its `escalate` tool sends no notification for the sentence. A log written by an older version is cleaned when it loads: sentence rows are hidden unless the row answers a player message directly or carries a tool trace or a reaction. A turn that says nothing leaves the activity line at idle, keeps the player's queued messages queued, and a queued message is read next.

## Release gates

Fake app-server tests cover initialize/resume, confinement failure, native aliases, consent approval/denial, tool errors, images, unsupported effort, logout, plan limits, cancelled startup races, lost start replies and duplicate mutations. Provider/session tests cover handoff bounds/privacy, intervening context, one transcript, active-turn switching and retained IDs. The service and real HTTP bridge tests exercise inherited Bot selection and denial of mutations. Existing Claude behavior tests remain unchanged.

For unit worktrees that inherit Genio's Git hooks, run the full suite with `GIT_CONFIG_COUNT=0` in the test process: the existing unit-hook test expects to control its own hooks. This does not change repository or global Git configuration.
