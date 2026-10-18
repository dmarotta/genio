# Genio glossary

Plain-language answers to "what does this do?" for the player. One entry per term: what it is, where to find it,
and the doc with the details. Settings paths are written the way Genio names them.

## Feature tips

Once-only hints chosen from what you are doing, on from the start. At most one a
day and one per session, only Online in the focused project, outside Play and
replies, and never for a feature you already used. A card at the bottom left of
the stage offers Ask Genio, No more tips and X; it fades after twenty seconds,
and Escape dismisses it. No more tips turns them off for every project. Turn them
back on in Settings under All projects → General → Feature tips (search “tips” or “hints”).
Source: [Feature tips](../feature-tips.md)

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

A per-project switch that lets Genio merge finished, green, in-scope Builds without asking you. Red, still running or
draft work is not covered: merging it goes through the chat's approval mode. Off by default; Genio can turn it on
for you, through the approval mode too.
Where: Settings → This project → Delivery → Merge finished work automatically.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [VOCABULARY.md](../VOCABULARY.md)

## Approval mode

How much the chat asks you before it acts: Ask (anything that changes something asks first), Auto-approve shell
(commands run, everything else asks) or YOLO (nothing asks). It is the only thing that decides whether Genio needs
your OK for its own actions: merging, discarding a unit's work, relaunching a held unit, editing files, committing,
creating a GitHub repository, turning on Auto-loot. When it asks, the permission prompt says in one line what will
happen; your Allow once is the approval, and Genio records it. Typing "yes" in chat does not answer the prompt.
It never approves spending, and Genio never reads or changes your logins, keys or spend records in any mode.
Where: the approval-mode button under the chat box (Shift+Tab cycles it).
Source: [chat-authority.md](../chat-authority.md)

## Merge approval

Genio merges on its own under Auto-loot or a standing approval, and when you click yes on its "Merge now?" choice.
Otherwise a merge follows the approval mode: in Ask and Auto-approve shell you get a prompt ("Merge u-3 ("Menu
rework"): its PR …?"), in YOLO it merges. A red PR, one still running checks or a draft can be merged too, and the
prompt says so. Every merge records what approved it.
Where: the ready unit's Merge button in Squad, the "Merge now?" choice card, or chat.
Source: [chat-authority.md](../chat-authority.md), [squad-display.md](../squad-display.md)

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
on this computer. Nothing is pushed unless you ask Genio to push it. Offline landings wait
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
Where: the unit page's Checks tab. It runs on Hardcore delivery, set in Settings → This project → Delivery. Its review
model and number of fix rounds are fixed defaults.
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
copy of the project. Genio deploys and steers them; they never talk to you directly. Squad shows active units.
The Squad list beside the chat shows active units first, then up to 25 recently finished units, newest first,
with their outcome and final duration; click one to reopen its page. Despawned units disappear at once.
The Quest log's Done column keeps the full history.
The Squad rail and unit page show running time with seconds ("1h 8m 3s"); the clock freezes when the unit is ready or finished.
Where: Squad (Ctrl+2); click one for its page.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [squad-display.md](../squad-display.md)

## Brief tab

A unit's mission in a few plain lines, the same for every kind: your ask in your own words, and what the unit will do (a short summary Genio writes when it deploys; for older units, the opening of Genio's instructions). When you gave the unit attachments, they are listed under References.
Genio's rules and tool notes are not shown: the unit keeps its full brief.
Where: a unit page's Brief tab; the same summary in a quest's details in Quests.
Source: [squad-display.md](../squad-display.md)

## Attachments

Attachments (also called references) are what you hand a unit for its work, the way you would in any chat: images you paste, files or whole folders on your
PC of any type (images, PDFs, documents, spreadsheets, audio, video, 3D models, archives, code, data), project files,
and text or links you give Genio. Ask Genio to start the unit with them and say what each one is for. Genio attaches
only what you pasted or named, copies them into the unit's own data folder (never into your project, never
committed) and tells you if it refused one and why: credential and config folders, secret files such as `.env` or
keys, files over 25 MB, more than 100 MB for one unit, or past the first 200 files of a folder. The unit gets a list
of them in its brief, with how to open each type; a Modeller compares every step with them. A picture of one
straight-on view of the whole model (front, side or top, such as a blueprint view or a screenshot) is matched
against every step by numbers, so the Modeller reads which parts are too wide, too high or missing; say which
view it is when you attach it (or name the file so, like `ship_side.png`). Concept art and 3/4 views are looked at,
not measured.
Where: ask in the chat; the unit page's Brief tab lists them under References (click one to open it).
Source: [unit-worktrees.md](../unit-worktrees.md)

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
merged, one question asks "Discard this unit and its unmerged work?"; Discard does it at once: the unit disappears
right away while its copy is deleted in the background, and comes back with the reason if that fails. In chat, Genio
can discard a unit's work too; the approval mode decides whether you get the same question first. It never removes
your main copy.
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
"Queued until reset" by quota protection), in flight, and the Done column with completed history. Ask Genio in the
chat to add a quest or change one (title, kind, notes, waits, start date, labels). A quest on its own has Dispatch and
Drop on its card and in its details, and its priority changes by dragging it to another band or in its details;
Dispatch is greyed while the quest waits for you or for another quest. A plan's quests have none of these: they
follow their plan. Click a quest to read its details.
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

