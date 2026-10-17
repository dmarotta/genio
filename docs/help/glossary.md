# Genio glossary

Plain-language answers to "what does this do?" for the player. One entry per term: what it is, where to find it,
and the doc with the details. Settings paths are written the way Genio names them.

## Presence

How much Genio interrupts you. Three modes: Online, DND and AFK. Switch with the Online / DND / AFK control in the
title bar, the command palette (Presence: …), or the chat commands /online, /dnd and /afk.
Where: the title bar, next to the window controls.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [VOCABULARY.md](../VOCABULARY.md)

## Online

The normal mode. Every event and outcome comes straight to Genio in Comms and Genio talks to you about it. An event
that needs nothing from you leaves no message at all: Genio does not say "All clear".
Where: title bar presence control, or /online (also /back).
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## DND

Do Not Disturb. Routine events (progress, ticks, automatic fixes) go to the Bot off-screen instead of Comms; anything
that needs you (a ready merge, a choice, a failure) still reaches Genio and you. Anything you ask still happens right
away. The Bot's escalations show in Comms as "Bot: …" lines with a notification.
Where: title bar presence control, or /dnd (the old /quiet works too); /dnd off ends it.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## AFK

Away from keyboard. Everything goes to the Bot, which watches the squad for you. Outcomes that need you are captured,
pushed to your notifications (desktop or webhook, if configured) and replayed when you come back. Merges, Offline
landings and anything destructive wait for your return. Units already working keep working. An unseen AFK choice or
failure can fire the alarm.
Where: title bar presence control, or /afk with optional notes for the Bot. Your next message, or /online, ends it.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## The Bot

Genio's away supervisor: a separate, hidden chat session that handles events while you are DND or AFK. It follows the
same hard rules as Genio. Its tools only read (squad, quests, units, logs) and escalate to you: it does not merge,
deploy, steer units, answer choices, approve spend or change settings, so that work waits for you. A routine turn that
needs nothing from you leaves no trace in Comms.
Where: not a screen of its own; its escalations appear in Comms (DND) or the welcome back summary (AFK).
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Welcome back

The summary you get when you return from AFK: what the Bot captured (ready work, findings, failures, choices waiting
for you), checked against the current state. A "Welcome back" dialog lists the captured items once.
Where: shown automatically when you go back Online after AFK.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Auto-loot

A per-project switch that lets Genio merge finished, green, in-scope Builds without asking you. Red, pending, draft,
destructive or risky work still waits for your word. Off by default; only you can turn it on.
Where: Settings → This project → Delivery → Merge finished work automatically.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [VOCABULARY.md](../VOCABULARY.md)

## Merge approval

Without Auto-loot, every merge needs you. Genio announces ready work and merges when you clearly say so in chat
(naming the work, "everything", or "merge it" in reply to its message), when you answer yes to its "Merge now?"
choice, or under a standing approval. Questions, maybes and design picks are not approval. Genio checks your words
itself and records every approval.
Where: the ready unit's Merge button in Squad, the "Merge now?" choice card, or chat.
Source: [squad-display.md](../squad-display.md), the chat contract (src/main/prompts.ts)

## Standing approval

Saying "keep merging everything" (or similar) lets Genio merge that project's Builds as they become green and ready,
like Auto-loot, for 8 hours or until Genio restarts. It never covers force, discards or destructive steps.
Where: shown in the title bar while active; revoke with one click or by saying "stop merging".
Source: the chat contract (src/main/prompts.ts)

## Delivery modes

How a Build's finished work reaches your main branch. A project follows its remote by default (no remote or a
non-GitHub remote: Offline; GitHub: Standard); a mode you pick stays pinned.
Where: Settings → This project → Delivery → Delivery.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [VOCABULARY.md](../VOCABULARY.md)

## Offline

