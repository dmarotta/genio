# Usage protection and measurement (stage 1)

Automatic unit selection excludes any provider with a reported window at 85% or
above or a rejection, observed within ten minutes and before reset. This
applies to category pools, rules, sticky follow-ups, defaults, exploration and
respawns. Pinned choices are held instead of silently changing their provider.
Unknown headroom (including expired hot evidence) permits ordinary dispatch with a quota-unverified warning, but never exploration.

Exploration requires both its original primary and alternate to have known,
unrejected applicable windows, observed within ten minutes and below 70%. Critical
work and explicit model/effort/harness picks do not explore. At 70?84%, a provider
can have at most one running or launching unit. The main-process dispatcher
serializes selection and claims a provider launch reservation across all homes;
launch refreshes the account report again just before terminal creation, and releases the
reservation on success or failure. Previews may use cached signals; actual launches
cannot rely on the five-minute preview cache. No quota is estimated from dollars
or token counts. Missing/failed scans preserve fresh protection only until its original observation expires; a scan never renews the evidence clock.

Each reported window retains observedAt and changedAt independently. Repeated
Claude events carrying a number refresh its observation time even when the percentage is unchanged. Status-only events do not renew that number; a changed reset discards the old percentage.
Codex snapshots merge per window, so a partial event cannot erase a hot weekly
window. Current percentages expire after ten minutes or their reset time and are
shown as unknown. Last-known percentages remain diagnostic history and cannot hold units, queue entries, exploration eligibility or chat settings.
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


Codex plan usage is read by a short-lived app-server (`account/rateLimits/read`,
`codex-usage-probe.ts`) in Genio's own Codex home only, which needs a ChatGPT
sign-in; an API-key login has no plan usage. What it reports per login state:
signed in with ChatGPT shows the real windows; not signed in, an API-key login
(Genio's home or the dummy key in the player's own `~/.codex`), no Codex CLI or
an unusable home all mean "needs sign-in": no probe process starts, no error
text is stored, the Codex row is left out of the usage popup and the plan meter,
and old Codex readings and session snapshots are ignored. The Accounts row
("Genio's Codex") says Sign in, and the rail warning names "Codex is not signed
in" (see below). The probe never reads or writes the player's `~/.codex`. A
signed-in probe that fails (timeout, unexpected format) still shows its
"could not read" reason.

Genio warns about exactly two sign-ins, Claude and Codex (a Codex API-key login
and an unsigned Genio home count as not signed in; FAL, Uthana, GitHub, Unity
and the rest never warn). The warning is one amber mark on the Systems button of
the rail, whose hover names the tool ("Claude is not signed in"); while it
shows, the button opens Accounts & keys. It appears at start and in every
window, again whenever a signed-in tool loses its sign-in, and clears by itself
once signed in. It is re-read every 10 minutes, whenever a login or logout
ends and whenever Accounts is read. An unverified quota is not a sign-in issue
and never warns.

