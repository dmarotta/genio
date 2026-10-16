# Explicit unit restarts and capacity

The chat `control` tool accepts `player_words` for a player-requested restart.
This reaches the same `manual=true` service path as Squad's Respawn button.
For a unit held after its automatic retry, the words must quote the player's own
chat message saying to resume or respawn it (`src/main/player-words.ts` checks
this); without them, the one-automatic-retry limit still applies. A successful
manual restart begins a new retry episode; a failed manual attempt preserves the
existing retry history. Bot cannot claim this authority. This grants no merge,
discard, account, spending or quota override.

Previously, the tool omitted manual authority even for an explicitly requested
restart. Separately, concurrency counts treated exited/detached task records as
running even when they had no terminal. Recalling a unit therefore did not free
capacity, which could prevent deploying the fix needed to recover those units.

Capacity now counts real live unfinished units plus launches in progress. It
retains the existing release of completed/handed-over work. An absent-terminal
restart reserves a new slot and observes global/project caps. Replacing a currently
live unit reuses its slot; it does not count as another unit on a warm plan. The
replacement stays in `spawning` while its old terminal exits. Lifecycle actions
for the same task cannot run concurrently.

Restart still resumes the existing mission/copy/branch. Preparation, recall and
launch errors return an operation failure, preserve uncommitted work and release
the launch reservation. A failure before recall leaves the live process intact;
a failed replacement leaves a recoverable task instead of a phantom spawning
slot. No cleanup, branch removal or force operation is part of this path.

The UI already passed manual authority; no extra UI permission control is needed.
The branch includes main's separate Codex correction that discovers the session
belonging to the unit's exact worktree instead of using an unrelated latest
session. The original live UI error could not be reproduced without restarting
other units, which was not authorized for this mission.

Regression tests exercise the actual IPC Respawn handler and chat tool against
the crew service, explicit retry after automatic exhaustion, failed preparation
and launch, concurrent requests, dirty-file preservation, absent-terminal
capacity, reserved launch accounting and a warm-plan replacement. They use fake
terminals; no existing units are restarted by these checks. Existing lifecycle
actions do not introduce a new player first-use event or achievement.