The unit leaves a clean local branch; after your approval (or Auto-loot) Genio fast-forwards it into your main branch
on this computer. Nothing is pushed unless you ask (the Push button on the Delivery page). Offline landings wait
while you are AFK.
Where: Settings → This project → Delivery.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Standard

The unit pushes its branch and opens a pull request itself. You (or Auto-loot) merge the PR once its checks are green.
Where: Settings → This project → Delivery.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Hardcore

The unit commits and says it is done; then the Gauntlet reviews and checks the work, sends fixes back, pushes and
opens the PR, and waits for CI. Hardcore (prod) runs product work Hardcore and internal tooling Standard.
Where: Settings → This project → Delivery.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Gauntlet

Genio's automatic validation for Hardcore Builds: rebase check, the project's lint/build/test commands, an AI review
of the change against your words, fix rounds with the unit, then push, PR and CI. Questions only you can answer
become choices. There is no manual Gauntlet button; it runs by itself.
Where: the unit page's Checks tab; settings in Settings → Advanced → Checks & review (Gauntlet).
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [gauntlet-unity.md](../gauntlet-unity.md)

## Plans

Work that needs two or more units in a set order. Each step is an ordinary quest; Genio starts each step by itself
once the steps it comes after have merged, and pings working steps to rebase when a landing touches their files.
Merges keep their usual approval, so a plan waits at an unapproved merge. A failed or discarded step pauses the plan
and asks you: resume, edit or cancel.
Where: Genio announces a plan in chat (steps, order, time, cost); its steps show in Quests.
Source: [plans.md](../plans.md)

## Plan steps

One unit's share of a plan: a full spec, a one-line acceptance check, the steps it waits for, and the files it
shares with other steps. Step states: waiting, queued, in flight, ready, merged, blocked, discarded.
Where: Quests (each step is a quest).
Source: [plans.md](../plans.md)

## Units

The workers: autonomous coding agents (Claude Code, Codex and others), each in its own terminal and its own isolated
copy of the project. Genio deploys and steers them; they never talk to you directly. Squad and the Squad list beside
the chat show the active units only; finished ones are in the Quest log's Done column.
Where: Squad (Ctrl+2); click one for its page.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [squad-display.md](../squad-display.md)

## Brief tab

A unit's mission in a few plain lines, the same for every kind: your ask in your own words, and what the unit will do (a short summary Genio writes when it deploys; for older units, the opening of Genio's instructions).
Genio's rules and tool notes are not shown: the unit keeps its full brief.
Where: a unit page's Brief tab; the same summary in a quest's details in Quests.
Source: [squad-display.md](../squad-display.md)

## Unit kinds and colors

Build (blue): makes a change. Recon (violet): investigates and delivers a report, never a PR. Modeller (orange): a
Build that makes a 3D model in live Blender steps. Generator (magenta): a Build that runs asset generation jobs.
Green marks READY TO MERGE and successful DONE; yellow marks an open choice or a blocked unit; red marks errors.
Where: the kind chip on Squad cards, unit pages and Quests.
Source: [squad-display.md](../squad-display.md), [unit-generator.md](../unit-generator.md)

## Squad states

What a unit's label means: WORKING (busy, including respawning and rebasing), READY TO MERGE (finished and waiting for
a merge), DONE. A finished unit's badge names how it ended: FAILED, MERGED, EXITED ABNORMALLY or DONE. The unit page
also says NOT RUNNING, RECALLED, STOPPED or WAITING when the agent is not running.
Where: Squad (Ctrl+2) and unit pages.
Source: [squad-display.md](../squad-display.md)

## Despawn and discard

Despawn removes a unit: Genio stops it, deletes its copy and branch, and keeps its record. When its work is not
merged, one question asks "Discard this unit and its unmerged work?"; Discard does it at once. In chat, tell Genio to
get rid of a unit in any plain words (kill, remove, drop, discard…) and name it or reply to its message about it.
Genio never discards work on its own, and never touches your main copy or other units.
Where: a unit page's More → Despawn…, or chat.
Source: [squad-display.md](../squad-display.md), [unit-worktrees.md](../unit-worktrees.md)

