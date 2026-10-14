# Genio Play 0.1

Unity Pipeline's media companion for the player's temporary copy (Unity 6). Genio embeds this folder under `Packages/com.genio.play` in its marked copy after each mirror. Nothing is installed into the source project or a unit's worktree.

The package is inert until an authenticated Pipeline command starts a session during Play Mode. It dials a token-authenticated WebSocket on `127.0.0.1`; it opens no listener. Frames are JPEGs encoded after GPU readback, up to 1920 × 1920, 30 fps, quality 75. There is no audio. The fixed cadence uses quarter-frame tolerance to avoid skipping frames of a 30 fps game; stalls reset it without catch-up bursts.

## Commands

- `genio_stream_start`: `port`, `token`, optional `width`, `height`. Credentials come from main's authenticated Pipeline request and never reach the renderer.
- `genio_stream_stop`: disconnect and release virtual input.
- `genio_set_resolution` (Editor): set Game view rendering resolution without changing a tracked setting.
- `genio_sync_begin` / `genio_sync_end` (Editor): suspend auto-refresh while the owner mirrors the copy, then resume and refresh. SessionState makes begin/end idempotent across retries.
- `genio_step` (Editor): retained historical command; no step toolbar or player IPC exposes it.

Runtime commands use Pipeline's `Unity.Pipeline.Attributes` assembly. Editor controls are in a separate Editor assembly. WebGL is unsupported because `ClientWebSocket` requires a desktop runtime.

## Input and lifecycle

The optional Input System assembly creates virtual keyboard, mouse and gamepad devices while input is captured. Genio sends complete held states. Legacy Input Manager code cannot see those devices; legacy-only games remain view-only.

Pause, release, disconnect, a 300 ms input watchdog, scene/domain reload and quit neutralize input or remove temporary devices. In the Editor, a temporary clone of Input System settings routes input to the game and is restored without saving an asset. `Application.runInBackground` is restored on disconnect. The Editor tick pump runs only while the streaming object is active. Capture can suspend if the Game view is inactive.

Historical smoke testing confirmed held Input System keys and frame delivery, but did not validate prompt device removal/settings restoration after sustained input. Stop the stream or Play Mode for full teardown if release is delayed. This restored version has not received a new real-editor input smoke test.

The main process owns the copy/editor, keeps Unity warm on Stop, quits at the idle deadline, and deletes the copy in the background. See [the lifecycle implementation](../../../docs/player-instance.md). The units' shared slot pool is separate.
