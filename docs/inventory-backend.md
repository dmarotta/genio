# Inventory backend

Step 2 supplies a read-only per-world index and media transport. It does not add
the Inventory screen, generation, placement, drafts or undo.

## Screen contract

- `inventoryOpen(world)` starts watching this world (closing any other world's
  watcher). It returns cached state immediately and reconciles in the background;
  without a cache it awaits the initial scan. State includes the registered engine
  and engine root, revision, counts, refresh/watch status and errors.
- Subscribe to the `inventory` event and re-query when its revision changes.
  `inventoryList(world, query)` returns a paginated asset list, matching total and
  immediate child folders with recursive media counts. Paths remain relative to
  the **world**, including a nested engine root.
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
  screen. Watch events are debounced 300 ms; unchanged assets are reused. A large
  event batch, ignore/config change or explicit refresh triggers a full stat diff.

## Index and transport

`git ls-files -z -t --cached --others --exclude-standard` is the sole world
enumerator. Engine caches are explicitly excluded before stat/sidecar reads,
including nested `Library`. No fallback disk walk occurs for a non-Git world.
Build output directories are excluded by exact names (`Build`, `Builds`,
`BuildOutput`), preserving legitimate `Buildings` art. Other output follows
`.gitignore`. Submodules are not recursively enumerated.

Stat and LFS header reads run in a Node worker. Sidecar contents are lazy for the
inspector/label filters, and hydrated in the background while open. Reads are
bounded to 64 KiB for sidecars and 256 KiB for provenance. `.meta`, `.import` and
`.genio` files never become tiles. `.tres` files are checked for a material type.
Vendor detection uses known folder names, configured prefixes and a conservative
pack heuristic (documentation plus demos/scenes). `.genio/assets.json` accepts
world-relative `vendor` and `ignore` prefix arrays; it is never written.

`data/inventory/<world>/index.json` is versioned and atomically replaced.
`genio-media://world/<world>/<path>` supports nested paths and Range requests;
guards reject traversal, Windows alternate streams, hidden control/cache folders,
and symlinks/junctions escaping the world. `.gltf` companion buffers can use the
same route. No route or index operation writes into a world.

Request `genio-media://thumb/<world>/<path>` only for visible tiles. Native image
formats decode via `createImageBitmap` and `OffscreenCanvas` in a Web Worker hosted
by a lazy, hidden, sandboxed renderer. Input is capped at 64 MiB, decoded images at
64 megapixels, output at 256 px and 1 MiB, and jobs at 20 seconds. Jobs are serialized
and duplicate requests coalesced. Unsupported/oversized/LFS assets return 404 so
the screen can show a type icon. DCC/HDR decoding, waveforms, video posters and
model snapshots belong to later preview steps.

WebP thumbnails live in `data/thumbs/<world>/`, keyed by root/path/size/mtime with a
1 GiB per-world LRU cap. Only Genio's thumbnail cache is walked for eviction.

## Measurements (Windows, 2026-10-13)

On lands-of-old, Git enumeration plus filtering took **337–366 ms** for **27,825
paths**, producing **6,616 media entries**. The full stat/index pass took
**1.16–1.20 s**; cached opening does not wait for this pass. Sidecar hydration and
thumbnail generation are separate from enumeration.

Spike 0c used five real PNGs (78 B–1.67 MB): native worker thumbnail requests took
**12–47 ms** after startup, **126 ms** for the first request including host creation,
and **0.8 ms** for a cache hit. All five output WebPs were independently decoded
and measured at no more than 256 px. Outputs ranged from 526 B to 10.4 KB. The
world was read only; benchmark caches lived in the unit's Genio scratch data.
