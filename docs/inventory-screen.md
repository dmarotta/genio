# Inventory screen v1

Open Inventory with **Ctrl+9**, the folder icon in the rail, or a world's **Inventory** button. The world switcher remembers the last world; navigation from Worlds takes precedence. FAL.ai and Uthana remain available in the command palette, and Ctrl+0 still opens Animation.

The hierarchy contains only indexed media, with recursive counts under the active filters. Select a folder to browse it and its descendants. **Ours** excludes vendor packs; **Vendor packs** and **All assets** reveal them with a circled-v badge. Search supports the index service's name/path matching and tokens such as `t:sfx`, `ext:png`, `in:UI`, `l:sprite`, `by:unit`, and `via:fal`. Type chips support multiple selections, tags are comma-separated, and Generated selects assets with Genio provenance. Sort by name, type, size or modification time.

Both grid and list request and render a bounded viewport with overscan. Only thumbnails near the viewport request `genio-media://thumb` URLs; unsupported, large, missing and still-loading images retain a type icon. Opening a world starts its index watcher; switching worlds or leaving Inventory closes it. Focus refreshes the index as a fallback. Requests from an old world, filter or asset cannot replace newer results.

The inspector uses native image, audio and video elements and the existing animation-capable GLB viewer. Images have zoom and scrolling; audio/video have native seek/play controls and looping. Unsupported codecs report an error. TGA, PSD, TIFF, FBX, glTF with external buffers and other formats awaiting richer previews show metadata and any thumbnail supplied by the index. LFS pointers explain why the asset cannot be previewed. No world files are written by browsing. Copy path, open in the default app and open containing folder are explicit actions.

Successful Inventory opening and asset inspection unlock feature-tagged achievements. The backend's separate index achievement remains unchanged.

## Validation

`tests/inventory-ui.test.ts` covers filter/tree consistency, folder boundaries, pagination, bounded virtualization, thumbnail guards and preview fallbacks. `tests/inventory-screen.test.ts` exercises watcher ownership in StrictMode, world navigation, stale inspector requests, folder collapse and shared tree/grid filters. Existing backend tests cover indexing and file watchers; navigation and achievement guard tests cover the rail and palette.

For real-world UI checks, use an isolated `GENIO_HOME` with a registry referencing the original worlds read-only, an isolated Electron `--user-data-dir`, and unset an inherited `ELECTRON_RENDERER_URL` when running the production build. `GENIO_CAPTURE_DIR` saves screenshots. Optionally set `GENIO_CAPTURE_SCENARIOS` to a JSON file containing `{ "name": "capture-name", "script": "..." }` objects. Each script runs in the renderer and should await its DOM/media readiness before capture. Scenario failures save `scenario-failure.png`, report the error and exit nonzero. The normal nine-screen tour remains available without scenarios.
