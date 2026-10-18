# Inventory model viewer performance

Measured on Windows in Electron 44 / Three r186, 2026-10-16. Baseline: `cb62958410ba8423ece95305f34a8eaa836b6e00`. Source models were opened directly from the registered project folders, read-only. No project assets were copied, converted or changed.

## Results

These are individual controlled traces with a shown, inactive benchmark window, a script-only sandboxed iframe, the real `genio-media://model` handler, and a separate Electron profile for each revision. Times below start at the frame's `open` command, excluding startup. The probes use `gl.finish()` **only in the benchmark** to include completed first-frame GPU work. Disk and shader caches affect these numbers; this is not a universal speedup claim.

| Real model | Bytes | First frame before → after | Complete before → after | What is visible now |
|---|---:|---:|---:|---|
| lands-of-old `SM_Work_Stool.fbx` | 69,696 | 28.9 → 33.1 ms | 23 → 35 ms | Geometry; no textures |
| Same prop, warm frame | 69,696 | 18.9 → 23.4 ms | 12 → 24 ms | Geometry, with no new frame startup |
| lands-of-old `LOD0_Orc_Basic_House.fbx` | 5,004,044 | 371.9 → 378.4 ms | 346 → 381 ms | Geometry; no textures |
| lands-of-old `SK_Viking.fbx` | 21,028,224 | 1,578.6 → 1,609.9 ms | 1,313 → 2,848 ms | Geometry first; 15 textures resolve, 7 remain missing |
| founders-of-avalon `ShoreGull.glb` | 1,515,244 | 54.1 → 29.0 ms | 32 → 74 ms | Geometry first, then its embedded image |
| lands-of-old `Ch36.fbx` | 35,099,440 | 888.3 → 334.2 ms | 813 → 1,068 ms | Geometry first, then embedded/PNG maps |
| lands-of-old `Rubble.fbx` | 79,824,752 | No frame: deliberately capped | Failure 4.6 → 1.9 ms | “Rubble.fbx is larger than the 64 MB preview limit.” |

The Ch36 first frame arrives 62% sooner. Viking's completed load does more work now: the old folder scope missed all 22 referenced images. The new lookup finds 15 of them in `HeroViking/Textures`; comparing its complete time as a speed regression would compare clay against textured geometry. The seven unresolved names remain explicit warnings. The small untextured cases have essentially the same parsing cost and a few milliseconds of extra first-render scheduling.

The old `loadMs` stopped before the first GPU upload, so it could report “loaded” before pixels appeared. The new value includes the final texture render. Use the **first frame** column for responsiveness and the **complete** column for when all texture work finishes.

## Phase measurements

All values are milliseconds, before → after. “Read/transfer” includes file lookup and streaming into the sandbox's ArrayBuffer; model bytes never pass through IPC or base64. “GPU/render” is the first render through `gl.finish`, including shader compilation and upload. “Texture wait” is after synchronous FBX parse in the baseline, and after the geometry frame in the new viewer. Zero means no image work. These overlapping stages are not additive.

| Model | Read/transfer | Loader parse | Texture wait | Worker decode + resize, summed | First GPU/render |
|---|---:|---:|---:|---:|---:|
| Stool | 3.8 → 4.2 | 14.9 → 15.2 | 0 → 0 | 0 → 0 | 6.1 → 11.9 |
| Stool, warm | 1.6 → 2.0 | 7.9 → 7.9 | 0 → 0 | 0 → 0 | 4.8 → 13.1 |
| House | 11.8 → 11.5 | 327.7 → 328.4 | 0 → 0 | 0 → 0 | 25.5 → 33.9 |
| Viking | 40.5 → 38.9 | 1,176.2 → 1,165.2 | 3.4 → 996.2 | 0 → 503.9 | 264.5 → 318.0 |
| ShoreGull GLB | 6.5 → 3.8 | 22.5* → 5.8 | Included* → 24.0 | Native loader* → 18.6 | 12.3 → 18.7 |
| Ch36 | 62.6 → 71.7 | 148.4 → 168.9 | 572.1 → 700.0 | 1,497.6 → 658.3 | 74.8 → 62.1 |

*The baseline GLTFLoader completes its asynchronous parse only after its image dependencies. Its 22.5 ms includes image resolution/decode; it cannot be counted as separate pure CPU parse and texture time. The new ordinary-image path returns geometry before decoding images. Ch36's old decodes overlapped; their summed durations exceed wall time. New decodes are serial to bound peak memory. Actual texture lookup/response setup was at most about 3.2 ms in the initial real-file run; no slow multi-second search was observed. The added deadline protects slow or unavailable storage regardless.

Fresh-frame startup after the first page was approximately 97–126 ms in these traces. First-page startup was 340 ms before and 231 ms after with development modules cached; earlier cold runs were 1.36 s and 0.72 s. Those cache-dependent differences are not attributed to this change. Reselection now keeps the same iframe, WebGL renderer and Draco/KTX2 instances, eliminating repeated startup. The baseline benchmark also explicitly exercises a warm frame for comparison, although the old Inventory component remounted it on every selected model.

The 76.1 MiB rubble file was tested under the normal 64 MiB cap. Its parse, texture decode and upload phases never run. The historical uncapped 90-second Recon freeze was not reproduced by bypassing this protection. PSD remains unsupported and fails fast; this change does not claim to add a PSD decoder.

## Confirmed causes and changes

