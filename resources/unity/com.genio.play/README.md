# Genio Play 0.2

Unity Pipeline's media companion for the player's temporary copy (Unity 6). Genio embeds this folder under `Packages/com.genio.play` in its marked copy after each mirror. Nothing is installed into the source project or a unit's worktree.

The package is inert until an authenticated Pipeline command starts a session during Play Mode. It dials a token-authenticated WebSocket on `127.0.0.1`; it opens no listener. Frames are JPEGs encoded after GPU readback, up to 1920 × 1920, 30 fps, quality 75. The fixed cadence uses quarter-frame tolerance to avoid skipping frames of a 30 fps game; stalls reset it without catch-up bursts.

## Audio

The optional `Genio.Play.Audio` assembly (compiled only when the project has the built-in Audio module, `com.unity.modules.audio`) streams the game's sound on the same socket. When a session starts it adds a hidden, unsaved filter to the active `AudioListener` and re-checks the listener twice a second, so it follows scene loads and camera switches. The filter sees the final mix, AudioMixer routes included, even while Unity's per-user **Mute Audio** is on; it copies the mix and then zeroes it, so the hidden editor never sounds by itself whatever that setting says. The package never reads or writes that setting. Once a session has started, the filter stays on the listener until the listener goes (scene unload, Play Mode exit), so the editor also stays quiet between sessions and during a resolution swap.

The mixer thread downmixes to stereo (quad, 5.0, 5.1 and 7.1 fold down; LFE is left out) and writes int16 into a preallocated ring: nothing is allocated on the audio thread. A sender thread sends one binary message per mixer block, at most 4096 frames, through the same single-send gate as the frames. Little-endian `GA` v1 packets: `'G' 'A'`, version `1`, channels (`2`), seq u32, sample rate u32, frames u16, reserved u16, capture time f64 (Unix ms), then the interleaved samples. A JPEG starts `FF D8`, so the two never collide. When the sender falls behind (about 1.4 s at 48 kHz) the newest block is dropped and its seq skipped. A scene without an active listener sends nothing.

## Commands

- `genio_stream_start`: `port`, `token`, optional `width`, `height`. Credentials come from main's authenticated Pipeline request and never reach the renderer.
- `genio_stream_stop`: disconnect and release virtual input.
- `genio_set_resolution` (Editor): set Game view rendering resolution without changing a tracked setting.
- `genio_sync_begin` / `genio_sync_end` (Editor): suspend auto-refresh while the owner mirrors the copy, then resume and refresh. SessionState makes begin/end idempotent across retries.
- `genio_step` (Editor): retained historical command; no step toolbar or player IPC exposes it.

`Experimental/GpuShare` holds the spike of a D3D11 shared-texture stream; it compiles only with the `GENIO_PLAY_GPU_SHARE` define, which Genio never sets ([its README](Experimental/GpuShare/README.md)).

Runtime commands use Pipeline's `Unity.Pipeline.Attributes` assembly. Editor controls are in a separate Editor assembly. WebGL is unsupported because `ClientWebSocket` requires a desktop runtime.

## Input and lifecycle

The optional Input System assembly creates virtual keyboard, mouse and gamepad devices while input is captured. Genio sends complete held states. A state's optional `scroll` (wheel notches since the last packet, positive up) becomes the virtual mouse's `scroll.y`, scaled like a real wheel in that project: `InputSystem.scrollWheelDeltaPerTick` when the editor reports it (1 with the uniform Scroll Delta Behavior), else 120 on Windows. Legacy Input Manager code cannot see those devices (including `Input.mouseScrollDelta`); legacy-only games remain view-only.

Pause, release, disconnect, a 300 ms input watchdog, scene/domain reload and quit neutralize input or remove temporary devices. In the Editor, a temporary clone of Input System settings routes input to the game and is restored without saving an asset. `Application.runInBackground` is restored on disconnect. The Editor tick pump runs only while the streaming object is active. Capture can suspend if the Game view is inactive.

Historical smoke testing confirmed held Input System keys and frame delivery, but did not validate prompt device removal/settings restoration after sustained input. Stop the stream or Play Mode for full teardown if release is delayed. This restored version has not received a new real-editor input smoke test.

The main process owns the copy/editor, keeps Unity warm on Stop, quits at the idle deadline, and deletes the copy in the background. See [the lifecycle implementation](../../../docs/player-instance.md). The units' shared slot pool is separate.
