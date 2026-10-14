---
name: unity
description: The only way a Genio unit compiles, tests, imports, builds, plays and reads the console of a Unity project. genio-unity targets only your own copy or your leased Play slot.
---

# Unity through genio-unity

For every Unity action run genio-unity:

`node "{{SKILL_DIR}}/scripts/genio-unity.mjs" <verb>`

The same path is in `GENIO_UNITY`. Never start `Unity.exe`, Unity Hub or the `unity` CLI yourself. Never open, read or write the main project folder, and never read an editor's Pipeline token. genio-unity takes no project path: it always uses your own worktree copy (`GENIO_UNITY_PROJECT`) or your leased Play slot. This is a guardrail, not an OS sandbox. Never touch Toolbox, its processes or packages.

| Verb | What it does |
|---|---|
| `status` | Shows your copy, Play session, unity CLI, license, editor seats and last run. Exits 4 when Unity has no license. |
| `compile [--where auto\|copy\|slot]` | Compiles scripts. It uses the warm Play slot when the slot holds your HEAD and your Unity root is clean, otherwise a headless run on your copy. |
| `test [--mode EditMode\|PlayMode] [--filter F]` | Runs tests on your copy and writes NUnit and JUnit reports. |
| `import` | Imports your copy headless, which refreshes a seeded Library. |
| `build --target T` or `--profile P` `[--execute-method M]` | Builds your copy into the run folder, never into the project. |
| `play [--no-open]` | Leases a shared Play slot, opens its editor and serves `cmd`. It is long-lived, so keep it running in the background. |
| `play --stop [--keep-editor]` | Ends the session, releases the slot and closes its editor; `--keep-editor` leaves it running for the next lease of the same revision. |
| `play --close` | Recovery when an earlier session of yours left a lease or a slot editor behind. It closes only your slots. |
| `cmd <command> [key=value ...]` | Sends one Pipeline command to your leased slot. Needs a running `play`. Values that parse as JSON keep their type; a single JSON object also works. |
| `console [--tail N]` | Shows the slot console, or the last run's editor log when no session runs. |

`--timeout S` caps an editor run. `--wait S` caps the wait for an editor seat (default 1800).

## Runs and records

`test`, `compile`, `import` and `build` print a JSON record and keep it in `GENIO_UNITY_RUNS/<stamp>-<verb>-<id>/`:

- `result.json`: verb, target, HEAD, CLI and editor versions, exit code, verdict, timings, NUnit totals and failing tests, compile errors.
- `editor.log`, plus `results.xml` and `results.junit.xml` for tests.

Read failures there; do not rerun just to see the log. A test run that exits 0 with verdict `no-tests` ran nothing.

The first run on your copy seeds its Library from the project (once). Units share a machine-wide limit of batch editors with the Gauntlet. genio-unity waits for a free seat, and exits 20 when the wait runs out.

Commit the branch state you want to test in Play first: a slot copies only committed files.

## Play

Run `play` in the background and wait for its `ready` record and the Unity import. The helper inside waits FIFO for a shared slot, seeds its Library once, and renews your lease while it runs. While queued it prints `waiting` records with your position, the cap, how many slots are in use or draining, and a rough wait: keep it running, it takes the slot by itself. The cap defaults to one; only the player configures it, in Settings › This project › Unity slots. A cap change applies at once and never stops a running session: a slot above a lowered cap is draining, keeps its current lease and editor until released, takes no new lease, and closes its editor on release. If the slot editor is open on another revision, it is closed before the branch switch; an editor on the same revision is reused. Branch changes are refused while the slot checkout has local changes. Do not delete those changes to continue.

Then drive the slot, for example:

```
node "{{SKILL_DIR}}/scripts/genio-unity.mjs" cmd editor_status
node "{{SKILL_DIR}}/scripts/genio-unity.mjs" cmd editor_play
node "{{SKILL_DIR}}/scripts/genio-unity.mjs" cmd capture_game_view width=1280 height=720 source=screen
node "{{SKILL_DIR}}/scripts/genio-unity.mjs" console --tail 100
node "{{SKILL_DIR}}/scripts/genio-unity.mjs" cmd editor_stop
node "{{SKILL_DIR}}/scripts/genio-unity.mjs" play --stop
```

Pipeline commands, including input and run_tests, reach only the leased slot. Use command discovery for parameter schemas. On exit 23, stop immediately: your lease was lost because the player or Genio took the slot. Unity work already executing cannot be revoked. Never run a second session.

`play --stop` prints the release with `editor` set to `closed`, `kept` or `stuck` (a graceful quit, then a forced stop of only that slot's recorded editor processes). Never stop Unity, import workers or any other process yourself. If a slot is stuck (`play --stop` or `play --close` exit 6), append `blocked: Play slot <n> stuck` to your status with the reason and PIDs printed; Genio or the player recovers it.

Screenshots come back as base64. Save reports and decoded images in your task's scratch data, never in the project. If a pool transaction lock survives a crashed process, report its path to Genio; never remove shared pool state yourself. This skill authorizes no stream package installation and no main-project writes.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | |
| 2 | usage | Fix the command. |
| 3, 4 | no Unity sign-in or license | Append `blocked: Unity license` and stop. Never run `unity license`, `auth` or `install`. |
| 6 | failed (compile errors, crash, timeout) | Read `result.json` and `editor.log`. |
| 7 | Unity service unreachable | Retry once, then report. |
| 8 | tests ran and failed | Fix the failing tests named in `result.json`. |
| 20 | waited too long for an editor seat | Retry later; if it repeats, append `blocked: Unity editor seat`. |
| 21 | forbidden target | You asked for something outside your copy or slot. Don't work around it. |
| 22 | your copy is already open in an editor | Wait. Never stop Unity processes yourself. If it persists, append `blocked: Unity copy open`. |
| 23 | no Play session, or the lease was lost | Start `play`, or stop driving the slot. |
