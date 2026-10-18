# Codex sessions out of the player's Codex apps

The Codex desktop app lists every thread in `$CODEX_HOME` that is not archived,
ephemeral, a sub-agent or an `exec` run. Genio's Codex units are `cli` threads,
so without help each one stays in the player's sidebar forever.

## Genio's own Codex home

- Every Codex process Genio starts (units and Recons, the Codex chat, the usage
  probe, model discovery and image runs) uses `CODEX_HOME=<base>/codex-home`
  (`codex-home.ts`), so nothing lists in the player's Codex or ChatGPT apps, even
  while it runs. Non-Codex units get it too, for their Codex image runs.
- The player signs that home in once from Settings > Accounts & keys > "Sign in Genio's
  Codex (same account)" (or the Hub's "Sign in with Codex", the same flow): `codex login` with that `CODEX_HOME`, with their usual
  ChatGPT account (same plan, no second subscription). It is an independent
  login; the player's `auth.json` is never copied or linked. "Sign out" runs
  `codex logout` there only.
- Genio seeds only `config.toml` with `model = "gpt-6.1-sol"`. Sandbox and
  approvals come from launch flags.

## Folder trust

Codex asks "Folder access … Trust this folder?" the first time it runs in a
folder it has not seen. For a unit's worktree, Codex says "Trusting will apply
to the repository root". Nothing answers it on its own, so a new project, a moved
project or a new Dev Drive path would hold the unit before its first turn.

- Prevent: at launch Genio writes `[projects.'<folder>'] trust_level = "trusted"`
  into its own home's `config.toml` (`setCodexTrust`, `codexUnitFolders`). It
  writes one entry for the unit's worktree and one for the registered project's
  repository root. The root the worktree's `.git` link names is also written,
  but only when it is that same registered folder under another spelling or
  through a link. The keys use the form Codex 0.162.1 matches: case does not
  matter; no `\\?\` prefix, backslashes, no trailing separator. Every other
  entry in the file stays. The worktree entry is dropped at despawn. The
  player's own Codex config is never edited.
- Backstop: if the dialog still shows (for example in a home Genio did not
  pre-trust, such as a unit resumed from before Genio's home), `watchCodexTrust` in `crew.ts` reads the folder it
  names. It answers Enter on "1. Trust and continue" once per appearance, and
  only when that folder is the unit's worktree or its project's root. It leaves
  any other folder, or a pointer moved off option 1, unanswered, and raises one
  stale signal that says why. The dialog never counts as unit work.
- Trust lets Codex read the worktree's `.codex/config.toml`. Its MCP servers stay
  off: each unit launch turns them off by name ([mcp-servers.md](mcp-servers.md)).
  Marking the folder "untrusted" instead is not an option: Codex then shows a
  different "Folder access … Open restricted" dialog before the first turn.
- The other runtimes: Claude Code's "Quick safety check … Yes, I trust this
  folder" is pre-accepted in Genio's Claude home (`setClaudeTrust`) and answered
  on screen. Gemini runs with `GEMINI_CLI_TRUST_WORKSPACE=true`, which its folder
  trust check honours. OpenCode 1.19 has no folder trust prompt. Cursor Agent
  runs with `--trust`.

## Needs sign-in: Genio never uses the player's own Codex login
- `codex login status` in that home must report ChatGPT. Until it does (not
  signed in, an API key, an error) Codex is **needs sign-in**, in one place:
  `codexLaunch()` in `codex-home.ts` throws `CodexNeedsSignIn` before anything
  starts. Codex units and Recons, the Codex chat and Lore chats, chat image
  generation, model discovery and the usage probe all go through it, so none of
  them ever runs against, reads or writes the player's `~/.codex` (its login may
  be a dummy or API key, and its threads would show in the player's Codex app).
  The only exception is a unit from before Genio's home existed: once Genio's
  home is signed in, it still resumes in the home where its thread lives.
- The answer is checked once at start (`startSignInWatch`) and then stands: no
  repeated probes or log lines per launch. A sign-in or sign-out ending in
  Accounts resets it, as does opening Accounts (a fresh check) and the 10-minute
  sign-in watch.
- Accounts shows it in the "Genio's Codex" row ("not signed in", with the
  existing "Sign in Genio's Codex (same account)" action; an API-key login shows
  as an error with both actions). The player's own "Codex CLI" row stays as a
  read-only status: Genio never signs the player's own login in or out.
- The dispatcher counts Codex as logged out meanwhile: the default model stays
  Claude, a rule or category row the player wrote skips it in the order written
  ("Codex ... skipped: not logged in (Genio's own Codex sign-in; picking
  another tool)"), and an explicit Codex pick is refused with the way to sign
  in. Once Codex is signed in and Claude is not, the default is Codex Sol 6.1. A running Codex unit that
  loses its sign-in fails like any provider auth error.
- A unit records the home it ran in (`Task.codexHome`); respawns, discovery and
  archiving use it. A chat thread the current home does not hold is left where it
  is; a fresh thread gets the bounded chat handoff.
- Usage reads `sessions/` and `archived_sessions/` of Genio's home, plus the
  player's for Genio threads from before it (read-only, never a login). The
  plan usage probe needs the ChatGPT sign-in; with none it reports nothing
  (see [usage-protection.md](usage-protection.md)).

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

## Claude sessions and exceptions

New Claude work uses `CLAUDE_CONFIG_DIR=<base>/claude-home`. Claude reuses
the player's login in place through `CLAUDE_SECURESTORAGE_CONFIG_DIR`; it does
not have a separate Genio sign-in. Its transcripts, history and session registry
stay in Genio's folder while the isolation preflight succeeds (`claude-home.ts`).

An older Codex unit or Claude conversation that exists only in the player's
home still resumes there and can appear in the player's apps. Claude also
falls back to the player's normal home if the isolation preflight fails, with
a warning; new Claude conversations can then appear there too. Signing out
Genio's Codex stops new Codex launches until it is signed in again.

The Settings session cleanup feature has been removed. Removing it does not
hide or move sessions already in the player's homes, or restore sessions
previously hidden by it. Old conversations may still need a one-time cleanup
if the player wants them out of their apps; that is a separate decision.
Genio's ongoing unit archiving, legacy resumes and read-only usage scans remain.
