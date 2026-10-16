---
name: fal
description: Generate audio, music, video, 3D, textures and specialised images with FAL.ai models (queue API) and download the outputs into your worktree. For specific needs Codex images cannot cover (seamless/PBR textures, 3D, audio, video, pixel-art conversion, upscaling, background removal, exact size/seed/reproducibility), or when the mission asks for FAL. Every model run is a paid call.
---

Genio chat: use fal_models for current schemas/prices and fal_generate with project, place from asset_locate, input and player_words. The tool shows a quote for every paid request and enforces hard monthly caps. Units use this CLI under their spend grant. Start with the assets umbrella skill.

# FAL.ai (Genio)

FAL is for specific use cases. For ordinary image work (concept art, sprites, icons, transparent cutouts, edits from references) use the `imagegen-codex` skill next to this one first: it runs on the player's ChatGPT plan, is on in every project by default and costs no FAL credit. Use FAL for seamless or PBR textures, 3D, audio, music, video, pixel-art conversion, upscaling, background removal on an existing image, when an exact size, seed or reproducible result is required, or when the mission asks for FAL by name.

Run any FAL model by endpoint id with a JSON input: submit to the queue, poll, fetch the result, and download the output files to a path you choose. The helper is a dependency-free Node script:

```
node "{{SKILL_DIR}}/scripts/fal.mjs" <command> ...
```

Every command prints JSON on stdout (progress on stderr). Exit codes: 0 ok, 2 usage, 3 key missing, 4 FAL or network error, 5 still pending, 6 no approval: no spend grant, over it, or over a cap (nothing was submitted).

## Key

- The key reaches you only as the `FAL_KEY` environment variable, set by Genio when the player stored one. Never print, echo, log or commit it, never put it in a command line, a file, a status line or a report. The helper reads it itself.
- Run `node "{{SKILL_DIR}}/scripts/fal.mjs" check` first (no network). If it exits 3 the key is missing: the player sets it in Genio under **Settings → Accounts & keys → API keys**. Append `blocked: FAL key missing (set it in Settings → Accounts & keys → API keys, then respawn me)` to your status file and stop. Do not look for keys elsewhere.

## Spending

- Each `run` or `submit` is one paid call. `check`, `price`, `estimate`, `status`, `result`, `download`, `world` and `recipe` cost nothing.
- **Ask before any paid call.** You spend only under your spend grant: the USD the player approved for you, at deploy or by answering your spend question. It is a hard stop, a ceiling and not a target, and you start with none unless your brief says the player approved an amount. `world --world .` shows your grant, what you spent and what is left. The helper refuses (exit 6, nothing submitted) any paid call when you have no grant or its estimate would take your spend past it.
- **How to ask.** Price the whole plan first (below), then append `needs-decision [key=spend]: <what you want to generate and why>` with JSON metadata `{"spend_usd": <amount>, "details": "<plan, estimate per call, total>"}` to your status file and stop. The player sees `Approve USD <amount>` or `Decline`; an approval records exactly that grant (grants add up) and Genio pings you; a decline records nothing, so do the work without that spend or report what you could not do. Never write or edit your grant file: only Genio signs grants. `--budget <usd>` is optional, your own lower limit.
- Codex images (`imagegen-codex`) cost no money and need no grant.
- Price every paid call: `price --endpoint <id>` tells you the billing unit (seconds, images, megapixels, ...); then give the call `--units <n>` (the helper prices it through FAL, free) or, when the unit is abstract (tokens, "units"), `--est-usd <n>` worked out from the model page. Price the whole plan before the first call with `estimate --endpoint <id> --units <total>`; if it does not fit your grant, do not submit: ask as above and stop. Exit 6 means the same.
- No automatic retries. A failed or uncertain call is reported, not repeated, unless the remaining grant allows it and the brief permits retries.
- Report what you spent when you finish, e.g. `done: <summary> (FAL: 3 calls, est. USD 0.04 of USD 1.00 approved)`. Estimates are not invoices; say "estimated".

## Project mode (`--world`)

Always pass `--world <your worktree root>` (usually `--world .`) when generating for the project you are working in. The project's `.genio/` folder is the player's per-project setup:

- `.genio/fal/config.json` (`genio.fal-config.v1`): save `folders` per output kind, `budget` (`monthly_usd`, the monthly cap; an old `confirm_over_usd` is ignored) and per-endpoint `defaults`.
- `.genio/fal/recipes.json`: named presets (`id`, `endpoint`, `prompt_template` with `{subject}`, `input`, `save_to`).

