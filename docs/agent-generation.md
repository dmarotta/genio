# Agent generation

Genio and allies use `assets` to select a provider and a project-relative location
from `asset_locate`. Paid requests use `fal_generate`, `uthana_motion`, or
`uthana_character`; `generate_image` uses Codex on the ChatGPT plan. All return
background job ids. `generation_status` returns progress, outputs, paths and
errors. Generation runs through agent tools; the FAL and Animation screens have been removed. Project details > Generation contains the shared monthly cap (a hard stop), per-run confirmation threshold (default $0.25), save folders and Codex opt-out. Settings use the existing `.genio/fal/config.json` and `.genio/uthana/config.json` files. Provider keys remain in Settings > Accounts.

`AgentGeneration` owns durable jobs in `data/generation-jobs.json`, bound to the
originating chat. It posts progress/result cards through the normal persisted
chat message path. Above `confirm_over_usd` (default USD 0.25), a card waits for
the player's click or `approve_run` with their quoted words. Approval is
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
