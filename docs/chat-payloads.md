# Bounded chat payloads

Claude and Codex use the same paged Genio tool registry. `read_task_file`,
`fleet_view`, `terminal_tail`, `memory_read`, and other inspection tools return
2,000 characters of content by default, plus a small page header and continuation.
Small results keep their original response shape. Mutations and tool errors are
never paginated, and image content is unchanged.

Repeat the original arguments with `cursor` to read the next page. `page_size`
accepts 200–10,000 characters; `full=true` explicitly reads everything. A cursor
with `full=true` returns that entire saved snapshot. Live logs, filed reports and
other changing sources are captured once, so continuation neither shifts offsets
nor repeats the underlying operation. Pages contain text excerpts, which may span
a JSON value; do not parse an individual excerpt as a complete document.

Cursors belong to their tool, arguments and registry session. They expire after
30 minutes, a session replacement, or cache eviction (32 snapshots / 8 million
characters, retaining at least the newest snapshot). Invalid/expired cursors fail
explicitly: restart the read without the cursor. Whole lines are preferred, and
individual tokens such as IDs and URLs are never split. An unusually large token
can exceed the requested size. All content remains available; paging does not
truncate the underlying result. The old 60K task-file cutoff is removed.

`read_task_file(which="report", appendix="evidence.md")` reads a linked appendix
inside that task's data folder. Absolute paths, parent traversal and escaping
symlinks are refused. Existing terminal-tail line limits still apply; paging
controls the characters returned from that selected tail.

## Events

Wake drains send approximately 2K-character batches of pending changes. Signal
lines appear once, without the duplicate UNREAD STATUS section or a full copy of
all open choices. Large event bodies are retained and linked through
`event_read(seq)`, which supports the same paging controls. `choice_list` remains
available when handling a choice requires it.

After finishing each event, call `events_ack(seqs=[id])`. Acknowledgements are
atomically persisted before success is returned, including out-of-order events.
A failed later action or restart replays only unfinished events. A successful turn
also acknowledges its delivered batch through the existing sequence cursor;
events arriving during that turn remain queued. Historical through-cursors are
compatible with the new sparse acknowledgement map. Queue compaction preserves
pending events through an atomic replacement.
Driver-retained retries refresh the event body from the durable queue immediately
before submission, while retaining any bounded provider handoff. Already handled
events are therefore removed even when the provider retries the same turn object.

This does not promise exactly-once external side effects: a crash after a side
effect but before its acknowledgement can still require idempotent re-handling.

## Memory and instructions

`memory_read` returns `which`, a content-hash `version`, and `text`. On a subsequent
read, `since=version` returns either `unchanged: true` or a character splice:
`delta: {baseVersion, start, deleteCount, insert}`. Apply it using JavaScript string
offsets: `old.slice(0,start) + insert + old.slice(start+deleteCount)`. Finish all
pages before treating a version as loaded. Unknown/evicted versions return a full
snapshot with `reset: true`; `full=true` without a cursor also ignores `since`.
Eight observed versions per file/base survive restart, including manual edits and
changes to an ally's inherited shared profile. These local snapshots have the same
sensitivity as the original memory files.

Both chat providers enforce a 10,000-character custom instruction budget, including
Bot rules and provider/Usage notes. The always-on contract keeps authority and
safety rules; it does not embed memory files, the full ally charter or asset skills.
Use `procedure_read` for intake, units, delivery, events, voice, quests, memory or
the ally charter. `skill_read` loads one named bundled skill, with an optional
Markdown `reference` inside its directory. These reads are paged. Claude's native
Skill tool is disabled to prevent incidental bulk configuration injection.
`settings_read`/`settings_update` expose only supported non-secret preferences;
advanced/security/account configuration remains in Systems. Bot cannot change them.

Recon reports default to the Usage-mode word target (800 words when unspecified)
and 6,000 characters, with evidence in linked separate appendices. Explicitly
requested detail overrides those targets.

No new achievement is awarded: paging, acknowledgements and lazy reads are
internal delivery mechanics without a player first-use action. A Usage-mode change
through the narrow settings tool triggers the existing Gear Shift event.

The existing provider history is retained. This change reduces new tool results,
event re-delivery and custom instructions; it does not remove old large content
already stored in a resumed provider conversation.