Read it first: `world --world .` prints folders, your spend grant, the monthly cap with what is already spent this month and by you, defaults and recipes (no network, no key needed). `recipe --world . --id <id> --subject "<text>"` prints one recipe with its prompt filled in and the defaults merged; put that prompt into the model's prompt field of your input.

In project mode `run` and `submit`:

- merge the endpoint's `defaults` and, with `--recipe <id>`, the recipe's `input` under your own input (yours wins); `--recipe` also supplies the endpoint;
- apply the project's Art Bible (`.genio/art-bible.md`, or your launch snapshot in `GENIO_ART_BIBLE`) when it has one: a short style line after your `prompt` (subject first), `negative_prompt` where the model takes one, the type's references in `image_urls` for edit models, palette parameters for Recraft and Image2Pixel, only the Audio/Music section for sound; spoken TTS text is never touched. Pass `--type <asset type>` for its section and `--no-bible` only when the mission says so. The receipt and provenance record it as `art_bible`;
- need `--units` or `--est-usd`, and stop with exit 6 when you have no spend grant or the call would pass it, your `--budget` or the project's monthly cap;
- append one line per paid call to `.genio/spend.jsonl`, with your grant and who approved it how;
- take `--dir` from the config folders when you omit it (`--kind image|audio|model|video`, or the recipe's `save_to`);
- write `.genio/provenance/<asset path>.json` (`genio.provenance.v1`: endpoint, request id, input, price, recipe, sha256, you as `by`, and `art_bible` when one was applied) for every downloaded file inside the project.

Commit the assets with their provenance files and the spend lines. Those are the only `.genio/` writes you ever make: **never edit `config.json` or `recipes.json`**, even when they look wrong (report it instead). Outside a project, `--ledger <spend.jsonl>` gives the same gate against a ledger file you keep in your scratch folder.

## Workflow

1. Read the model's current input schema from its OpenAPI document: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>` (public JSON, no key; the input schema is the `$ref` under `paths["/<endpoint>"].post.requestBody`, with `required`, `default`, `enum`, `minimum`/`maximum` and `maxLength`). Field names, limits and output formats differ per model; do not assume `prompt` or `duration`. Leave optional fields out to get FAL's defaults.
2. Write the input as a JSON file, one per call (convention: `<name>.input.json`). Set durations, sizes and counts explicitly. Local files can be passed inline: a string value `"@file:path/to/image.png"` is sent as a base64 data URI (20 MB max).
3. Run it. The receipt (`<name>.job.json`) is written before the paid call and is never overwritten:
   ```
   node "{{SKILL_DIR}}/scripts/fal.mjs" run --world . --units 1 --endpoint fal-ai/flux/dev --input <scratch>/hero.input.json --receipt <scratch>/hero.job.json --kind image --name hero
   ```
   Keep receipts in the standard layout, `<name>.input.json`, `<name>.job.json` and `<name>.result.json` side by side, in your scratch data folder (never inside `.genio/`); the provenance file carries what the project keeps. `run` submits, polls with backoff, saves `<name>.result.json` next to the receipt and downloads every output file into `--dir` (unauthenticated). With `--name` the files are `hero.png`, or `hero-01.png`, `hero-02.png` for several outputs. Existing files are kept unless `--overwrite`.
4. If `run` times out (exit 5) or you were interrupted, run the same command again: an existing receipt is resumed, never resubmitted. For finer control use `submit`, `status --receipt <f> [--logs]`, `result --receipt <f>`, `download --result <f> --dir <d>` and `cancel --receipt <f>`.
5. A receipt in state `rejected` means FAL refused the input (its `error` says why, nothing was billed); fix the input and use a new receipt name. A receipt in `submission_unknown` means the outcome is uncertain: do not resubmit; check the FAL dashboard request history and report it.
6. Inspect what you got (dimensions, duration, format, clipping, silence) before using it. Keep the originals; convert or trim copies. Do not claim quality from metadata alone.

## Where files go

- Download outputs into your worktree at the path the mission, the project's `.genio/fal/config.json` folders or the project's conventions call for (look for an existing `tools/<media>/` or asset folder first). Commit the assets with their `.genio/provenance/` files and `.genio/spend.jsonl` lines; large intermediates, receipts and rejected candidates go to your scratch data directory instead.
- Ordinary images go through the `imagegen-codex` skill (the player's ChatGPT plan, on by default in every project) rather than FAL credit; a project opts out only with `"providers": { "codex": { "enabled": false } }`.
- Receipts and results never contain the key. Output URLs from FAL are public and short-lived: download, do not link.
