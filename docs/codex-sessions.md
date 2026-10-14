# Codex sessions out of the player's Codex apps

The Codex desktop app lists every thread in `$CODEX_HOME` that is not archived,
ephemeral, a sub-agent or an `exec` run. Genio's Codex units are `cli` threads,
so without help each one stays in the player's sidebar forever.

## Despawned units are archived

- When a Codex unit is despawned, `crew.ts` schedules `codex-archive.ts`. It waits
  5 seconds so the unit's process can exit, then finds every rollout whose
  `session_meta.cwd` is the unit's worktree and runs `codex archive <id>` against
  the unit's Codex home. Threads of other units or of the player are never matched.
- Archiving is the official Codex operation: the rollout moves to
  `$CODEX_HOME/archived_sessions/` and the thread is flagged archived. Nothing is
  deleted. It is safe while the Codex app runs.
- Codex refuses a thread that is still live or open (exit 1). Genio never forces
  it: the id goes into `data/codex-archive-pending.json`. Genio retries it 1, 5
  and 30 minutes after each previous try, and on every start. After 20 refusals it lets the thread be.
- Each archive and unarchive Genio performs is a line in
  `data/codex-archive.jsonl` (`action`, `id`, `codexHome`, `task`, `cwd`, `at`).
  `codex unarchive <id>` with `CODEX_HOME` set to that home reverses an entry.

## Archived threads still count

- Discovery (`codex-session.ts`) reads `sessions/` and `archived_sessions/`, so a
  unit's id is still found after archiving.
- A respawn whose thread is archived runs `codex unarchive` first, because Codex
  refuses to resume an archived thread. It also drops the id from the retry list
  so the resumed thread stays visible to the unit. If the unarchive fails, the unit
  starts a fresh conversation in the same copy, as when no session is found.
- The usage scan reads both folders with the same week window. An archive keeps
  the file's mtime, so the week's totals and plan snapshots do not change.
- The Codex image helper's `findRollout` falls back to `archived_sessions/`.

## Image runs are not archived

The image helper runs `codex exec`, and Codex already hides `exec` threads: the
desktop app drops them, and the app-server's default `thread/list` (used by the
CLI resume picker) lists only interactive sources. Archiving them would add a
Codex call per image without hiding anything more.

## Rule for new one-shot Codex calls

A Codex call that does not need its thread afterwards runs ephemeral:
`codex exec --ephemeral`, or app-server `thread/start` with `ephemeral: true`.
Nothing is then written to disk, so nothing can list. The probes start no
thread at all. `tests/codex-one-shot-rule.test.ts` enforces this rule. It allows
only the threads that must persist: the image helper reads its rollout, and the
chat thread is resumed across restarts.

## Older Genio sessions: Settings > Accounts > Housekeeping

Threads and Claude folders Genio left before this are hidden only when the player
clicks "Hide Genio's past sessions from the Codex and Claude apps"
(`session-migration.ts`). It shows a preview first and never runs automatically.

- What is Genio's comes from where it ran: Genio's bases, unit worktrees, data
  folders and `genio-e2e-*` temp folders, plus Codex chat threads (originator
  `genio_chat`). Codex threads are matched by the rollout's `session_meta.cwd`;
  a Claude folder is matched only when every transcript's `cwd` is Genio's.
- Running units, the current chat sessions and live Claude registry entries are
  skipped.
- Codex: one pilot thread is archived first. If Codex's `thread/list` still shows
  it, nothing else is archived. Claude: folders move into `<base>/claude-home/projects`,
  where Genio still resumes them.
- Every item is written to `data/session-migration.json` (from, to, time) as it
  happens. Undo unarchives and moves back everything there, and never overwrites a
  file the player has again. `history.jsonl` and `session_index.jsonl` are never edited.
