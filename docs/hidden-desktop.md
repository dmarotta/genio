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
  fake editor fixture only, and never launch Unity.
- Manual, on the player's machine: `node scripts/hidden-desktop-check.mjs` builds the helper and
  uses PowerShell message boxes on hidden desktops. It checks invisibility, process identity, the
  safe-button click, a blocking dialog with its screenshot, `WM_CLOSE` and desktop clean-up.
  Add `--unity <throwaway project>` to open, watch and quit a real editor that way. It prints
  PASSED or FAILED.
- Untested so far: hidden desktops while Windows is locked, asleep or under RDP.
