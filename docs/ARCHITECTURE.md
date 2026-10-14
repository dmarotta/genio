# Genio architecture

Genio is an Electron reimplementation of [companion](https://github.com/example-org/companion)
for game development. Companion is an "agent distro" that runs inside a terminal
harness and drives tmux; Genio turns the same operating model into a desktop app.
Vocabulary is gaming, not nautical: see [VOCABULARY.md](VOCABULARY.md).

- **One companion.** The Player talks only to Genio. Genio is a Claude Agent SDK
  session running in the main process with an in-process MCP toolbelt
  (`mcp__genio__*`). It never edits projects (projects) itself.
- **A visible Squad.** Each unit is an autonomous coding-agent CLI (Claude Code,
  Codex, Gemini, OpenCode, Cursor, Grok, Aider, custom) running in a real PTY
  (node-pty) inside its own git worktree. The GUI shows every terminal live
  (xterm.js); the Player can watch or type into any of them.
- **Scripts own mechanics, agents own judgment.** Deploying, worktrees, status
  parsing, overwatch, merge guards, despawn guards, Gauntlet steps and quest
  transitions are deterministic TypeScript. Genio decides what to do, writes
  briefs, and talks to the Player.
- **A restart is a non-event.** Everything lives under the Base directory
  (`~/.genio`, or `GENIO_HOME`). On restart, units whose process died are marked
  `detached` and can be respawned with conversation resume.
- **Unit capacity follows current work.** `shared/unit-capacity.ts` defines slot
  occupancy for dispatch and the UI: spawning tasks and live unfinished units
  count; ready, merged, done, failed and cleaned tasks release their slots even
  with an idle terminal. Respawn sets the task to working, including tasks with
  historical PRs. Dispatch owns each pending launch reservation until listing
  or release and publishes pending counts to the Hub and scoped project windows.

## Concept map (companion → Genio)

| companion | Genio module | UI |
|---|---|---|
| main agent session | `wksp.ts` Agent SDK session (main base) | COMMS |
| teammate in a tmux window | `crew.ts` task + `terminals.ts` PTY | SQUAD |
| ship / scout task | `kind: 'ship' \| 'scout'` | BUILD / RECON mission |
| treehouse worktree | `git worktree add` under `worktrees/<world>/<id>` | — |
| `state/<id>.status` verbs | same grammar, parsed by `status.ts` | timeline |
| `ag-send` steering inbox | `state/<id>.inbox/NNN.msg` + typed doorbell | PING |
| `fm-control` interrupt/exit/relaunch | `crew.control()` | INTERRUPT / RECALL / RESPAWN |
| `fm-watch` wakes | `supervisor.ts` (overwatch) + durable `wakes.ts` | KILLFEED |
| backlog + holds | `backlog.ts` | QUEST LOG |
| keyed decisions / captain holds | `decisions.ts` + quests waiting for the player | Pending answers / QUEST LOG |
| project registry, modes, +yolo | `projects.ts` | PROJECTS |
| no-mistakes pipeline | `gauntlet.ts` | GAUNTLET |
| `fm-pr-merge` / `fm-merge-local` / `fm-teardown` | `crew.merge()` / `crew.cleanup()` | MERGE / DESPAWN |
| `/bearings` | `statusreport.ts` | Agent status report (`status_report`) |
| `/ahoy` | recap + one-at-a-time choices | RECAP (/recap) |
| `/afk`, `/quiet`, away daemon, wedge alarm | `away.ts` + the Bot session | presence ONLINE / DND / AFK |
| `/stow` | `memory.ts` + save prompt | LORE (/save) |
| `/updatecompanion` | `update.ts` | SYSTEMS (/patch) |
| subsidiarys | `allies.ts`, `wksps/<name>/` bases | ALLIES |
| dispatch profiles | `settings.dispatchRules` | SYSTEMS |
| harness adapters | `settings.harnesses` | SYSTEMS |
| captain inbox | `inbox.ts` + token-protected local HTTP intake | MAIL |
| fleet ledger | `ledger.ts` | Replay log |
| process-event sources | `settings.eventSources` | SYSTEMS › Triggers |
| calm mode | `settings.calm` | Clean HUD |
| seatbelt / subagent guard | `canUseTool` policy in `wksp.ts` | permission prompt |
| voice relay | text-to-speech of Genio replies | toggle |

Game-dev additions: engine detection (Godot, Unity, Unreal, Bevy, LÖVE,
GameMaker, Defold, MonoGame, web), engine-aware command presets, a **PLAYTEST**
button that launches the game from any unit's worktree before merging, XP,
levels, achievements, sound effects and a HUD visual language.

## Process layout

```
src/shared/types.ts   data model (single source of truth)
src/shared/api.ts     renderer → main API (ipcRenderer.invoke('genio:<method>'))
src/main/services.ts  service interfaces
src/main/ctx.ts       composition root + factory contract
src/main/*.ts         one module per service
src/preload/index.ts  exposes window.genio = { api, on, onTerminalData }
src/renderer/src/     React UI
```

Main → renderer push events go through `bus.publish(GenioEvent)`; `event-router.ts`
forwards them on channel `genio:event`, building the fleet snapshot at most once
per event and only for events routed by it, and coalescing chat deltas per
message (flushed every 40 ms, ahead of any later event). Terminal output is
batched separately on `genio:term-data`. The Hub receives fleet events only:
chat, chat deltas, generation progress and terminal output go to the owning
project window alone. See [performance.md](performance.md).

## Status protocol (companion grammar)

Units append one line per actionable event to their status file:

```
<verb> [key=<slug>] [at=<epoch>]: <one short line>
```

Verbs: `working`, `needs-decision`, `blocked`, `paused` (optional `until <ISO>`),
`done`, `failed`, `note`, `resolved`, `player-held`. `needs-decision`/`blocked`
open a keyed choice (key `default` when absent); `resolved`/`player-held` with
the same key close it. Player-relevant: `done`, `needs-decision`, `blocked`,
`failed`, `paused`, plus legacy free text `PR ready|checks green|ready in branch|merged`.
A Build `done:` naming `PR <https url>` registers the PR.

## Overwatch (zero-token supervision)

`supervisor.ts` polls every `pollSeconds` (15s) per base:

- **signal** — player-relevant status lines, persisted as a batch on the next poll
  before advancing the status-file cursor; also surfaced when a turn ended (Claude Stop hook writes
  `state/<id>.turn-ended`) without a declared status.
- **stale** — lagging unit: no PTY output for `staleSeconds` (240s) outside a
  declared wait; `paused` resurfaces every `pausedResurfaceHours` or at its
  `until`; a dead process raises one `exited` event; an unread ping past
  `inboxGraceSeconds` re-rings up to `inboxRingMax`, then escalates.
- **check** — PR polls every `prPollMinutes` (merged / checks red / green), Mail,
  triggers, ally reports, Gauntlet results.
- **tick** (heartbeat) — base and max set by the Usage mode (Save 30/120,
  Balanced 15/120, Max 10/120 min), doubling per quiet streak; surfaces only with
  something to act on. Routine-only event batches wait the mode's batching window
  (10 / 5 / 1 min) before Genio gets a turn; anything urgent is delivered at once.

Actionable events go to the durable queue (`state/wakes.jsonl`). Every poll retries
delivery of pending events, including after restart or while chat was unavailable.
Genio gets one turn per bounded drain; per-event acknowledgements persist immediately,
and successful completion acknowledges only the delivered batch. Events arriving
during a turn remain pending for a later batch. A crash re-presents unfinished events.
Completed local branches in `ready` release concurrency slots even with an idle PTY.

Presence: in **DND** routine events go to a separate *Bot* session instead of
Comms; in **AFK** everything goes to the Bot, player-relevant outcomes are
captured to the away log, pushed to notifiers (desktop / webhook) and replayed
as a "welcome back" brief. Unseen AFK escalations older than `alarmMinutes`
fire the alarm.

## Delivery modes and merge authority

- **Hardcore** (`no-mistakes`): the unit commits and declares `done:`; Genio runs
  the **Gauntlet**: rebase check → project lint/build/test commands → AI review of
  the diff against the Player's intent → findings go back to the unit (up to
  `validationMaxRounds`) → push → PR (gh) → CI wait. Ask-user findings become
  Your Move choices.
