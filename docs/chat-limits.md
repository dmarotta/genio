# Claude chat limits

Each AgentSession retains its own queue and banner. Account-wide eligibility is
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

The existing Retry now / Restart session actions retain their queue and query
recovery behavior but pass through this gate. A stale foreground error may still
resume once, subject to the shared probe budget. Repeated errors and notices are
deduplicated by rejection episode. Failed wake turns are not acknowledged.
Local 30-second checks read persisted evidence only, never the provider. Stopping
the service cancels its timers. After application shutdown, queued player messages
keep the existing unsent behavior and can be sent again.

CLI clock times use the named timezone (local time if omitted). Already-past
clocks are never rolled forward to tomorrow. Explicit today/tomorrow, month/date,
ISO timestamps and SDK epoch seconds are supported. Expired quota percentages
become unknown in the account view. Old hot evidence remains protective for
units until a fresh observation confirms recovery; a reset timestamp alone does
not authorize an automatic retry swarm.

`tests/chat-queue.test.ts` exercises fake SDK streams and reset timers.
`tests/usage-protection.test.ts` exercises persistence, shared rejection/probe
budgets, deduplication and cumulative cost checkpoints. No provider quota is used.
