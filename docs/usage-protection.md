# Usage protection and measurement (stage 1)

Quota protection never picks, changes or holds a model because of who chose it:
it only limits how many units run. A provider with a reported window at 85% or
above, or a rejection, observed within ten minutes and before reset, starts no
new unit: the launch waits (quota-deferred) with its tool and model and is never
moved to the other plan. This applies the same way to explicit picks, rules,
category rows, sticky follow-ups, the default and respawns.
Unknown headroom (including expired hot evidence) permits ordinary dispatch with a quota-unverified warning.

At 70?84%, a provider can have at most one running, launching or reserved unit;
further launches on it wait. Below 70% launches on the same provider run side by
side. The main-process dispatcher
serializes selection and claims a provider launch reservation across all homes;
launch refreshes the account report again just before terminal creation, and releases the
reservation on success or failure. Previews may use cached signals; actual launches
cannot rely on the five-minute preview cache. No quota is estimated from dollars
or token counts. An unavailable usage source fails open for units and queued
quests with the existing quiet quota-unverified warning, even if diagnostic
history still contains a hot reading. A scan never renews the evidence clock.

The main process refreshes account usage at startup and every **two minutes**
while any quota hold, queued quest, deferred launch/relaunch or pending wake
exists. No Settings page or renderer subscription is needed. Failed refreshes
back off at 2, 4, 8, 16 and at most 30 minutes; success restores the two-minute
interval. Each source is single-flight, has a one-minute minimum interval even
for launch preflights, and enforces its own error backoff across all callers.
Every reservation and final launch check reads account usage before deciding
whether to defer, subject to those source limits. Evidence older than **ten
minutes**, or past its own five-hour/weekly reset, cannot hold work.

Previously the dispatcher had only startup and demand-driven scans: opening
Usage & limits refreshed the Claude Code `/usage` and Codex
`account/rateLimits/read` snapshots. A queued quest could be filtered out before
the launch preflight ran, leaving no independent refresh or prompt retry.
Account refresh now re-evaluates supervision immediately when protection changes,
without waiting for the backed-off heartbeat. Plans drain through their normal
gates; other queued quests follow the existing automatic-dispatch setting.
Already-requested quota-deferred deployments and relaunches are persisted
and retried automatically, preserving the request, its loadout and relaunch allowance.
They still respect project closure, player holds, dependencies, capacity and
per-launch model approval. Recalling a unit cancels its pending relaunch.

Each reported window retains observedAt and changedAt independently. Repeated
Claude events carrying a number refresh its observation time even when the percentage is unchanged. Status-only events do not renew that number; a changed reset discards the old percentage.
Codex snapshots merge per window, so a partial event cannot erase a hot weekly
window. Current percentages expire after ten minutes or their reset time and are
shown as unknown. Last-known percentages remain diagnostic history and cannot hold units or queue entries.
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

Replay coverage: the 97%-Claude Recon (nothing explores, nothing moves to the other plan); stale/unknown/rejected combinations;
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
and never warns. The same read picks the default model (Claude, else Codex when
only Codex is signed in) and closes the Hub's sign-in gate while neither is signed
in (see [project-startup.md](project-startup.md)).

