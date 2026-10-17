# Squad display

Squad rows, cards and details show WORKING, READY TO MERGE or DONE. A finished
unit's card and page badge name how it ended instead (FAILED, MERGED, EXITED
ABNORMALLY or DONE, `squadBadge`), so a failed unit never reads as a red DONE;
their clock stops when the unit is ready or finished ("took 54 min"). The unit
page also says when the agent is simply not running: NOT RUNNING (detached),
RECALLED, STOPPED (a clean exit without a final status) or WAITING (paused).
Internal lifecycle states and capacity rules are unchanged. Completed units
leave both active rosters immediately; header counts include working and ready
units only.

## Unit page

The agent terminal stays the main area (watched until the player clicks into
it). Every unit kind (Build, Recon, Modeller, Generator) has the same header:
the back link, the kind and state chips, the clock and an ⓘ details popover with
the facts (project, branch to base, model, effort, category, delivery ("Merge
into main" for Offline), and the landed commit or respawn count when there is
one; the loadout reasons and Auto-loot are not shown there), then the title.
There is no status subtitle under the title: the unit's words are in the
Timeline, an open question shows inline, and only a stopped unit says why
("Stopped: …") beside its Respawn. A Squad card's footer and an in-flight quest
ticket show the unit's last words only when it needs the player or is stuck
(question, blocked, failed, waiting, stopped; `statusWorthShowing`); otherwise
the card says when the unit last printed and the ticket shows only its state.
Beside More sits one primary action, by state
(`primaryAction` in `src/shared/unit-page.ts`):

| State | Primary |
|---|---|
| working, spawning, validating, lagging, waiting | none: the ping box below steers |
| needs-decision, blocked (or any open choice) | the open question inline, with answer buttons |
| ready, Offline | Merge into main |
| ready, PR | Merge PR #n (off until checks are green) and Open PR |
| failed, exited, detached | Respawn, with the stop reason in words |
| Recon done | Build from this report, and Archive (despawns the copy, keeps the report) |
| merged, despawned | none |

A Modeller offers the same: it exports, places and commits its model when it
judges it done, reports ready, and merges like any Build (Auto-loot or the
player's approval). So does a Generator, with no Accept step either.

More holds Interrupt (working only), Respawn, Recall (live only), Open folder
and Despawn (red), each with its one-line consequence (`UNIT_ACTION_HINT`).
There is no shell button: the player's own shell is the project window's
terminal pane (docs/terminal-pane.md), which can run in a unit's copy. There is
no manual Gauntlet button. 👍/👎 shows on finished units only; a ready unit is
rated in the Merge confirm.

Side tabs: Changes (diffstat, changed and uncommitted files, commits, and the
test status: the Gauntlet, PR checks, or the unit's own reported words, with no
explanatory notes under it),
Timeline (status lines and pings, newest first), Brief, Report (Recons) and
Checks (Hardcore). The Timeline labels a `note` line EVENT and a ping YOU, and
never shows a line's `[key=…]`. Notes under Genio's own bookkeeping keys
(`INTERNAL_STATUS_KEYS` in `shared/unit-page.ts`: `genio-blender-run`,
`genio-codex-image`, `genio-uthana-run`, `deps`, `claim`) stay in the status
log for stats, landing and the unit but are hidden from the Timeline, the page's
status line and the quest log's progress line, except a failed node_modules
setup, shown as a plain sentence. It is the same for every unit kind. Under 900 px one strip switches between the terminal and the
tabs. The ping box spans the page under them, with an "interrupt and send"
option while the agent runs. A "needs input" badge marks the terminal when the
agent has printed nothing for the lagging window (Settings: Call a unit lagging
after) or the unit is lagging.

A Modeller (a Build deployed with the Modeller flag, or one that started a 3D model) leads with its live model instead
of the terminal, which becomes a side tab after Steps (a plain list, newest first:
each step's render, caption, triangles and parts). There are no Revert or Branch
buttons and no branch names: the player steers in words through the ping box and
the unit runs the kernel's revert, branch and switch itself. Its Squad card and
rail row show the latest step's render; Changes shows binaries before and after.

The live view shows each step the moment Blender has exported its GLB: the
kernel publishes it then, and the snapshot, checks and review sheet follow
(a failed sheet leaves the step published, with a warning). Main watches the
unit's step data and step scripts while the page is open and pushes each change
(`modeller-live` event); the page's poll (1 s, 250 ms while a step runs) stays
as the fallback. The caption over the view is plain text, never a button or a
toast: one line in a soft pill centred near the bottom edge of the view (14.5 px,
shortened with an ellipsis in a narrow window, never wrapped). While a step runs
or the unit works between steps, an orange dot beside it breathes with a soft
ring (a still dot with reduced motion); it is gone once the unit is ready,
stopped or its step failed. While the unit works and no step runs, it says what the unit is doing:
before the first step, its latest status line and the time since it started;
between steps, the last step's caption with "working on the next step · N s";
as soon as the next step's script exists under `.genio/modeller/<model>/`, its
caption ("next: …"). A step Blender runs shows "Step N · caption…" and its
seconds.

A Generator (a Build deployed or filed with the Generator flag: one or more
asset generation jobs, see docs/unit-generator.md) has no live view: its page,
card and rail row keep the terminal, like any Build. Only its color and its
Generator chip (sparkles icon) tell it apart. It never becomes a Modeller.

Build work uses blue, Modeller work orange, Generator work magenta (`--magenta`);
Recon work uses purple. The kind chip (unit page header, Squad card, Quest log)
keeps the kind's color in every state: neon Build, orange Modeller, magenta
Generator, violet Recon. Open player decisions and blocked
units use yellow while retaining WORKING. Errors and abnormal exits use red.
READY TO MERGE and successful DONE outcomes use the same existing green. Per the
player's explicit color decision, there is no extra ready highlight or badge;
the label text is the difference.

Ready requires no running validation and no positive evidence of resumed work
after the ready signal (`src/shared/unit-activity.ts`): a new status line, a ping
delivered to the CLI, a new turn from the harness (Claude's UserPromptSubmit hook
writes `.turn-started`; a later Stop returns the unit to ready), a relaunch, or,
for a runtime without a turn marker, sustained new output past a one-minute
closing-summary grace. An idle surviving terminal and its own chrome (dialogs,
tips, status-bar repaints, usage and update notices) never count as work.
Overwatch persists the evidence as `resumedAt`, so the Squad label, the unit
clock, its color and the unit cap agree. Respawning/rebasing units whose lifecycle
returns to working show WORKING even when an old PR still exists. The ready signal
is persisted in the existing task record, independently of later bookkeeping.

Per the player's subsequent decision, the previous Killfeed panel and its
renderer-only activity state, wake hydration and feed formatting are removed.
Completed history belongs to the Quest log's Done column, owned by the separate
Quest log change. Underlying task records, status history, wakes and ledger data
remain available to their existing consumers. No process, branch or worktree is
removed by this display change.

Verification: exhaustive lifecycle mapping and signal/color tests, rendered
roster/event/count tests, source-timestamp delivery coverage, the existing squad
achievement coverage guard, and a dev renderer visual check. This is a
presentation revision of the existing squad feature, with no new achievement
trigger.
