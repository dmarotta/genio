# Genio glossary

Plain-language answers to "what does this do?" for the player. One entry per term: what it is, where to find it,
and the doc with the details. Settings paths are written the way Genio names them.

## Presence

How much Genio interrupts you. Three modes: Online, DND and AFK. Switch with the Online / DND / AFK control in the
title bar, the command palette (Presence: …), or the chat commands /online, /dnd and /afk.
Where: the title bar, next to the window controls.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [VOCABULARY.md](../VOCABULARY.md)

## Online

The normal mode. Every event and outcome comes straight to Genio in Comms and Genio talks to you about it.
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
deploy, steer units, answer choices, approve spend or change settings, so that work waits for you.
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
copy of the project. Genio deploys and steers them; they never talk to you directly.
Where: Squad (Ctrl+2); click one for its page.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [squad-display.md](../squad-display.md)

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
"Queued until reset" by quota protection), in flight, and the Done column with completed history.
Where: Quests (Ctrl+3).
Source: [VOCABULARY.md](../VOCABULARY.md), [squad-display.md](../squad-display.md)

## Choices

Decisions only you can make, with options and Genio's recommendation. Pending choices float as cards on the right
edge (the oldest three, urgent first; "+K waiting" counts the rest). Answering one sends it to the unit or Genio at
once; you can also defer one and resume it later, or ask a clarifying question.
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
Where: Settings → Usage & limits (notices and the plan meter); the rail's gauge icon.
Source: [usage-protection.md](../usage-protection.md), [chat-limits.md](../chat-limits.md)

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
Where: the unit page's Brief tab shows its full instructions.
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
starting, and the live game. Pick what to play (main, your worktrees, a unit's copy) with the source chip.
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
is only read. Despawning a unit removes its copy, and refuses while it holds work that has not landed.
Where: a unit page's More → Open folder; Despawn in the same menu.
Source: [unit-worktrees.md](../unit-worktrees.md)

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
