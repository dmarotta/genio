# Agent generation

Genio and allies use `assets` to select a provider and a project-relative location
from `asset_locate`. Paid requests use `fal_generate`, `uthana_motion`, or
`uthana_character`; `generate_image` uses Codex on the ChatGPT plan. All return
background job ids. `generation_status` returns progress, outputs, paths and
errors. Generation runs through agent tools; the FAL and Animation screens have been removed. Settings > This project > Asset generation contains the shared monthly cap (a hard stop) and the Codex opt-out; save folders stay in the config files below (ask Genio to change them). Every paid run asks first, so there is no ask-before threshold; an old `confirm_over_usd` in a config is kept but ignored. Settings use the existing `.genio/fal/config.json` and `.genio/uthana/config.json` files. Provider keys remain in Settings > Accounts & keys > API keys.

`AgentGeneration` owns durable jobs in `data/generation-jobs.json`, bound to the
originating chat. It posts progress/result cards through the normal persisted
chat message path. Every paid request, whatever the amount, waits on a card for
the player's click or `approve_run` with their quoted reply, sent after the card
appeared. The card and the request's spend line say who approved it and how. Approval is
idempotent and rechecks the cap. Quoted requests keep their input, price ceiling
and local-reference hashes; changed references or increased FAL prices require
a new request. Genio handles at most four outputs and USD 2 per call; larger
jobs and engine wiring belong to units.

`generation-spend.ts` records provider reservations before submission in
`data/spend.jsonl`, updating by run id as request ids and costs become known.
The budget calculation unions this ledger, old provider histories and project
receipts, deduplicated by provider/request. Deleting provider history does not
erase spend. Failed or cancelled requests remain conservatively charged because
submission or cancellation may have billed. Unknown prices cannot bypass a
configured cap. Codex records zero-cost receipts and never needs a quote, but
respects the project's Codex opt-out. Units still use their own worktree ledger;
cross-unit shared budgeting is outside this migration step.

Units spend only under a spend grant (`spend-grants.ts`, the format in
`resources/unit-skills/genio/lib/spend-grant.mjs`). Genio records one only from
a player action: an approved budget at deploy (the Deploy dialog's field, or the
`deploy` tool's `budget_usd` with `player_words` quoting the player's message that
names the amount) or the player's approval of the unit's spend question, a
`needs-decision` with `spend_usd` metadata answered in the choice panel (or by the
player's own reply, verified). Grants add up per unit in `data/spend-grants.jsonl`,
never pass the project's monthly cap, and reach the unit as an Ed25519-signed
`spend-grant.json` in its data folder; the unit gets only the public key, so it
cannot create or raise its own. FAL, Uthana and the Sound Studio refuse a paid call
with exit 6 and nothing sent when there is no grant or the call would pass it,
and every unit spend line records the grant and who approved it.

`placeOutput` is the shared FAL/Uthana/Codex media copier and provenance writer.
The agent path accepts only its own generated run outputs and quotes the player
request. It checks the engine root, media extension, forbidden directories,
vendor paths, links and collisions. Explicit `overwrite_words` is required to
replace a named file. It never commits or writes code, scenes, prefabs, .meta or
import settings. `.genio` writes are limited to provenance/spend and the existing
scaffold. Legacy player Save actions retain their existing Generated-folder and
Unity glTF choices; agent placement uses the stricter `asset_locate` policy.

On restart, existing provider runs resume and their cards reconcile. A job
interrupted before a provider id was recorded fails with an inspection request;
it is never silently resubmitted. A placement collision leaves the provider
output available and reports the error. There are no drafts or undo records.

The umbrella skill is read into Genio's system context explicitly because its
session has `settingSources: []`; relative references are anchored at the
bundled skill directory. Unit launch briefs/environment point at the installed
assets, Codex, FAL and Uthana skills. The FAL helper has read-only `locate` and
`catalogue` commands. Its bundled catalogue snapshot should be updated with
`resources/fal-catalogue.json` when the catalogue changes.

Verification uses mocked providers only. Guard tests cover role exclusion,
overwrite/link/path rules, nested-engine placement, quote thresholds, concurrent
cap reservations, restarted quotes, reference changes, character reuse, Codex
opt-out, tool schemas and the quote card IPC action.

Achievements: Worth Every Cent (`spend-approve`) when an approved quote starts its run; Motion Crew (`unit-motion`) when a unit's Uthana helper saves a motion (its `genio-uthana-run` status note).
