# Genio vocabulary

Genio speaks gamer, not sailor. No "captain", no nautical flavour anywhere:
UI, agent persona, briefs, docs, or identifiers. Companion terms appear only in
code comments that cite the original design.

| companion term | Genio term | Notes |
|---|---|---|
| captain (the user) | **Player** | Genio addresses the player by their **gamertag** (setting, default `Player`) |
| main agent | **Genio** | the AI companion that leads the squad |
| crew | **Squad** | |
| teammate / worker | **unit** | an agent CLI in its own terminal |
| home (`AG_HOME`) | **Base** | `~/.genio` |
| subsidiary | **Ally** | an allied Genio with its own base and a charter |
| spawn | **Deploy** | |
| relaunch | **Respawn** | resumes the unit's conversation |
| exit | **Recall** | |
| interrupt | **Interrupt** | |
| teardown / cleanup | **Despawn** | refuses unlanded work |
| steer (`ag-send`) | **Ping** | durable inbox + doorbell |
| backlog | **Quest Log** | items are **quests** |
| ship task | **Build** mission | produces a change |
| scout task | **Recon** mission | produces a report |
| promote scout | **Upgrade to Build** | |
| delivery mode `no-mistakes` | **Hardcore** | full Gauntlet validation, then PR |
| delivery mode `direct-PR` | **Standard** | unit pushes and opens a PR |
| delivery mode `local-only` | **Offline** | clean local branch, fast-forward merge |
| `no-mistakes-prod-only` | **Hardcore (prod)** | product work Hardcore, internal tooling Standard |
| `+yolo` | **Auto-loot** | Genio merges green, in-scope work itself |
| no-mistakes pipeline | **Gauntlet** | |
| captain decision / hold | **Your Move** | open choices waiting on the player |
| `/ahoy` | **/recap** | "previously on…" + one-at-a-time choices |
| `/bearings` | **/status** | Status Screen, four sections below |
| Captain's Call | **Your Move** | |
| Recently Landed | **Loot** | |
| Underway | **In Progress** | |
| Charted Next | **Up Next** | |
| `/afk` | **/afk** | presence AFK: the **Bot** plays for you |
| `/quiet` | **/dnd** | presence DND: routine pings handled off-screen |
| active | **Online** | |
| away supervisor daemon | **Bot** | |
| `/stow` | **/save** | curate memory (save game) |
| `/updatecompanion` | **/patch** | self-update |
| `captain.md` | `player.md` | **Player Profile** |
| `captain-shared.md` | `player-shared.md` | inherited by allies |
| `learnings.md` | `lore.md` | **Lore** |
| wakes / watcher | **events** / **overwatch** | event feed = **Killfeed** |
| stale worker | **lagging** / **frozen** | |
| heartbeat | **tick** | |
| fleet ledger | **Replay log** | |
| captain inbox | **Mail** | |
| calm mode | **Clean HUD** | |
| fleet view | **Squad view** | |
| projects | **Worlds** | the player's games/repos |
| bridge (chat) | **Comms** | |
| wedge alarm | **Alarm** | |
| "Captain, shipshape." no-op | **"All clear."** | |

Seasoning: light gamer slang (`GG`, `on it`, `queued`, `loot secured`, `respawning`)
is allowed when it fits, never obscures technical content, and is dropped
entirely for bad news or failures.
