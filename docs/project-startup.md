# Project opening and automatic greeting

The Hub owns project selection and nothing else: it shows the project list (with
Open folder, Add project, Sync all and Settings) and no project's
work, choices or presence.

**Sign-in gate.** A project opens only once Claude or Codex is signed in (Claude's
login, or Genio's own Codex home; an API-key Codex login does not count). While
neither is, the Hub still lists the projects, but opening, Open folder and Add
project are disabled, and one bordered box under the title says "Sign in with
Claude or Codex to open a project." with **Sign in with Claude** and **Sign in with
Codex**. They run the same flows as Settings → Accounts & keys (Claude's own login;
"Sign in Genio's Codex (same account)"), in a terminal shown in the box. The sign-in
watch (`sign-in-watch.ts`) re-reads Claude and Codex when that terminal ends and
every ten minutes, and publishes the gate with the rail's sign-in warning, so the box
disappears and projects open as soon as one sign-in works, with no restart. The
main process enforces it too: `projectOpen` (the Hub and File › Open) waits for the
first read at start, reads again while the gate is closed and refuses with "Sign in
with Claude or Codex first." A state that cannot be read never blocks. Inside a
project, a lost sign-in keeps the single rail warning (see
[usage-protection.md](usage-protection.md)). Opening a project, from the Hub or anywhere else,
closes the Hub once the project window has loaded (a failed open leaves it up to
show the error). Genio keeps running while any window is open; closing the last
project window quits as before, and File › Hub (Ctrl+N) in a project window brings
the Hub back. Project windows open on Comms and add their own folder to the
recent list the Hub sorts by. After the renderer loads and app startup finishes, the main process
runs `startProjectBase` once for that window. Focusing or reloading an existing
window does not repeat the reconciliation or greeting. Closing resets this
guard; reopening resumes the same conversation with a fresh recap.

Project rows have a fixed height and share the available width, with aligned remove
buttons. Names and paths each stay on one line and truncate with an ellipsis.

`project-startup.ts` clears stale terminals, replays unread status through the
same durable batches as overwatch, and applies outcomes before deciding which
units to resume. Detached unfinished units use the deliberate Respawn path:
their copies and conversation survive, and startup does not consume the single
automatic recovery attempt. Declared pauses, blockers and player decisions stay
waiting. Global/project capacity, launch reservations, account quota and premium
model consent still apply. Full capacity leaves excess units detached.

Startup resumes existing units first, then deploys eligible queued quests in
their owning homes, including legacy records. Dependencies, dates and player
holds still gate deployment. Project filtering happens before selecting a capped
batch, so another project's higher-priority rows cannot starve this opening.
Already attempted failures are also excluded before capping that batch, so a
failed launch does not hide eligible work behind it.
A WorkPlan step launches from its stored spec, loadout and handoff note, never
from the quest notes, and a paused plan's steps stay queued. A queued quest
whose work another quest or unit already covers (same title, done, in flight or
delivered) is flagged as a duplicate instead of started.
This opening reconciliation resumes queued authorized work independently of the
routine `autoDispatchQueued` heartbeat preference. Failed/deferred launches are
reported in the recap and do not cause duplicate dispatch on repeated opens.

The project wksp holds event delivery and early player sends until reconciliation
finishes. Its first turn receives the real startup results, landed work since
the previous visit, running/waiting units, ready outcomes, quests waiting for the player and open
decisions, plus a bounded durable event batch. Genio generates the greeting;
there is no canned transcript message or synthetic player message. Even an
empty project gets a greeting, visibly in DND/AFK too. Later event routing keeps
the existing Bot/ally rules. Successful opening turns unlock `project-welcome`;
opening a window alone does not award it.

Unacknowledged events stay durable. At submission/retry the opening refreshes
its event batch, preserving the recap and excluding individually acknowledged
events. A successful turn acknowledges only its delivered batch; later arrivals
follow separately. Oversized events retain the usual `event_read` continuation.

## A new folder: project setup

There is no New project form: the player makes or picks any folder in the
system folder dialog (it has New folder) and opens it. The first open of a
folder writes nothing into it; Genio registers it in its own data and infers the
engine. A folder that is empty or has no git repo starts project setup
([project-setup.md](project-setup.md)): the recap carries one line such as
`Setup: new project; next: git repo.`, and the greeting ends with that step as one
question. Its first step is git: `project_init` runs only on the player's yes.
On later openings the line says `Setup: reopened; next: …; skipped: …` and Genio
asks once whether to pick setup up there; after two openings in a row with no
answer, setup stops without a word. While the player is DND or AFK the line is
left out. Stopped, finished or never started setup adds no line.
Coverage lives in `project-startup.test.ts`, `chat-queue.test.ts`, and
`window-manager.test.ts`, with the existing status, backlog, lifecycle and
achievement guard suites. Tests use fake terminals and SDK streams; they do not
restart real units or spend provider tokens.
