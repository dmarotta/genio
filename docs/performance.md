# Performance

Measurements and the optimisation pass behind them. The numbers come from the
perf harness (`npm run perf`), which exercises the real modules over a
realistic Base (about 100 units, 100 quests, a 2 MB chat log and a 200 KB
stats file) and prints a table per suite. `GENIO_PERF_BASE=<base root>` runs
the startup and main-process suites over a copy of a real Base instead; nothing
outside the temporary copy is written.

Numbers below were taken on Windows 11 in vitest (Node 24, jsdom for the
renderer). jsdom is several times slower than Chromium at rendering, so the
renderer figures matter as ratios, not absolutes. Event-loop lag readings on
Windows carry about 15 ms of timer-granularity noise; counts and wall time
are the reliable columns.

## Test and capture isolation

Every unit, e2e and perf suite loads `tests/support/setup.ts` before its test
modules. `tests/support/isolated-homes.mjs` creates private temporary
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` and
`GENIO_HOME` directories. It also replaces `HOME`, `USERPROFILE`, AppData and
XDG roots so a missing override falls back inside the sandbox. Child processes
must inherit these overrides; never delete them from a child environment or
point a test at the player's Base. An explicit fixture home must also be under
the run's temp root, with no symlink or junction escaping that directory.
Stop app contexts and children before removing fixtures, including on assertion
failure. Temporary homes contain no copied credentials.

The coordinator's `tests/support/global-setup.ts` gives every run a unique
temporary root. Worker homes and `TEMP`/`TMP`/`TMPDIR` live under it, so test
projects, working directories and provider prompts referencing those directories
carry its unique token. A child probe proves the passed environment and native
HOME resolution actually stay in the sandbox; hooks reject escaping home paths.
The fallback-path test checks actual Genio, Codex and Claude HOME resolvers.
Teardown scans the first 64 KiB of real Codex rollouts (live and archived) and
Claude transcripts for that token, and queries only matching Codex `threads`
rows in `state_5.sqlite` through a read-only connection. Missing folders and
databases are skipped. It fails only on test-attributable artifacts; file counts,
database bytes and modification times from concurrently running player apps,
Genio units or chat are ignored. Never open the real database read-write.
Run checks with inherited `GIT_CONFIG_*` variables removed; in PowerShell:
`Get-ChildItem Env:GIT_CONFIG* | Remove-Item`.

`npm run test:e2e` runs the unauthenticated real Codex archive check when the CLI
is installed. Paid Claude checks require `GENIO_E2E_REAL=1` and credentials
provided specifically for the test (for example `ANTHROPIC_API_KEY` in the
environment). They never reuse the player's Claude config or secure-storage
directory. Do not restore access to real homes to make an auth check pass.

For visual-check units and manual capture tours, run `npm run build`, then
`npm run capture -- <output-dir> [app arguments]`. The launcher uses the same
helper and real-home guard, replaces inherited homes, clears renderer/node
Electron overrides and Git config overrides, and passes an isolated Electron
`--user-data-dir`, with a unique run token and the same attribution-based leak
guard. Optional `GENIO_CAPTURE_PROMPT`, `GENIO_CAPTURE_SCRIPT`,
`GENIO_CAPTURE_SCENARIOS` and `GENIO_CAPTURE_DELAY` still apply;
`GENIO_CAPTURE_SIZE=<width>x<height>` shoots at that window size (e.g. the
480x360 minimum), and a scenario's return value is printed beside its shot. Use
`GENIO_CAPTURE_BASE` only for a purpose-built fixture Base with no real home
paths or live units; the launcher copies it into the temporary Base. Output
screenshots remain in the requested output directory after sandbox cleanup.
Starting the app directly with `GENIO_CAPTURE_DIR` requires all sandbox paths
and `GENIO_CAPTURE_ROOT`; the Electron entry rejects incomplete or escaping
homes before it locks the profile or writes the Base.

## What made chat sluggish

The chat log re-rendered every message on every streamed token. `Message`
was a plain component, so each `chat-delta` (several per second, in bursts of
dozens when the SDK's stdout arrives) re-ran all ~300 messages of a long
transcript, including their Markdown components. With a few hundred tokens
per reply that is tens of thousands of component renders per reply, on the
renderer's main thread, while the player is typing.

Three main-process habits added load that grows with the number of agents:

- every bus event built a full fleet snapshot before routing, including the
  thousands of `chat-delta` and `wksp` activity events per reply;
- the Hub window received every chat delta, chat message and terminal chunk of
  every project although it has no screen for them;
- the usage scan (Settings › Accounts & keys, dispatch signals, every 5 minutes and at
  startup) re-parsed the whole transcript of every running unit each time one
  grew, then grouped records per project with an O(n²) copy.

Two files grew without bound: `stats.json` kept every asset dedupe key ever
seen (1,306 keys were 186 KB of a 208 KB file rewritten on every award).

## Changes

| Area | Change | Risk |
|---|---|---|
| Renderer chat | `Message` is memoised and the take-back callback is stable, so a delta re-renders only the streaming message. | low |
| Renderer chat | Messages scrolled out of view use `content-visibility: auto`, so off-screen avatars (five infinite SVG animations each) and bubbles are not laid out, painted or animated. | low |
| Main events | New `src/main/event-router.ts`: the snapshot is built lazily, at most once per event or terminal flush, and only for the event kinds that route by it (`status`, `backlog`, `decisions`, `terminal`, `navigate`). | low |
| Main events | `chat-delta` events are coalesced per message and flushed every 40 ms, always ahead of any later event, so order is preserved and a window sees at most ~25 chat updates per second. | low |
| Main events | The Hub no longer receives `chat`, `chat-delta`, `generation` or terminal output; it still observes tasks, quests, choices, settings and toasts. | low |
| Usage scan | Session logs are append-only, so a grown log is parsed from the byte after its last complete line; the Codex parser keeps its cumulative counters between scans. Ownership checks are memoised per cwd and the per-project grouping is linear. | low |
| Stats | Asset dedupe keys are capped at 2,000 (newest kept), on load and on write. | low |

No behaviour changed for the player: the same events reach the same project
windows in the same order, the Hub shows what it showed before, and every
existing test still passes.

## Before and after

Main process (synthetic Base, Hub plus one project window open):

| Measure | Before | After |
|---|---|---|
| 2,000 streamed deltas: fleet snapshots built | 2,000 | 0 |
| 2,000 streamed deltas: IPC messages sent | 4,000 | 14 (one per 40 ms flush, project window only) |
| 2,000 streamed deltas: IPC bytes | 306 KB | 22 KB |
| 5,000 activity (`wksp`) events: wall time | 259 ms | 6 ms |
| 5,000 activity events: fleet snapshots built | 5,000 | 0 |
| 30-tool turn: IPC bytes (growing partial message) | 8.76 MB | 4.40 MB |
| 30-tool turn: fleet snapshots built | 92 | 0 |
| Terminal output, 12 units, 40 flushes: IPC messages | 80 | 40 |
| Terminal output, 12 units, 40 flushes: snapshots built | 40 | 40 (one per flush, only while a project window is open; 1 since the second pass) |
| `status` / `backlog` event: snapshots built | 1 | 1 |
| `ctx.snapshot()` | 0.06 ms | 0.06 ms |
| `crew.update()` (rewrites tasks.json, 102 units) | 1.1 ms | 1.1 ms |

Renderer (jsdom, 300-message transcript, 400 deltas streamed into one message):

| Measure | Before | After |
|---|---|---|
| Wall time | 32,567 ms | 1,670 ms |
| React commits | 400 | 400 |
| Profiler render time | 24,620 ms | 1,185 ms |
| Markdown component renders | 68,400 | 400 |
| Initial render of 300 messages | 552 ms | 563 ms |
| `renderMarkdown` of a 4.3 KB reply | 1.6 ms | 1.7 ms |

Usage scan (194 MB of session logs in 6 files):

| Measure | Before | After |
|---|---|---|
| Cold scan (every file parsed) | 1,032 ms | 400 ms |
| Warm scan (nothing changed) | 696 ms | 15 ms |
| After one appended line per file | 1,018 ms | 22 ms |

Startup (real Base copy): `createApp()` 133 ms; first project-window snapshot
272 KB; the project chat's first `history(300)` reads and compacts the 2.2 MB
log in 112 ms and ships 356 KB to the window, 206 KB of it tool traces.
Unchanged by this pass.

## Regression guards

- `tests/event-router.test.ts`: deltas coalesce and never overtake a later
  event; no snapshot for chat, delta or activity events and at most one per
  event otherwise; terminal output is batched per flush and never sent to the
  Hub; 5,000 pings plus 5,000 deltas route without a snapshot and well under a
  second.
- `tests/chat-render-count.test.ts`: streaming 50 deltas into a 100-message
  transcript renders at most 52 Markdown components; a replaced message
  re-renders only itself.
- `tests/usage-scan.test.ts`: unchanged logs are not re-read, a grown log reads
  only its appended bytes, a truncated log is read from the start, and
  `readLines` leaves a trailing partial line for the next scan.
- `tests/stats.test.ts`: the asset dedupe keys on disk stay at the cap.
- `tests/project-windows.test.ts` and `tests/window-manager.test.ts`: the Hub
  gets no chat traffic; a snapshot getter is only called for events that need it.

## Not changed, worth knowing

- Tool traces travel in full (2,000 + 4,000 characters each) although the
  chat shows 600 + 1,200. Trimming them for transport would cut the first
  chat load and tool-heavy turns by roughly 60%, at the cost of coupling the
  main process to what the renderer displays.
- A `backlog` or `decisions` event sends the project window a full snapshot
  (about 330 KB with 100 units and 100 quests). It happens a few times per
  quest, not per token. (Since the second pass a `backlog` event carries the
  project's quests instead; `decisions` still sends the snapshot.)
- The renderer keeps every chat message received during a session; the main
  process caps its history at 1,000. A day-long session with thousands of
  turns grows the DOM, though off-screen messages are now skipped by the
  compositor.
- The cold usage scan still streams every transcript modified in the last
  week once per app start (about 2 ms per MB). Growth after that is
  incremental.
- `tasks.json` is rewritten synchronously on every unit update (about 1 ms per
  100 units). It is durable by design and cheap at this size.

## Second pass: screens, startup, the main process and Play streaming (2026-10-17)

### How it was measured

`scripts/screen-benchmark.mjs` runs Genio's real main-process services and IPC
handlers over a sandboxed copy of a Base and drives the built renderer in
Electron (one project window) through the DevTools protocol:

- **The data**: a copy of the player's Base (`--base`, default `~/.genio`)
  without worktrees, Play pools, player copies or the Claude and Codex homes.
  Base paths are remapped into the copy; project folders stay where they are
  and are only read. `--freeze <dir>` keeps one snapshot, so every revision is
  measured on the same units, quests and chat (a live Base changes while units
  run). This pass used a snapshot with 234 units (27 unfinished), 229 quests,
  88 choices, a 4.6 MB chat log and the `genio` and `lands-of-old` (Unity,
  28,000 files) projects.
- **Live units**: six units get real PTYs. Each fills a 1.4 MB scrollback with
  Claude Code-like coloured output, then prints two lines every 300 ms.
  Nothing starts supervision, agents or Unity.
- **The tour**: boot (window load to the chat's messages), 5 s idle on the
  chat, each screen from the chat (Ctrl+digit), a plain unit's page, a
  Modeller's page, a streamed reply (150 deltas over 6 s) with the floating chat
  over Squad and on the chat screen, and five quest updates 1 s apart on Quests.
- **Play** (`--play-stream`, in a Unity project): a stand-in for com.genio.play's
  `StreamSession` feeds the real `PlayStream` socket, `playerInstanceStream`
  handler, MessagePort and live view. It sends game-like JPEGs (quality 75)
  at Unity's 30 fps, one frame in flight, plus audio packets. Each frame
  carries a stamp, so the page can time it from send to paint.
- **Per phase**: first painted frame; content shown (the screen's own content,
  not its loading shell); renderer main-thread task, script, layout and style
  time; renderer thread and process CPU time; forced and total layout and style
  recalculation counts; long tasks; IPC calls and bytes; routed events and
  bytes; fleet snapshots built; and the main process's CPU time and event-loop
  lag. `--profile` writes main and renderer CPU profiles per phase, `--trace`
  writes a Chromium timeline (with style invalidations and stacks), `--shots`
  saves a screenshot per phase, and `--css` adds a diagnostic stylesheet.
- **A loaded machine**: the player's own Genio, other units and their tools
  shared the machine (16 logical CPUs, at times fully used). `--snapshot <name>`
  keeps a revision's build, and `--apps a,b,...` measures the builds in turn
  (a b a b ...), so load drifts over every revision alike. The tables give
  medians of three interleaved runs, and CPU time and counts are read before
  wall time. Expect ±20% between runs on anything but counts.

Main-process pieces without a window use the Vitest perf harness
(`npm run perf`) over a copy of the same Base (`GENIO_PERF_BASE`).

### What was slow

From the baseline runs, in order of cost:

1. **Squad and the unit page.** Each live unit's terminal is an xterm. Its DOM
   renderer measures every new glyph's width with a forced style and layout
   pass. It drew every frame while parsing the 1.5 MB scrollback it attaches
   to. Every forced style pass also restyled the floating chat's 300 messages:
   their `rise` entry animation used fill-mode `both`, so each message stayed
   animated for good. Squad took 2-3.5 s to show its content, with about
   6.7 s of renderer CPU in the phase.
2. **A streamed reply.** It kept the renderer 70-85% busy. Each delta
   re-parsed the whole reply and replaced all of its DOM (2.2 s of style
   recalculation in 6 s). The log also re-pinned to the bottom in a layout
   effect: one forced layout per delta, 1.7 s of the 6 s in a profile.
3. **Every screen switch.** The floating chat (300 messages) mounts on every
   screen but Chat. Its timestamps each built a new `Intl.DateTimeFormat`,
   every message's Markdown was parsed and sanitized again (about 100 ms), and
   the composer's model picker read its anchor's rectangle on every render.
4. **Boot.** One 1.9 MB chunk held every screen and xterm. The main process
   blocked about 600 ms, in two parts: a synchronous read of the 4.6 MB chat
   log (about 170 ms, mostly the file open) and a usage refresh that starts
   the account CLIs (about 230 ms of process spawns).
5. **Steady main-process work**:
   - a fleet snapshot built on every 16 ms terminal flush while units print;
   - `tasks.json` (547 KB) rewritten once per unfinished unit at startup;
   - a 1.3 s synchronous Blender probe on every toolchain check;
   - two PowerShells listing every process every 5 s, with or without Play;
   - every quest change sending the project window its whole 750 KB snapshot;
   - every quest save reading the 155 KB done archive.
6. **Always-mounted components.** The answer cards, rail, title bar and an
   unloaded chat selected a new array or object on every store change, so
   each re-rendered once per streamed delta or terminal event.

### Changes

Each change was measured on its own against the build before it, except where
noted. "Interleaved" means the screen benchmark (median of 3, a b a b) on the
frozen Base.

| Change | Measure | Before → after |
|---|---|---|
| The chat's `rise` entry animation fills backwards, so finished animations stop costing style work (`theme.css`); dead `.msg.noop` opacity and transform go | Interleaved, renderer CPU | Streamed reply on Chat 3,116 → 2,555 ms; over Squad 2,620 → 2,206 ms; Modeller page 2,324 → 1,977 ms |
| A terminal parses its scrollback before it joins the page, then draws once (`Terminal.tsx`) | Interleaved, on top of the row above | Squad content shown 3,478 → 1,412 ms, renderer CPU 6,675 → 4,490 ms; unit page CPU 6,104 → 4,990 ms |
| A streaming reply rebuilds only its changed trailing Markdown blocks (`Markdown.tsx`) | Interleaved, 6 s stream, renderer task time | On Chat 5,146 → 2,123 ms (style recalculation 2,208 → 124 ms); over Squad 4,206 → 2,292 ms |
| The chat follows the latest message from its ResizeObserver only, with no layout effect per delta (`Comms.tsx`) | CPU profile of a 6 s stream; interleaved | Forced layouts from re-pinning 1,668 ms → 0; the interleaved run was within noise (4,485 → 4,342 ms) |
| Cached date formatters (`lib/format.ts`); the model picker measures its anchor only while open | Interleaved, renderer task of a switch from Chat | Quests 431 → 356 ms, Settings 373 → 292, Inventory 410 → 321, Art Bible 354 → 281 |
| Rendered Markdown cached by source text across remounts, bounded at 4 M characters | CPU profile of a screen switch | About 100 ms of parsing and sanitizing 300 messages → cache hits |
| Every screen but the chat is its own chunk, loaded on first use or when the window is idle; xterm loads with the first terminal (`App.tsx`, `TerminalPane.tsx`) | Build output; interleaved boot | Main chunk 1,930 → 1,107 KB; boot script time 318 → 316 ms (no measurable change); renderer heap at boot 19.2 → 17.2 MB |
| Stable selections for always-mounted components (`openDecisions` cache, memoised quest counts, shared empty lists) | `tests/store-selectors.test.ts` | A new list per store change → the same list until the choices change or a deferral ends |
| The event router caches each terminal's project (`event-router.ts`); the `terminals` handler and window close build one snapshot | Perf harness, 12 terminals, 40 flushes | Snapshots built 40 → 1 |
| The Play poll lists processes only while a player editor is launched (`player-instance.ts`) | PowerShell launches with no Play running | 24 a minute → 0 |
| The Blender probe runs on a worker thread (`toolchain.ts`) | Longest main-process event-loop gap during a toolchain check | 1,317 → 17 ms (wall time unchanged) |
| A project chat's log is read asynchronously while its window loads (`chat-thread.ts`) | Main-process stall at boot | About 170 ms of synchronous read removed; boot max loop lag, with the three rows above, 521 → 372 ms |
| Startup reconciliation writes `tasks.json` once per home (`crew.ts`) | `tests/perf/reconcile.perf.ts`, real Base copy, 27 unfinished units | Writes 27 → 2; about 216 → 45 ms |
| Unit-page fallback polls wait while the window is hidden (`lib/visible-poll.ts`) | Reads while minimized | Diff stats (three git commands) every 8 s, pings every 8 s, Modeller state every 1 s → none; one read when shown |
| The command palette builds its list only while open | Rebuilds while closed | One per unit change → none |
| A quest save reads the done archive only for quests not yet seen archived (`backlog.ts`) | Per quest save | 10-15 ms of about 30 ms (a 155 KB read) → skipped once every id is known |
| A project window gets its quests from the `backlog` event, not a whole snapshot (`project-windows.ts`, `store.ts`) | Interleaved, five quest updates on Quests | Renderer CPU 578 → 268 ms; style recalculations 79 → 7; event bytes 3,781 → 1,070 KB; snapshots built 5 → 0 |

Tried and dropped: `contain: strict` on xterm's rows and measuring element
(no gain).

### Overall

The branch's starting point (main plus the benchmark) against the finished
pass, interleaved, median of 3, `genio` project. The starting build predates
the benchmark's CPU-time columns. A rerun with them was stopped when the
machine ran low on memory, so this table compares wall times, lag and counts.
The CPU-time effect of each change is in the table above.

| Phase | Content shown | First frame | Other |
|---|---|---|---|
| Boot | 986 → 1,000 ms | | Main-process longest loop gap 528 → 316 ms; snapshots built 88 → 5 |
| 5 s idle on Chat, six units printing | | | Snapshots built 65 → 0 |
| Squad | 4,070 → 238 ms | 352 → 101 ms | |
| Quests | 170 → 160 ms | 140 → 110 ms | |
| Character Sheet | 160 → 142 ms | 133 → 89 ms | |
| Settings | 141 → 105 ms | 123 → 74 ms | |
| Inventory | 153 → 90 ms | 128 → 67 ms | |
| Art Bible | 138 → 100 ms | 110 → 74 ms | |
| Play (stopped) | 29 → 33 ms | | |
| Unit page | 582 → 515 ms | 51 → 22 ms | |
| Modeller page | | 30 → 26 ms | |
| Streamed reply, over Squad and on Chat | | | Snapshots built 75 and 72 → 0 |

On `lands-of-old` (Unity, 28,000 files), Inventory and Play were within noise:
one run of each build stalled about 1.4 s. The boot's longest main-process
loop gap went from 407 to 324 ms.

### Play streaming

The player saw Play streaming as slow. The Genio half was measured end to end
with the stand-in. The Unity half was read but not run: this unit cannot start
Unity.

| Genio side, stand-in at 30 fps | 1280 × 720 | 1920 × 1080 | 720p with a streamed reply in the floating chat |
|---|---|---|---|
| Frames sent / painted per second | 30.5 / 30.1 | 30.1 / 30.1 | 31.2 / 30.0 |
| Dropped by the newest-frame rule | 0 | 0 | 0 |
| Frame size | 113 KB | 259 KB | 113 KB |
| Socket send to paint, p50 / p95 | 13.8 / 21.5 ms | 19.4 / 26.6 ms | 15.2 / 22.4 ms |
| Decode (`createImageBitmap`), p50 / p95 | 3.4 / 4.4 ms | 7.1 / 8.7 ms | 3.5 / 6.4 ms |
| Renderer main thread busy | 6.3% | 6.8% | 23% |
| Main process CPU | 0.9% | 1.9% | 1.1% |

Genio already does what the cheap-wins list asks for on its side: binary
frames, the newest frame wins at the socket and at the renderer's credit, the
bytes are transferred, and frames are decoded with `createImageBitmap` and drawn
on a canvas. It paints every frame at 1080p with headroom. So this pass changed
nothing on that path. It only named the contract the sink consumes,
`PlayFrameSource` in `play-stream.ts` (complete frames, newest wins; audio in
order; input; close), so another transport could plug in beside the WebSocket
later. WebCodecs/H.264 and shared memory are not needed for Genio's half. The
D3D shared texture was not built.

`StreamSession.cs` already uses `AsyncGPUReadback`, caps the stream at 30 fps,
keeps one frame in flight, and encodes JPEG (quality 75) on a worker task. What
it still costs, by reading the code:

1. **One frame in flight across the whole chain.** The next capture waits for
   readback (one to three game frames), the CPU row flip, the encode and the
   send. The stream rate is therefore 1 / (readback + encode + send), not
   30 fps: with a 10-20 ms 720p encode, that is likely 15-25 fps.
2. **Per-frame allocations.** `GetData<byte>().ToArray()` allocates 3.7 MB
   (720p) or 8.3 MB (1080p) of managed memory per frame, and `FlipRows` adds a
   row buffer. That is GC pressure inside the game.

Recommended for a Unity unit, which can run and profile it:

- Allow a second readback while the previous frame encodes. Stamp frames with
  a sequence number and drop one that finishes after a newer one.
- Keep one pooled buffer, or encode straight from the `NativeArray`.
- Flip in the `Blit` with a negative scale, not on the CPU.
- Measure with Unity's profiler plus this benchmark's send-to-paint stamps.

#### The GPU stream (2026-10-17)

The D3D shared texture was then built as Play's fast path, with the JPEG stream kept as the automatic fallback ([play-gpu-stream.md](play-gpu-stream.md)). Measured end to end in a real Unity 6000.5.1f1 editor on a hidden desktop against Genio's own stream code, two 15 s runs per row, from Unity's end of frame to the canvas draw:

| Play stream | 1280 × 720 before → after | 1920 × 1080 before → after |
|---|---|---|
| Shown frames per second | 30.0 → 59.9 | 20.6 → 59.7–59.8 |
| End of frame to drawn, p50 | 27.1–27.4 → 1.1–1.3 ms | 41.3–41.8 → 1.5–1.6 ms |
| End of frame to drawn, p95 | 30.6–30.7 → 1.8–2.5 ms | 44–52 → 2.8–4.3 ms |
| Electron CPU, % of one core (main + GPU + renderer) | 19.4–19.5 → 22.3–23.1 | 21.8–24.0 → 23.8–24.4 |
| Unity editor CPU, % of one core | 4–5 → 4 | 16 → 4–5 |

"Before" is the JPEG stream as it ships (and as it still runs for projects that need Direct3D 12): readback, encode at quality 75, 30 fps cadence, one frame in flight. "After" draws twice the frames for about the same Electron CPU, and takes the 1080p encode off the editor.

### Left alone, and why

- **The unit page still spends about 5 s of renderer CPU in the tour.** xterm's
  glyph measuring still forces style passes, and the floating chat's messages
  are part of the page. Hiding the floating chat brings it to 348 ms. Options:
  - xterm's WebGL renderer, which does no DOM measuring. Each terminal needs
    its own WebGL context and Chromium caps them at about 16, so Squad would
    keep the DOM renderer.
  - One width cache shared by all terminals. This relies on xterm's private
    internals and is fragile on upgrade.
  - A lighter floating chat, such as fewer messages mounted. This changes what
    the player sees, so it is a product decision.

  Recommended: the WebGL renderer on the unit page only, falling back to the
  DOM renderer, as its own change with a visual check.
- **The model catalogue re-probes every 60 s** while any route is not
  installed or not signed in. Each refresh starts the account CLIs
  synchronously, about 230 ms of the main process (one of the boot stall's
  causes). Recommended: run those probes off the main process with the same
  answers. A longer expiry for "not installed" would change how soon a new
  sign-in shows, so that is a design decision.
- **The project window's snapshot holds every unit ever run** (719 KB).
  Pruning it changes what Squad and the history show.
- **A `decisions` event still sends a whole snapshot.** Its order differs from
  the snapshot's, and it happens a few times per quest.
- **An engine rescan saves the registry and sends `projects`**, because
  Settings shows when each project was last scanned. The Hub's project
  metadata (a few git calls per project) refreshes on that event for the same
  freshness.
- **Small items.** Inventory asks for `inventoryInfo` twice (main caches it).
  Quests subscribes to every status change. The terminal scrollback is
  trimmed by shifting.
- **Minifying the renderer.** Parsing is no longer the cost, and readable
  stacks matter more.

### Regression guards

- `tests/markdown-stream.test.ts`: a streamed reply's DOM equals a full render
  at every prefix, unchanged blocks keep their nodes, and the Markdown cache
  hits and evicts.
- `tests/chat-scroll.test.ts` and the `chat-scroll` and `chat-jump-layout` e2e
  checks: the log still follows new messages, deltas and late layout.
- `tests/format-dates.test.ts`, `tests/model-picker.test.ts`,
  `tests/store-selectors.test.ts` and `tests/store-backlog-event.test.ts`.
- `tests/renderer-chunks.test.ts`: the eager import graph holds no screen and
  no xterm.
- `tests/event-router.test.ts`: a terminal's owner is resolved once, and an
  unknown one is retried.
- `tests/player-instance.test.ts`: no process listing without a launched
  editor.
- `tests/toolchain-blender.test.ts`: the worker answers what the in-process
  probe answers.
- `tests/chat-provider-service.test.ts`: the asynchronous first read gives the
  same history as the synchronous one, stranded queued messages included.
- `tests/crew-lifecycle.test.ts` and `tests/perf/reconcile.perf.ts`: one write
  per reconciliation.
- `tests/visible-poll.test.ts`, `tests/backlog.test.ts` (archive reads) and
  `tests/project-windows.test.ts` (quests scoped to the window's project).

## Modeller start (2026-10-18)

A Modeller took about a minute from deploy to its first step. Taken from the
ship rerun's logs (the fleet ledger, `deps.json`, the unit's transcript and the
step receipt) and timed again on the same machine (Blender 4.2.1 and 5.2.1):

| Piece | Time |
|---|---|
| Genio's deploy work (worktree, submodules, brief, skills, hooks) | 8.3 s in the rerun, 2.8 s for a later unit; the rerun overlapped the removal of a landed unit's copy |
| Claude Code start, up to the kickoff prompt | 2.9 s (1.7 s) |
| The model's own turns: reading, planning, writing `lib.py` and the first step | about 44 s |
| Tools before the first step: the brief read (the session's first Bash call), the skill section, an `ls` | 9.0 s, 2.2 s, 0.5 s |
| `node_modules` copy (16-thread robocopy, 1 GB), while the brief said to wait for it | 31.5 s in the background; it ended before `init`, so the unit did not wait this time |
| `modeller.mjs init` | about 2 s: three `reg query /s` of the Uninstall keys (1.2 to 1.7 s) and `--version` of each Blender (0.3 s) |
| First step, until its GLB reached the live view | 1.27 s: Blender start and imports about 0.87 s, the factory reset 71 ms, the export 180 ms |

In a headless 4.2 start, numpy's import alone took 350 to 540 ms and the
helpers' 50 ms: Blender ships no bytecode for numpy (5.2 ships none at all) and
cannot write any into Program Files, so every run compiled them again.

| Change | Measure | Before → after |
|---|---|---|
| Compiled Python shared by every Blender run, in `GENIO_BLENDER_CACHE/pyc` (`bytecodeEnv`, `blender.mjs`) | Headless start with the step runner's imports, median of 6, interleaved | 4.2: 1,477 → 983 ms; 5.2: 3,893 → 1,531 ms |
| The Modeller's list of installed Blenders kept for a week in `blenders.json` (`listBlenders`), searched again when a listed binary changes or a new one appears in Program Files, Steam or PATH, and on `init --repin` | `init` of a new model | 1.8 to 2.2 s → 95 to 102 ms |
| `init` starts `modeller.mjs warm` in the background when the pinned Blender has no warm-up marker: one short run of `genio_warm.py` (the step runner's imports, a box through the GLB preset, the checks) | First step on a cold cache, until its GLB reached the live view | Started at once (no time to warm): 2,180 ms; started 8 s after `init`, as an agent writing it would: 625 to 636 ms |
| No `node_modules` copy for a Modeller's worktree; its brief says its tools need none and how to get one (`crew.ts`, `nodeDepsLines`) | Background work in the unit's first minute | A 30 to 50 s, 16-thread copy of 1 GB → none; nothing to wait for |

The three-step stool bench (one part per step, through the CLI, as a unit runs
it): before, `init` plus the first step's landing took 2.9 to 3.8 s (median
3.4 s), each later step landed in 1.1 to 1.6 s and finished in 2.0 to 2.9 s.
After, 0.73 to 0.80 s, 0.55 to 0.70 s and 1.5 to 1.6 s. With every cache cold
and the first step started at once, racing the warm-up, it took 3.8 s, as
before. The GLBs, reviews, warnings, counts and bounds were byte-identical
across all six runs.

Left alone: the model's own turns are most of the minute. A persistent warm
Blender would save at most the remaining 0.5 s start per step and needs the
player's say-so for a background process. The factory reset (55 to 80 ms) and
the default add-ons (about 50 ms with the cache) stay: changing them could
change what a step makes.

Guards: `tests/modeller.test.ts` (the list cache, the bytecode environment, the
warm-up marker, and the real-Blender builds with their exact counts),
`tests/crew-lifecycle.test.ts` (a Build gets the copy, a Modeller does not) and
`tests/worktree-deps.test.ts` (the Modeller's brief lines).

## Modeller high-poly steps (2026-10-18)

The Recon on faster Modeller units replayed a high-poly starship's five steps
(105k triangles) and the same with a level-1 Subdivision on every part (423k).
At 423k a step ran past the 60 s watchdog, was stopped after it landed and
before its snapshot, and the next step replayed it. Bench: the same replay
through the CLI, one Blender per step as a unit runs it, then a one-part change,
two planted coplanar plates and another one-part change. Blender 4.2.1, 16
logical CPUs. Other units' Blenders loaded the machine during the "before" run
and the first "after" run, so single numbers can be off by up to 2x. The
trends are far larger.

| Step | Before: checks, sheet, step | After: checks, sheet, step |
|---|---|---|
| s005 at 105k, one part added | 2,133 ms, 714 ms, 4.0 s | 210 to 315 ms, 629 to 902 ms, 1.6 to 2.4 s |
| One part moved at 423k, live Subdivision | 35,219 ms, 24,046 ms, 65.9 s (past 60 s: measured with `--timeout 400`) | 992 to 1,091 ms, 713 to 781 ms, 8.4 to 10.4 s |
| The same with the parts frozen | not possible (no `p.freeze`) | 907 ms, 694 ms, 3.1 s |
| The step adding the Subdivision (every pair checked) | 39,450 ms, 24,693 ms, 71.5 s | 2,286 ms, 708 ms, 10.1 s |

What changed (`genio_step.py`, `genio_review.py`, `genio_bpy.py`, `genio_parts.py`):

| Change | Measure | Before → after |
|---|---|---|
| The sheet renders the shipped meshes (`modifiers_baked`) instead of letting each of its 4 renders evaluate live modifiers again | Sheet at 423k, live Subdivision | 24.0 s → 0.71 s |
| The snapshot is saved right after the export, before the checks and the sheet | A step stopped during them | lost its snapshot (the next step replayed it) → keeps it |
| Incremental checks: only pairs with a part whose shipped geometry changed (exact hash of vertices, triangles and edges); the other pairs keep the parent's results. Every pair every 10th step, when the model's size changes, and in `materialize` | Checks at 423k, one part changed | 35.2 s → 1.0 s |
| Z-fighting: faces paired through sorted plane offsets (an exact pre-filter: a window per face instead of every face of the other part) and the coverage test vectorised; a work budget, with a warning when it stops early | Z-fighting of every pair at 423k | 4.6 s with the window alone → 1.2 s |
| `validate()` counts edges, winding and shells with numpy instead of bmesh loops; reports identical on 11 test meshes (inward, open, two shells with one inward, one reversed face, loose and degenerate geometry, a flat closed shell, one far from the origin) and both starship snapshots | `validate()` at 423k | 511 → 393 ms here (1.7 s in the Recon, under load) |
| Part records build their BVH, pulled-in points and edges only when a pair needs them | One part changed at 423k | only the parts near it are built |
| The step runner opens the snapshot itself (`load` in the receipt's timings): live modifiers are evaluated while a snapshot loads, which the receipts never showed | Load at 423k | 5.3 to 6.9 s with live Subdivision, 42 ms frozen |
| `p.freeze(*parts)` applies modifiers for good, to the bit (the frozen part's geometry hash is unchanged); a warning names the parts when loading and evaluating live modifiers takes 2 s or more | Step after, 423k | 8.4 s → 3.1 s |

Reviews were identical to the old kernel's on all nine bench steps (live and
frozen). The planted coplanar pair is found when planted and still reported on
the next step, where neither plate changed. The only new line is the
live-modifier warning on the step that added Subdivision.

Left alone: the bake (11 s at 2048 px at any density, by the Recon) and
the Blender start. A full check of every pair at 423k now takes 2.3 s.

Guards: `tests/modeller.test.ts` (the real-Blender reviews with their exact
lines through incremental checks; an incremental review equal to the full
check `materialize` runs; a frozen part with nothing changed; the snapshot
saved before the checks, and kept when Blender stops after it).

## Modeller review and measurement (2026-10-18)

The Recon on faster Modeller units found that agents fix every new Z-fighting
or Floating line in one or two re-runs, but ignore a line that stands: the ship
rerun's intended `Hull / Keel` overlap led its Deep overlap line on 20 of 20
runs. Think and write time existed only in transcripts, and a high-poly agent
wrote its own close-up render (11.8 s, plus writing it) because a 512 px cell
of a 25 m ship cannot show 1 cm seams.

What changed (`genio_review.py`, `genio_step.py`, `genio_parts.py`, `modeller.mjs`):

| Change | Where |
|---|---|
| Each review item (a pair, a part, a group) is named the first time a line shows it and when its numbers move; while it stands it is a count (`3 known`). The receipt's `review_full`, `materialize` and the Modeller report keep every item | the parent's `review_seen`, passed in the plan |
| `p.intended(a, b, ...)`: pairs meant to overlap leave the Deep overlap and Z-fighting lines, kept in the scene | `genio_parts.py` |
| New lines: `Size` by axis (5 % off the brief, was a 25 % warning), `Triangles` per part (past half the budget, or one part holding 40 % of a dense model; was an over-budget warning), `Materials` (none, or two that look the same), `Bake` (paint not baked yet, parts without UVs) | `genio_review.py` |
| Per run in the receipt: `agent_ms` (since the kernel returned the run before or `init`; past 10 minutes an `agent_gap`), `script_bytes`, `lib_bytes`, `lib_changed`, `amend`, `rerun_of`, `phases_ms` (think, Blender, export, checks, sheet), Blender's `start` (process to plan loaded), `checks_ms` per check, `review_new` and `review_known` per line, `warnings_new`, `killed_after_landing` | `modeller.mjs`, `genio_step.py` |
| `modeller.mjs report <model>`: wall time, first step, steps, runs, amends, reruns, failures, agent and Blender time (median, 90th percentile, sum), phases, checks, script and lib KB, triangles against the budget, new and known review items, open review lines, killed steps | `modeller.mjs` |
| On a model of 50,000 triangles or more, the sheet gets a third column: two close-ups of the step's changed parts (when they span less than half the model), from the two of 16 directions whose rays see most of them, with what stands in front clipped away | `genio_step.py` |
| `dirBytes` no longer fails when a batch's Blender renames `model.blend@` while the kernel sums the model's folder (a race the batch tests hit once) | `step-kernel.mjs` |

Replays through the CLI, one Blender per run as a unit runs them, back to back
(so `agent_ms` is about 0.1 s here), Blender 4.2.1, a loaded machine:

| Replay | Review | `report` |
|---|---|---|
| Ship rerun: 13 scripts, 20 runs with 7 amends, 4,950 triangles | `Hull / Keel` on 1 run (was 20), then `1 known` to `6 known`; defect lines 3,863 → 2,410 characters over the 20 runs. Items the old `and N more` hid now surface once the first ones are known (`Bulwark L / Hull`, `Upper wale L / Hull`) | 38.3 s wall, 20 runs, 7 amends and reruns, Blender median 1,349 ms (90th 1,734), sheet 15.1 s of the 33.4 s Blender total, checks 1.5 s |
| Starship: 5 steps, 105k triangles, `--size 13x30x7.5`, budget 400k | Size line (80 %, 85 %) on s001, again only where an axis moved (s002, s004), else `2 known`; Triangles line from s002 (one part holding half); close-ups on s004 (Engineering hull) and s005 (Neck, seen from below the saucer on both sides) | 10.3 s wall, Blender median 1,576 ms, sheet 3.5 s, checks 1.2 s |

The close-ups' cost, on the starship's s004 snapshot in one Blender: choosing
the two directions 57 ms cold (Blender builds its ray trees), 5 ms after; the
sheet 459 to 554 ms with them against 381 to 437 ms without. In whole steps
(four interleaved rounds, a loaded machine) the sheet's median was 826 against
822 ms at s005 and 1,086 against 688 ms at s004. The new review lines cost 13 ms
over the ship's 20 runs.

Left alone: think versus write inside `agent_ms` stays a transcript analysis;
Genio's respawn and player-wait marks are not read, only the 10-minute gap.

Guards: `tests/modeller.test.ts` (the measures in each receipt, reruns after an
amend and a failure, a batch's later steps, the agent gap and a step killed
after landing; `report` from the API and the CLI, old receipts included; the
real-Blender review printing an item once and then a count, `p.intended`, the
Size, Triangles, Materials and Bake lines, `materialize` returning every item;
the close-up column on an 82k-triangle model).