- **Standard** (`direct-PR`): the unit pushes and opens a non-draft PR, then
  `done: PR <url>`.
- **Offline** (`local-only`): the unit leaves a clean fast-forward branch:
  `done: ready in branch <b>`.
- **Auto-loot** (`yolo`, per project, granted by the Player) lets Genio merge
  green, in-scope work itself. Never merge red, pending or draft work.
  Destructive things always escalate.

Despawn refuses unlanded work: uncommitted changes, or commits that are not
reachable from any remote-tracking branch, not in base, and not in a merged PR.
Forcing requires the Player's explicit word.

## Base layout

See `src/main/home.ts`.

## Project chat shell

The Hub opens one window per project. Comms and Inventory share the window's
project wksp, with per-chat controls, queued-message editing, image attachments,
and in-memory drafts. There are no chat tabs, splits or saved dock layouts.
Both chat providers run from the project folder and use scoped tool sessions.
Project windows and tool sessions include only records belonging to their project.
Before services load, the versioned project-data migration transfers registered
projects' units, quests and decisions from main or multi-project bases to their
single-project bases. Existing project bases and chat sessions are reused;
retired bases remain archived. IDs, quest dependencies, holds, player answers,
status cursors and unit session IDs survive. Unassigned records and records for
unregistered projects stay in their original bases. Quest mirrors are regenerated.

