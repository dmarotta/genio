# Project opening and automatic greeting

The Hub owns project selection and nothing else: it shows the project list (with
Open folder, Add project, New project, Sync all and Settings) and no project's
work, choices or presence. Opening a project, from the Hub or anywhere else,
closes the Hub once the project window has loaded (a failed open leaves it up to
show the error). Genio keeps running while any window is open; closing the last
project window quits as before, and File › Hub (Ctrl+N) in a project window brings
the Hub back. Project windows open on Comms and add their own folder to the
recent list the Hub sorts by. After the renderer loads and app startup finishes, the main process
runs `startProjectBase` once for that window. Focusing or reloading an existing
window does not repeat the reconciliation or greeting. Closing resets this
guard; reopening resumes the same conversation with a fresh recap.

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
failed pinned launch does not hide eligible work behind it.
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

Coverage lives in `project-startup.test.ts`, `chat-queue.test.ts`, and
`window-manager.test.ts`, with the existing status, backlog, lifecycle and
achievement guard suites. Tests use fake terminals and SDK streams; they do not
restart real units or spend provider tokens.