Claude plan usage is refreshed through the SDK's structured `/usage` control request
(`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, SDK 0.3.296), using
an empty streaming input, no tools and no persisted session. It submits no model
prompt. The CLI handles its own authentication and its account usage endpoint;
Genio does not read credentials or call a private OAuth endpoint. Refresh starts
on application startup, runs on meter/usage scans (one-minute probe cache), and
is checked before unit reservation and immediately before launch, with a forced
refresh attempt whenever Claude protection could hold the launch, respecting
the one-minute source minimum and error backoff above. Probes are
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
number choice (1–32). The mode never picks a model or an effort: it sets only how long routine
updates batch and how long answers and Recon summaries run, and its one-line summary says exactly
that ("Replies under about 250 words; routine updates batched up to 5 min."). Models are not set on
this page. `src/shared/usage-mode.ts` holds the table; the summary line, the chat sessions, the
supervisor and the dispatcher read it.

| | Save | Balanced (default) | Max |
|---|---|---|---|
| Routine wake batching; heartbeat base/max | 10 min; 30/120 | 5 min; 15/120 | 1 min; 10/120 |
| Chat answer / Recon summary target | 150 / 400 words | 250 / 800 | 400 / 1,500 |

**Models: whatever the player set, else one default.** The chat, the Bot, allies, Lore chats and
units use the model and effort the player set, as written, always: a chat or ally model and effort,
a dispatch rule, a category row in Settings → Advanced → Model routing (Dispatch), the default unit tool, model
and effort, an explicit deploy pick and a follow-up's original loadout. Nothing switches or holds a
model because the player chose it. Where nothing is set the default is **Claude Sonnet 5.5**
(`claude-sonnet-5-5`); when Claude is not signed in (or not installed) and Codex is, it is **Codex
Sol 6.1** (`gpt-6.1-sol`); with both signed in Claude wins. The default effort is medium for the
chat and for Builds, high for Recons (Codex's own default is medium too). The default is the same for
every unit category, Usage mode and Modeller Build. The categories, the scorecard and its learned
scores stay as history: they never pick or reorder a model. The scorecard may still propose adding
or removing a candidate in the player's own rows and rules as a Your Move choice; only accepting it
changes anything. `src/shared/unit-model-policy.ts` holds the default; `pickLoadout` (units) and
`chatSettings` (chats) apply it, reading the same Claude/Codex sign-in the rail warning reads.

Codex units explicitly use `gpt-6.1-sol` so a CLI default cannot silently select
Astra. Unspecified Claude unit models resolve to Sonnet 5.5. Within the player's own ordered rule or
row, a tool that is not installed or not signed in is skipped in the order written; a plan quota
protection holds makes the launch wait instead.

Fable and Astra always require a fresh player approval at the central unit launch
boundary. Deploy buttons, chat tools, queued dispatch, saved picks, rules, sticky
follow-ups, automatic recovery, respawns and Recon upgrades all use the same
Allow once / Deny permission prompt. Approval is never saved on a task or inferred
from shell mode, YOLO, model selection or prior consent. Denial or the broker's
ten-minute timeout prevents the launch. A respawn waits for approval before
recalling its current process. Quota is checked again after approval and directly
before process creation, and reservations are released on failure.

The default is Sonnet or Sol; Opus and the rest run only when the player picks
them. Astra is normally reserved for heavy visual work and remains an explicitly
chosen, explicitly approved exception.
A project can carry its own mode (This project → General, or its legacy cost dial).
Neither global nor project Usage mode changes concurrency. **Units at once** sets the
shared cap across all projects and bases; the existing project **Max units at once**
can only lower it for that project (0 means no project limit). Equal or higher project
limits add no extra display.
The cap is checked inside the serialized launch reservation, counting units that
hold a place in every base plus launches reserved but not yet listed; a respawn
keeps the place it already holds. Cheap third-party models run only from a rule or
category row the player wrote, and also need an explicit paid-spend allowance; a
mode never grants one.

New installs start with 8 unit places. Existing settings migrate once to their previous
global mode's limit: Save 4, Balanced 8, Max 16 (including the equivalent legacy cost dial).
Explicit unit limits, model picks, credentials and other saved settings are preserved;
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

**Migration** (once, `plainModelDefaults`): every explicit pick stays as written (the
chat, Bot and ally models and efforts, the default unit model and effort, rules, explicit
deploy picks). The old shipped defaults become unset and so use the default: category rows
that were not locked (they followed the Usage mode and were never used as written) are
dropped, locked rows stay as the player's rows without the lock, rules lose their lock, the
shipped default unit tool `claude` becomes unset unless a default unit model or effort was set
for it, and the automatic reorder switch is gone. As before, the old shipped chat default
(`workspaceEffort: 'high'` with no model) becomes unset and the old cost dial becomes the mode
(Quality → Max, Cost → Save).

**Protection**, per plan, from the worst fresh reported window (all expired evidence is unknown):

- below 70%: no limit;
- 70–84%: at most one unit on that plan and answers held to Save's target;
- 85–94%: new units on that plan wait;
- 95%+ or rejected: new units on that plan and optional system work wait; low-priority queued
  quests and, when no plan has headroom, all queued quests stay queued until
  reset ("Queued until reset" in Quests). Running work is never stopped.

No level changes a model or an effort, and no launch moves to the other plan.

**Quota protection** is on by default, including for existing settings. Turn it off
with the single switch beside the plan meter in Settings → Usage & limits. Off means
units, queued quests and optional system work run without percentage-based limits
or quota holds. The
independent Units at once setting and project caps still apply. Real
provider rejections still show the existing chat limit line and keep their retry
backoff; turning protection off cannot remove a provider's own limit.

While protection acts at 70% or above (or after a rejection), the project chat and
floating Genio panel show one amber bordered, subtly tinted warning box at the
top centre of the chat, below the title bar and above its content. It uses the
existing warning glyph and readable text, with one line that wraps in narrow
windows; choice cards, feature tips and toasts stay clear of it. It
names each affected plan and what is being limited, including the titles of launches
waiting in this project, read from the same persistent retry queue. Turning
protection off retries those launches immediately through their normal checks. Its **Settings** action opens Usage & limits at
the Quota protection switch. The dismiss icon hides the current levels in both
chat surfaces, including remounts and restarts; only a worse level
returns. The box clears when evidence expires, protection recovers or the switch
is off. It is never repeated per message and produces no toast or popup.

The switch's one-line description says it runs fewer units as plans fill up, never another model, and that provider limits always apply.
The chat's `settings_read` and `settings_update` expose `quotaProtection` as a
boolean; the chat can change it on the player's request through its existing
approval policy. A successful change earns **Your Pace** once.

**Plan meter.** One component (Settings › Usage & limits; nothing shows it at all times): a Claude
row and a Codex row, never summed, each reported window with what is left, reset
time, source and observation age. Expired or missing observations read "unknown",
never "100% left"; missing standard windows read "not reported". While Quota protection is on and a plan is at
70% or more, Usage & limits also shows one line for it with what protection is doing.
With the switch off the plan meter remains, without a protection line.
