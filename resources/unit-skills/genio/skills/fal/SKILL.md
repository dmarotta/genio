---
name: fal
description: Generate images, audio, music, video or 3D with FAL.ai models (queue API) and download the outputs into your worktree. Use only when your mission asks for FAL generation, FAL pricing or a FAL cost estimate. Every model run is a paid call.
---

# FAL.ai (Genio)

Run any FAL model by endpoint id with a JSON input: submit to the queue, poll, fetch the result, and download the output files to a path you choose. The helper is a dependency-free Node script:

```
node "{{SKILL_DIR}}/scripts/fal.mjs" <command> ...
```

Every command prints JSON on stdout (progress on stderr). Exit codes: 0 ok, 2 usage, 3 key missing, 4 FAL or network error, 5 still pending.

## Key

- The key reaches you only as the `FAL_KEY` environment variable, set by Genio when the player stored one. Never print, echo, log or commit it, never put it in a command line, a file, a status line or a report. The helper reads it itself.
- Run `node "{{SKILL_DIR}}/scripts/fal.mjs" check` first (no network). If it exits 3 the key is missing: the player sets it in Genio under **Systems → Accounts**. Append `blocked: FAL key missing (set it in Systems → Accounts, then respawn me)` to your status file and stop. Do not look for keys elsewhere.

## Spending

- Each `run` or `submit` is one paid call. `check`, `price`, `estimate`, `status`, `result` and `download` cost nothing.
- Respect any USD budget or call count stated in your brief or ping. A budget is a ceiling, not a target. With no budget stated, make only the calls the mission explicitly asks for (one candidate per requested asset), never speculative batches, alternative models or extra variants.
- When a budget is stated, price the plan before the first paid call: `price --endpoint <id>` for the billing unit (seconds, images, megapixels, ...), then `estimate --endpoint <id> --units <total units>`. If the estimate does not fit the budget, do not submit: append `needs-decision: <plan, estimate, budget>` and stop.
- No automatic retries. A failed or uncertain call is reported, not repeated, unless the remaining budget allows it and the brief permits retries.
- Keep a spend record next to the receipts (e.g. `production.json`): endpoint, budget_usd, calls made, billing unit, unit price, estimated total, pricing source and the request ids. Report what you spent when you finish, e.g. `done: <summary> (FAL: 3 calls, est. USD 0.04 of 1.00 budget)`. Estimates are not invoices; say "estimated".

## Workflow

1. Check the model's current input schema on its API page (`https://fal.ai/models/<endpoint>/api`). Field names, limits and output formats differ per model; do not assume `prompt` or `duration`.
2. Write the input as a JSON file, one per call (convention: `<name>.input.json`). Set durations, sizes and counts explicitly. Local files can be passed inline: a string value `"@file:path/to/image.png"` is sent as a base64 data URI (20 MB max).
3. Run it. The receipt (`<name>.job.json`) is written before the paid call and is never overwritten:
   ```
   node "{{SKILL_DIR}}/scripts/fal.mjs" run --endpoint fal-ai/flux/dev --input art/hero.input.json --receipt art/hero.job.json --dir art/out --name hero
   ```
   `run` submits, polls with backoff, saves `<name>.result.json` next to the receipt and downloads every output file into `--dir` (unauthenticated). With `--name` the files are `hero.png`, or `hero-01.png`, `hero-02.png` for several outputs. Existing files are kept unless `--overwrite`.
4. If `run` times out (exit 5) or you were interrupted, run the same command again: an existing receipt is resumed, never resubmitted. For finer control use `submit`, `status --receipt <f> [--logs]`, `result --receipt <f>`, `download --result <f> --dir <d>` and `cancel --receipt <f>`.
5. A receipt in state `rejected` means FAL refused the input (its `error` says why, nothing was billed); fix the input and use a new receipt name. A receipt in `submission_unknown` means the outcome is uncertain: do not resubmit; check the FAL dashboard request history and report it.
6. Inspect what you got (dimensions, duration, format, clipping, silence) before using it. Keep the originals; convert or trim copies. Do not claim quality from metadata alone.

## Where files go

- Download outputs into your worktree at the path the mission or the world's conventions call for (look for an existing `tools/<media>/` or asset folder first). Commit the inputs, receipts and spend record with the assets when the world keeps them; large intermediates and rejected candidates go to your scratch data directory instead.
- Receipts and results never contain the key. Output URLs from FAL are public and short-lived: download, do not link.
