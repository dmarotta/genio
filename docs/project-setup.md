# Project setup in the chat

Genio sets up a new project in its chat, one plain question per turn, asking only
about what is still open. It is a conversation, not a wizard: there is no setup
screen, form, step counter, progress bar or choice card. Any free answer works.
"Skip" and "stop setup" work at any point, and asking for real work always comes
first.

## Projects are opened, not created

There is no New project form. The player makes or picks a folder anywhere in the
system folder dialog (Open folder… in the Hub or File menu; it has New folder,
also on macOS) and opens it. The first open writes nothing into the folder: Genio
registers it in its own data and infers the engine. The project's `.genio/`
folder appears only when an answer needs it (the Art Bible, design notes,
generation settings or a pinned engine root).

## When setup runs

| Case | What happens |
|---|---|
| First open of an empty folder, or one without a git repo | The opening greeting starts setup and asks its first open step, the git repo. |
| Reopened while setup is open | The greeting asks once whether to pick setup up at the next step. Two openings in a row with no answer stop it without a word. |
| A project that already has a repo and content | No setup. "Set up this project" in the chat starts it at any time. |
| Any time | "Set up this project", "continue setup" (re-asks skipped steps) or "stop setup", in plain words. |

Nothing is asked while the player is DND or AFK; those openings do not count as
unanswered.

## Steps, in order

A step whose fact is already true is ticked and never asked. Facts are read on
every check, so something done on a screen (an Art Bible saved on its screen, a
mode chosen in Settings) ticks the step too.

| Step | Ticked when | What Genio asks or does |
|---|---|---|
| git repo | the folder is a git repo | Offers `git init` on `main`, a `.gitignore` for the engine, an `AGENTS.md` seed with the pitch and a first commit, through `project_init`, only on the player's yes. A GitHub repo only when they ask for it. |
| the game in a sentence | the project has a description | Confirms or writes the pitch and saves it as the description. |
| engine | an engine is detected | Says what was detected. With no engine files yet: Unity, create the project in Unity Hub in this folder; Godot, open the folder in Godot; web, offer a Build that scaffolds it. |
| how work lands | Auto-loot is on or the delivery mode was chosen | "Merge green, in-scope work yourself (Auto-loot), or ask me each time?" Both need the player's words. |
| art direction | `.genio/art-bible.md` exists | Link an existing style doc, write a short Art Bible together, or skip. Skipped for apps unless asked. |
| design one-pager | a note exists in `.genio/design/` | Points to Lore (Ctrl+7) to ask a design chat for a one-pager. Skipped for apps unless asked. |
| tools | nothing is missing (Godot for Godot projects, gh for a GitHub remote) | Names what is missing; installing stays with the player. |
| Unity and Play (Unity only) | Play has started once in this project | Names the Unity version, the Input System for interactive Play, and Unity slots and idle time in Settings. |
| paid generation | the project has a monthly generation cap | Only if the player plans FAL or Uthana: the cap and keys are in Settings. |
| first work | a quest or unit exists for the project | "What should the first Build be?" Finishing this step finishes setup. |

## project_init

`project_init(world, engine?, pitch?, create_remote?, private_remote?, player_words)`
starts the git repo of an opened folder. It refuses unless `player_words` quotes
the player's own yes (a question, a "no" or Genio's own text never counts) and
refuses the Bot. It keeps an existing `.gitignore` and `AGENTS.md`, commits
everything in the folder as the first commit, and fails clearly when git has no
identity. The engine only picks the `.gitignore`; detection takes over when the
engine's files appear. `create_remote` makes a GitHub repo with `gh` and pushes,
and its words must agree to the repo. Genio then re-reads the folder: git
present, delivery following the remote. Only that first commit is committed;
everything setup writes later stays uncommitted.

A delivery mode change through `world_update` needs the player's words too.

## State

`project_setup(world, action: read | skip | stop | resume, step?)` reads or
changes setup. The project's base keeps `state/setup.json` (never in the repo):
whether the folder was new, when setup started, the skipped steps, unanswered
openings, whether Play has started, and when it stopped or finished. Done is
never stored.

The opening recap gets one line outside the contract, for example
`Setup: new project; next: git repo.` or
`Setup: reopened; next: art direction; skipped: paid generation.`, and nothing
when setup is stopped, finished or never started. The contract has one line
pointing to `procedure_read("setup")`, which holds the rules above.

## What setup never does

- Deploy, spend, install, sign in, or change a setting, the delivery mode or the
  Art Bible without the player's words for that exact thing.
- Create an Art Bible or design note by itself, or open screens or panels.
- Deploy because the quest log is empty.

Finishing setup with its first work earns Character Creation.

Coverage: `tests/project-setup.test.ts`, `tests/prompts.test.ts`,
`tests/achievement-coverage.test.ts`.
