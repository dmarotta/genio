# Usage protection and measurement (stage 1)

Automatic unit selection excludes any provider with a reported window at 85% or
above, a rejection, or retained hot evidence awaiting fresh confirmation. This
applies to category pools, rules, sticky follow-ups, defaults, exploration and
respawns. Pinned choices are held instead of silently changing their provider.
Unknown cold headroom permits ordinary dispatch but never exploration.

Exploration requires both its original primary and alternate to have known,
unrejected applicable windows, observed within ten minutes and below 70%. Critical
work and explicit model/effort/harness picks do not explore. At 70?84%, a provider
can have at most one running or launching unit. The main-process dispatcher
serializes selection and claims a provider launch reservation across all homes;
launch scans local evidence again just before terminal creation, and releases the
reservation on success or failure. Previews may use cached signals; actual launches
cannot rely on the five-minute preview cache. No quota is estimated from dollars
or token counts. Missing/failed scans do not clear previous protective evidence.

Each reported window retains observedAt and changedAt independently. Repeated
Claude events refresh observation time even when the percentage is unchanged.
Codex snapshots merge per window, so a partial event cannot erase a hot weekly
window. Current percentages expire after ten minutes or their reset time and are
shown as unknown. Last-known percentages remain separate protective evidence.
Model buckets are conservatively included in provider eligibility.

Claude usage is attributed by persisted main/ally/Bot session IDs before cwd,
including sessions retained in the cost ledger. Transcript request/message IDs
are deduplicated with maximum streaming counters. Each session's cumulative SDK
cost baseline, counter epoch and result IDs are persisted in
`data/usage/session-costs.json`. On first resume without an existing baseline, the
first cumulative total seeds the baseline without being charged as a new turn.
This deliberately leaves that first increment unmeasured rather than inventing a
historical turn cost. Counter decreases start a new epoch; replayed result IDs do
not advance accounting. Existing historical estimates are not rewritten.

The HUD labels its cost as a chat/review SDK estimate: main
chat, allies, Bot and review calls, excluding units and subscription charges.
Token measurements in Usage include units independently.

One automatic relaunch attempt is allowed per task before holding it. Attempts
are persisted before launch, including failures; a new model-written progress
note cannot reset the counter. Existing tasks with past relaunches migrate
conservatively to held on their next automatic attempt. The existing unit Respawn
button explicitly resumes the task and resets the automatic attempt allowance;
model tools cannot mark their own relaunch as manual. Quota eligibility still
applies to manual respawn.

Replay coverage: the 97%-Claude explored Recon; stale/unknown/rejected combinations;
atomic launch reservations and last-moment rejection; cwd drift; the resumed
$14.7858063 checkpoint; duplicate result IDs; independent snapshot expiry; shared
chat backoff; and the relaunch cap. All tests use local fixtures or fake SDK streams.

# Usage mode and shared plan meter (stage 3)

One control, Systems → Usage: **Usage mode [Save | Balanced* | Max] Advanced**.
`src/shared/usage-mode.ts` holds the table; the Systems preview, the loadout
picker, the chat sessions, the supervisor and the dispatcher all read it.

| | Save | Balanced (default) | Max |
|---|---|---|---|
| Chat, including allies without their own pick | Sonnet / low | Sonnet / medium | Opus / high |
| Units: chore, docs, tests, build/CI | Codex / low | Codex / medium | Codex / high |
| Units: feature, bugfix, UI | Sonnet / medium | Codex / medium | Opus / high |
| Units: recon/design, refactor, graphics | Codex / medium | Codex / high | Opus / xhigh |
| Units: review, large-context | Codex / medium | Codex / high | Codex / xhigh |
| Units: art (agent work) | Codex / low | Codex / medium | Codex / high |
| Concurrent units across all worlds and bases | 1 | 2 | 4 |
| Exploration | 0 | 0 | 5%, only with fresh evidence below 70% on both plans |
| Cheap third-party models (low-stakes only) | first | after the plans | off |
| Routine wake batching; heartbeat base/max | 10 min; 30/120 | 5 min; 15/120 | 1 min; 10/120 |
| Chat answer / Recon summary target | 150 / 400 words | 250 / 800 | 400 / 1,500 |

Codex units explicitly use `gpt-6.1-sol` so a CLI default cannot silently select
Astra. Unspecified Claude unit models resolve to Sonnet. Each unit cell falls back at the same effort:
Codex ↔ Sonnet, Opus → Codex. Cells are final efforts; no dial shift is applied.

Fable and Astra always require a fresh player approval at the central unit launch
boundary. Deploy buttons, chat tools, queued dispatch, pins, rules, sticky
follow-ups, automatic recovery, respawns and Recon upgrades all use the same
Allow once / Deny permission prompt. Approval is never saved on a task or inferred
from shell mode, YOLO, model selection or prior consent. Denial or the broker's
ten-minute timeout prevents the launch. A respawn waits for approval before
recalling its current process. Quota is checked again after approval and directly
before process creation, and reservations are released on failure.

Ordinary automatic routing uses Sol, Sonnet or Opus. Astra is normally reserved
for heavy visual work and remains an explicitly chosen, explicitly approved
exception. The broad art/graphics categories include audio and performance work,
so those labels alone do not automatically select Astra.
A world can carry its own mode (Advanced, or its legacy cost dial); the global
mode sets the shared unit cap, and a world's mode or capacity can only lower it.
The cap is checked inside the serialized launch reservation, counting units that
hold a place in every base plus launches reserved but not yet listed; a respawn
keeps the place it already holds. Cheap models also need an explicit paid-spend
allowance (Advanced); a mode never grants one.

**Pinned.** A non-empty chat/Bot/unit model or effort, an ally's own pick, a
locked category row, a dispatch rule or an explicit deploy pick is Pinned: neither
the mode nor protection changes it, and Systems → Usage lists it with Unpin.
Migration keeps every explicit pick as written; only the old shipped chat default
(`wkspEffort: 'high'` with no model) becomes Auto, and the old cost dial becomes
the mode (Quality → Max, Cost → Save).

**Protection**, per plan, from the worst reported window (retained hot evidence
still counts, stale cold evidence is unknown):

- below 70%: the mode as set;
- 70–84%: exploration off, at most one unit on that plan, Auto unit effort one
  step lower, the other plan preferred, Auto chat effort one step lower and
  answers held to Save's target;
- 85–94%: excluded from every automatic unit candidate; Auto chat drops to
  Sonnet / low at the next turn;
- 95%+ or rejected: also no background chat work (stage 1); low-priority queued
  quests and, when no plan has headroom, all queued quests stay queued until
  reset ("Queued until reset" in Quests). Running work is never stopped.

A one-line notice (toast and Systems → Usage) is emitted only when a plan's level
changes; its details give the cause and evidence age. Levels persist in
`data/usage/policy-state.json`, so restarts do not repeat notices.

**Plan meter.** One component (Accounts, Usage, compact in the rail): a Claude
row and a Codex row, never summed, each reported window with what is left, reset
time, source and observation age. Expired or missing observations read "unknown",
never "100% left"; missing standard windows read "not reported". Unit tokens per
world are shown separately as measured consumption, not a share of the plan.
