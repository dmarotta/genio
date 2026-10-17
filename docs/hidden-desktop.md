# Hidden-desktop slot editors

Every Play slot editor (a unit's `genio-unity play` session through `play.mjs`) starts through
`PlayPool.launchEditor`. On Windows it opens on a fresh hidden Win32 desktop: no splash, no editor
window, no focus theft. Unity on that desktop believes it is focused, so it is not throttled, and
Pipeline commands and `capture_game_view` work unchanged (recon b801). The player's own main
editor stays an ordinary window. The Gauntlet runs batch editors only and opens no slot editor.

## Why a compiled helper

Node and Electron have no API for `CreateDesktop` or `STARTUPINFO.lpDesktop`. PowerShell
`Add-Type` on every launch is slow (a C# compile per call) and antivirus-sensitive, and Genio must
not ship a prebuilt binary nobody can review. So the C# source,
`resources/unit-skills/genio/lib/hidden-desktop/GenioDesktop.cs`, is compiled once per source
hash with the `csc.exe` that ships with .NET Framework 4 on every Windows 10/11, into
`<data>/hidden-desktop/bin/<hash>/genio-desktop.exe` (a GUI-subsystem program, so it never
opens a console). The helper only runs Win32 primitives (`launch`, `windows`, `click`,
`screenshot`, `close`). Every decision lives in `lib/hidden-desktop.mjs`, which tests drive with a
fake desktop API.

## Launch and identity

`launch` creates `WinSta0\genio-slot<N>-<random>`, starts the editor there with the pool's usual
command line (`-automated -projectPath <slot>`), no inherited handles and the caller's
environment (the unit's own environment for unit sessions), prints the PID and the creation time
(microsecond FILETIME, the same value `listProcesses` reads from CIM), then stays until the editor
exits, writes `exit.json` and closes the desktop. The pool records `{ pid, created, desktop, dir }`
on the slot.

- **Close.** Pipeline quit first, as before. The polite fallback posts `WM_CLOSE` through the
  helper, because `taskkill` cannot reach windows on another desktop. While waiting, safe dialogs
  (such as "save changes?") are dismissed. The forced stop is unchanged: only the verified editor
  and its children (import workers), matched by PID and creation time. A recorded PID whose
  creation time no longer matches is never touched.
- **Process watch.** `unity-guards.ts` treats a pool editor recorded with a creation time as the
  pool's only when that exact process matches. The helper is not a Unity executable, so it is
  never an editor violation itself.

## Dialog watcher

The lease holder's five-second heartbeat (`play.mjs`) runs
`PlayPool.watchEditor`. It lists the visible windows on the slot's desktop and logs each dialog
once (title, text, buttons) to `<data>/hidden-desktop/launches/<desktop>/dialogs.jsonl`.

- **Benign** dialogs get their safe button: "Scene(s) Have Been Modified" → Don't Save, API updater
  → No Thanks, Safe Mode → Ignore (the console then shows the compile errors).
- **Blocking** dialogs fail the lease: licence or sign-in prompts, crash reporters and version
  prompts at once; import errors and unknown dialogs after 10 s. A screenshot of the hidden desktop
  is saved next to the log, the editor is closed, and the lease ends with a message naming the
  dialog and the screenshot. `check()` keeps answering that message to the old holder; the slot
  shows it in Settings › This project › Unity slots.

## Readiness

`play.mjs` prints its `ready` record only when the slot editor answers, never at spawn.
`PlayPool.waitReady` polls once a second until both of these hold:

- `Library/Pipeline/.unity-pipeline-port` exists and names this slot root, `mode: "editor"`, and
  a live PID that is the slot's own editor (Genio's launch record or Unity's
  `EditorInstance.json`). A leftover descriptor from a crash, another project or another process is
  never used, and its port is never contacted.
- Pipeline's `GET /api/status`, which it answers off the main thread, says `ready`. Pipeline
  reports `settling` through the first import and `blocked_by_dialog` while a modal is open.

Unity writes the descriptor only once the Pipeline package loads, after the first script compile
and domain reload. A fresh slot with a seeded Library compiles everything and reimports for
minutes. While waiting, the session prints a `waiting` record (`phase: "editor"`) every 30 s with
the current reason. After 20 minutes it fails with an error naming the last cause (endpoint file
never written, nothing answering on the port, a 401, still settling, a dialog) and the slot's
`Logs/Editor.log`. The release then closes the editor. An editor that exits first fails at once,
and a lease lost to a blocking dialog ends the wait with the dialog's message. The wait applies
whenever an editor runs in the slot: one just launched, or one kept from an earlier lease. The
seed already leaves out `Library/Pipeline`, `EditorInstance.json` and lock files at every depth.

Each later `cmd` re-reads the descriptor. A missing descriptor is reported as "the slot editor has
no Pipeline endpoint" (still starting or importing, or it exited), not a raw ENOENT. A 401 is
retried once after Pipeline's next heartbeat, because the token rotates. Any other refusal carries
Pipeline's own status and reason, for example
`HTTP 400: Internal Server Error: Main thread operation timed out after 15000ms` while the editor is busy importing.

### Founders of Avalon, 2026-10-17

The unit `remove-hover-ui-on-houses` (project on `F:`, Unity 6000.5.1f1, slot on the same Dev
Drive, Library block-cloned with `clone:fsctl`) hit three separate problems:

1. **Ready without an endpoint.** On the first attempt, slot preparation finished at 08:05:05
   (cloning plus a 70 s Library seed). The editor launched and `ready` was printed by 08:05:38:
   the old `play.mjs` printed it right after the spawn. Two `cmd editor_status` calls, at 08:05:43
   and 08:06:37, read a descriptor that did not exist yet (ENOENT). When the session was stopped
   at 08:07:29, the slot's `Logs/Editor-prev.log` ended inside the first `bee_backend`
   ScriptAssemblies compile, before the Pipeline package had loaded. The seed was not at fault:
   `Library/Pipeline` is excluded on both the clone and the robocopy paths. Neither was the F:
   volume: the editor opened the path and logged into it normally.
2. **"Invalid Pipeline response" after recovery.** The retry relaunched the editor on the same
   revision, with no new seed, and printed `ready` 10 s after starting. By 08:08:50 Pipeline was
   listening, but the editor was still in its first asset import. `Logs/Editor.log` records
   `Failed to handle /api/exec request: Main thread operation timed out after 15000ms`: Pipeline
   answers that with HTTP 400 and a JSON reason, and the old `play.mjs` mapped every non-200
   answer to "Invalid Pipeline response". It was not a reused port, a stale token or another
   editor's answer.
3. **Four "unit-spawned" editors.** In the unit's Codex log, its only Unity actions before Play
   were `genio-unity status` (07:55:25) and `genio-unity test --mode EditMode` (`unity test`
   from 07:58:23). The Unity CLI's own log (`%APPDATA%\UnityHub\logs\cli-log.json`) shows that
   PIDs 53664 (07:55:31.24) and 66848 (07:58:28.57) were the CLI's AuthBroker, started by
   `license status` and `test`. 66056 (07:55:31.69) was another CLI process. A probe run with a
   throwaway profile showed what these are: the Store CLI runs its packaged
   `...\UnityTechnologies.UnityCLI_<ver>\app\unity.exe` with `--internal-auth-broker-serve`
   and `--internal-msix-repair`. That path is not the WindowsApps alias recorded in the unit's
   config, and the flags were not among the process watch's CLI verbs. So the watch counted them
   as editors without a project and stopped them. 42792 (08:02:10, near the end of the test run)
   has no line in the CLI log. Its timing and its missing project fit a broker restarted after
   the first one was stopped, but that could not be confirmed. The unit's brief carried the
   `genio-unity`-only rule, and the unit followed it.

Fixes: the readiness wait above; Pipeline's own reasons in `cmd` errors; the process watch now
leaves the CLI's packaged binary and its `--internal-*` helpers alone; and each watch incident
records the command line, the parent PID and the parent's command line.

## Visible windows and fallback

Settings › This project › Unity slots › **Slot editor windows** switches later launches to
visible windows, for debugging a stuck dialog. Without a hidden desktop (another OS, no
`csc.exe`, `CreateDesktop` refused in a restricted session, a helper failure), the launch falls
back to today's visible launch. `play.mjs` prints a `warning` record, and the slot shows the
warning.

## Self-resetting slots

Unity writes into a slot it opens (`.meta` files for assets a commit lacks, `packages-lock.json`,
upgraded ProjectSettings). Before a branch switch a prepared slot now runs
`git clean -fd -e Library/ -e Temp/ -e Logs/ -e UserSettings/` in its own clone. It first checks
that the slot is the top of its own repository, so the source and any parent repository are never
touched. The checkout that follows uses `--force`. `preparation.reset` records how many untracked
and modified files were reset.

## Checks

- Unit tests: `tests/hidden-desktop.test.ts`, `tests/play-pool-editor.test.ts`,
  `tests/play-pool.test.ts`, `tests/unity-guards.test.ts`. They use a fake desktop API and the
  fake editor fixture only, and never launch Unity. The fixture can write its endpoint late
  (`-endpointDelay`), report `settling` (`-settleMs`), and refuse exec the way a busy editor does
  (`-execError`). The readiness tests cover a slow endpoint, an endpoint that never appears, an
  editor that exits, a stale or foreign descriptor, and `play.mjs` end to end.
- Manual, on the player's machine: `node scripts/hidden-desktop-check.mjs` builds the helper and
  uses PowerShell message boxes on hidden desktops. It checks invisibility, process identity, the
  safe-button click, a blocking dialog with its screenshot, `WM_CLOSE` and desktop clean-up.
  Add `--unity <throwaway project>` to open, watch and quit a real editor that way. It prints
  PASSED or FAILED.
- Untested so far: hidden desktops while Windows is locked, asleep or under RDP.
