# Player instance lifecycle (build 2)

The main process owns one player copy and editor per project window. They live outside the units' slot pool, leases, queue and cap. This is the service behind the [Play screen](play.md): IPC, frame/input MessagePort and the Settings → Unity & Play controls.

The final quest decisions supersede the Recon's earlier cap: the global player limit defaults to **2**, adjustable from 1–8. Idle time defaults to **10 minutes**, adjustable from 0–60. Lowering the cap leaves current editors alone. A start at the limit can close the oldest stopped, warm instance; it refuses while all instances are playing or busy. Units' slots are untouched.

## Play and Stop

`PlayerInstanceService.play()` mirrors a checkout's current files (including uncommitted and untracked files) or a git ref using `PlayerCopies`. It embeds `resources/unity/com.genio.play` **only in the marked player copy**, copying changed package bytes without churning timestamps on repeated Plays. The source checkout, unit worktrees and Toolbox are untouched.

For a warm editor, Play closes the previous stream, stops Play Mode, waits for the stopped state, calls `genio_sync_begin` (`DisallowAutoRefresh`), mirrors, reapplies the package, and calls `genio_sync_end` (`AllowAutoRefresh` and `Refresh`). The mirror's `beforeApply` hook closes the editor **before writing** source changes under Packages or ProjectSettings. A version change switches the Library stash while the editor is gone. A restart keeps the same copy; a regular quit schedules its deletion. Failed or cancelled hot mirrors attempt to resume auto-refresh.

Startup and reloads are polled for up to ten minutes. Status includes a bounded tail of `editor.log`. Blocking hidden dialogs include title, text, buttons and screenshot. Compilation refusal uses Unity's current [`EditorUtility.scriptCompilationFailed`](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/EditorUtility-scriptCompilationFailed.html) flag; historical Pipeline console entries do not prevent replay after a fix. The console API targets this copy only. Play waits for Play Mode to be running before reporting `playing`; streaming can then begin.

Stop disconnects streaming and stops Play Mode, leaving Unity warm. The main process checks deadlines every five seconds without requiring an open Play surface. Keep-alive restarts the idle period; zero minutes quits on Stop. Closing the Play port stops Play and starts the timer. Closing the project window quits its player editor. Stop, Quit, a newer Play and Genio exit cancel pending copies/startup so they cannot enter Play later.

## Separate controls

The minimal Play screen drives one control per action. `startUnity()` copies and starts Unity, then stops in `ready` (edit mode, the only state with an idle deadline); it does nothing while the editor runs. `enterPlay()` (and the older `play()`) starts Unity first when it is off, in the same call, then syncs and enters Play. `exitPlay()` (and `stop()`) passes `exiting-play` back to `ready`. `stopUnity()` exits Play, quits the editor and keeps the copy until its idle deadline through `editorGone(…, { manual: true })`, so the next start skips the copy. Idle timeout, Genio exit, crash cleanup and `quit()` still delete the copy. A cold start checks the cap and memory **before** copying, so a refusal copies nothing.

`pause()` reads Unity's `playMode` before sending the toggling `editor_pause`. `step()` pauses first, then sends `genio_step`. On a step, the stream captures that frame and waits for its GPU readback inside it, so the frame is not one step late. The poll picks up a pause or stop made in Unity itself. `scenes()` lists build-settings scenes first, then the other `Assets/**/*.unity`. It asks Pipeline while the editor answers and reads the files otherwise. `setScene()` remembers the scene while Unity is off, opens it when ready, and re-plays into it while playing. `resize()` swaps Unity's stream session behind the same MessagePort, so a new resolution does not exit Play. Stream and input accept `paused`. `controls(state)` in `src/shared/play-controls.ts` maps every state to the toolbar's labels, enabled flags and actions.

## Shutdown and recovery

`<data>/player-copies/<key>/player.json` records the Genio owner PID and creation time, editor identity, root, source, version, state, deadline, observed process tree and peak working set. `instance.json` remains the copy manager's record. `player.json` survives copy deletion to retain the memory estimate. Global settings are in `player-copies/settings.json`.

Only the recorded PID **and creation time**, opening the exact `-projectPath`, can be closed. Pipeline quit and helper `WM_CLOSE` precede a 30-second wait and a forced stop of the verified tree. Every force kill checks the creation time on the OS handle used to kill. Children are checked by creation time; shared licence clients and processes naming another project are excluded. An unverified or surviving editor produces `close-stuck`, retains the copy and requires another Quit. Startup protects those copies from the deletion sweep.

