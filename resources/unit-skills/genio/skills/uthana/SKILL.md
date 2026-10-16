---
name: uthana
description: Generate character motion and reuse or upload characters through Genio's Uthana API tools, with quoted prices and engine-aware exports.
---

# Uthana motions

Genio chat uses its Uthana tools (below). Units use the helper `uthana.mjs` with their explicit budget (see **Units**); never an improvised client. Keys stay in Genio's Accounts storage.

Read the assets skill and choose `place` with `asset_locate` first. Prefer stock Manny (`c43tbGks3crJ`) or Y Bot (`cJM4ngRqXg83`) for humanoids. No upload or auto-rig charge is needed. For a nonhumanoid or a requested custom preview, find the rig with `assets_find`, then call `uthana_character(world, path, name?, auto_rig?, player_words)`. Project-relative FBX/GLB/glTF, under 30 MB; source path and sha256 reuse an existing character id. Uploaded ids remain in Genio data, not team config. Auto-rig is up to USD 0.15; the normal project threshold applies.

`uthana_motion(world, prompt, character?, model?, length?, format?, place, player_words)` defaults to text-to-motion-3.0 and Manny. Text models get the project Art Bible's Animation line after the prompt when it has one (`art_bible: false` skips it). 3.0 costs USD 0.10/s, length 4–10 whole seconds (default 8). text-to-motion-bucmd costs USD 0.03/s, 0.25–10 seconds (default 10). text-to-motion picks its length, conservatively quoted up to 10 seconds at USD 0.02/s. Prices are the existing service snapshot; inspect the quote before approving.

Video models `video-to-motion-2.0` and `video-to-motion-2.1` take a project-relative `video` path plus a descriptive prompt/name. USD 0.05/s; up to 60 seconds. Larger than Genio's USD 2 quick-call limit requires a budgeted unit workflow. Do not split a call to bypass that limit.

Export FBX for Unity, GLB for Godot, or BVH when requested. Unity humanoid FBX still imports as Generic until a unit or the player sets Humanoid import settings; Genio never writes .meta. The provenance records character_id and the custom source reference.

Runs return an id and progress/result card. Use generation_status to inspect it. Above the confirm threshold, only the player can approve the quote (click, or typed approval via approve_run). A monthly cap cannot be overridden. Never resubmit uncertain calls; inspect provider history first.

## Units

```
node "{{SKILL_DIR}}/scripts/uthana.mjs" <command> ...
```

A dependency-free Node script that mirrors the FAL helper. Every command prints JSON on stdout (progress on stderr). Exit codes: 0 ok, 2 usage, 3 key missing, 4 Uthana or network error, 5 still pending, 6 over budget (nothing was sent).

**Key.** The key reaches you only as the `UTHANA_API_KEY` environment variable, set by Genio when the player stored one (Settings → Accounts & keys → API keys, Uthana). It goes only to uthana.com. Never print, echo, log or commit it, and never put it in a command line, a file or a status line. Run `check` first (no network); exit 3 means it is missing: append `blocked: Uthana key missing (set it in Settings → Accounts & keys → API keys, then respawn me)` and stop.

**Spending.** `motion` (one generation) and an uploading `character` are the paid calls; `check`, `estimate`, `characters`, character reuse, job polling and the export download are free. Pass the brief's USD budget on every paid call as `--budget <usd>`, with `--world <your worktree root>`: the helper estimates the call from the snapshot prices above, then refuses (exit 6, nothing sent) when it would take your spend past your budget, the project's monthly cap or, with no budget, its confirm threshold (`.genio/fal/config.json`, which covers Uthana too). Price a plan first with `estimate --model <id> --length <s>` (or `estimate --kind character`). No automatic paid retries: an uncertain call is counted against the budget and reported, never repeated. Report it like FAL: `(Uthana: 2 motions, est. USD 1.60 of 2.00 budget)`.

**Motion.** Choose the file with `asset_locate` (in a unit: `fal.mjs locate --world . --kind animation --name run.fbx --engine unity`), then:

```
node "{{SKILL_DIR}}/scripts/uthana.mjs" motion --world . --budget 2 --prompt "a tired soldier jogs forward" --length 6 --out Assets/Animations/Generated/soldier-jog.fbx --receipt <scratch>/soldier-jog.job.json
```

- `--model` text-to-motion-3.0 (default), text-to-motion-bucmd or text-to-motion; `--length` as above (text-to-motion picks its own). Video-to-motion is not in the helper: report the motion and its video to Genio.
- `--character` takes a stock name (Manny is the default; Tar, Ava, Quinn, Y Bot) or an uploaded character id from `character`.
- The format is the `--out` extension: `.fbx` for Unity, `.glb` for Godot or web, `.bvh` on request. `--fps 24|30|60` and `--in-place` (no root motion) shape the export.
- The project's Art Bible Animation line follows your prompt when it has one (`--no-bible` only when the mission says so); keep the prompt about the movement.
- It writes the receipt before the paid call, waits for the job, downloads the export to `--out`, appends one line to `.genio/spend.jsonl` and writes `.genio/provenance/<asset path>.json` (model, motion and job ids, prompt, character, download options, price, you as `by`). A timeout (exit 5) or a failed download: run the same command again; an existing receipt resumes, never resubmits. A `rejected` receipt means Uthana refused it (nothing billed): fix the request and use a new receipt name. `submission_unknown` means uncertain: do not resubmit; check uthana.com/app and report it.
- Existing files are refused before anything is sent; pick a new name or pass `--overwrite` when the mission says so.

**Character.** Prefer the stock humanoids. For a custom rig in the project:

```
node "{{SKILL_DIR}}/scripts/uthana.mjs" character --world . --budget 1 --file Assets/Models/Goblin.fbx --receipt <scratch>/goblin.char.json
```

The same project path and sha256 reuse a character Genio or a unit already uploaded (free, no key needed); otherwise it uploads (FBX/GLB/glTF under 30 MB; auto-rig up to USD 0.15, `--no-auto-rig` for a mesh that already has a skeleton) and remembers the id in Genio's data (`GENIO_UTHANA_DATA`), never in the project. `characters` lists what is known. Use the printed `character.id` with `motion --character <id>`.

Keep receipts in your scratch data folder, never inside `.genio/`. Commit the motion with its provenance file and the spend lines; never edit `.genio/fal/config.json`.