Claude plan usage is refreshed through the SDK's structured `/usage` control request
(`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, SDK 0.3.296), using
an empty streaming input, no tools and no persisted session. It submits no model
prompt. The CLI handles its own authentication and its account usage endpoint;
Genio does not read credentials or call a private OAuth endpoint. Refresh starts
on application startup, runs on meter/usage scans (one-minute probe cache), and
is checked before unit reservation and immediately before launch, with a forced
refresh whenever Claude protection could hold the launch. Probes are
single-flight and close after success, error or a 25-second deadline. An older
CLI without this experimental control reports a visible refresh failure; expired
evidence remains unknown and permits ordinary dispatch.

The structured account endpoint reports **used percent, 0?100**, including 0 and 1;
SDK `rate_limit_event.utilization` is a **used fraction, 0?1**. The parsers use
separate contracts, never a magnitude-based guess. Remaining is computed once,
as `100 - used`. Five-hour, weekly and model windows stay separate; session cost,
context occupancy and transcript token totals never become plan percentages.
A successful full account snapshot replaces old account/window evidence and
records the subscription type. API-key/third-party sessions invalidate the saved
subscription snapshot without inventing a remaining balance.

Event turns (unit ready/blocked/done notifications and the requested project-open
greeting) bypass percentage protection at delivery, provider preflight and the
Claude driver. They can pass optional unsubmitted system work waiting on plan
protection. Routine events still use the Usage mode's batching window. Actual
provider rejections retain the shared transport backoff; delivery keeps its
batch unacknowledged, publishes the pending event count and a durable deduplicated
hold reason, and refreshes account usage automatically. A newer full account
report can confirm recovery. Only successful handling acknowledges the batch;
failed or interrupted handling is replayable after restart. Unit protection for
fresh 70/85/95% readings and rejections remains in place.

# Usage mode and shared plan meter (stage 3)

Settings → Usage & limits has **Usage mode [Save | Balanced | Max]** and the separate **Units at once**
number choice (1–32). The mode's one-line summary shows the chat model and effort, without repeating the unit limit.
Model and effort pins are no longer set there: the
page lists any pin that exists (chat or unit model and effort, locked routing rows and rules, a project's own
mode) with Unpin or Open. `src/shared/usage-mode.ts` holds the table; the summary line, the loadout
picker, the chat sessions, the supervisor and the dispatcher all read it.

| | Save | Balanced (default) | Max |
|---|---|---|---|
| Chat, including allies without their own pick | Sonnet / low | Sonnet / medium | Opus / high |
| Units: chore, docs, tests, build/CI | Codex / low | Codex / medium | Codex / high |
| Units: feature, bugfix, UI | Sonnet / medium | Codex / medium | Opus / high |
| Units: recon/design, refactor, graphics | Codex / medium | Codex / high | Opus / xhigh |
| Units: review, large-context | Codex / medium | Codex / high | Codex / xhigh |
| Units: art (agent work) | Codex / low | Codex / medium | Codex / high |
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
A project can carry its own mode (This project → General, or its legacy cost dial).
Neither global nor project Usage mode changes concurrency. **Units at once** sets the
shared cap across all projects and bases; the existing project **Max units at once**
can only lower it for that project (0 means no project limit). Equal or higher project
limits add no extra display.
The cap is checked inside the serialized launch reservation, counting units that
hold a place in every base plus launches reserved but not yet listed; a respawn
keeps the place it already holds. Cheap models also need an explicit paid-spend
allowance (Advanced); a mode never grants one.

New installs start with 8 unit places. Existing settings migrate once to their previous
global mode's limit: Save 4, Balanced 8, Max 16 (including the equivalent legacy cost dial).
Explicit unit limits, model pins, credentials and other saved settings are preserved;
later mode changes leave Units at once alone. Reducing the limit leaves running work
alone and holds new launches until capacity is free. `settings_read` exposes `unitsAtOnce`
and `settings_update` accepts an integer from 1 to 32 on the player's request.

All project windows share that dispatcher and account meter. Competing project launches reserve the last place
atomically; a warm plan's one-unit limit also counts work in every project base.
Finished units release their places even when their terminals remain alive.

Queued quests use the dispatcher's current Units at once limit and the project's
capacity; project-open recovery uses the same limits. A work plan's `max_parallel`
(default 2, maximum 3) separately bounds that plan's active steps. Unity's per-project
slot pool (1–8, default 1) and machine editor/memory limits separately bound editor work; they do not
change the global unit setting. Quota protection may still hold launches below the
configured unit limit.

The meter's project attribution includes project chat and Bot session IDs (current
and recorded historical sessions), plus units under each base's worktrees.
Session ownership takes precedence over cwd changes. Codex telemetry and native
logs use the metadata session ID. Legacy main chat stays unattributed, since it
can span projects. These measured tokens are separate from shared account quotas;
they do not represent a project's percentage of a plan.

`tests/project-usage.test.ts` verifies both providers, historical sessions, cwd
drift, nested project worktrees, deduplication and legacy shared chat.
`tests/usage-mode.test.ts` covers cross-project launch races and warm-plan fallback.

**Pinned.** A non-empty chat/Bot/unit model or effort, an ally's own pick, a
locked category row, a dispatch rule or an explicit deploy pick is Pinned: neither
the mode nor protection changes it, and Settings → Usage & limits lists it with Unpin.
Migration keeps every explicit pick as written; only the old shipped chat default
(`wkspEffort: 'high'` with no model) becomes Auto, and the old cost dial becomes
the mode (Quality → Max, Cost → Save).

**Protection**, per plan, from the worst fresh reported window (all expired evidence is unknown):

- below 70%: the mode as set;
- 70–84%: exploration off, at most one unit on that plan, Auto unit effort one
  step lower, the other plan preferred, Auto chat effort one step lower and
  answers held to Save's target;
- 85–94%: excluded from every automatic unit candidate; Auto chat drops to
  Sonnet / low at the next turn;
- 95%+ or rejected: optional system work is held; low-priority queued
  quests and, when no plan has headroom, all queued quests stay queued until
  reset ("Queued until reset" in Quests). Running work is never stopped.

A one-line notice (a toast) is emitted only when a plan's level
changes; its details give the cause and evidence age. Levels persist in
`data/usage/policy-state.json`, so restarts do not repeat notices.

**Plan meter.** One component (Settings › Usage & limits; nothing shows it at all times): a Claude
row and a Codex row, never summed, each reported window with what is left, reset
time, source and observation age. Expired or missing observations read "unknown",
never "100% left"; missing standard windows read "not reported". While a plan is at
70% or more, Usage & limits also shows one line for it with what protection is doing.
