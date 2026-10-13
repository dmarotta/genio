---
name: assets
description: Generate and place game media using Genio APIs or unit helpers. Routes images, textures, audio, video, models and animation, and chooses locations from the current world's engine and conventions.
---

# Assets

Use this workflow whenever the player asks for new media or a variation in a world.

1. Resolve the world and request. Inventory selection supplies references; its current folder is a destination only if the player says "here" or names that folder. Read `asset_info` for references and `assets_find` for neighbouring work.
2. Choose a provider. Ordinary images, sprites, icons, concepts and cutouts use **imagegen-codex** on the ChatGPT plan. Read `../imagegen-codex/SKILL.md`. Use **fal** for seamless/PBR textures, 3D, audio/music, video, exact size/seed, upscaling and other specialised endpoints; read `../fal/SKILL.md`. Motions and rigged characters use **uthana**; read `../uthana/SKILL.md`.
3. Choose the destination yourself with `asset_locate(world, kind, name, hint)`. Use the current world type and engine root, configured folders, then measured sibling naming and engine fallbacks. Pass an actual extension when known. Review the reasons and warnings. See `references/placement.md` and `references/engines.md`.
4. Call the provider API with `world`, the chosen `place`, and `player_words` quoting the asset request. Tools return immediately with a background run id. `generation_status(run)` reports completion and paths. There are no drafts, Keep actions, or undo tools. Results are saved directly and left uncommitted. Report paths and cost; never claim quality from metadata alone.
5. FAL: `fal_models(world, job?, query?, endpoint?)` supplies catalogue, schemas and prices. Use schema field names and defaults; `fal_generate(world, endpoint, input, place, player_words)` validates and prices before submitting. Uthana: use `uthana_motion` or `uthana_character`. Codex: `generate_image(prompt, refs?, transparent?, count?, world, place, player_words)`; omit world for chat-only images.
6. Paid requests only ask above the world's `confirm_over_usd` (default USD 0.25). The one-click chat quote is bound to the request and estimate. A typed approval goes through `approve_run(run, player_words)` with the player's actual words. Never approve your own quote. Monthly caps are hard stops. Codex images never ask; respect world Codex opt-out. No automatic paid retries after uncertain failure.
7. `asset_place(run, output, world, path, player_words)` can place an already generated output. An existing target is refused unless the player explicitly confirms overwriting that specific file; only then provide their words as `overwrite_words`. Prefer another collision-free name. Never use it for arbitrary local files, code, scenes, prefabs or .meta files. Bot cannot generate, approve or place.

Genio handles up to four outputs and at most USD 2 per request. Delegate batches, conversions, materials referring to textures, import settings, Humanoid setup, scenes, prefabs and code to a Build unit. Never commit from Genio. Units work only in their isolated copy and commit assets with provenance/spend. They use the provider CLI helpers with their explicit budget, not Genio's chat tools. Uthana has no unit helper yet; report the needed motion to Genio instead of improvising a paid client.

Unit placement uses the same `suggestLocation` helper in `../../lib/genio-world.mjs`, or `fal.mjs locate --world . --kind audio --name door.wav --engine unity --engine-root Game`. Read-only `catalogue` lists bundled FAL models. Do not edit world generation config or recipes.
