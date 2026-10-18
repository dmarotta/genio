# Claude chat limits

The provider queue defers unsubmitted quota-held turns before starting a driver.
A stale high percentage may hold automatic startup/wake work, but does not occupy
the foreground slot: an explicit message still reaches the foreground quota gate,
and an explicit provider selection can route unsubmitted work to that provider.
A last-moment driver refusal returns ownership to the queue without acknowledging
wakes. A background policy hold is labelled separately from a provider rejection.

Each AgentSession retains submitted/rejected work. Account-wide eligibility is
persisted in `data/usage/claude-backoff.json`: a rejection pauses new turns in main
chat, allies and the Bot, including after application restart. Deterministic
supervision and queued work continue without provider calls.

A limit result returns its turn to the front of the queue, preserving prompt,
images and wake acknowledgement cursor. Future reset times prevent retries until
the reset. An expired reset permits one serialized foreground probe for the
account; background event turns never probe. Unknown resets require new provider
evidence. Restarting a session does not clear the account rejection or probe
budget. A successful probe or a later allowed provider observation releases the
rejection; an older allowed observation cannot override a newer rejection.

The limit line's one action (Retry now, or Restart session when Claude still reports an expired limit) keeps its queue and query
recovery behavior but passes through this gate. A stale foreground error may still
resume once, subject to the shared probe budget. Repeated errors and notices are
deduplicated by rejection episode. Failed wake turns are not acknowledged.
Local 30-second checks read persisted evidence only, never the provider. Stopping
the service cancels its timers. After application shutdown, queued player messages
keep the existing unsent behavior and can be sent again.

CLI clock times use the named timezone (local time if omitted). Already-past
clocks are never rolled forward to tomorrow. Explicit today/tomorrow, month/date,
ISO timestamps and SDK epoch seconds are supported. Expired quota percentages
become unknown in the account view. Unit protection expires after ten minutes
or the window's reset, whichever comes first. Account usage refreshes before
launch decisions, and ordinary dispatch fails open if the source is unavailable;
actual chat rejection backoff remains separate.

Status-only SDK events do not refresh the age of a retained utilization number.
The meter shows stale percentages as unknown. The main process reads the live
Claude `/usage` and Codex rate-limit sources on startup and every two minutes
while work or a hold waits, with error backoff to at most 30 minutes. Reading
Usage shares those probes and their one-minute minimum interval; it is never
required to release a quota hold. Missing reports are unknown, and source errors
retain their safe reason. No percentage is invented from a reset or read failure.

Claude initialization has a 30-second deadline, cleared by the SDK init event.
A timeout closes the query, reports an error with bounded stderr diagnostics and
requires an explicit session restart before further dispatch, so unacknowledged
wakes cannot automatically replay the timed-out request. Late setup completions are
ignored. This deadline does not limit a turn after initialization.

`tests/chat-queue.test.ts` exercises fake SDK streams and reset timers.
`tests/usage-protection.test.ts` exercises persistence, shared rejection/probe
budgets, deduplication and cumulative cost checkpoints. No provider quota is used.
`tests/claude-startup.test.ts` covers stale startup holds, foreground priority,
provider switching, restart/interrupt, acknowledgement preservation, fresh-zero
recovery, read failures and initialization timeouts using a mocked SDK.