The Windows helper retains the editor's original handle and watches a pinned Genio owner handle. Two minutes after the owner disappears it posts `WM_CLOSE`, waits 30 seconds, then stops verified descendants and the original editor if needed. Visible recovery uses the same watched helper. A player launch is refused if it cannot retain a watchdog; unit-slot fallback behavior is unchanged. The helper writes `exit.json` and, when used, `watchdog.json` in its launch directory.

Genio exit requests all player editors to quit and shares the existing four-second application shutdown budget. It never awaits copy deletion. The next startup closes orphan editors before `PlayerCopies.sweep()`. Deletion remains marker-guarded, asynchronous and retryable; unfinished or locked copies stay pending and can be revived for the next Play.

## Memory and streaming

A cold start is admitted before the copy: the editor cap, then available RAM (`os.freemem()`, standby included) against the project's learned steady working set (6 GiB on the first run) plus a 1 GiB reserve. When short, Genio first closes its own warm player instances and idle unit-slot editors, never the player's editors. Still short, Play stops at `low-memory` with the three biggest consumers by plain name; the Unity button becomes Start anyway (`startAnyway: true`) and Cancel (Stop) dismisses it. Only commit headroom below the estimate blocks even Start anyway. A refused copy gets the idle deadline. The five-second monitor records the steady working set while playing or stopped warm (each session replaces the last) and the import peak separately. Settings displays player, unit-slot and running batch editor counts, working sets, and machine available/total RAM.

`playerInstanceStream` transfers one MessagePort to the owning project window. Unity credentials stay in main. The loopback WebSocket accepts one authenticated client, validates JPEG frames and complete input packets, and retains one latest frame. The MessagePort sends one frame per renderer credit. Port replacement cannot stop a successor session. Legacy input is view-only; Input System virtual keyboard/mouse/gamepad support and the corrected 30 fps cadence are restored from `4d08711^`. Audio is not streamed yet.

Unit tool guards forbid player roots, including copies placed on another volume. Raw copy IPC cannot mirror under a running player editor; it must use lifecycle Play.

## A source that vanishes

Genio removes a unit's worktree and branch when it despawns the unit after a merge. That can happen at any moment of a Play, so the mirror is staged. `applyMirror` first reads every changed file into `.mirror-staging` beside the manifest, and that is the only step that reads the source. Only then does it remove and rename files inside the copy, which it never stops halfway. If the source vanishes while it is being read (a missing folder, `.git` link or worktree metadata, or a deleted branch, all detected by `sourceMissing`), the sync fails with `code: 'SOURCE_GONE'` and the copy keeps exactly what the previous sync left. Files already staged are reused by the next sync of the same content.

- **Copying or syncing:** `PlayerInstanceService` does not throw. A warm editor ends its hot sync and stays `ready`; a cold start ends `idle` with no Unity started. The status carries `sourceGone: { when: 'loading' }`, and the Play screen shows "This unit was merged and removed while loading. Its work is in main now." with **Play main instead**.
- **Unity starting, entering Play, playing:** the copy is independent, so everything goes on. `sourceGone: { when: 'running' }` adds a dim note to the status line. It is set by crew cleanup (`sourceRemoved`), and the five-second poll also checks the source.
- **The next Play, Restart or scene re-play:** a source that is already gone plays the main checkout, with `sourceGone: { when: 'fallback' }`.
- **Cleanup:** while a copy reads a checkout it holds a lease (`src/main/source-leases.ts`). Before removing a worktree, `crew.cleanup` waits up to 8 s for the read to finish. After that it stops the read (marked gone) and waits up to 10 s more, then removes the worktree anyway, so cleanup never hangs.
- **Picker:** it lists only checkouts with a `.git`. It reloads when the project's units change state and drops vanished checkouts (`playerSourceAvailable`, checked every 10 s). A request, pick or choice for a vanished source shows an inline message.
- **Unexpected errors** in the background poll are logged. The instance moves to `error` with the message and a **Retry**, except during Play, where only the message is set.

The unit page's **Play** (beside the primary action, under More at 720 px and below) appears for Builds in Unity projects. It is disabled once the worktree is gone. It opens Play with `unit:<id>` preselected as a one-shot request (`lib/play-nav.ts`, handed to the project's window through localStorage when needed) and does not start Unity.

## Verification

Run `npm run typecheck` and `npm test` with `GIT_CONFIG_*` variables removed (`Get-ChildItem Env:GIT_CONFIG* | Remove-Item` in PowerShell). Lifecycle tests use disposable repositories, fake process identities, fake Pipeline commands and a fake desktop API. They never launch Unity. The helper can be compiled without running it. Real importing, graphics, licensing and virtual-input release latency require a later manual check in a disposable copy; no real Unity editor was launched for this build.