Save, Balanced (default) or Max: how long routine updates wait to batch and how long answers and Recon summaries run.
It never picks a model or an effort (see Default model). A project can pick its own mode. Concurrency is controlled
separately by Units at once.
Where: Settings → Usage & limits → Usage mode; per project in Settings → This project → General.
Source: [usage-protection.md](../usage-protection.md)

## Units at once

The maximum units working across all projects and bases, independently of Usage mode. Choose 1–32;
new installs start at 8. Existing settings keep the old global mode's limit (Save 4, Balanced 8, Max 16)
until you change it. A project's Max units at once can impose a lower limit on that project only;
0 means use the global limit. Queued quests wait when capacity is full. Plan parallelism,
quota protection and Unity editor slots may limit work further. Chat can read and change it on your request.
Where: Settings → Usage & limits → Units at once.
Source: [usage-protection.md](../usage-protection.md), [plans.md](../plans.md), [unity-copies.md](../unity-copies.md)

## Quota protection

Fewer units as your plans fill up, from the latest reported usage: at 70% a plan runs at most one unit at a time;
at 85% new units on it wait; at 95% or a rejection, low-priority queued quests (or all, if no plan has headroom) wait
until the reset. Running work is never stopped, and it never changes a model or moves a unit to the other plan.
Usage refreshes in the background at startup and every two minutes while work or a hold waits; opening Settings
is unnecessary. Errors back off to at most 30 minutes. Readings older than ten minutes or past their own reset
cannot hold work; an unavailable source allows ordinary dispatch with quota unverified. When headroom returns,
deferred deployments and relaunches retry themselves, with the same model, through the usual permissions and limits. Queued
plans resume automatically; other queued quests still follow the automatic-dispatch setting.
On by default. Turn it off with **Quota protection** beside the plan meter in Settings → Usage & limits;
units then run without these limits, while actual provider limits and retry backoff still apply.
The project chat and floating Genio panel show one amber warning box at the top centre of the chat, below its
title bar and above the content, naming affected plans and launches waiting in this project. Text wraps in narrow windows;
choice cards, tips and toasts stay clear. **Settings** jumps straight to the switch. Dismiss it for the current level; it returns only
if protection worsens, and clears when protection stops acting or is off.
Where: the project chat and floating Genio panel; Settings → Usage & limits → Quota protection.
Source: [usage-protection.md](../usage-protection.md), [chat-limits.md](../chat-limits.md)

## Sign-in warning (Claude and Codex)

When Claude or Codex is not signed in, the Systems button on the rail shows an amber mark; hover it for which one
("Codex is not signed in"), click it to open Accounts & keys and sign in. It clears by itself once you are signed in.
Only Claude and Codex warn (never FAL, Uthana, GitHub, Unity or other sign-ins). Genio runs Codex only in its own
Codex home, signed in once with your usual ChatGPT account (Accounts & keys → "Sign in Genio's Codex (same account)");
it never uses your own Codex login, and an API-key login does not count. Until then Codex shows nothing in the usage popup.
The Hub opens no project while neither Claude nor Codex is signed in: it lists your projects and offers **Sign in with
Claude** and **Sign in with Codex**, and opens them as soon as one sign-in works.
Where: the rail's Systems button; the Hub; Settings → Accounts & keys.
Source: [codex-sessions.md](../codex-sessions.md), [usage-protection.md](../usage-protection.md), [project-startup.md](../project-startup.md)

## Default model

