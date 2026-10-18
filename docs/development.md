# Developing Genio

Everything for building, running, testing and packaging Genio from source. For what Genio does, see the
[README](../README.md); for the design, [ARCHITECTURE.md](ARCHITECTURE.md).
Contributor rules (tests, UI guidelines, keeping docs and achievements current) are in [AGENTS.md](../AGENTS.md) and
[ui-guidelines.md](ui-guidelines.md).

## Requirements

- Node.js 20+ and Git.
- Claude Code (`claude`) and/or Codex (`codex`) installed and signed in. Genio itself talks to Claude through the
  Claude Agent SDK, and Claude Code is the default unit runtime.
- GitHub CLI (`gh`), signed in, for the modes that open pull requests. **Settings** can install missing tools after
  you click Install.

## Run it

```sh
npm install
npm run dev        # development with hot reload
npm run build      # production bundle in out/
npm start          # run the production bundle
npm test           # unit tests
npm run typecheck
```

npm 11 blocks dependency install scripts by default. This repo allow-lists the ones it needs (`electron`, `esbuild`,
`node-pty`) in `package.json`.

## Checks

```sh
npm test                 # unit tests (status protocol, briefs, git guards, quest log, events, memory)
npm run test:e2e         # isolated CLI checks; paid Claude checks require GENIO_E2E_REAL=1
                         # and test-only credentials (see performance.md)
npm run perf             # performance harness: chat rendering, main-process event routing,
                         # startup and the usage scan over a realistic Base (performance.md)
npm run typecheck
```

Tests and experiments never touch your real provider config or credentials: point `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` and similar at a temporary folder in the same command, and never run login or logout commands.
Remove `GIT_CONFIG_*` variables from the shell first; they break the git tests.

`npm run build` and `npm run dist` first run `scripts/check-help.mjs`, which fails when a doc listed in
`docs/help/help-set.json` is missing or links to a doc that does not exist.

### Capture tool

Build, then run `npm run capture -- <output-dir>`. Genio screenshots its own window on every view and quits, using
temporary provider homes, a temporary Base and an isolated Electron profile. Capture options and the testing isolation
rule are in [performance.md](performance.md).

## Slash commands in Comms

| Command | What it does |
|---|---|
| `/recap` | What happened since you last spoke, then your open choices one at a time |
| `/status` | Character Sheet (level, XP and achievements) |
| `/afk [note]` | Go AFK: the Bot handles events and holds anything that needs you |
| `/dnd` · `/dnd off` | Do not disturb: routine events stay off Comms |
| `/online` | Back online |
| `/save` | Curate the player profile and squad memory |
| `/patch` | Update a source checkout of Genio (fast-forward only) |
| `/help` | List commands |

## Base layout

Everything lives under `~/.genio` (override with `GENIO_HOME`):

- `config/`: settings
- `data/`: durable records (projects, quests, choices, briefs, reports, profile, squad memory, replay log)
- `state/`: runtime records (unit status logs, event queue, presence)
- `projects/`: clones
- `worktrees/`: one per unit
- `workspaces/<name>/`: project and ally bases, each with the same layout
- `backups/workspaces-migration/`: the checkpoint written when an older base was migrated (below)

Older bases kept these under `wksps/`. On the first start of a build that uses `workspaces/`, and only when no unit
process is running, Genio moves the folder with one rename and then repairs everything that pointed into it:

