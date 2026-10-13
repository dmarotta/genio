# Inventory screen v1

Open Inventory with **Ctrl+9**, the folder icon in the rail, or a world's **Inventory** button. The world switcher remembers the last world; navigation from Worlds takes precedence. Generate assets through the Inventory chat. Per-world budgets, folder overrides and the Codex image switch are in Worlds > world settings > Generation.

The hierarchy contains only indexed media, with recursive counts under the active filters. Select a folder to browse it and its descendants. **Ours** excludes vendor packs; **Vendor packs** and **All assets** reveal them with a circled-v badge. Search supports the index service's name/path matching and tokens such as `t:sfx`, `ext:png`, `in:UI`, `l:sprite`, `by:unit`, and `via:fal`. Type chips support multiple selections, tags are comma-separated, and Generated selects assets with Genio provenance. Sort by name, type, size or modification time.

Both grid and list request and render a bounded viewport with overscan. Only thumbnails near the viewport request `genio-media://thumb` URLs; unsupported, large, missing and still-loading images retain a type icon. Opening a world starts its index watcher; switching worlds or leaving Inventory closes it. Focus refreshes the index as a fallback. Requests from an old world, filter or asset cannot replace newer results.

The inspector uses native image, audio and video elements and the existing animation-capable GLB viewer. Images have zoom and scrolling; audio/video have native seek/play controls and looping. Unsupported codecs report an error. TGA, PSD, TIFF, FBX, glTF with external buffers and other formats awaiting richer previews show metadata and any thumbnail supplied by the index. LFS pointers explain why the asset cannot be previewed. No world files are written by browsing. Copy path, open in the default app and open containing folder are explicit actions.

Successful Inventory opening and asset inspection unlock feature-tagged achievements. The backend's separate index achievement remains unchanged.

## Floating Genio chat

Inventory mounts the same `ChatPanel wksp="main"` as Comms. Conversation history, queued messages, image paste, drafts, model/effort and approval controls are shared. Drag its header or resize from its lower-right corner; arrow keys on either handle also work. Drag to the right edge or use Snap to put it in the right column, with an Inspector/Chat toggle. Collapse to a pill or use **Ctrl+Space**. The pill shows activity, new messages and queued/generating counts. Position, size, snap and collapse state are saved in this window's session storage.

The composer shows removable folder, preview and multi-selection chips. Ctrl/Command/Shift-click toggles up to 20 selected assets. Changing folders clears the old preview and selection. A dismissal applies to that chip value; browsing to another value restores it. Removing every chip sends no Inventory context.

`sendChat` accepts an optional context snapshot, carried through to `wksp.send`. It appends an escaped JSON `[inventory: ...]` block containing the world/engine/root and visible paths, kinds, sizes and compact provenance. The preview may add one cached 256-pixel WebP thumbnail through existing chat-image storage. Identical thumbnail bytes already delivered in this session are reused; queued, cancelled and unsent messages cannot suppress a needed thumbnail. Missing/unsupported previews and a full pasted-image attachment limit are recorded explicitly. Sent bubbles retain their own chips and thumbnail receipt. Editing a queued message restores that snapshot, including when editing from Comms, and never turns the automatic preview into a pasted attachment. Slow thumbnail preparation preserves send order. Successful contextual sends unlock **Shared View** (`inventory-chat`).

## Validation

`tests/inventory-ui.test.ts` covers filter/tree consistency, folder boundaries, pagination, bounded virtualization, thumbnail guards and preview fallbacks. `tests/inventory-screen.test.ts` exercises watcher ownership in StrictMode, world navigation, stale inspector requests, folder collapse and shared tree/grid filters. Existing backend tests cover indexing and file watchers; navigation and achievement guard tests cover the rail and palette.

`tests/inventory-context.test.ts`, `tests/inventory-chat.test.ts` and the Inventory cases in `tests/chat-queue.test.ts` cover chip dismissal/live updates, snapshots, bounded selection, payload validation, thumbnail dedupe and limits, queued editing, send order, pointer drag/resize, snap/collapse persistence and the feature achievement. Real-world capture scenarios should include floating, snapped, collapsed and resized chat, visible/removed chips and the model picker at narrow widths.

For real-world UI checks, use an isolated `GENIO_HOME` with a registry referencing the original worlds read-only, an isolated Electron `--user-data-dir`, and unset an inherited `ELECTRON_RENDERER_URL` when running the production build. `GENIO_CAPTURE_DIR` saves screenshots. Optionally set `GENIO_CAPTURE_SCENARIOS` to a JSON file containing `{ "name": "capture-name", "script": "..." }` objects. Each script runs in the renderer and should await its DOM/media readiness before capture. Scenario failures save `scenario-failure.png`, report the error and exit nonzero. The normal nine-screen tour remains available without scenarios.