## Unit timeline

A unit's reports and your pings, newest first, each with its time and a kind label such as WORKING, DONE, BLOCKED, FAILED,
PAUSED, NEEDS-DECISION, YOU (your ping) or EVENT (anything else the unit or Genio noted, such as a spend grant or a
guard that stopped something). Genio's own bookkeeping (helper runs, file claims, node_modules setup) stays out of it
unless it is the only sign of a problem. The same for every unit kind.
Where: the unit page's Timeline tab.
Source: [squad-display.md](../squad-display.md)

## Quests

Work items. A quest is a Build, a Recon or a choice waiting for you. Genio files one for every deploy and can queue
quests that wait for other quests to land first.
Where: Quests (Ctrl+3).
Source: [VOCABULARY.md](../VOCABULARY.md), [project-startup.md](../project-startup.md)

## Quest log

The list of quests in dispatch order (priority, then rank, then age): Queued (including quests waiting for you or
"Queued until reset" by quota protection), in flight, and the Done column with completed history. Drag a queued quest
to reorder it or change its priority; click one to edit its title, kind, priority and notes, or to drop or dispatch
it. Ask Genio in the chat to make a quest wait for another, set a start date or change its labels.
Where: Quests (Ctrl+3).
Source: [VOCABULARY.md](../VOCABULARY.md), [squad-display.md](../squad-display.md)

## Choices

Decisions only you can make, with options and Genio's recommendation. Pending choices float as cards on the right
edge (the oldest three, urgent first; "+K waiting" counts the rest). Each card shows the question, its details, and
one row per option (the recommended one says Recommended); an open question has a text box instead (Enter answers).
Click a row to answer: it goes to the unit or Genio at once, with no confirm step. Later sets the choice aside unanswered (its quest waits too)
under Deferred, where Resume brings it back. Ask Genio sends the question, details and options to the Genio chat as
your message and sets the choice aside: Genio explains and recommends, and once you say what you decided it passes
your words to the unit. A choice set aside still shows its unit as waiting for you, but no card or count nags.
Where: the floating answer cards; the title-bar count toggles them; Ctrl+J answers the next one.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [structured-unit-choices.md](../structured-unit-choices.md)

## Your Move

The game name for open choices waiting on you, and the first section of the status report (Your Move, Loot,
In Progress, Up Next).
Where: the floating answer cards; /status in chat for the report.
Source: [VOCABULARY.md](../VOCABULARY.md)

## Usage modes

One control for how much of your Claude and Codex plans Genio may use: Save, Balanced (default) or Max. It sets chat
and unit models and effort, how many units run at once across all projects (Save 4, Balanced 8, Max 16), event
batching and answer length. Only Max sometimes tries a less-proven model. A project can only lower the global mode.
Where: Settings → Usage & limits → Usage mode; per project in Settings → This project → General.
Source: [usage-protection.md](../usage-protection.md)

## Quota protection

Automatic protection of your plans, from the latest reported usage: at 70% a plan runs at most one unit with lower
effort; at 85% it gets no new automatic units; at 95% or a rejection, low-priority queued quests (or all, if no plan
has headroom) wait until the reset. Running work is never stopped, and pinned picks are held rather than switched.
Where: Settings → Usage & limits (notices and the plan meter).
Source: [usage-protection.md](../usage-protection.md), [chat-limits.md](../chat-limits.md)

## Sign-in warning (Claude and Codex)

When Claude or Codex is not signed in, the Systems button on the rail shows an amber mark; hover it for which one
("Codex is not signed in"), click it to open Accounts & keys and sign in. It clears by itself once you are signed in.
Only Claude and Codex warn (never FAL, Uthana, GitHub, Unity or other sign-ins). Genio runs Codex only in its own
Codex home, signed in once with your usual ChatGPT account (Accounts & keys → "Sign in Genio's Codex (same account)");
it never uses your own Codex login, and an API-key login does not count. Until then Genio picks Claude for units, and
Codex shows nothing in the usage popup.
Where: the rail's Systems button; Settings → Accounts & keys.
Source: [codex-sessions.md](../codex-sessions.md), [usage-protection.md](../usage-protection.md)