1. It copies the small config, data and state records it may rewrite (and Genio's own Claude and Codex config) to
   `backups/workspaces-migration/files/` and writes `manifest.json` there.
2. It renames `wksps/` to `workspaces/`. If `workspaces/` already exists, or the rename fails, it stops with one
   warning and leaves everything as it was. Nothing is ever deleted.
3. It rewrites stored absolute paths (unit records, task paths, claude-settings and mcp-config files, plans, the
   ally registry, trust entries) and runs `git worktree repair` for each repository.
4. It copies, never moves, Genio's own saved Claude conversations that are keyed by the old working directories, so
   respawned units and ally chats keep their history. Conversations that exist only in the player's own Claude folder
   are counted in the manifest and left alone; those chats start fresh.

A record that could not be rewritten is still read through its new location. The migration is idempotent; an
interrupted run resumes at the repair step. To go back to a build that uses `wksps/`, quit Genio and call
`restoreWorkspaces(<base>)` from `src/main/workspaces-migration.ts`: it renames the folder back, restores the
checkpointed files and re-points the git worktrees. A restored base is not migrated again until
`backups/workspaces-migration/` is removed.

Records written before the "wksp" concept became "workspace" keep loading: `src/main/legacy-keys.ts` renames the old
`wksp…` keys on read (JSON and JSONL through `readJson`/`readJsonl`), and `Home.workspaceFileToRead` falls back to the
old `state/wksp.json`. Only the new keys are written.

Registered projects own their units, quests and choices in their project base. Startup migrates legacy ownership once
with a durable backup checkpoint; existing unit artifact and worktree paths stay valid.

## Projects, the Hub and Settings

Launching Genio without arguments opens a minimal project-selection Hub. Recent projects, **Open folder** and
**Clone** select a project. Search by name, folder or engine, or sort the list. Waiting choice counts and answer
history remain available from the Hub. Selecting a project opens its own window on its main chat. Recent selections
are remembered on this device; work controls and first-run setup live inside the project window.

**Open folder…** accepts any existing folder. Git subfolders resolve to the repository root. Ordinary folders open
Offline with chat and Inventory; git actions unlock after initializing the repository in chat and reopening the
folder. Closing a project window warns before stopping running units; non-git folders keep git actions disabled.

Project windows keep configuration in **Settings → This project**: General (the detected engine and engine root,
read-only with Rescan, a repository pins its root in `.genio/project.json`; description, usage mode, max units at
once, the OpenRouter opt-out, and the setup/build/test/lint commands), Delivery (Offline, Standard PRs, or the
Hardcore Gauntlet, automatic remote following, and merge finished work automatically (Auto-loot)), Asset generation
and, for Unity, Unity slots. Settings stored for every project are under **All projects**, and two expert pages under
**Advanced**. Pages and fields use plain names, and Settings search still finds the old names and game terms
(Gauntlet, Loadout, Patch…). Sync and push on demand are asked of Genio in chat. A project is removed from Genio with
the bin icon beside it in the Hub's project list (or by asking Genio); removal still refuses live units, queued quests
and unlanded work, and an owned folder is never deleted.

Existing stored keys and file formats remain compatible. MCP tools with a `world` argument also accept `project`; the
original argument and tool names remain supported. Conflicting aliases are rejected before scoped calls run. Bundled
unit CLI flags such as `--world` keep their existing spelling.

## The `genio` terminal command (Windows)

For development, run `npm ci`, then `npm run build`. From any PowerShell directory:

```powershell
& C:\path\to\genio\resources\genio.cmd .
& C:\path\to\genio\resources\genio.cmd 'C:\Games\My Game'
```

The shim preserves the caller's working directory. Equivalently, invoke
`C:\path\to\genio\node_modules\electron\dist\electron.exe C:\path\to\genio <folder>`. With `resources` on PATH, use
`genio .` or `genio <folder>`. A second invocation opens or focuses the project in the existing process. Closing a
project with running units offers **Stop units and close** or **Cancel**, retaining worktrees.

To enable `genio` in new terminals, open Windows **Edit environment variables for your account**, edit the user
**Path**, and add the absolute path to Genio's `resources` folder (containing `genio.cmd`). Remove that entry to
uninstall the terminal command. The shim runs a packaged `Genio.exe` (it lives in `<install>\resources\app\resources`),
or the built development app in the parent folder. It does not change PATH itself.

## Building the Windows app

`npm run dist` builds an unpacked, Genio-branded `release\win-unpacked\Genio.exe` (electron-builder, configured under
`build` in `package.json`; nothing is published).

## Windows integration

In a project window, **Settings → System → Windows integration → Install** adds **Open with Genio** to folder and
folder-background context menus for your Windows account. On Windows 11 it appears under **Show more options**. It
uses the same folder-open path as `genio <folder>`, including focusing an already-open project. Once it is installed
the same button becomes **Remove**, which deletes both Genio context-menu keys. A partial or older installation shows
**Install**, which repairs it.

Only these HKCU keys are modified: `Software\Classes\Directory\shell\Genio` and
`Software\Classes\Directory\Background\shell\Genio`. No administrator rights are needed, and startup never installs or
repairs them. If Genio moves, click Install from the new location. Remove the entry before deleting Genio's files.
Development installs require a built app and register Electron with the app's absolute entry path; packaged installs
register the Genio executable directly.

## Third-party notices

`THIRD_PARTY_NOTICES.md` is generated from `package-lock.json` and the installed packages:

```sh
npm ci
node scripts/third-party-notices.mjs
```

The script lists the runtime dependencies and their transitive packages with their licenses and flags any that are
not permissive for commercial use. Re-run it and commit the result when dependencies change.
