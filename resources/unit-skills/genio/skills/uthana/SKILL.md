---
name: uthana
description: Generate character motion and reuse or upload characters through Genio's Uthana API tools, with quoted prices and engine-aware exports.
---

# Uthana motions

Genio tools are the supported interface; there is no Uthana unit CLI. Keys stay in Genio's Accounts storage. Units ask Genio for motions rather than running an improvised client.

Read the assets skill and choose `place` with `asset_locate` first. Prefer stock Manny (`c43tbGks3crJ`) or Y Bot (`cJM4ngRqXg83`) for humanoids. No upload or auto-rig charge is needed. For a nonhumanoid or a requested custom preview, find the rig with `assets_find`, then call `uthana_character(world, path, name?, auto_rig?, player_words)`. Project-relative FBX/GLB/glTF, under 30 MB; source path and sha256 reuse an existing character id. Uploaded ids remain in Genio data, not team config. Auto-rig is up to USD 0.15; the normal project threshold applies.

`uthana_motion(world, prompt, character?, model?, length?, format?, place, player_words)` defaults to text-to-motion-3.0 and Manny. 3.0 costs USD 0.10/s, length 4–10 whole seconds (default 8). text-to-motion-bucmd costs USD 0.03/s, 0.25–10 seconds (default 10). text-to-motion picks its length, conservatively quoted up to 10 seconds at USD 0.02/s. Prices are the existing service snapshot; inspect the quote before approving.

Video models `video-to-motion-2.0` and `video-to-motion-2.1` take a project-relative `video` path plus a descriptive prompt/name. USD 0.05/s; up to 60 seconds. Larger than Genio's USD 2 quick-call limit requires a budgeted unit workflow. Do not split a call to bypass that limit.

Export FBX for Unity, GLB for Godot, or BVH when requested. Unity humanoid FBX still imports as Generic until a unit or the player sets Humanoid import settings; Genio never writes .meta. The provenance records character_id and the custom source reference.

Runs return an id and progress/result card. Use generation_status to inspect it. Above the confirm threshold, only the player can approve the quote (click, or typed approval via approve_run). A monthly cap cannot be overridden. Never resubmit uncertain calls; inspect provider history first.
