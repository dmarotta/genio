# GENIO

**Talk to one AI. Ship with a squad.**

Genio is a desktop command center for AI-assisted game development. You talk to
one companion, Genio. Genio deploys a squad of autonomous coding agents (units),
gives each one an isolated git worktree, watches them to completion, and brings
you finished pull requests, ready local branches, or recon reports.

It is a GUI port of [companion](https://github.com/example-org/companion)'s
operating model (MIT), rebuilt as an Electron app with a gaming HUD and
game-dev specific features. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the design and [docs/VOCABULARY.md](docs/VOCABULARY.md) for the terms.

## What you get

- **Comms** — chat with Genio. It plans, deploys units, pings them, and only
  bothers you with real choices, finished work and failures.
- **Squad** — every unit runs in a live terminal you can watch or type into:
  Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Grok, Aider or your own.
- **Missions** — *Build* missions deliver a change; *Recon* missions deliver a
  written report and can be upgraded to a Build in place.
- **Delivery modes per project** — *Hardcore* runs the Gauntlet (lint, build,
  tests, AI review, fix rounds, PR, CI), *Standard* opens a PR directly,
  *Offline* leaves a clean local branch. *Auto-loot* lets Genio merge green,
  in-scope work on its own.
- **Overwatch** — zero-token supervision: Genio only spends tokens when a unit
  finishes, needs a choice, lags, or a PR changes state.
- **Pending answers** — floating choice cards over the right edge (oldest three, urgent first; Ctrl+J answers next), with options, recommendations and free-text answers.
- **Quest Log** — queued work with priorities, dependencies, holds and capacity.
- **Character Sheet** (`/status`) — Level, XP, streaks and stats above a large achievements grid (Ctrl+5).
- **Presence** — Online, DND (routine events handled off-screen), AFK (the Bot
  plays for you and replays a welcome-back brief; optional desktop and webhook
  alerts).
- **Memory** (Settings → Memory, `/save`) — curated player profile and squad memory with decay
  and a memory budget.
- **Project windows** - open a folder for its own chat, Inventory and squad.
  Closing warns before stopping running units; non-git folders keep git actions disabled.
- **Play** (Unity projects, Ctrl 0) — play the main checkout, any worktree, a
  unit's worktree or a branch in your own hidden Unity instance, streamed into
  Genio with keyboard, mouse and gamepad. Stop keeps Unity warm; it quits after
  10 idle minutes by default. See [docs/play.md](docs/play.md).
- **Unity slots** (Settings → This project → Unity slots) — units compile, test and play Unity
  projects in their own copies and in shared slot editors. Genio can also look
  at your open editor in chat.
- **Engine aware** — Godot, Unity, Unreal, Bevy, LÖVE, GameMaker, Defold,
  MonoGame and web engines get sensible build and test presets.
- **Progression** — XP, levels, streaks and achievements for shipping.
- **Restart-proof** — all state lives on disk in your Base (`~/.genio`).

## Requirements

- Windows 10/11, macOS or Linux, Node.js 20+ and Git.
- Claude Code installed and logged in (`claude`), used by Genio itself through
  the Claude Agent SDK and as the default unit runtime.
- GitHub CLI (`gh`) authenticated for PR-based modes. Genio's Settings screen
  can install missing tools after you click Install.

## Run it

```sh
npm install
npm run dev        # development with hot reload
npm run build      # production bundle in out/
npm start          # run the production bundle
npm test           # unit tests
npm run typecheck
```

### Checks

```sh
npm test                 # unit tests (status protocol, briefs, git guards, quest log, events, memory)
npm run test:e2e         # isolated CLI checks; paid Claude checks require GENIO_E2E_REAL=1
                         # and test-only credentials (see docs/performance.md)
npm run perf             # performance harness: chat rendering, main-process event routing,
                         # startup and the usage scan over a realistic Base (docs/performance.md)
```

Dev-only visual check: build, then run `npm run capture -- <output-dir>`. Genio
screenshots its own window on every view and quits, using temporary provider
homes, a temporary Base and an isolated Electron profile. Capture options and
the testing isolation rule are in [docs/performance.md](docs/performance.md).

npm 11 blocks dependency install scripts by default. This repo allow-lists the
ones it needs (`electron`, `esbuild`, `node-pty`) in `package.json`.

## Slash commands in Comms

| Command | What it does |
|---|---|
| `/recap` | What happened since you last spoke, then your open choices one at a time |
| `/status` | Character Sheet (level, XP and achievements) |
| `/afk [note]` | Go AFK: the Bot handles events and holds anything that needs you |
| `/dnd` · `/dnd off` | Do not disturb: routine events stay off Comms |
| `/online` | Back online |
| `/save` | Curate the player profile and squad memory |
| `/patch` | Update Genio itself (fast-forward only) |
| `/help` | List commands |

## Base layout

Everything lives under `~/.genio` (override with `GENIO_HOME`): `config/`
settings, `data/` durable records (projects, quests, choices, briefs, reports,
profile, squad memory, replay log), `state/` runtime records (unit status logs, event
queue, presence), `projects/` clones, `worktrees/` one per unit, and `wksps/`
for project and ally bases. Registered projects own their units, quests and
choices in their project base. Startup migrates legacy ownership once with a
durable backup checkpoint; existing unit artifact and worktree paths stay valid.

## License

MIT. Genio reimplements concepts from companion by The team (MIT).

### Open a project folder

Project windows keep configuration in **Settings → This project**: General (the
detected engine and engine root, read-only with Rescan, a repository pins its root
in `.genio/project.json`; description, usage mode, max units at once, the
OpenRouter opt-out, and the setup/build/test/lint commands), Delivery (Offline,
Standard PRs, or the Hardcore Gauntlet, automatic remote following, and merge
finished work automatically (Auto-loot)), Asset generation and, for Unity, Unity
slots. Settings stored for every project are under **All projects**, and two
expert pages under **Advanced**. Pages and fields use plain names, and Settings
search still finds the old names and game terms (Gauntlet, Loadout, Patch…).
Sync and push on demand are asked of Genio in chat. A project is removed from Genio
with the bin icon beside it in the Hub's project list (or by asking Genio); removal
still refuses live units, queued quests and unlanded work, and an owned folder is
never deleted.

Existing stored keys and file formats remain compatible. MCP tools with a
`world` argument also accept `project`; the original argument and tool names
remain supported. Conflicting aliases are rejected before scoped calls run.
Bundled unit CLI flags such as `--world` keep their existing spelling.

Launching Genio without arguments opens a minimal project-selection Hub. Recent
projects, **Open folder** and **Clone** select a project. Search
by name, folder or engine, or sort the list. Waiting choice
counts and answer history remain available from the Hub.
Selecting a project opens its own window on its main chat. Recent selections are
remembered on this device; work controls and first-run setup live inside the
project window. **Open folder�** accepts any existing folder. Git subfolders resolve to
the repository root. Ordinary folders open Offline with chat and Inventory; git
actions unlock after initializing the repository in chat and reopening the folder.

For development, run `npm ci`, then `npm run build`. From any PowerShell directory:

```powershell
& C:\path\to\genio\resources\genio.cmd .
& C:\path\to\genio\resources\genio.cmd 'C:\Games\My Game'
```

The shim preserves the caller's working directory. Equivalently, invoke
`C:\path\to\genio\node_modules\electron\dist\electron.exe C:\path\to\genio <folder>`.
With `resources` on PATH, use `genio .` or `genio <folder>`. A second invocation
opens or focuses the project in the existing process. Closing a project with
running units offers **Stop units and close** or **Cancel**, retaining worktrees.

To enable `genio` in new terminals, open Windows **Edit environment variables for
your account**, edit the user **Path**, and add the absolute path to Genio's
`resources` folder (containing `genio.cmd`). Remove that entry to uninstall the
terminal command. The shim runs a packaged `Genio.exe` (it lives in
`<install>\resources\app\resources`), or the built development app in the parent
folder. It does not change PATH itself.

`npm run dist` builds an unpacked, Genio-branded `release\win-unpacked\Genio.exe`
(electron-builder, configured under `build` in `package.json`; nothing is published).

In a project window, **Settings → System → Windows integration → Install** adds **Open with Genio**
to folder and folder-background context menus for your Windows account. On
Windows 11 it appears under **Show more options**. It uses the same folder-open
path as `genio <folder>`, including focusing an already-open project. Once it is
installed the same button becomes **Remove**, which deletes both Genio
context-menu keys. A partial or older installation shows **Install**, which
repairs it. Only
these HKCU keys are modified: `Software\Classes\Directory\shell\Genio` and
`Software\Classes\Directory\Background\shell\Genio`. No administrator rights
are needed, and startup never installs or repairs them. If Genio moves, click
Install from the new location. Remove the entry before deleting Genio's files.
Development installs require a built app and register Electron with the app's
absolute entry path; packaged installs register the Genio executable directly.