Whatever model and effort you set is what runs, always: in the chat (and each ally's own pick), dispatch rules, category
rows, the default unit tool and an explicit deploy. Where you set nothing, Genio uses Claude Sonnet 5.5 at medium effort
(high for a Recon); when Claude is not signed in and Codex is, Codex Sol 6.1 instead. With both signed in, Claude wins.
The same default applies to every kind of unit; Usage mode, quota protection and the scorecard never change it.
Where: the chat's model and effort controls; Settings → Advanced → Model routing (Dispatch); Settings → Units (Default agent tool).
Source: [usage-protection.md](../usage-protection.md)

## Effort levels

How hard a model thinks: low, medium, high, xhigh, max. Yours is used as you set it; otherwise medium (high for a
Recon). Nothing lowers or raises it on its own. Fable and Astra models need your approval for every unit launch.
Where: the chat's model and effort controls; Settings → Advanced → Model routing (Dispatch).
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
never edits outside its copy. Unity work targets only its own copy or a leased slot; your own editors and tools stay
untouched.
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

## Level titles

Every level up to 40 has its own title, from Recruit through ranks like Operator Mk I, Mk II and Mk III to Living
Legend; past level 40 the last title stays. You do not pick it: the sheet always shows your level's title, with one
quiet line naming the next title and the level it comes at. XP comes from real outcomes (deploys, recons, merges,
answered choices). The old playstyle titles (Builder, Scout, Artificer, Warden, Adventurer) are gone.
Where: Character Sheet in the rail (Ctrl+5), beside your level.
Source: [ARCHITECTURE.md](../ARCHITECTURE.md)

## Play

The screen where you play a Unity project inside Genio, from its own private copy and hidden editor. One toolbar
(Unity button, ▶, Pause, Step, Scene, Resolution, Game sound), one status line with one progress bar while
starting, centered in the game area until the game shows, and the live game. Pick what to play (main, your worktrees, a unit's copy) with the source chip.
Where: Play in the rail (Ctrl+0), Unity projects only.
Source: [play.md](../play.md), [player-instance.md](../player-instance.md)

## Play copy

Your Play instance's private copy of the project. It survives closing the window and Genio; an unused copy is removed
after more than 24 hours since its last Play (sooner when the disk runs low). It lives in a short folder (`pc`) on the
project's Dev Drive, else in Genio's data folder, so Unity's paths stay under Windows' 260-character limit; when a
project's own paths still come near it, the Play status line says so while Unity starts. There is no setting for the
location: it follows the project's drive, or Genio's home (`GENIO_HOME`).
Where: managed automatically; Settings → Unity & Play for idle time and the editor limit.
Source: [play.md](../play.md), [player-instance.md](../player-instance.md)

## Play GPU stream

How the live game reaches Play on Windows: when the project and the computer allow it, Genio runs its hidden Play
editor on DirectX 11 and shows each frame straight from the graphics card, at up to 60 fps and about 2 ms behind the
game. A project that needs DirectX 12, a laptop with two graphics chips, or any problem with the shared frames uses the
JPEG stream instead (up to 30 fps), without stopping the game. Automatic, with no setting; the first Play on DirectX 11
compiles the project's shaders once, while Unity starts. Genio's log names the path in use.
Where: Play, automatically.
Source: [play.md](../play.md), [play-gpu-stream.md](../play-gpu-stream.md), [player-instance.md](../player-instance.md)

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
While it is on, the Voice drop-down under the toggle picks who speaks: Default or one of the Windows voices installed
on this PC and, once the natural voice is downloaded, its 11 voices (Default, Bella, Nicole, Sarah, Sky, Adam, Michael,
and the British Emma, Isabella, George and Lewis). While the natural voice is missing, Download natural voice sits next
to it. A natural voice speaks with Windows' default voice until it is downloaded; a Windows voice removed from the PC
speaks as Default. A new choice applies from the next spoken reply. Pressing the mic, Esc in the chat box, or sending
any message (typed or spoken, a steer or a ! command) stops it at once; the next reply is read as usual. The Bot never
speaks.
Where: Settings → General → Read replies aloud (off by default), and Voice under it.
Source: [voice.md](../voice.md)

## Natural voice

Kokoro, a natural-sounding voice for Read replies aloud that runs on this PC. The first reply read aloud offers it at
the mic button: a one-time download of about 329 MB (Download or Not now). Not now keeps Windows' voice until you turn
Read replies aloud off and on again. You can also download it any time with Download natural voice next to Settings →
General → Voice (the same Download or Not now; the button fills with the progress). Replies are spoken a few
sentences at a time, the next made while one plays, with a short pause at each full stop; Windows' voice takes over if it fails.
It speaks with its Default voice unless you choose another in Settings → General → Voice. To remove it, quit Genio and delete the voice\kokoro folder in Genio's data folder.
Where: the panel at the mic button, the first time a reply is read aloud, or Download natural voice in Settings →
General → Voice; its voice in Settings → General → Voice.
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

## Lore

A screen for thinking through your game's design apart from Genio's chat. Lore chats ask, challenge and offer
options, but start no work and spend nothing; you set a chat's role in words ("be a harsh critic"). Keep several,
one per topic: New chat starts one, right-click a chat to delete it. Each chat has its own model and effort. To build
something, ask Genio in the floating panel.
Where: Lore in the rail (Ctrl+7).
Source: [design-chats.md](../design-chats.md)

## Lore notes

Short markdown notes about your game's design (a system, the pillars, a decision), saved in the project's
.genio/design/ folder next to the Art Bible. A Lore chat saves one only when you ask ("save this as the combat
note"), and leaves it uncommitted. Each note keeps Open questions and Decided sections. Read and edit them on the
Lore screen. Genio and units read notes as context, never as orders: to build from one, ask Genio ("plan the
combat note").
Where: Notes on the Lore screen (Ctrl+7); the files are in .genio/design/ in the project.
Source: [design-chats.md](../design-chats.md)

## Modeller

A Build that makes a 3D model in small Blender steps you watch live: its page leads with the model, with a label at
the bottom saying what the unit is doing, and a Steps tab lists every step with its picture and triangles. The unit
plans the model's main parts first, so its first step shows all of them as simple shapes; later steps build each one
for real. To go back to an earlier step or try another direction, say so in the ping box: the unit does it. It
exports, places and commits the model, with its step scripts and `lib.py` (its plan and the helpers every step uses),
then merges like any Build.
Needs Blender on this computer.
Where: Deploy dialog (Modeller option) or ask Genio; its unit page in Squad.
Source: [squad-display.md](../squad-display.md)

## Generator

A Build that runs one or more asset generation jobs (images, textures, sounds, music, 3D, motions), places the
results and merges like any Build. No default budget: it spends only what you approve (see Spend approval).
Where: Deploy dialog (Generator option) or ask Genio.
Source: [unit-generator.md](../unit-generator.md)

## Hub

The window for opening a project, shown when Genio starts with no project. It lists your projects (most recently
opened first) with Open folder, Add project, Sync all and Settings, and nothing else: no choices, units or chat.
There is no New project: make or pick any folder in Open folder (it can make a new one) and Genio sets it up (see
Project setup). Click a project to open it; the Hub closes once the project window is up. Choices from closed
projects come as desktop notifications and wait in that project's window. Genio needs Claude or Codex: while neither is
signed in, the Hub still lists your projects but opens none and shows **Sign in with Claude** and **Sign in with Codex**
(the same sign-ins as Accounts & keys); as soon as one works, projects open, no restart needed.
Where: on start, or File › Hub (Ctrl+N) in a project window.
Project rows stay the same size with aligned remove buttons; long names and paths truncate on one line.
Source: [project-startup.md](../project-startup.md)

## Project setup

Genio guiding a new project in the chat, one question at a time: a git repo (started only on your yes), the game in
a sentence, the engine, how work lands, art direction, a design one-pager, missing tools, Unity and Play, paid
generation, and the first work. Steps tick by themselves when the fact is true, wherever you did it. Say "skip" for
any step, "stop setup" to end it, "set up this project" or "continue setup" to start or resume it. Skips and stops
are remembered. It starts by itself only on the first open of an empty folder or one without git; it never deploys,
spends, installs or changes a setting without your words.
Where: the project's chat (Comms).
Source: [project-setup.md](../project-setup.md)

## Settings pages

Settings has three groups. This project: General (with the build and test commands), Delivery, Asset generation,
Unity slots. All projects: General (with notifications and away alerts), Usage & limits, Accounts & keys, Memory,
Units, Unity & Play, Inbox & automation, System.
Advanced: Model routing (Dispatch), Agent tools (Harnesses). To remove a project from Genio, use the bin icon beside
it in the Hub's project list, or ask Genio. It only takes the project off the list and keeps your folder; for a clone
Genio made you can choose to delete the clone too.
Where: Settings in the rail (Ctrl+8).
Source: [VOCABULARY.md](../VOCABULARY.md)

## Worktrees

Each unit's isolated copy of the project: a git worktree on its own branch, with its own node_modules (a Modeller's
only when it needs the project's own node tools). Your main copy
is only read. Despawning a unit removes its copy; work that is not merged goes only after you confirm Discard, or when the chat's approval mode lets Genio discard it.
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
chat but never a unit. Gemini and OpenCode units, the Bot, Lore chats and the Codex chat get none (the Codex chat
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
time. They are separate from your own Play copy. Like it, they live in short folders (`ps`), and a slot whose paths
come near Windows' 260-character limit shows a warning on its row.
Where: Settings → This project → Unity slots (cap, editor windows, states, Close slot editor).
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
