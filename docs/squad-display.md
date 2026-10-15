# Squad display

Squad rows, cards and details show WORKING, READY TO MERGE or DONE. A finished
unit's card and page badge name how it ended instead (FAILED, MERGED, EXITED
ABNORMALLY or DONE, `squadBadge`), so a failed unit never reads as a red DONE;
their clock stops when the unit is ready or finished ("took 54 min"). Internal
lifecycle states and capacity rules are unchanged. Completed units leave both
active rosters immediately; header counts include working and ready units only.

Build work uses blue; Recon work uses purple. Open player decisions and blocked
units use yellow while retaining WORKING. Errors and abnormal exits use red.
READY TO MERGE and successful DONE outcomes use the same existing green. Per the
player's explicit color decision, there is no extra ready highlight or badge;
the label text is the difference.

Ready requires no running validation and no live terminal output after the ready
signal. Terminal output carries its source timestamp through the existing batched
IPC channel, so delivery after a ready event cannot falsely imply resumed work.
An idle surviving terminal is allowed. Respawning/rebasing units whose lifecycle
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