- **Geometry waited for images.** FBX, OBJ, Collada, 3DS and ordinary glTF images now render geometry first. Material groups use clay until their images arrive, then restore their original material. Texture progress counts completed image sources, including failures. Compressed KTX2 still uses Three's supported worker path; USDA's loader retains its own texture-ready callback.
- **Too much simultaneous texture work.** TGA already used a worker in the baseline; the 90-second main-thread TGA implementation was not present here. Fetch/decode now runs serially with an 8-second per-image deadline, cancellation and worker termination. Images are capped at 1024 px for the inspector and 512 px for thumbnails. No JavaScript TGA fallback runs on the UI thread when workers are unavailable. glTF's ordinary images now use the same worker/cap before their first upload. A source is marked for upload once when it arrives, rather than re-uploading every prior map on each progress event.
- **Unity sibling images did not resolve.** The shared, case-insensitive index includes the model folder and the conventional sibling `Textures` folder. It stops at 5,000 entries, four levels and a one-second scan budget; a request waits at most 1.2 seconds for that index. It does not search arbitrary sibling folders or the whole project. Every served candidate still passes Inventory's real-path guard.
- **No foreground priority.** Interactive grants pause thumbnail hashes and pending draws. A running thumbnail's hidden window is destroyed so its parser/GPU work cannot continue competing. Interrupted thumbnails retry after the interactive load finishes and do not poison the failure cache. The inspector and thumbnails retain separate windows/contexts. A 35-second priority lease also releases a crashed/disconnected host. Interactive grants cannot be evicted by rolling thumbnail grants; selection cleanup revokes them.
- **Startup and selection could leave a spinner.** One host watchdog now covers IPC/grant, module startup, the ready handshake, reading, parsing and texture work. It is not restarted by progress or duplicate ready messages. Read/parse/texture progress, Cancel, Retry and phase-specific timeout reasons are visible. A failure discards the frame; a retry gets a fresh one. Normal model changes reuse the warm frame, abort previous file/texture requests, dispose the previous model, and reject stale request IDs. The Inspector also cancels as soon as selection changes, while new asset info is arriving.
- **Transport already streamed.** No main-to-renderer model byte cloning/base64 was found. The existing protocol keeps streaming; it now supports bounded and suffix byte ranges, HTTP 206/416, HEAD and the same per-file size guard on every path.
- **Synchronous work inspected.** FBX parsing dominates the 20 MB Viking, at about 1.17 seconds; this change does not move FBX scene parsing to a worker. Skeleton helpers were already created only when shown. Unity clip extraction now has a 1.5-second sidecar deadline and a 512-clip cap, matching the protocol/action limit. Normal computation remains necessary for formats that omit normals, rather than being repeated on every frame.

## Reproduction

Create a manifest outside the source projects, then run from the checkout:

```json
[
  { "world": "example", "root": "C:/Projects/Game", "asset": "Assets/Models/hero.fbx", "size": 21028224 },
  { "world": "example", "root": "C:/Projects/Game", "asset": "Assets/Models/hero.fbx", "size": 21028224, "reuse": true }
]
```

```powershell
node scripts/model-viewer-benchmark.mjs <scratch>/before <scratch>/manifest.json cb62958
node scripts/model-viewer-benchmark.mjs <scratch>/after <scratch>/manifest.json
```

The optional revision is read with `git show`; no checkout or source-project copy occurs. The harness uses plain viewer TypeScript, not the React app. It emits `results.json` (phase probes/messages), `summary.json`, `requests.json` (protocol setup/status) and `console.json`. Its profile and child home directories stay under the output folder, which is rejected if it lies inside any source project. The viewer's own CSP and sandbox remain enabled.

This run's manifests, profiles and raw traces live under the unit scratch directory `<Genio home>/workspaces/genio/data/fix-inventory-model-viewer-gets-stuck-or-8eb3/`, in `before-measured/` and `after-measured/`. Exact source paths are retained in those manifests rather than embedding private project roots in reusable code.

## Regression checks

```powershell
Get-ChildItem Env: | Where-Object Name -Like 'GIT_CONFIG_*' | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
npm run typecheck
npm test -- --maxWorkers=4 --testTimeout=15000
npm run perf -- model-viewer.perf
npm run build
npm run test:e2e -- model-viewer.e2e model-thumbnails.e2e
$env:MODEL_VIEWER_BUILT='1'
npm run test:e2e -- model-viewer.e2e
```

`tests/perf/model-viewer.perf.ts` generates a 200,000-triangle FBX (9,995,337 bytes) and glTF with a separate 7,200,000-byte buffer. It streams them through the real file service, parses them with Three, checks 600,000 vertices and a ten-second regression budget, and disposes resources. No large fixture is committed. On this run FBX read/parse took 33.0/231.4 ms; glTF manifest read/parse including its buffer took 1.4/21.8 ms. Set `MODEL_VIEWER_PERF_RESULTS` to retain its JSON timings.

Unit tests cover cancellation before/inside texture IO, stale results, one-open-per-ready, warm frame reuse, Cancel/Retry, timeouts before IPC or ready, priority preemption/lease recovery/stop, separate grant lifetimes, range responses and sibling lookup. Real Chromium tests check geometry before delayed textures, cancellation while reading and while textures are pending, every supported format, Draco, texture orientation/downscaling, sandbox isolation, thumbnail timeout recovery, and 100 load/dispose cycles without GPU resource growth.

Default five-second unit-test limits produced unrelated process-launch timeouts in archive/Unity/hook tests under machine contention. The validation command above allows 15 seconds for those test fixtures without changing production timeouts. Performance traces were captured separately from the full suite.

Final validation: typecheck and production build passed; all 1,840 unit tests in 173 files passed with four workers and the 15-second fixture limit. The generated performance test passed. The development viewer passed 8 Chromium checks, thumbnails passed 3, and the production-bundle viewer passed the same 8 checks, including cancellation and the GPU disposal test.
