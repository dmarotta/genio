# Genio Play 0.1

An opt-in media companion to Unity Pipeline, for Unity 6. It streams the rendered game screen as JPEG (up to 1920 × 1920, 30 fps, quality 75) using GPU readback and a worker encoder. There is no audio. The package is inert until `genio_stream_start` runs during Play Mode or in a running player with Pipeline enabled. It opens no listener: it dials a token-authenticated WebSocket on `127.0.0.1` only.

Genio's Play screen installs the bundled tarball in the project's `.genio/unity/` folder and adds a relative `file:` dependency to the Unity manifest. These changes stay uncommitted. Commit them before preparing a branch slot. The install preserves unrelated packages and never changes Toolbox or the package lock directly. Wait for Unity to import the package, enter Play Mode, then start live streaming. Snapshot mode remains available without this package.

## Commands

- `genio_stream_start`: `port`, `token`, optional `width` and `height`. Credentials come from Genio's authenticated Pipeline call; keep them out of logs and reports.
- `genio_stream_stop`: close the socket and release input.
- `genio_step` (Editor): advance one frame while paused.
- `genio_set_resolution` (Editor): `width`, `height`, 16–3840. Updates the Game view's user resolution entry, not a tracked project setting.

Runtime commands use the `Unity.Pipeline.Attributes` assembly introduced in Pipeline 0.8. Editor-specific controls are in a separate Editor assembly. Development players must have Pipeline's runtime server enabled to invoke the start command; Genio's Play screen currently attaches to editors only. Player builds have no Editor tick pump. WebGL is unsupported (`ClientWebSocket` requires a desktop runtime).

## Input and lifecycle

The optional Input System assembly creates virtual keyboard, mouse and gamepad devices only while input is captured. Genio sends complete held states, rather than queued key presses. Legacy Input Manager code cannot see those devices. In mixed-input games those paths remain view-only.

Input is neutralized on pause, focus loss, release, disconnection and a 300 ms input watchdog. In the Editor, a temporary clone of Input System settings routes input to the game; the original settings object is restored without saving an asset. Scene reload, domain reload, detach and quit remove temporary objects and devices. After a reload, restart the stream from Genio. Keep the Game view tab active in Unity: Unity's end-of-frame capture can suspend when another editor tab becomes active.

**Experimental input limitation:** the Unity 6000.5.1f1 smoke confirmed W held for 132 gameplay samples and one `<Keyboard>/w` action, with the virtual keyboard enabled and current. Explicit release did not remove devices or restore the original settings within the probe's 200 ms window after a sustained input burst. Editor load/queued packets can delay release. Leave capture off for observation, and stop the live stream or Play Mode for full detach if input remains held. Do not treat this version's release latency as validated for interactive play. The task's `smoke-result.json` and `unity-smoke/editor-guidance.log` contain the diagnostics; the run also received 142 JPEG frames in five seconds. No further input smoke was attempted after this result, as directed by Genio.

The Editor tick pump uses the same `SignalTick` method validated by the throttle spike, while the temporary streaming object is active. It does not change Pipeline's own autotick preferences. `Application.runInBackground` is restored on disconnect.

## Shared instances

The Play screen and the bundled unit `play` skill share per-project pool state under Genio's main data directory. The default cap is one, configurable from one to eight. Slots are independent local Git clones of committed revisions, with a Library seeded once from the main copy. They never share Assets, Packages or ProjectSettings through links. Pipeline credentials and editor instance metadata are not seeded.

An atomic directory mutex serializes state updates. Leases carry a random token, PID and 30-second deadline, renewed every five seconds; stale leases and queue entries are reclaimed. Requests queue FIFO. Player takeover rotates the lease token, fencing subsequent commands by the previous owner. It cannot undo a Unity command already executing. A slot's branch cannot change while its editor is open or its checkout has local changes. Returning to main releases the lease and leaves the slot editor warm.

A transaction lock left by a process that crashed during a state write requires operator inspection. Its owner record is inside `mutex/owner.json`; units must never delete shared state to recover. Main-editor controls are coordinated between Genio processes. Unit enforcement is a helper/brief guardrail under the same OS account, not a sandbox.

## Validation

Rebuild the deterministic tarball with `node scripts/pack-unity-play.mjs` from the Genio repository. Run `npm run typecheck` and `npm test`. The manual smoke script uses a disposable project named `unity-smoke`; launch that fixture with `-automated`, import the package, then run:

`node --experimental-transform-types scripts/play-stream-smoke.mjs <scratch-project> <scratch-output>`

Copy `scripts/unity-smoke/GenioInputProbe.cs` into the disposable fixture's Assets before launching. The probe records held input and a `<Keyboard>/w` action in gameplay updates; Editor callbacks can read a different input state buffer. It logs device identity, enabled state and received W state. The script verifies frame delivery, release/settings restoration, pause, step, resolution and stop, and separately records any input limitation (exit code 2). It saves a JPEG orientation fixture (green above blue) and a JSON report in scratch output. Never target a game project with this script.
