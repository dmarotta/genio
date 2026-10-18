# GENIO

**Talk to one AI. Ship with a squad.**

Genio is a desktop command center for AI-assisted game development. You talk to one companion, Genio. It deploys a
squad of coding agents, called units, that each work in their own isolated git worktree, and brings back finished
work: a pull request, a ready local branch or a written report.

## What you can do

### Talk to Genio

- **Chat.** Describe what you want in plain words. Genio plans it, deploys units, follows them to completion and only
  interrupts you for real choices, finished work and failures.
- **Approval modes.** Ask, Auto-approve shell or YOLO decide how much the chat asks before it acts on your machine.
- **Voice.** Read replies aloud with your Windows voice or an optional natural voice, and push-to-talk dictation
  (click the mic or hold F8). Speech recognition runs on your PC.
- **Setup chat and tips.** Open a folder and Genio walks you through setting the project up, one question at a time.
  Once-only feature tips show you what you have not tried yet.
- **MCP tools.** Add your own Model Context Protocol servers in Settings and Genio's chat and units can call them.
- **Presence.** Online, DND and AFK control how much Genio interrupts you. While you are away a supervisor handles
  events and gives you a brief when you come back.

### Put a squad to work

- **Units with live terminals.** Every unit runs in a real terminal you can watch or type into. Claude Code and Codex
  are the supported runtimes.
- **Build and Recon.** A Build delivers a change; a Recon investigates and delivers a report.
- **Modeller.** A unit that builds a 3D model live in Blender, step by step, which you can watch and steer.
- **Generator.** A unit that runs asset generation jobs for images, sounds, textures and more, and places the results.
- **Plans and the Quest log.** Work that needs several units in order becomes a plan. A plan is one card on the Quest
  log with its own priority; the Quest log queues work with priorities, dependencies and holds.
- **Delivery modes.** Offline leaves a clean local branch, Standard opens a pull request, Hardcore also runs lint,
  build, tests, an AI review and CI before the work is ready. Auto-loot can merge finished, green work for you.
- **Quota protection and usage modes.** Genio slows down new units as your Claude and Codex plans fill up, and Save,
  Balanced or Max set how much it spends on routine updates.

### Make your game

- **Play.** Run a Unity project inside Genio, from the main checkout, a worktree, a unit's work or a branch, with
  keyboard, mouse and gamepad.
- **Inventory.** Browse the project's images, audio, video and 3D models with previews and a 3D viewer.
- **Art Bible.** Keep the project's art direction in one file that every generator follows.
- **Lore.** Think through the game's design in chats that start no work, and keep short design notes.

### Track your progress

- **Character Sheet.** Levels, titles, streaks and achievements for the things you ship.

## Getting started

### Requirements

- Windows 10 or 11. This is the platform Genio is built, packaged and tested on.
- macOS and Linux: Genio is an Electron app and can be run from source there, but there are no release builds, and
  Play, hidden Unity editors, the Windows voice and the Windows shell integration are Windows features. Treat them as
  unsupported for now.
- [Node.js](https://nodejs.org) 20 or newer and [Git](https://git-scm.com).
- A Claude or ChatGPT (Codex) account. The launcher guides you through signing in with Claude or Codex; either one is
  enough to start.
- Optional: the GitHub CLI for the modes that open pull requests, Blender for the Modeller, Unity for Play. Settings
  can install missing tools after you click Install.

### Install and run

Build and run from source:

```sh
npm ci
npm run build
npm start
```

`npm run dist` packs a Windows build. More on building, testing and the `genio` terminal command is in [docs/development.md](docs/development.md).

### First steps

1. Start Genio, sign in when the launcher asks, then **Open folder** for your game or **Clone** a repository.
2. Answer the setup chat. It sets up git, the engine, how work lands and your art direction. Say "skip" to pass on
   any step.
3. Give Genio a task in the chat, such as "add a pause menu", and watch the unit work in its terminal.

## Privacy and safety

- Genio runs on your computer. It uploads nothing by itself: your code goes only to the AI services you sign in to,
  through their own tools.
- Units work in isolated copies of your project and never touch your main branch until you approve, or Auto-loot
  merges green work.
- Genio uses its own isolated Claude and Codex homes and never reads or changes your own logins.
- Paid generation always needs your approval, and a monthly cap is a hard stop.
- By default a Claude unit runs commands inside its own isolated copy without asking for each one; you can change
  that in Settings, and merging your work (unless you turn on Auto-loot) and paid generation still need your approval.
- The approval mode decides what Genio may do on your machine without asking.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Glossary](docs/help/glossary.md): what each feature does and where to find it
- [Plans](docs/plans.md), [Play](docs/play.md), [Voice](docs/voice.md), [MCP servers](docs/mcp-servers.md),
  [Usage protection](docs/usage-protection.md), [Art Bible](docs/art-bible.md)
- [Developing Genio](docs/development.md): building, testing, packaging and the terminal command

## License

Genio is released under the [MIT License](LICENSE), which allows commercial use. Third-party components and the
optional downloads for voice are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
