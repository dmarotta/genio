---
name: imagegen-codex
description: Generate PNG images (concepts, sprites, transparent cutouts, edits from reference images) through Codex's built-in image_gen tool. Uses your ChatGPT plan, not a paid API. Use only when your mission asks for images and the world enabled Codex images, or the mission explicitly asks for it outside a world.
---

# Codex images (Genio) · uses your ChatGPT plan

Images come from Codex's built-in `image_gen` tool, billed to the player's **ChatGPT plan** (no API key, no per-image price). The plan is shared with the coding units, so every image uses allowance they also need. The helper is a dependency-free Node script:

```
node "{{SKILL_DIR}}/scripts/codex-image.mjs" --world . --prompt "<text>" --out <file.png> [--transparent] [--ref <image> ...]
```

It runs `codex exec` in a scratch folder under Genio's data (never in your worktree), reads the generated file's location from the Codex session record and copies it to `--out` itself. It prints JSON on stdout (progress on stderr). Exit codes: 0 ok, 2 usage, 3 not enabled for this world, 4 Codex error or a missing image, 5 timed out.

## When you may use it

- **World mode (normal):** pass `--world <your worktree root>`. It runs only if the world turned Codex on in `.genio/fal/config.json`: `"providers": { "codex": { "enabled": true } }`. Exit 3 means it is off: use FAL instead, or append `needs-decision: enable Codex images for this world?` and stop. Never edit `.genio/fal/config.json` yourself.
- **Outside a world:** only when your mission explicitly asks for Codex images, with `--no-world` (no provenance, no spend line).
- Make only the images the mission asks for. No speculative variants: each image costs plan allowance and about a minute.

## What you get and what you don't

- PNG only, square-ish around 1254×1254. `--transparent` asks for a real alpha background.
- **No** size, seed, count, negative prompt or mask. Results are not reproducible; the revised prompt is recorded instead. For exact sizes, seeds, tiling, PBR, pixel art, cutout, upscale, 3D, audio or video use the FAL skill.
- `--ref <image>` attaches reference images (edits, consistent characters or props).
- Several images: repeat `--prompt … --out …` pairs (up to 8) or pass `--batch items.json` (`[{"prompt", "out", "transparent"?}]`). One Codex run serves them all, which saves most of the per-run overhead.
- Allow about a minute per image (`--timeout <s>` to change the limit).

## Plan meter

The output's `plan_meter` shows the plan's `used_percent` (weekly window and any secondary window) from Codex's own rate-limit report. Above 80% (or `--warn-at <n>`) the helper prints a warning and sets `warning`. When you see one, stop generating, finish with what you have, and mention it in your final status line.

## Records (world mode)

For every image inside the world it writes `.genio/provenance/<image path>.json` (`genio.provenance.v1`, provider `codex`, prompt, revised prompt, thread id, sha256, you as `by`) and appends a line to `.genio/spend.jsonl` (`est_usd` 0, `plan` chatgpt). Commit those files with the images. These are the only `.genio/` writes you make; never edit config or recipes.

## Where files go

Save into the folder the mission or the world's `.genio/fal/config.json` `folders.image` names (`node "{{SKILL_DIR}}/../fal/scripts/fal.mjs" world --world .` prints it, no key or network needed). Never write inside `.genio/`. Inspect each image before using it; keep the originals.
