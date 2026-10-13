# Claude chat limits

Each `AgentSession` owns its limit state, reset timer and retry budget. Main Genio,
allies and the AFK Bot recover independently. Account usage snapshots inform the
Accounts screen and dispatch; they never pause another chat's input queue.

A limit result returns its turn to the front of the queue, with the original
prompt, images and wake acknowledgement cursor. An expired reset (or a missing
reset with a latest `allowed` event) closes the SDK query, resumes the same
conversation and retries once. Another stale rejection leaves the turn queued
and shows a single banner with **Restart session**. Failed wake turns are not
acknowledged.

A future reset pauses the queue and schedules a resumed query at that time.
**Retry now** and **Restart session** restart only the selected session. A
successful turn or an `allowed` event clears the banner. Unknown reset times
remain queued for a manual retry or a later rate event; no reset is invented.
Stopping the service cancels its timer. Queue persistence across an application
shutdown retains the existing “unsent” behavior.

CLI clock times use the named timezone (local time if omitted). An already-past
clock is never rolled forward to tomorrow. Explicit today/tomorrow, month/date,
ISO timestamps and SDK epoch seconds are also supported. Expired rejected usage
windows are stale, cannot exhaust dispatch quota, and no longer display a
current rejection. An allowed snapshot does not inherit a rejected snapshot's
exhausted utilization when no new utilization was reported.

`tests/chat-queue.test.ts` drives fake SDK streams and fake reset timers; it does
not consume Claude quota. `tests/claude-limit.test.ts` covers parsing, timezone
offsets and usage snapshots.
