---
name: imagegen-codex
description: Generate PNG images (concept art, sprites, icons, transparent cutouts, edits and variations from reference images) through Codex's built-in image_gen tool. Uses your ChatGPT plan, not a paid API. The default for ordinary image work in any world; use FAL only for what Codex cannot do.
---

# Codex images (Genio) · uses your ChatGPT plan

Images come from Codex's built-in `image_gen` tool, billed to the player's **ChatGPT plan** (no API key, no per-image price). The plan is shared with the coding units, so every image uses allowance they also need. The helper is a dependency-free Node script:

```
node "{{SKILL_DIR}}/scripts/codex-image.mjs" --world . --prompt "<text>" --out <file.png> [--transparent] [--ref <image> ...]
```

It runs `codex exec` in a scratch folder under Genio's data (never in your worktree), reads the generated file's location from the Codex session record and copies it to `--out` itself. It prints JSON on stdout (progress on stderr). Exit codes: 0 ok, 2 usage, 3 this world opted out of Codex images, 4 Codex error or a missing image, 5 timed out.

## When to use it

- **Default for ordinary image work:** concept art, sprites and icons, UI art, transparent cutouts, edits and variations from reference images. Reach for this before FAL.
- **Use FAL instead** (the `fal` skill next to this one) for what Codex cannot cover: seamless or PBR textures, 3D, audio, video, pixel-art conversion, upscaling, background removal on an existing image, or when an exact size, seed or reproducible result is required.
- **World mode (normal):** pass `--world <your worktree root>`. Codex images are on in every world by default. Exit 3 means the player opted this world out (`.genio/fal/config.json` `"providers": { "codex": { "enabled": false } }`): use FAL instead, or append `needs-decision: <what you need>` and stop. Never edit `.genio/fal/config.json` yourself.
- **Outside a world:** pass `--no-world` (no provenance, no spend line).
- Make only the images the mission needs. No speculative variants: each image costs plan allowance and about a minute.

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
