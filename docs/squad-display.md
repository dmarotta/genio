# Squad display

Squad rows, cards and details show WORKING, READY TO MERGE or DONE. A finished
unit's card and page badge name how it ended instead (FAILED, MERGED, EXITED
ABNORMALLY or DONE, `squadBadge`), so a failed unit never reads as a red DONE;
their clock stops when the unit is ready or finished ("took 54 min"). The unit
page also says when the agent is simply not running: NOT RUNNING (detached),
RECALLED, STOPPED (a clean exit without a final status) or WAITING (paused).
Internal lifecycle states and capacity rules are unchanged. Completed units
leave the Squad rail and page immediately (`squadActive`); their record is the
Quest log's Done column. Neither the rail nor the page shows a unit count.

## Squad rail and page

A rail row is the unit's title, its kind and its state (with the yellow "needs
you" mark when it waits on the player); a click opens its page. There is no
project, plan step, clock, model thumbnail or tooltip, and no list of finished
units. With no unit deployed the rail says "No units deployed." and the Squad
page the same line under its Deploy button.

A Squad card shows the kind, the title, the state chip ("needs you" and "paused
by your dislike" when they apply), the live terminal (a Modeller's latest
render) and Open. Its footer shows the unit's last words only when it needs the
player or is stuck (question, blocked, failed, waiting, stopped;
`statusWorthShowing`). No project, tool, model, category, clock, PR link or
rating: those live on the unit page. A card whose agent is not running reads
"No signal" (or "Despawned"); Respawn is on the unit page.

## Unit page

The agent terminal stays the main area (watched until the player clicks into
it). Every unit kind (Build, Recon, Modeller, Generator) has the same header:
the back link, the kind and state chips, the clock and a "details" popover with
the branch to base, the model, the effort and the landed commit when there is
one (no project, category, delivery, respawn count, loadout or Auto-loot), then
the title. There is no plan chip, "needs you" chip, "ready since" time or merge
approval line in the header. There is no status subtitle under the title: the
unit's words are in the Timeline, an open question shows inline, and only a
stopped unit says why ("Stopped: …") beside its Respawn. Beside More sits one
primary action, by state (`primaryAction` in `src/shared/unit-page.ts`):

| State | Primary |
|---|---|
| working, spawning, validating, lagging, waiting | none: the ping box below steers |
| needs-decision, blocked (or any open choice) | the open question inline, with answer buttons |
| ready, Offline | Merge into main |
| ready, PR | Merge PR #n (off until checks are green) and Open PR |
| failed, exited, detached | Respawn, with the stop reason in words |
| Recon done | Build from this report (Despawn stays under More) |
| merged, despawned | none |

A Modeller offers the same: it exports, places and commits its model when it
judges it done, reports ready, and merges like any Build (Auto-loot or the
player's approval). So does a Generator, with no Accept step either.

More holds Interrupt (working only), Recall (live only), Open folder and
Despawn (red), labels only; Respawn is the primary action of a stopped unit, and
on narrow widths Play joins the menu with its reason when it is off.
Despawn asks one line with Cancel and one button (`despawnConfirm` in
`src/shared/unit-actions.ts`): "Discard this unit and its unmerged work?" with
Discard, or "Despawn this unit?" with Despawn once it is merged (an open PR adds
that it stays open). The click does it at once, unlanded work included; there
is no second dialog and nothing to type.
There is no shell button: the player's own shell is the project window's
terminal pane (docs/terminal-pane.md), which can run in a unit's copy. There is
no manual Gauntlet button. 👍/👎 shows on finished units only, on their page;
the Merge confirm is one line (what goes where) with Cancel and Merge. Recall's
confirm says the copy stays and reopening the project respawns it.

Side tabs: Changes (lines added and removed, the uncommitted count, the changed
and uncommitted files with their line counts, before and after pictures of
images and models, and the test status: PR checks or the unit's own reported
words; no file or commit counts, no commit log, no sizes), Timeline (status
lines and pings, newest first), Brief, Report (Recons) and Checks (Hardcore:
the Gauntlet's state, its steps and findings, and the log). No tab carries a
count or a dot. The Timeline labels a `note` line EVENT and a ping YOU, and
never shows a line's `[key=…]`. Notes under Genio's own bookkeeping keys
(`INTERNAL_STATUS_KEYS` in `shared/unit-page.ts`: `genio-blender-run`,
`genio-codex-image`, `genio-uthana-run`, `deps`, `claim`) stay in the status
log for stats, landing and the unit but are hidden from the Timeline, the page's
status line and the quest log's progress line, except a failed node_modules
setup, shown as a plain sentence. It is the same for every unit kind.

Brief is a short summary for the player, the same on every kind (`BriefTab`,
`src/shared/unit-brief.ts`): "Your ask" (the player's words recorded in the
brief, as written) and "What the unit will do" (the `summary` Genio passed to
deploy, quest_add or the plan step, stored on the quest and the unit; without
one, the first paragraph of the brief's Genio spec cut at a sentence end near
600 characters, else the ask). The title is not repeated: the page header shows
it. Genio's rules, skills and contract text never show there; the full brief
file stays on disk, unchanged, for the unit. The quest details dialog shows the
same summary.

Under 900 px one strip switches between the terminal and the side
tabs. The ping box ("Ping this unit") spans the page under them; to stop the
agent first, use More → Interrupt. A despawned unit has no ping box. A "needs
input" badge marks the terminal when the agent has printed nothing for the
lagging window (Settings: Call a unit lagging after) or the unit is lagging.

A Modeller (a Build deployed with the Modeller flag, or one that started a 3D model) leads with its live model instead
of the terminal, which becomes a side tab after Steps (a plain list, newest first:
each step's render, caption and triangles). There are no Revert or Branch
buttons and no branch names: the player steers in words through the ping box and
the unit runs the kernel's revert, branch and switch itself. Its Squad card
shows the latest step's render; Changes shows binaries before and after. The live view has one toggle, Wireframe.

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
caption ("next: …"); `lib.py` there, the unit's helpers that run before every step,
is never taken for a step. A step Blender runs shows "Step N · caption…" and its
seconds.

A Generator (a Build deployed or filed with the Generator flag: one or more
asset generation jobs, see docs/unit-generator.md) has no live view: its page
and card keep the terminal, like any Build. Only its color and its
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
