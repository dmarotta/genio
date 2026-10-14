# Player instance lifecycle (build 2)

The main process owns one player copy and editor per project window. They live outside the units' slot pool, leases, queue and cap. Build 3 adds the Play screen; this build supplies its service, IPC, frame/input MessagePort and Settings → Unity slots controls.

The final quest decisions supersede the Recon's earlier cap: the global player limit defaults to **2**, adjustable from 1–8. Idle time defaults to **10 minutes**, adjustable from 0–60. Lowering the cap leaves current editors alone. A start at the limit can close the oldest stopped, warm instance; it refuses while all instances are playing or busy. Units' slots are untouched.

## Play and Stop

`PlayerInstanceService.play()` mirrors a checkout's current files (including uncommitted and untracked files) or a git ref using `PlayerCopies`. It embeds `resources/unity/com.genio.play` **only in the marked player copy**, copying changed package bytes without churning timestamps on repeated Plays. The source checkout, unit worktrees and Toolbox are untouched.

For a warm editor, Play closes the previous stream, stops Play Mode, waits for the stopped state, calls `genio_sync_begin` (`DisallowAutoRefresh`), mirrors, reapplies the package, and calls `genio_sync_end` (`AllowAutoRefresh` and `Refresh`). The mirror's `beforeApply` hook closes the editor **before writing** source changes under Packages or ProjectSettings. A version change switches the Library stash while the editor is gone. A restart keeps the same copy; a regular quit schedules its deletion. Failed or cancelled hot mirrors attempt to resume auto-refresh.

Startup and reloads are polled for up to ten minutes. Status includes a bounded tail of `editor.log`. Blocking hidden dialogs include title, text, buttons and screenshot. Compilation refusal uses Unity's current [`EditorUtility.scriptCompilationFailed`](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/EditorUtility-scriptCompilationFailed.html) flag; historical Pipeline console entries do not prevent replay after a fix. The console API targets this copy only. Play waits for Play Mode to be running before reporting `playing`; streaming can then begin.

Stop disconnects streaming and stops Play Mode, leaving Unity warm. The main process checks deadlines every five seconds without requiring an open Play surface. Keep-alive restarts the idle period; zero minutes quits on Stop. Closing the Play port stops Play and starts the timer. Closing the project window quits its player editor. Stop, Quit, a newer Play and Genio exit cancel pending copies/startup so they cannot enter Play later.

## Shutdown and recovery

`<data>/player-copies/<key>/player.json` records the Genio owner PID and creation time, editor identity, root, source, version, state, deadline, observed process tree and peak working set. `instance.json` remains the copy manager's record. `player.json` survives copy deletion to retain the memory estimate. Global settings are in `player-copies/settings.json`.

Only the recorded PID **and creation time**, opening the exact `-projectPath`, can be closed. Pipeline quit and helper `WM_CLOSE` precede a 30-second wait and a forced stop of the verified tree. Every force kill checks the creation time on the OS handle used to kill. Children are checked by creation time; shared licence clients and processes naming another project are excluded. An unverified or surviving editor produces `close-stuck`, retains the copy and requires another Quit. Startup protects those copies from the deletion sweep.

The Windows helper retains the editor's original handle and watches a pinned Genio owner handle. Two minutes after the owner disappears it posts `WM_CLOSE`, waits 30 seconds, then stops verified descendants and the original editor if needed. Visible recovery uses the same watched helper. A player launch is refused if it cannot retain a watchdog; unit-slot fallback behavior is unchanged. The helper writes `exit.json` and, when used, `watchdog.json` in its launch directory.

Genio exit requests all player editors to quit and shares the existing four-second application shutdown budget. It never awaits copy deletion. The next startup closes orphan editors before `PlayerCopies.sweep()`. Deletion remains marker-guarded, asynchronous and retryable; unfinished or locked copies stay pending and can be revived for the next Play.

## Memory and streaming

Every start checks free physical RAM against the project's recorded peak (6 GiB initially) plus 2 GiB reserve. `startAnyway: true` explicitly overrides RAM refusal, while retaining the cap. The five-second monitor saves observed peaks. Settings displays player, unit-slot and running batch editor counts, working sets, and machine free/total RAM.

`playerInstanceStream` transfers one MessagePort to the owning project window. Unity credentials stay in main. The loopback WebSocket accepts one authenticated client, validates JPEG frames and complete input packets, and retains one latest frame. The MessagePort sends one frame per renderer credit. Port replacement cannot stop a successor session. Legacy input is view-only; Input System virtual keyboard/mouse/gamepad support and the corrected 30 fps cadence are restored from `4d08711^`. Audio and the Play screen are outside this build.

Unit tool guards forbid player roots, including copies placed on another volume. Raw copy IPC cannot mirror under a running player editor; it must use lifecycle Play.

## Verification

Run `npm run typecheck` and `npm test` with `GIT_CONFIG_*` variables removed (`Get-ChildItem Env:GIT_CONFIG* | Remove-Item` in PowerShell). Lifecycle tests use disposable repositories, fake process identities, fake Pipeline commands and a fake desktop API. They never launch Unity. The helper can be compiled without running it. Real importing, graphics, licensing and virtual-input release latency require a later manual check in a disposable copy; no real Unity editor was launched for this build.
