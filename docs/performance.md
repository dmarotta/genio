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
- the usage scan (Systems › Accounts, dispatch signals, every 5 minutes and at
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
| Terminal output, 12 units, 40 flushes: snapshots built | 40 | 40 (one per flush, only while a project window is open) |
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
  quest, not per token.
- The renderer keeps every chat message received during a session; the main
  process caps its history at 1,000. A day-long session with thousands of
  turns grows the DOM, though off-screen messages are now skipped by the
  compositor.
- The cold usage scan still streams every transcript modified in the last
  week once per app start (about 2 ms per MB). Growth after that is
  incremental.
- `tasks.json` is rewritten synchronously on every unit update (about 1 ms per
  100 units). It is durable by design and cheap at this size.
