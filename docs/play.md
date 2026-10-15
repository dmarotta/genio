# Play screen

Play (rail, Ctrl 0, or "Go to Play" in the command palette) appears only in a project window whose engine supports Unity slots (`supportsUnitySlots`). It drives the project's own player instance ([player-instance.md](player-instance.md)): one copy and one hidden Unity editor per project window, outside the units' slots.

- **Source**: the main checkout, your worktrees, units' worktrees by unit name, or a local branch played from its commits. Checkouts show their branch and uncommitted count; files are copied as they are on disk when you press Play. Genio's own slot and player copies are never offered. Refresh re-reads git.
- **Play / Stop / Restart Unity**: Play copies or syncs, starts Unity when needed, enters Play Mode and streams. Play on another source while Unity is warm re-syncs only what changed. Stop leaves Unity warm. Restart quits Unity and starts it again on the same source.
- **First copy**: when no copy exists, Play first shows the copy's size and a time range at the measured 47–73 MB/s and asks to confirm.
- **Status**: the lifecycle steps (copy or sync, start Unity, enter Play, playing, stopped warm, quit and delete), the source played, the last sync, live copy progress with sizes and time left, Unity's startup log tail, and any background deletion.
- **Idle countdown**: after Stop, "the instance is deleted in m:ss", with Keep N more min and Quit now. The idle time and the editor limit are in Settings › Unity & Play (they apply to all projects).
- **Problems**, each with one action: low memory (Start anyway), Unity version missing, editor limit reached (open the limit), compile errors (the console opens), crashed (Play again), a dialog blocking the hidden editor (its text, buttons and screenshot; Restart Unity or Open this instance visibly), and an editor that would not close (Close again).
- **Live game**: a 1280×720 canvas. Click it to send keyboard, mouse and gamepad through the Input System; Esc releases; Lock pointer and Full screen. Games that read legacy input are view-only, with a note. Leaving the screen while playing stops Play and starts the idle countdown.
- **Console drawer**: the instance's Unity console, polled while open and Unity runs.
- **Open this instance visibly** (footer): restarts the instance as a normal window for debugging.

The floating Genio panel receives the instance state, source, countdown, copy progress, blocking dialog and last console error as screen facts.

Achievements: Press Play (`play-first`), Motion Picture (`play-stream`, first live frame), Hands On (`play-input`, first held input), Big Screen (`play-fullscreen`) and Field Test (`play-unit`, Play a unit's worktree). The old screen's package, snapshot, slot, takeover, step and resolution trophies stay retired.

Tests and screenshots use a fake player backend; no Unity editor is launched (`tests/play-screen.test.ts`, `tests/player-sources.test.ts`).
