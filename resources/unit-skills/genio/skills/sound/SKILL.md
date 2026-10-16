---
name: sound
description: Sound Studio steps - make a set of game SFX, UI sounds or an ambience loop in small reviewed JSON recipes (a FAL generation or an earlier take, then local trim, fade, normalize, loop, pitch, layer), with a waveform and spectrogram sheet and level/seam metrics per take, revert and branch, paid takes only under the player's approved spend grant, and export to WAV with provenance. Genio's own Node audio code, no install.
---

# Sound Studio

A sound set (for example `door_wood`: four slam variations, or `forest_bed`: one ambience loop) is made in steps. Each step is a small JSON recipe; each take in it has one source and a list of local ops. The kernel keeps every step, its takes, a review sheet per take and metrics, so you (and the player, later on the screen) can compare, revert and branch.

```
node "{{SKILL_DIR}}/scripts/sound.mjs" <command> <set> [args] --world <your worktree root>
```

Every command prints JSON on stdout. Exit codes: 0 ok, 1 error (nothing changed), 2 the step failed (recorded, the set stays at its last good step), 6 no approval: no spend grant, over it or the set's budget, or over a cap (nothing was submitted).

v1 covers **SFX, UI sounds and ambience**. No music loops and no voice: those are not part of this skill.

## Data and what is committed