The migration records original file contents and complete replacements in
`state/project-data-migration-v1.json` before changing authoritative files.
Interrupted writes replay from this checkpoint before startup can proceed;
completed migrations never overwrite subsequent work. Invalid JSON or destination
ID collisions stop startup with the original data intact. Linked task wakes move
to project queues with new sequence numbers and preserved acknowledgements; source
events retain their sequence history and are acknowledged as transferred.

Legacy unit artifacts and worktrees keep their absolute paths. A migrated task's
`storageRoot` lets its project crew read and write the original status log, ping
inbox, reports, hooks and turn markers, so existing briefs and resumed CLI sessions
remain valid. New units use their project base's storage. Global settings,
credentials, progression, profiles, squad memory and archived transcripts remain intact.

The old main chat is read-only. Opening the `genio` project imports its compacted
transcript and image files once into that project's base without changing the
source log or adopting the old cross-project provider session. Existing project
messages win on duplicate IDs. Imported history supplies a bounded handoff on a
new provider session; existing project provider sessions retain normal resume.
Project agents and their Bot cannot wake while their project is closed. The
main supervisor observes any units for unregistered projects and forwards their
task wakes if the owning project is reopened. A close cancellation keeps units
running; confirmation stops that project's terminals and preserves its worktrees.

The standalone Your Move page has been removed. Pending choices appear in a
non-modal answer panel beside the current screen; the title-bar count and desktop
notifications reveal it without navigating away. Ready merges remain in Squad; completed units leave the active roster for the Quest log's Done
column; quests waiting for the player stay in its Queued column. Existing `move` notification targets reveal the answer panel.


Choices retain their project and conversation ownership while a project is closed.
Project windows show and answer only their own choices; the Hub provides waiting
counts across projects and access to the fleet's answer history. Pending answers
include Answered and Deferred filters, with Resume for deferred choices. Desktop
notification clicks open or focus the owning project and reveal the exact choice,
including its history if it has since been answered or deferred. Answer resolution
claims the current record synchronously before side effects, so simultaneous
answers relay and award once, and write an answer receipt in the owning chat.
Returning from AFK or DND summarizes the current number of waiting choices without
replaying each decision question.