## Effort levels

How hard a model thinks: low, medium, high, xhigh, max. The Usage mode picks it unless you pin one; quota protection
may lower an automatic effort one step. Fable and Astra models need your approval for every unit launch.
Where: the chat's model and effort controls; pins in Settings → Usage & limits → Pin models and effort.
Source: [usage-protection.md](../usage-protection.md)

## Spend approval

No money is spent without your approval. In chat, every paid generation (FAL, Uthana), whatever the amount, waits
on a quote card for your click or your typed approval. A unit spends only under a spend grant you gave it: an
approved budget when you deploy it (the Deploy dialog's "Approved spend" field, or telling Genio the amount), or
your "Approve USD …" answer to the unit's spend question in Choices. Grants add up per unit; a decline grants
nothing; nobody else, not a unit and not Genio on its own, can create one. The monthly cap is a hard stop nobody can
override. Codex images on your ChatGPT plan are free and never ask. Spend lines say who approved each paid call and how.
Where: quote cards in chat; Choices for a unit's spend question; Deploy dialog; the monthly cap in
Settings → This project → Asset generation.
Source: [agent-generation.md](../agent-generation.md), [unit-generator.md](../unit-generator.md)

## Unit capabilities

What every unit can do: work and commit in its own isolated copy, read and follow the bundled skills (assets, images,
FAL, Uthana, sound, Blender, Unity), report status to Genio, open choices for you, and read these help docs. Every
unit gets every skill, whatever its kind (Recon, Build, Modeller, Generator) or runtime (Claude, Codex or another);
only its mission rules differ. Each skill needs only its own prerequisite: Blender a local Blender, Unity a Unity
project, FAL and Uthana their key. Paid calls still need your approval. Genio prefers to hand project work,
generation included, to units. A unit never pushes to or merges your main branch, never talks to you directly, and
never edits outside its copy.
Where: nothing to set; the unit's full instructions (its brief file) stay with the unit.
Source: [unit-worktrees.md](../unit-worktrees.md), [unity-enforcement.md](../unity-enforcement.md)

## Skills

Bundled instructions and helpers units and Genio load on demand: assets (where media goes and which provider makes
it), imagegen-codex (images on your ChatGPT plan), fal (paid FAL.ai media: textures, 3D, audio, video), uthana
(character motions), sound (sound effects and ambience loops), blender (batch modelling, export, the Modeller) and
unity (the only way a unit compiles, tests and plays Unity).
Where: nothing to set up; they ship with Genio.
Source: [agent-generation.md](../agent-generation.md), [art-bible.md](../art-bible.md)

## Achievements

Trophies for real things you did in Genio: a merged build, a finished plan, your game's sound on the Play screen.
Each unlocks once, when the action succeeds; you can pin up to three to the front. Retired ones you earned stay on the
sheet but never unlock again.
Where: Character Sheet in the rail (Ctrl+5).
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Play

The screen where you play a Unity project inside Genio, from its own private copy and hidden editor. One toolbar
(Unity button, ▶, Pause, Step, Scene, Resolution, Game sound), one status line with one progress bar while
starting, centered in the game area until the game shows, and the live game. Pick what to play (main, your worktrees, a unit's copy) with the source chip.
Where: Play in the rail (Ctrl+0), Unity projects only.
Source: [play.md](../play.md), [player-instance.md](../player-instance.md)

## Play copy

Your Play instance's private copy of the project. It survives closing the window and Genio; an unused copy is removed
after more than 24 hours since its last Play (sooner when the disk runs low).
Where: managed automatically; Settings → Unity & Play for idle time and the editor limit.
Source: [play.md](../play.md), [player-instance.md](../player-instance.md)

## Game sound

The game's audio plays in Genio while you play. The speaker button on the Play toolbar mutes or unmutes it, remembered
per project on this computer; it does not touch Genio's own sounds or Unity's Mute Audio.
Where: Play toolbar, after Resolution.
Source: [play.md](../play.md)

## Voice input

Talk instead of typing. Click the mic button in the chat box, or hold F8 (not while the game view has the keys), and
speak; click again, press Enter or release F8 to stop. A speech model on this PC types your words into the box, where
they wait for you: Enter sends (or queues), Ctrl+Enter steers, as if you had typed them. The first press asks to
download the model once (about 206 MB); your voice never leaves the PC and is never saved. English only.
Where: the mic button in every chat box, before Send.
Source: [voice.md](../voice.md)

## Read replies aloud

Genio speaks the end of each chat reply when the turn ends: code, tables, links and file paths are skipped and a long
reply is cut at a sentence end. It uses the natural voice once you have downloaded it, otherwise Windows' voice.
Pressing the mic or Esc in the chat box stops it at once. The Bot never speaks.
Where: Settings → General → Read replies aloud (off by default).
Source: [voice.md](../voice.md)

## Natural voice

Kokoro, a natural-sounding voice for Read replies aloud that runs on this PC. The first reply read aloud offers it at
the mic button: a one-time download of about 329 MB (Download or Not now). Not now keeps Windows' voice until you turn
Read replies aloud off and on again. Replies are spoken sentence by sentence; Windows' voice takes over if it fails.
To remove it, quit Genio and delete the voice\kokoro folder in Genio's data folder.
Where: the panel at the mic button, the first time a reply is read aloud.
Source: [voice.md](../voice.md)

## Inventory

Browse the project's media: images, audio, video and 3D models with previews, search tokens (t:sfx, in:UI, via:fal)
and a 3D viewer. Browsing never writes to the project. Ask Genio to generate assets from the floating chat panel.
Where: Inventory in the rail (Ctrl+9).
Source: [inventory-screen.md](../inventory-screen.md)

## Art Bible

A project's art direction in .genio/art-bible.md: style, palette, references and per-type notes that image, 3D,
audio and motion generators apply. Nothing is automatic: a project has one only when you create it (ask Genio), and
without it no style is applied.
Where: Art Bible in the rail (Ctrl+6).
Source: [art-bible.md](../art-bible.md)

## Design

A screen for thinking through your game's design apart from Genio's chat. Design chats ask, challenge and offer
options, but start no work and spend nothing; you set a chat's role in words ("be a harsh critic"). Keep several,
one per topic: New chat starts one, right-click a chat to delete it. Each chat has its own model and effort. To build
something, ask Genio in the floating panel.
Where: Design in the rail (Ctrl+7).
Source: [design-chats.md](../design-chats.md)

## Design notes

Short markdown notes about your game's design (a system, the pillars, a decision), saved in the project's
.genio/design/ folder next to the Art Bible. A design chat saves one only when you ask ("save this as the combat
note"), and leaves it uncommitted. Each note keeps Open questions and Decided sections. Read and edit them on the
Design screen. Genio and units read notes as context, never as orders: to build from one, ask Genio ("plan the
combat note").
Where: Notes on the Design screen (Ctrl+7); the files are in .genio/design/ in the project.
Source: [design-chats.md](../design-chats.md)

## Modeller

A Build that makes a 3D model in small Blender steps you watch live: its page leads with the model, with a label at
the bottom saying what the unit is doing, and a Steps tab lists every step with its picture, triangles and parts. To
go back to an earlier step or try another direction, say so in the ping box: the unit does it. It exports, places
and commits the model, then merges like any Build.
Needs Blender on this computer.
Where: Deploy dialog (Modeller option) or ask Genio; its unit page in Squad.
Source: [squad-display.md](../squad-display.md)

## Generator

A Build that runs one or more asset generation jobs (images, textures, sounds, music, 3D, motions), places the
results and merges like any Build. No default budget: it spends only what you approve (see Spend approval).
Where: Deploy dialog (Generator option) or ask Genio.
Source: [unit-generator.md](../unit-generator.md)

## Settings pages

Settings has three groups. This project: General, Delivery, Commands, Asset generation, Unity slots. Genio · all
projects: General, Notifications, Usage & limits, Accounts & keys, Memory, Units, Unity & Play, Inbox & automation,
System. Advanced (behind Show advanced settings): Model routing (Dispatch), Agent tools (Harnesses), Checks & review
(Gauntlet), Timing (Overwatch), Maintenance.
Where: Settings in the rail (Ctrl+8).
Source: [VOCABULARY.md](../VOCABULARY.md)

## Worktrees

Each unit's isolated copy of the project: a git worktree on its own branch, with its own node_modules. Your main copy
is only read. Despawning a unit removes its copy; work that is not merged goes only after you confirm Discard.
Where: a unit page's More → Open folder; Despawn in the same menu.
Source: [unit-worktrees.md](../unit-worktrees.md)

## MCP servers

Extra tools an agent can call through the Model Context Protocol. Only the servers you add in Settings reach units
and the chat: a command Genio starts on this PC or a remote URL, with masked secrets (environment variables or
headers, kept encrypted like your API keys), for all projects or one. Claude and Codex units get them through Genio,
which starts or calls the real server, adds the secrets, never passes on a unit's keys, and logs every call in the
unit's data folder; a failed call shows on the unit's timeline. The chat gets them too when it runs on a Claude model:
each call asks you first in Ask and Auto-approve shell and runs in YOLO, and they never replace Genio's own deploy,
merge or spending tools. Set a server to **Chat only** (for mail, calendar or documents) and it reaches the Claude
chat but never a unit. Gemini and OpenCode units, the Bot, design chats and the Codex chat get none (the Codex chat
blocks every tool that is not Genio's own; ask it to deploy a unit instead). Servers a project declares in its own
files (such as `.mcp.json`) and your own CLI servers stay off for units. Paid servers are
not supported: Genio cannot price an MCP call, so spending stays with FAL and Uthana under your approvals. Unity MCP
servers are not supported either; units use Unity only through Genio. A remote server that asks for a sign-in (OAuth)
shows **Sign in**, which opens your browser once; Genio keeps the sign-in encrypted, refreshes it itself and adds it to
every call, and the button turns into **Sign out**. When a sign-in expires for good, the entry shows Sign in again
and a unit that needs the server stops and asks you; the chat tells you to sign in again. A server that does not let apps register themselves needs a
token header instead.
Where: Settings → Advanced → Agent tools (Harnesses) → MCP servers.
Source: [mcp-servers.md](../mcp-servers.md)

## Slots

Extra copies of a Unity project, each with its own editor, that units lease to play and test in Unity at the same
time. They are separate from your own Play copy.
Where: Settings → This project → Unity slots (cap, editor windows, states, disk use, Close slot editor).
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [unity-copies.md](../unity-copies.md)

## Hidden desktop

On Windows, units' slot editors open on a hidden desktop: no window, no splash, no focus stealing. Blocking Unity
dialogs are caught and reported. You can switch to visible windows for debugging.
Where: Settings → This project → Unity slots → Slot editor windows.
Source: [hidden-desktop.md](../hidden-desktop.md)

## Dev Drive

When a project sits on a Dev Drive (or another ReFS volume that can clone blocks), Genio puts unit worktrees and Play
slots on that drive and clones files almost for free instead of copying them. Genio never creates, mounts or formats a
drive; if the drive is not mounted it tells you.
Where: nothing to set; it follows where the project lives.
Source: [unity-copies.md](../unity-copies.md), [unit-worktrees.md](../unit-worktrees.md)
