# Inventory backend

Step 2 supplies a read-only per-project index and media transport. It does not add
the Inventory screen, generation, placement, drafts or undo.

## Screen contract

- `inventoryOpen(world)` starts watching this project (closing any other project's
  watcher). It never waits for a scan: it returns cached state immediately and
  reconciles in the background. Without a cache the first scan streams into the
  index in pages; `state.indexing` reports `{done, total}` and the revision bumps
  about every 250 ms so the open screen fills as it runs. Nothing scans at app
  start; a project is first indexed when Inventory opens or a tool asks for it.
  State includes the registered engine and engine root, revision, counts,
  refresh/watch status and errors.
- Subscribe to the `inventory` event and re-query when its revision changes.
  `inventoryList(world, query)` returns a paginated asset list, matching total and
  immediate child folders with recursive media counts. Paths remain relative to
  the **project**, including a nested engine root.
- Use `{folder, recursive: false}` for a folder listing. Omit `recursive` to search
  descendants. `kinds`, `tags`, `generated`, `scope` (`ours` by default), `sort`,
  `descending`, `offset` and `limit` are typed in `shared/inventory.ts` (limit caps
  at 1,000). Empty folders are omitted. Name/path matching uses `matchScore`.
- Search tokens: `t:sfx`, `t:3d`, `t:sprite`, `t:texture`, `ext:psd`, `in:UI/Buffs`,
  `l:"unity label"`, `by:unit`, `via:fal`, `new:7d`, `size>20mb`, `lfs:missing`.
- `inventoryInfo(world, path, verifyHash?)` hydrates hidden Unity/Godot sidecar bits,
  returns provenance and preview URLs, and optionally streams a SHA-256 comparison
  in a worker. Enumeration never hashes media. A provenance record marks a file
  generated regardless of whether its author was a player, unit or Genio.
- Call `inventoryRefresh(world)` on focus; this also covers platforms where
  recursive watching is unavailable. Call `inventoryClose(world)` on leaving the
  screen. Watch events are debounced 300 ms. A batch of only `change` events
  re-stats the affected known assets without running Git; renames, ignore/config
  changes, a large batch or an explicit refresh enumerate with Git and stat-diff
  every asset. Each indexed path keeps a size/mtime/sidecar/record stamp; equal
  stamps reuse the entry without reading. A refresh that changes nothing keeps
  the revision, so the screen does not re-query. This matters on Windows, where
  reading files updates last-access times and the recursive watcher reports them
  as changes; before stamps, Inventory's own reads re-triggered full rescans.
  `list` memoizes the sorted match per revision and filters, so the tree, grid
  and scrolled pages share one filter/sort.

## Index and transport

`git ls-files -z -t --cached --others --exclude-standard` is the sole project
enumerator. Engine caches are explicitly excluded before stat/sidecar reads,
including nested `Library`. No fallback disk walk occurs for a non-Git project.
Build output directories are excluded by exact names (`Build`, `Builds`,
`BuildOutput`), preserving legitimate `Buildings` art. Other output follows
`.gitignore`. Submodules are not recursively enumerated.

Stat and LFS header reads run in a Node worker that streams results in pages of
256; the main thread yields between enumeration batches. Sidecar contents are
read only on demand: for the selected asset (inspector) or when a label/sprite/
texture filter needs them. Hydrated metadata persists in the index. Reads are
bounded to 64 KiB for sidecars and 256 KiB for provenance. `.meta`, `.import` and
`.genio` files never become tiles. `.tres` files are checked for a material type.
Vendor detection uses known folder names, configured prefixes and a conservative
pack heuristic (documentation plus demos/scenes). `.genio/assets.json` accepts
project-relative `vendor` and `ignore` prefix arrays; it is never written.

`data/inventory/<world>/index.json` is versioned (v2 adds stamps; v1 still loads
and is re-read once) and atomically replaced.
`genio-media://world/<world>/<path>` supports nested paths and Range requests;
guards reject traversal, Windows alternate streams, hidden control/cache folders,
and symlinks/junctions escaping the project. `.gltf` companion buffers can use the
same route. No route or index operation writes into a project.