- Step data lives outside the project in `GENIO_SOUND_DATA` (set by Genio; the fallback is next to the unit's Modeller data, else temp). Takes, sheets, receipts, FAL receipts and raw downloads stay there and are **never committed**.
- Only `export` writes into the project: the final WAVs where you place them, `.genio/provenance/<asset>.json` for each, `.genio/spend.jsonl` lines (fal.mjs writes one per paid call) and the recipes under `.genio/sound/<set>/`. Commit those together.

## Commands

```
init <set> [--kind sfx|ui|ambience] [--target unity|godot|web] [--budget <usd>]
step <set> <recipe.json> [--name <name>] [--amend] [--budget <usd>]
batch <set> <folder|batch.json|recipe.json...> [--budget <usd>]
revert <set> <step>                  move this branch's head back to a step (later steps stay, off the branch)
branch <set> <name> [--from <step>]  start a branch at a step (default: the head) and switch to it
switch <set> <branch>
status <set>                         the steps on this branch and the set's takes at its head
budget <set> [--budget <usd>]        your grant, the set's budget, spent by you and what is left (no network)
export <set> --to <path.wav|folder> [--take <name>]... [--step <step>] [--bits 16|24] [--overwrite]
```

`batch` runs recipes in order (a folder of `.json` files sorted by name, `{"steps": ["s01.json", ...]}`, or several files). Each lands as it finishes, at least 0.6 s apart, so a live view shows each. The first failure stops the batch; earlier steps stay. `--amend` replaces the head step instead of adding one.

## Recipes

```json
{
  "caption": "Three heavier door slams, less creak",
  "takes": [
    {"name": "door_wood-01",
     "source": {"fal": {"input": {"text": "heavy oak door slammed shut, dry room, no creak", "duration_seconds": 1.5}}},
     "ops": [{"trim": {"db": -60}}, {"fade": {"out_ms": 30}}, {"normalize": {"peak_db": -1}}]},
    {"name": "door_wood-02", "source": {"take": "door_wood-01"}, "ops": [{"pitch": {"semitones": -2}}]},
    {"name": "door_wood-03", "source": {"take": "door_wood-01"}, "ops": [{"rate": {"factor": 1.08}}, {"mix": {"take": "s002:thud", "gain_db": -9}}]}
  ],
  "drop": ["door_wood-old"]
}
```

The caption is what the player reads next to the step: say what changed and why. A take name is 1-64 letters, digits, `-` or `_`. The set at a step is every take its line has made, the latest of each name winning; `drop` removes takes from the set.

**Sources** (exactly one per take):

- `{"fal": {"endpoint": "...", "input": {...}}}`: a paid generation through the FAL skill's `fal.mjs` (`--world`, your spend grant, spend line). The input uses the model's own field names:
  - `fal-ai/elevenlabs/sound-effects/v2` (default, USD 0.002/s): `text`, `duration_seconds` (0.5-22, required so the call is priced), `loop` (true for ambience beds), `prompt_influence`. `output_format` is set to `pcm_48000`; MP3 and Opus are refused because the kernel decodes WAV/PCM only.
  - `sonilo/v1.1/text-to-sound-effects` (alternative, USD 0.0018/s, longer beds up to 180 s): `prompt`, `duration` (required); `audio_format` is set to `wav`.
- `{"take": "<name>"}`: a take made earlier in this step, else in the set at the parent step. `{"take": "s003:<name>"}` takes it from the set at any step, on any branch. Free: make variations this way before paying for new takes.
- `{"file": "<path.wav>"}`: a WAV file, relative to the project root.

Everything is resampled to the **48 kHz master** first. `"loop": true` on a take marks it as a loop (the seam is measured); a `loop` op or an ElevenLabs `loop: true` input does that too. `"expect_s": <seconds>` adds a length check on the final take.

**Ops**, applied in order:

| Op | Arguments |
|---|---|
| `trim` | `db` (-60), `pad_ms` (5), `start`, `end`: cut silence below the threshold |
| `cut` | `start_ms`, `end_ms` |
| `fade` | `in_ms`, `out_ms`, `shape` `linear` or `equal` |
| `gain` | `db` |
| `normalize` | `peak_db` (sample peak), or `lufs` (BS.1770, takes of 400 ms or more) with `ceiling_db` (-1 dBTP). No limiter: a loudness the ceiling forbids is held lower and noted |
| `loop` | `crossfade_ms` (500): the tail crossfades into the head with equal power; the take becomes a whole-file loop, shorter by the crossfade |
| `pitch` | `semitones`: varispeed, so higher is also shorter |
| `rate` | `factor`: 1.1 is 10% faster and higher |
| `mix` | `take` (same refs as a source), `gain_db`, `offset_ms`: layer another take on top |
| `mono`, `stereo` | `{}` |
| `resample` | `rate` (leave the master at 48 kHz unless the mission says otherwise) |

The whole recipe (names, sources, prices, ops) is checked before anything runs or is paid.

## Spending: ask first, then a hard stop

- Paid takes (FAL sources) need your spend grant: the USD the player approved for you, at deploy or by answering your spend question. You start with none unless your brief says otherwise, and there is no default budget. `budget <set>` shows your grant and what is left. Local steps and takes from earlier takes are free and need no approval; so are Codex images.
- To ask: price the plan (catalogue price x seconds per paid take), append `needs-decision [key=spend]: <what and why>` with JSON metadata `{"spend_usd": <amount>, "details": "<plan, estimate per take, total>"}` and stop until Genio pings you. An approval records exactly that grant (grants add up); a decline records nothing. Never write or edit your grant file.
- `init --budget` optionally sets the set's own lower limit; `--budget` on `step`/`batch` overrides it for that run. Neither can go past your grant.
- Before the first call of a step or batch the kernel prices every paid take and adds what you already spent (the project's `.genio/spend.jsonl`, by your unit id). If it does not fit your grant (or the set's budget, or the monthly cap), nothing is submitted (exit 6). `fal.mjs` checks each call again on FAL's live price.
- A paid take is kept in step data even when a later part of the step fails. Re-running the same recipe resumes it from its FAL receipt without paying again; a changed input is a new call.
- No automatic retries. Vary earlier takes for free before paying for new ones. Report what you spent: `budget <set>` gives it.

## Reviewing a step

You cannot hear. Each take has `steps/<id>/<take>.sheet.png`: a header of metrics and the first warning, the waveform per channel with -1 dB and -6 dB guides, a log-frequency spectrogram (40 Hz to 24 kHz) and, for loops, the last 50 ms joined to the first 50 ms with the join marked. Open the sheets of every step and read `receipt.json`:

- `metrics`: duration, peak, true peak, RMS, LUFS (null under 400 ms), clipped samples, the source's bit depth and **effective bits**, silence before and after, stereo correlation, loop seam (`jump` about 1 is seamless; `step_db` is the level change across the join).
- `warnings`, information only, never a gate:
  - **too quiet**: the source uses fewer than 12 effective bits. Regenerate it; normalizing would bring up its quantization noise.
  - **clipping**: samples at full scale, now or in the source.
  - **silence**: a silent take, a silent tail (cut early?) or silence before the sound.
  - **seam click**: the loop point jumps; add a `loop` crossfade.
  - **length drift**: FAL delivered a different length than asked, or the take misses `expect_s`.
- `lineage`: the FAL request ids, files and earlier takes the take came from.

Suggested targets, not rules: one-shots and UI trimmed with a 2-5 ms fade-out and `normalize peak_db -1`; ambience beds about -20 to -24 LUFS as a whole-file loop. Taste is the player's: name the intent in captions and leave choices between good takes to them.

## Export

```
node "{{SKILL_DIR}}/scripts/sound.mjs" export door_wood --world . --to Assets/Audio/SFX
node "{{SKILL_DIR}}/scripts/sound.mjs" export forest_bed --world . --take bed --to Assets/Audio/Ambience/forest_bed.wav
```

Take the path from `asset_locate` (or `fal.mjs locate --kind audio`); keep a kind folder such as `SFX`, `Ambience` or `UI`. `--to` is one `.wav` for one take or a folder for several (`<folder>/<take>.wav`). Export writes 48 kHz WAV (16-bit, `--bits 24` on request), reads it back to verify length, channels and rate, and refuses to overwrite an existing file without `--overwrite`. For each file it writes provenance (`provider: local`, `derived_from` the FAL request ids, the sources and their estimated cost, the recipe), makes sure the spend lines are in the ledger, and copies the recipes of the steps involved plus the manifest to `.genio/sound/<set>/`. Unity: import the files with `genio-unity import` so their `.meta` is committed. Godot: commit without `.import` and say so.
