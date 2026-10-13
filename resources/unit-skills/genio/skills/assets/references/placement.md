# Placement and provenance

Precedence: explicit player folder, world engine/root, configured folder for the kind, indexed own-media folders matching the subject, engine fallback. Use `asset_locate` and follow its naming convention and collision increment. Do not drop media into the repository root simply because it is the working directory.

Forbidden: .git, .genio (except tool-owned provenance/spend/scaffold), Library, Temp, Logs, obj, Build*, dist, out, UserSettings, ProjectSettings, Packages, .godot, .import, addons, Intermediate, Saved, DerivedDataCache, Binaries, node_modules, Editor, AddressableAssetsData, vendor and generated directories. Vendor packs are never destinations. The tool also conservatively excludes Resources and StreamingAssets; requests for those require a unit to handle build/import implications. Symlinks and junctions are refused.

Every placed file receives genio.provenance.v1 with provider, input, request, hash, derived references, creator and price. One spend receipt per request is copied to .genio/spend.jsonl, while the central ledger records provider calls even before placement. Leave files uncommitted for the player. Use numbered siblings for variants; never silently replace existing media.
