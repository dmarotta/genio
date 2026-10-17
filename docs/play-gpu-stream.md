# Play GPU stream

Play frames reach the canvas through D3D11 shared textures, with the JPEG stream as the automatic fallback. The Recon (e90c) proved the Electron end with stand-ins; step 1, the spike below, ran the Unity end in a real editor; step 2 built it into Play.

## Step 2: the fast path in Play

**Built and on by default where it can run.** On Windows, Genio starts its Play editor with `-force-d3d11` when the project and the machine allow it; frames then go from Unity to the Play canvas as shared textures, at about 60 fps and 1–2 ms from Unity's end of frame to drawn, with no readback, encode or decode. Everything else streams JPEG exactly as before, and any failure switches a running session to JPEG once, without stopping the game. There is no setting, button or message; the one status line and bar are unchanged.

### How it fits

- **Unity (`com.genio.play`, C# source, no native plugin).** `genio_stream_start` takes an optional `genioPid`. With it, and an editor rendering with Direct3D 11, `StreamSession` hands each captured frame to `GpuFrames.cs` instead of the readback: a GPU `CopyResource` into a ring of three shared textures (`D3D11Ring.cs`, the spike's ring with fences required and the adapter's PCI ids added), a fence, and a worker thread that sends `'G' 'F'` once the GPU finished. The ring goes once per session as `'G' 'R'` v2 (size, LUID, PCI vendor and device ids, three NT handles duplicated into Genio's main process). Genio frees slots with `{"type":"free"}` and can ask for `{"type":"jpeg"}`; Unity ends the fast path itself with `'G' 'X'` (not Direct3D 11, no ring, a failed copy) and logs one warning. Audio and input are untouched: same socket, same tap, same packets. The package README has the byte layouts.
- **Main.** `shared-texture.ts` is the one file that touches Electron 44's experimental `sharedTexture` module (import, send, the GPU list, GPU-process exits). `play-gpu.ts` holds the message parsers, the project rule, the GPU match and `GpuSession`: one Unity session's ring, the start-up probe (every handle imports once), the frames it hands out (`TextureFrame`: deliver or drop, freed exactly once) and the fallback. `PlayStream` (`play-stream.ts`) owns a `GpuSession` when the stream asked for the fast path; the frame source and sink contract from the optimization pass (`PlayFrameSource`) gained `onTexture`, and the sink in `ipc.ts` takes either kind of frame. `player-instance.ts` decides the launch flag, opens fast-path streams, restarts a warm editor whose project rule changed, and remembers fallbacks ([player-instance.md](player-instance.md)).
- **Renderer.** The preload registers the shared-texture receiver and passes each `VideoFrame` through `contextBridge` to `PlayLive`, which draws it on the existing 2D canvas (no flip, no decode, no layout work) and returns the credit on the port. The frame is shared, not copied, so the preload closes it and releases the texture only after the listener returned. JPEG frames keep their path.
- **Release order.** Main imports a slot when a credit is free, sends it, then releases its own reference; the renderer releases after drawing; Chromium's `allReferencesReleased` then frees the slot to Unity. A frame superseded before a credit, held during a resize, or after a fallback is freed without importing it. Unity takes a slot back after 2 s whatever Genio says, so a lost free cannot stall the stream; the ring's handles close in Genio when the session ends.

### Selection and fallback

| When | What happens |
|---|---|
| Not Windows, or Electron has no `sharedTexture` | The editor starts as before; JPEG |
| The project fails the rule below | The editor starts as before, on the project's own API (D3D12 by default in Unity 6); JPEG |
| Chromium lists more than one hardware GPU, or none | The editor starts as before; JPEG |
| The ring's size differs, Unity's GPU is not Chromium's, or a handle fails the start-up probe | That session switches to JPEG before its first frame |
| No ring within 5 s of Unity connecting, or no frame within 3 s of playing time after it | That session switches to JPEG |
| Three imports or sends in a row fail, or Chromium's GPU process exits (device loss, driver update, crash) | That session switches to JPEG mid-stream; the game goes on |
| Unity cannot run it (`'G' 'X'`) | Unity switches by itself |

A switch happens once. The editor then streams JPEG for the rest of its life; a hybrid, unknown or different GPU also keeps later Play editors off Direct3D 11 until Genio restarts. The project rule is the spike's [fallback rule](#fallback-rule-when-a-project-cannot-use-d3d11), read from the copy before each launch (`d3d11Rule`): the Windows API list must allow Direct3D 11, and nothing may need Direct3D 12 (ray tracing in an HDRP asset, a `.raytrace` shader or a script; a Shader Model 6 `#pragma require`; variable-rate shading). It is part of the warm editor: a Play that finds it changed restarts the editor. The first Play on Direct3D 11 compiles that API's shaders once, inside Starting Unity. The path in use is in Genio's log (`[player-instance]` at launch, `[play-stream]` per session and on a fallback), never on the Play screen.

### Measured (smoke test, 2026-10-17)

A scratch Unity 6000.5.1f1 project on a hidden desktop, launched as Genio launches the Play editor, with the real `com.genio.play`, against a consumer that runs Genio's own `PlayStream`, `play-gpu.ts` and `shared-texture.ts` (bundled from `src/main`), the `ipc.ts` sink logic, the preload receiver and a `PlayLive`-style draw. RTX 3060 Ti; four other Unity editors open, the machine otherwise quiet (CPU about 6 %). Two 15 s runs per row; latency is from Unity's end of frame to just after `drawImage`, joined by frame number.

| Path | Size | Shown fps | Latency p50 / p95, ms | CPU, % of one core: Electron main / GPU / renderer, editor | Frame checks |
|---|---|---|---|---|---|
| JPEG (before) | 1280 × 720 | 30.0 | 27.1–27.4 / 30.6–30.7 | 2.8 / 5.1–5.2 / 11.5, 4–5 | 902/902 |
| GPU (after) | 1280 × 720 | 59.9 | **1.1–1.3** / 1.8–2.5 | 4.7 / 12.0–12.6 / 5.6–5.8, 4 | 59/59 |
| JPEG (before) | 1920 × 1080 | 20.6 | 41.3–41.8 / 44–52 | 2.6–2.9 / 4.8–5.2 / 14.4–15.9, 16 | 621/621 |
| GPU (after) | 1920 × 1080 | 59.7–59.8 | **1.5–1.6** / 2.8–4.3 | 4.4–4.8 / 13.4–13.6 / 5.8–6.2, 4–5 | 60/60 |

The GPU path draws twice the frames for about the same Electron CPU, and at 1080p takes the JPEG encode off the editor (16 % → 4–5 % of a core). Game sound flowed beside the frames in every run (about 1,030 packets in 15 s).

| Check | Result |
|---|---|
| Resize 720p → 1080p mid-stream (a new session and ring, as Genio resizes) | Stayed on the GPU path; 65 ms between the last small and the first large frame |
| Imports fail from 6 s (injected) | Third failure → `{"type":"jpeg"}`; JPEG frames 132 ms after the last GPU frame; the game kept running |
| Chromium's GPU process killed at 6 s | Fallback at the exit event; JPEG frames from the next frame on (8 ms gap); the game kept running |
| A Direct3D 12 editor asked for the fast path | Unity sent `'G' 'X'` 1 and one console warning, then JPEG on the same session at 29.6 fps |
| The scratch project set to Direct3D 12 only | `d3d11Rule`: no ("the Windows graphics API list has no Direct3D 11") |
| Handles in Electron main | The same +72 after every run, one ring or two, 1,315 frames: no leak |

Not tested on real hardware: a hybrid laptop (the rule falls back on two GPUs without trying) and a GPU of another vendor.

## Step 1: the Unity spike

**Verdict: go for build step 2.** Every part the Recon could not run works in Unity 6000.5.1f1 with no native plugin. The rest of this page is the spike's report; its session code became `Runtime/GpuFrames.cs`.
### Setup
- Unity 6000.5.1f1, launched like the Play editor (`launchEditor` from `resources/unit-skills/genio/lib/hidden-desktop.mjs`, `-automated -projectPath … -logFile …` on a fresh hidden desktop) plus `-force-d3d11`.
- A scratch project in a new `%TEMP%` folder, deleted afterwards. It holds the real `com.genio.play` (Pipeline's attribute stubbed, since the spike starts sessions directly) and a test scene: moving cubes and a strip of 20 blocks that spell `Time.frameCount`.
- The consumer is the Recon's Electron 44.7.0 app, now serving the same authenticated `/play` WebSocket as `src/main/play-stream.ts`. It imports each frame with `sharedTexture`, draws it on a 2D canvas and reads the blocks back from the drawn canvas.
- One editor at a time, on an RTX 3060 Ti, 2026-10-17. Other units' Unity editors were running, at times using up to 13 cores; see Tails.

### What was proven
- **`-force-d3d11` works on the hidden desktop.** The log says `Forcing GfxDevice: Direct3D 11`, `Direct3D 11.0 [level 11.1]`, `kGfxThreadingModeNonThreaded`. It also wins when the project's Windows API list is Direct3D12 only, so Unity never refuses by itself: Genio must decide (Fallback rule).
- **The device comes from the stream texture.** `RenderTexture.GetNativeTexturePtr()` answers `QueryInterface(ID3D11Texture2D)` (a D3D12 resource would answer E_NOINTERFACE). `ID3D11DeviceChild::GetDevice` returns Unity's own device, which has `ID3D11Device5` (fences) and `ID3D11DeviceContext4`. The adapter LUID (0x11e56) is the one Windows lists for Chromium's GPU process.
- **Mono runs the COM calls.** P/Invoke plus vtable calls through `Marshal.GetDelegateForFunctionPointer` work in Unity's Mono. There is no unsafe code and no DLL. The vtable slots were checked against the Windows SDK's C declarations.
- **Both threading modes work.** By default the editor has no render thread, so the copy runs on the main thread at end of frame. With `-force-gfx-mt` (`kGfxThreadingModeThreaded`), it runs on Unity's render thread through `GL.IssuePluginEvent` with a managed callback (`Marshal.GetFunctionPointerForDelegate`, `[MonoPInvokeCallback]`). That was 59.1 fps, 2.0 / 3.8 ms, 30/30 frame checks.
- **Handles cross from the editor to Electron.** Unity duplicates the ring's NT handles into Electron main's PID once per ring. Electron imports each frame (0.11 ms) and frees the slot back on `allReferencesReleased`.
  - 22,621 frames in 20 GPU runs, 0 import or send errors.
  - Every frame check matched: 535 of 535 on the GPU path (every 30th frame, read from the drawn canvas) and 3,839 of 3,839 frame numbers on the JPEG path.
  - No leak: Electron main had 13 more handles after 60 s and 3,365 frames, against 17 more after a 15 s run.
- **Sync without a keyed mutex.** `CopyResource`, then `ID3D11DeviceContext4::Signal` on a fence and `SetEventOnCompletion` with a wait handle per slot. A worker thread waits and sends the frame message, so the game never waits for the GPU. A slot is reused only after Genio frees it. Without `ID3D11Device5`, the code falls back to event queries polled on the render thread (`D3D11Ring.Poll`).
- **Orientation.** After `CaptureScreenshotIntoRenderTexture` and `Blit`, the D3D11 stream texture's first row is the top of the picture. Draw it as is; no flip. The JPEG path flips only because readback rows are bottom-up.

### Numbers
From Unity's end of frame (t0) to just after `drawImage` in the renderer. On the GPU path, t0 travels in the frame message. On the JPEG path, the frame number read back from the drawn image finds t0 in Unity's frame log. Both clocks are the system clock (`GetSystemTimePreciseAsFileTime` against `performance.timeOrigin`). Each figure is the median over the repeats, with the range in brackets. The JPEG path is today's: `StreamSession` at 30 fps, AsyncGPUReadback, `EncodeArrayToJPG` q75, PlayStream's 25 ms throttle, one credit, `createImageBitmap`.

| Path | Runs | Shown fps | Latency p50, ms | Latency p95, ms | Electron CPU, % of a core | Editor CPU, % of a core |
|---|---|---|---|---|---|---|
| GPU 720p @60 | 5 | 56.4 [27–60] | **2.1** [1.6–2.8] | 8.9 [3.8–27] | 25 | 39 |
| GPU 1080p @60 | 5 | 53.7 [35–56] | **2.7** [2.1–3.2] | 12.5 [5.7–61] | 31 | 55 |
| GPU 720p @30 | 2 | 29.9 | 1.6–2.8 | 6.4–57 | 19 | 33 |
| GPU 720p @60, render thread | 1 | 59.1 | 2.0 | 3.8 | 28 | 12 |
| JPEG 720p (today) | 5 | 21.8 [15–28] | **36.9** [30–49] | 72 [46–106] | 23 | 58 |
| JPEG 1080p (today) | 5 | 14.7 [10–20] | **63.5** [52–85] | 97 [65–166] | 26 | 59 |

On the quietest pair (B1 and B2, with other editors at most 76 % of a core), the GPU path ran at 59.7 fps with 1.55 / 3.9 ms; JPEG ran at 28.0 fps with 30.4 / 46.2 ms.

Unity's cost per frame on the GPU path:
- capture and Blit: 0.04 ms of CPU;
- `CopyResource`, Signal and Flush: 0.2–0.7 ms on the main thread (0.06 ms when queued to the render thread);
- end of frame to GPU done: 0.7–0.9 ms (median);
- a new ring: 0.8 ms (11 ms the first time, which includes JIT).

Electron's cost per frame: import 0.11 ms, main to renderer 0.7–1.3 ms, draw 0.2–0.3 ms.

"Editor CPU" is the whole editor process, including rendering the scene at 60 fps on both paths; other editors made it noisy. At 1080p the JPEG encode alone took it from about 40 % to about 60 %.

**Tails.** The GPU path's p95 outliers sit between Unity's end of frame and GPU completion. They come in bursts while other editors load the machine; transport and drawing stay under 2 ms. The JPEG path waits for the same GPU completion before its readback, then adds readback, encode, decode and throttle.

**Resizing.** The GPU session swaps to a new ring in place; the old ring's handles close once Genio frees its slots.
- Gap at the switch: 66–109 ms (155 ms under load). Today's JPEG restart: 94–140 ms.
- After the in-place swap to 1080p, the median latency was 6.1 ms in the clean run (2.7 ms for a session started at 1080p) and 56 ms in one loaded run.
- Step 2 should restart the session at the new size, as Genio does for JPEG today, unless the in-place swap is shown to be as fast.

### What failed, and the alternatives
Nothing in the chain failed: the device pointer, the marshalling, `-force-d3d11` and the handle sharing all worked. Points found on the way:
- **The orientation guess was wrong.** The first two runs drew upside down, so their frame checks failed. The ring message keeps a bottom-up flag, now measured off.
- **Asset import workers run `[InitializeOnLoad]` too, on Unity's default API (D3D12).** Harmless for the stream, which only runs in Play Mode, but editor hooks must check `AssetDatabase.IsAssetImportWorkerProcess()`.
- **A scripted `PlayerSettings.SetGraphicsAPIs` during Play Mode was not saved,** so the serialized form below was written by hand and read back by the editor.

Not tested: a hybrid laptop (this machine has one GPU), and a sandboxed renderer.

If a machine fails where this one did not:
- **No `ID3D11Device5` fence:** event queries, already built in.
- **Mono marshalling misbehaves:** a tiny native plugin (`IUnityGraphicsD3D11` plus `IssuePluginEvent`) doing the same calls. It needs MSVC and a reviewed binary, so it is the last resort.
- **The import fails in Chromium, or the GPU process restarts:** JPEG for that session.
- **A different adapter:** compare Unity's `SystemInfo.graphicsDeviceVendorID` and `graphicsDeviceID` (and the ring's LUID) with Electron's active `gpuDevice` (`app.getGPUInfo('complete')`, which exposes no LUID). On a mismatch, use JPEG.

### Fallback rule: when a project cannot use D3D11
Genio decides before it launches the Play editor, from the project's files, because Unity applies `-force-d3d11` whatever the project says. A project gets `-force-d3d11` and the GPU stream only when all of these hold:

1. **Windows.** On other systems the stream stays JPEG.
2. **The Windows API list allows D3D11.**
   - Look in `ProjectSettings/ProjectSettings.asset`, under `m_BuildTargetGraphicsAPIs`, for the entry with `m_BuildTarget: WindowsStandaloneSupport`.
   - No entry, `[]`, or `m_Automatic: 1` means automatic, and automatic includes D3D11.
   - With `m_Automatic: 0`, `m_APIs` is a hex run of little-endian int32 `GraphicsDeviceType` values. Use D3D11 only if the run contains `02000000` (Direct3D11).
   - Other values: `12000000` Direct3D12, `15000000` Vulkan, `11000000` OpenGLCore. A Direct3D12-only project reads `m_APIs: 12000000`.
3. **No ray tracing.** An HDRP asset with `supportRayTracing: 1`, any `*.raytrace` shader, or `RayTracingShader` / `RayTracingAccelerationStructure` in the project's scripts means it needs D3D12.
4. **No D3D12-only shader or GPU features.** Look for `#pragma require` naming a Shader Model 6 feature (`wavebasic`, `wavevote`, `waveballot`, `wavemath`, `wavemultiprefix`, `quadshuffle`, `native16bit`, `int64`, `int64bufferatomics`, `barycentrics`, `meshshader`, `raytracing`, `inlineraytracing`, `setrtarrayindexfromanyshader`), or variable-rate shading (`ShadingRateImage` / `ShadingRateInfo`). D3D11 stops at Shader Model 5.0.
5. **At runtime:**
   - `GpuStreamSession.StartStream` throws unless `SystemInfo.graphicsDeviceType` is Direct3D11.
   - The ring must import in main, and the adapter must match (above).
   - Any failure, including a GPU-process restart, falls back to JPEG for the session.

When a rule says no, the Play editor launches exactly as today: no `-force-d3d11`, the project's own API (D3D12 by default in Unity 6), and the JPEG stream. Nothing appears on the Play screen (step 2 names the path in Genio's log). Two more points for step 2:
- The API is part of the warm editor's identity. A project-settings change between D3D11 and D3D12 restarts the editor at the next Play.
- The first D3D11 Play compiles that API's shader variants once, into the copy's Library.

