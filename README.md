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
- **Delivery modes per world** — *Hardcore* runs the Gauntlet (lint, build,
  tests, AI review, fix rounds, PR, CI), *Standard* opens a PR directly,
  *Offline* leaves a clean local branch. *Auto-loot* lets Genio merge green,
  in-scope work on its own.
- **Overwatch** — zero-token supervision: Genio only spends tokens when a unit
  finishes, needs a choice, lags, or a PR changes state.
- **Your Move** — every open choice, one card at a time, with a recommendation.
- **Quest Log** — queued work with priorities, dependencies, holds and capacity.
- **Status** (`/status`) — Your Move, Loot, In Progress, Up Next.
- **Presence** — Online, DND (routine events handled off-screen), AFK (the Bot
  plays for you and replays a welcome-back brief; optional desktop and webhook
  alerts).
- **Lore** (`/save`) — curated player profile and squad knowledge with decay
  and a memory budget.
- **Allies** — extra Genio instances with their own base and charter for
  separate domains.
- **Playtest** — launch the game from any unit's worktree before you merge.
- **Engine aware** — Godot, Unity, Unreal, Bevy, LÖVE, GameMaker, Defold,
  MonoGame and web engines get sensible build, test and run presets.
- **Progression** — XP, levels, streaks and achievements for shipping.
- **Restart-proof** — all state lives on disk in your Base (`~/.genio`).

## Requirements

- Windows 10/11, macOS or Linux, Node.js 20+ and Git.
- Claude Code installed and logged in (`claude`), used by Genio itself through
  the Claude Agent SDK and as the default unit runtime.
- GitHub CLI (`gh`) authenticated for PR-based modes. Genio's Systems screen
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
npm run test:e2e         # real end-to-end runs: a Claude unit ships an Offline Build, and Genio
                         # answers from its tools (spends a few cents; uses the haiku model)
```

Dev-only visual check: set `GENIO_CAPTURE_DIR=<dir>` (optionally `GENIO_HOME`,
`GENIO_CAPTURE_PROMPT` or `GENIO_CAPTURE_SCRIPT`) and launch the built app. Genio
screenshots its own window on every view and quits.

npm 11 blocks dependency install scripts by default. This repo allow-lists the
ones it needs (`electron`, `esbuild`, `node-pty`) in `package.json`.

## Slash commands in Comms

| Command | What it does |
|---|---|
| `/recap` | What happened since you last spoke, then your open choices one at a time |
| `/status [file] [include PRs]` | The four-section Status Screen |
| `/afk [note]` | Go AFK: the Bot handles events and holds anything that needs you |
| `/dnd` · `/dnd off` | Do not disturb: routine events stay off Comms |
| `/online` | Back online |
| `/save` | Curate the Player Profile and Lore |
| `/patch` | Update Genio itself (fast-forward only) |
| `/help` | List commands |

## Base layout

Everything lives under `~/.genio` (override with `GENIO_HOME`): `config/`
settings, `data/` durable records (worlds, quests, choices, briefs, reports,
profile, lore, replay log), `state/` runtime records (unit status logs, event
queue, presence), `projects/` clones, `worktrees/` one per unit, and `wksps/`
for ally bases.

## License

MIT. Genio reimplements concepts from companion by The team (MIT).
