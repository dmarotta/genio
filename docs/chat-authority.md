# Chat authority and approval modes

Genio's chat (the project chat, the floating Genio panel and allies: the wksp runtime in `src/main/wksp.ts`) has full
authority over units and the project's git. It can deploy, relaunch, interrupt, exit, ping and despawn any unit,
discard unlanded work, merge any Build or PR (red, still running or draft too), commit, branch, rebase, edit files and
run state-changing commands in a project or a unit's copy. Coding is still preferably delegated to units: that is a
preference in the contract (`src/main/prompts.ts`), not a block.

The only thing that decides whether an action needs the player's OK is the chat's **approval mode**: the button under
the composer, also cycled with Shift+Tab. When an action needs it, the standard permission prompt shows one plain
line saying what will happen ("Discard unit u-3 ("Menu rework") and its unmerged work?") with **Deny** and
**Allow once**. The player's click is the authority. Chat text never is: tools no longer take `player_words` for these
actions, and a quote of the player's own message does not stand in for the click.

## The modes

| Mode | Read-only tools and commands | Shell commands (Bash, PowerShell, `run_command`) | Everything else that changes something |
|---|---|---|---|
| Ask | run | ask | ask |
| Auto-approve shell | run | run | ask |
| YOLO | run | run | run |

"Everything else" is the guarded class (`actionAsks` in `src/main/chat-tool-policy.ts`): discarding work, merging,
outward-facing steps (a GitHub repository, turning on Auto-loot), native edits and writes (`Write`, `Edit`,
`write_file`), subagents, and every action that used to need the player's quoted words. No mode had a rule for these
Genio actions before, so they take the conservative one: they ask unless the mode is YOLO. Genio's ordinary tools
(deploy, ping, quests, plans, reads) run in every mode, as before.

## What asks, tool by tool

| Tool | Asks (outside YOLO) when |
|---|---|
| `merge` | no Auto-loot, standing approval or click on its "Merge now?" choice covers it; always for a red PR, checks still running, a draft (marked ready first) or an Offline branch not reported ready, and the line says which |
| `despawn` | `force` and something would be lost |
| `control` | relaunching a unit held after its automatic relaunch |
| `deploy` | `force`: a quest started before what it waits on lands |
| `merge`, `control`, `deploy`, `quest_update`, `quest_answer`, `quest_release` | going ahead with work the player's dislike paused while its choice is open |
| `world_create` | `create_remote` |
| `world_update` | turning Auto-loot on |
| `world_remove` | `delete_clone` or `force` (past live units, open quests and unpushed work) |
| `world_engine_root`, `art_bible` (write), `settings_update`, `play_control` | always |
| `write_file` | always |
| `run_command` | a command that is not read-only, in Ask only |

`run_command` and `write_file` act in a project's main copy (`world`) or a unit's copy (`task`). They give the Codex
chat, which has no native shell or edits, the same reach as the Claude chat's native tools.

## Records

Every clearance and every Deny is a ledger line (`approval.action`, with the tool, the line and `via: prompt` or
`via: mode`). A merge records what cleared it on the unit (`MergeApproval`): Auto-loot, a standing approval, the
choice click, the Merge button, `prompt` ("Merged by you (Allow once)") or `mode` ("Merged by Genio in YOLO"). A forced
despawn records `by: prompt` or `by: mode`. A merge choice the chat closed with `choice_resolve` is not a click and
clears nothing; the merge then asks.

## What the approval mode never changes

- **Spend.** Paid generation (FAL, Uthana, the Sound Studio's FAL steps), a unit's budget at deploy and a unit's spend
  question are approved only by the player's own click or their verified words and Genio's signed grant, never by the
  mode. Monthly caps stay hard stops. `player_words` remains on these tools only (`src/main/player-words.ts`).
- **Credentials.** The player's logins and keys (`~/.codex`, `~/.claude`, auth files, `.env`, SSH keys, Genio's
  secrets) and the spend records (grants, the signing key, `.genio/fal/` budgets) are closed to every chat tool in
  every mode, and login commands are refused (`touchesProtected`). A click does not open them. The check reads the
  tool's input, so it is best effort against a script that builds a path at run time.
- **Units.** Units keep their own rules: isolated copies, spend grants, no pushes or merges of the main branch.
- **The Bot.** The away-mode Bot never asks: it merges only green work under Auto-loot, never discards, never
  relaunches a held unit and only reads otherwise.
- **Premium launches.** Fable and Astra unit launches keep their own Allow once / Deny prompt in every mode
  (`src/main/crew.ts`).
- **Integrity checks.** A PR with merge conflicts, a project's own folder as a unit copy, claim conflicts between
  Modellers and Generators and the capacity and quota limits still refuse: they are facts, not consent.

## Tests

`tests/chat-authority.test.ts` runs each formerly guarded action in each mode (runs or asks as above, a Deny leaves
everything untouched, the player's own words do not answer the prompt), the merge and despawn records, red PRs, the
Bot's limits, spend in YOLO and the closed credential paths. `tests/wksp-policy.test.ts` covers the native tools.
