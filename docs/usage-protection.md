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

The HUD and Status screen label their cost as a chat/review SDK estimate: main
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