Request `genio-media://thumb/<world>/<path>` only for visible tiles. Native image
formats decode via `createImageBitmap` and `OffscreenCanvas` in a Web Worker hosted
by a lazy, hidden, sandboxed renderer. Input is capped at 64 MiB, decoded images at
64 megapixels, output at 256 px and 1 MiB, and jobs at 20 seconds. Jobs are serialized
and duplicate requests coalesced. A queued job whose requests were all aborted
(tile scrolled away) is skipped. Cache hits do not wait for the one-off walk of
the thumbnail cache; that walk happens only before the first write. Unsupported/oversized/LFS assets return 404 so
the screen can show a type icon. DCC/HDR decoding, waveforms, video posters and
model snapshots belong to later preview steps.

WebP thumbnails live in `data/thumbs/<world>/`, keyed by root/path/size/mtime with a
1 GiB per-project LRU cap. Only Genio's thumbnail cache is walked for eviction.

## Measurements (Windows, 2026-10-13)

On lands-of-old, Git enumeration plus filtering took **337–366 ms** for **27,825
paths**, producing **6,616 media entries**. The full stat/index pass took
**1.16–1.20 s**; cached opening does not wait for this pass. Sidecar hydration and
thumbnail generation are separate from enumeration.

Spike 0c used five real PNGs (78 B–1.67 MB): native worker thumbnail requests took
**12–47 ms** after startup, **126 ms** for the first request including host creation,
and **0.8 ms** for a cache hit. All five output WebPs were independently decoded
and measured at no more than 256 px. Outputs ranged from 526 B to 10.4 KB. The
project was read only; benchmark caches lived in the unit's Genio scratch data.

### Open latency (Windows, 2026-10-13, async/lazy index)

The service was measured in-process: open → first page → settled, with a 5 ms
timer measuring main-thread stalls. On a synthetic project (12,000 media files with
`.meta` sidecars and access times aged 3 days, so reads trigger last-access
watcher events), the results were:

| | before | after |
|---|---|---|
| cold open (no cache) | 4,738 ms, blocked on full scan | 24 ms; grid streams in |
| cold settle / rescans | 14.9 s / 4 | 8.1 s / 1 (+1 no-op stat batch) |
| warm open / settle | 102 ms / 33 s | 50 ms / 6.2 s |
| warm self-triggered revisions | 6 full rescans and re-queries | 0 |
| worst main-thread stall | 465 ms (3.8 s total > 50 ms) | 81 ms |
| repeat page query | 10–28 ms | 0–4 ms (memoized) |

On lands-of-old (6,616 media), the first open of the day took 3.96 s, then
re-scanned itself 13 times (warm: 22 times) over 22–27 s, with stalls of up to
549 ms. After the change, cold open took 8 ms and settled in 3.7 s. Warm open
took 30 ms and settled in 1.4 s with no revision change; the worst stall was 28 ms.
Access times were recent for the after-run, so this run did not reproduce the
echo storm. The synthetic run covers that case. The default page payload is
about 20 KB.

## Genio read tools

`assets_find({ world, query?, kind?, folder?, generated?, limit? })` uses the
Inventory search grammar and returns up to 50 assets by default (200 maximum),
including flagged vendor assets. `asset_info({ world, path })` returns index
metadata, provenance, LFS state and up to 50 neighbouring indexed media files.
PNG/GIF dimensions and WAV duration are read from at most 64 KiB of headers;
unsupported formats and LFS pointers omit those fields.

`asset_locate({ world, kind, name?, hint? })` returns up to five ranked suggestions
with confidence, reasons, naming style and sibling examples. Placement is shared
with units through `conventionsOf` / `suggestLocation` in
`resources/unit-skills/genio/lib/genio-world.mjs`. Pass indexed assets, engine,
engineRoot and optionally config and root to those helpers. A root enables disk
collision and symlink/junction checks. Hints can be subject words or a
project-relative folder. Configured folders outrank inferred folders; explicit
folder hints outrank configuration. Unsafe destinations are discarded, even
when configured or hinted. The fallback avoids generated directories too.

Naming measures case, majority -NN numbering and common art prefixes/suffixes.
Suggestions are advisory: no directory or asset is created, and a future writer
must revalidate containment and collisions. Unity GLB/glTF suggestions stay in
source art outside Assets because importer support is not assumed. All three
tools refresh the index without opening a watcher; only Genio's index cache and
first-use achievement can be persisted, never project files.
