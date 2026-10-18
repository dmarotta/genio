# Genio vocabulary

Genio speaks gamer, not sailor. No "captain", no nautical flavour anywhere:
UI, agent persona, briefs, docs, or identifiers.

| Term | Meaning |
|---|---|
| **Player** | the user; Genio addresses them by their **gamertag** (setting, default `Player`) |
| **Genio** | the AI companion that leads the squad |
| **Squad** | all the units |
| **unit** | an agent CLI in its own terminal |
| **Base** | `~/.genio` |
| **Ally** | an allied Genio with its own base and a charter |
| **Deploy** | start a unit |
| **Respawn** | relaunch a unit, resuming its conversation |
| **Recall** | exit a unit |
| **Interrupt** | stop a unit's current turn |
| **Despawn** | tear down a unit; refuses unlanded work |
| **Ping** | steer a unit: durable inbox + doorbell |
| **Quest Log** | the backlog; items are **quests** |
| **Build** mission | produces a change |
| **Recon** mission | produces a report |
| **Generator** | a Build running asset generation jobs (magenta) |
| **Upgrade to Build** | promote a Recon |
| **Hardcore** | full Gauntlet validation, then PR |
| **Standard** | unit pushes and opens a PR |
| **Offline** | clean local branch, fast-forward merge |
| **Hardcore (prod)** | product work Hardcore, internal tooling Standard |
| **Auto-loot** | Genio merges green, in-scope work itself |
| **Gauntlet** | the validation pipeline |
| **Your Move** | open choices waiting on the player |
| **/recap** | "previously on…" + one-at-a-time choices |
| **status_report** | Agent report, four sections below; the UI `/status` opens Character Sheet |
| **Loot** | recently landed work |
| **In Progress** | work underway |
| **Up Next** | work charted next |
| **/afk** | the **Bot** plays for you |
| **/dnd** | routine pings are handled off-screen |
| **Online** | active |
| **Bot** | the away supervisor |
| **/save** | curate memory (save game) |
| **/patch** | self-update |
| **Player Profile** | `player.md`; `player-shared.md` is inherited by allies |
| **Squad memory** | `lore.md` (Settings → Memory) |
| **events** / **overwatch** | internal event records; no standalone feed |
| **lagging** / **frozen** | a stale unit |
| **tick** | heartbeat |
| **Replay log** | the fleet ledger |
| **Mail** | notes the player sends from elsewhere |
| **Clean chat** | calm mode |
| **Squad view** | fleet view |
| **Projects** | the player's games/repos |
| **Comms** | the chat with Genio |
| **Alarm** | wedge alarm |

An event turn that needs no one ends with no text: never shown, never "All clear".
## Settings: plain names, game term as a hint

The rest of the app speaks the vocabulary above. Settings is the exception: its
pages and fields use plain names only, e.g. **Merge finished work automatically**
(not Auto-loot), **Clean chat**, **Agent tools**, **Installed tools**, **Updates**.
Text elsewhere that sends the player to a setting names its path through
`settingsPath()` (`src/shared/settings-pages.ts`), which keeps the game term as a
hint, e.g. "Settings → Advanced → Model routing (Dispatch)"; a test checks every
such path in the source. Settings search keeps the old names and game terms as
synonyms.

Seasoning: light gamer slang (`GG`, `on it`, `queued`, `loot secured`, `respawning`)
is allowed when it fits, never obscures technical content, and is dropped
entirely for bad news or failures.