### ### Code

The spike's `Experimental/GpuShare` folder is gone: its ring is `resources/unity/com.genio.play/Runtime/D3D11Ring.cs` (event queries dropped, fences required) and its session became `Runtime/GpuFrames.cs` inside `StreamSession`. `scripts/play-gpu-spike/` (not shipped) now drives the shipped path, and is the smoke test for step 2 and for every Electron upgrade:
- `run-spike.mjs launch [--d3d12] | run | quit [--keep]`: the scratch project (in a new `%TEMP%` folder, deleted by `quit`), the hidden-desktop launch with or without `-force-d3d11`, consumer runs with Genio's `src/main/play-stream.ts` bundled in, and cleanup;
- `consumer/`: the Electron consumer (the `ipc.ts` sink and resize swap in `main.js`, Genio's preload receiver in `preload.js`, a `PlayLive`-style draw and frame checks in `renderer.js`); `--fail-imports-at` and `--kill-gpu-at` inject the fallbacks;
- `unity/Assets/`: the scene (moving cubes, a 440 Hz tone, the frame-number strip), the run driver and the Pipeline stub;
- `summarize.mjs`: the results table;
- `RingTest.cs`: a no-Unity check of `D3D11Ring` with the .NET Framework `csc.exe`.

Rerun (needs Unity 6000.5.1f1 and the worktree's Electron; data goes to the folder given):

```
node scripts/play-gpu-spike/run-spike.mjs launch --data <dir>          (in the background; prints launched, then watches dialogs)
node scripts/play-gpu-spike/run-spike.mjs run --data <dir> --label G1 -- --mode gpu --w 1280 --h 720 --seconds 15
node scripts/play-gpu-spike/run-spike.mjs run --data <dir> --label J1 -- --mode jpeg --w 1280 --h 720 --seconds 15
node scripts/play-gpu-spike/run-spike.mjs run --data <dir> --label R1 -- --mode gpu --w 1280 --h 720 --resize-at 6 --seconds 15
node scripts/play-gpu-spike/run-spike.mjs run --data <dir> --label F1 -- --mode gpu --w 1280 --h 720 --fail-imports-at 6 --seconds 15
node scripts/play-gpu-spike/run-spike.mjs run --data <dir> --label K1 -- --mode gpu --w 1280 --h 720 --kill-gpu-at 6 --seconds 15
node scripts/play-gpu-spike/run-spike.mjs quit --data <dir>
node scripts/play-gpu-spike/summarize.mjs <dir>/results
```