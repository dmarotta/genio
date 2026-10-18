# UI guidelines

Rules for anyone (human or agent) who adds to or changes Genio's UI. Short version in
[AGENTS.md](../AGENTS.md); this is the long one.

## The main rule

**Do not add anything that is not strictly necessary.**

Every time you add something to the UI (a label, a status, a subtitle, a count, a button, a
toggle, a tooltip, a chip, a column, a toast, a notification, an explanatory sentence, a
section), ask one question: **does the user MUST have it to perform the use case well?** If
not, do not add it.

This holds even for status labels. One is fine. No fluff. Show a status only when knowing the
current status changes what the user does next.

"Nice to have", "might be useful", "for completeness" and "the data was already there" are all
the answer no.

## The rules that follow

1. **One status line and one progress bar at most, in one place.** The Play screen is the
   model ([play.md](play.md)). Several indicators for the same work make the user reconcile
   them.
2. **No duplicate information.** The same fact must not appear in two places. The second copy
   can only disagree with the first, and it costs attention either way.
3. **No internal or technical detail in front of the player.** Keys, ids, node names, raw log
   names, counts of internals and file paths of Genio's own data belong in logs and docs. The
   player cannot act on them.
4. **No micro-copy that restates what the screen already says.** A grey line under a heading
   that repeats the heading, a tooltip that repeats the button: delete them. Text the user
   must read to understand the screen means the screen is wrong; fix the screen.
5. **No new button when plain words to the chat can do it.** The chat is already the way to ask
   for anything. A button is one more thing to find, learn and keep working.
6. **No toast, desktop notification or killfeed entry unless the user must act or would
   otherwise miss something that matters.** An interruption has to earn itself; "done" and
   "started" rarely do.
   Feature tips are the one bounded exception, explicitly requested on from the start:
   one relevant line of at most 90 characters, once per feature ever, at most one per
   day and one per session. Only Online in the focused project, outside Play, replies,
   dialogs and other choice cards; Ask Genio alone may explain its single waiting choice.
   Never teach an already-used feature. The card must not block work, fades after
   20 seconds, and offers Ask Genio, No more tips and X; Escape dismisses it too.
   It sits at the stage's bottom left, above the terminal, and yields to choices
   and toasts if space runs out. In Settings, All projects → General → Feature tips
   is the single row to restore tips or turn them off. No feed, history, tour or
   per-tip controls. See [Feature tips](feature-tips.md).
7. **An empty state is one plain line.** What is missing, and if there is a next step, what it
   is. No illustration, no tutorial.
8. **Do not hide clutter behind a toggle or a popover; delete it.** A hidden thing is still a
   thing to maintain and still an interface to learn. Move the detail to docs or logs.
9. **Be consistent across unit kinds and screens.** Build, Recon, Modeller and Generator share
   the same header, timeline and details. Add an extra only where a kind genuinely needs it, and
   say which use case needs it.
10. **Plain names, not jargon or game-flavored words where they would confuse.** Say project,
    not `world`. Say EVENT, not NOTE. Genio's gamer vocabulary ([VOCABULARY.md](VOCABULARY.md))
    stays where it is already established; do not invent new flavor.
11. **Nothing automatic or forced on the user.** Opt-in: the player asks. No auto-opened
    panels, no auto-started work, no settings changed for them.
12. **A new element needs a one-sentence justification** in the PR or the final note: which use
    case needs it. If you cannot write that sentence, you have your answer.

Usage & limits keeps concurrency in one **Units at once** number choice beside Usage mode:
the player needs it to change parallel work without changing model and quota preferences.
Do not repeat its value in the mode summary or add explanatory copy, status or notifications.

## What not to do

Real examples of things that were added, then removed because they were not necessary. Dates
are 2026-10-17 unless a commit says otherwise.

On main now:

- **The past-session cleanup controls in Settings > System**: Preview, Hide and Undo,
  their confirmations and progress display. New work uses Genio's provider homes;
  legacy sessions and Claude's fallback are documented in [codex-sessions.md](codex-sessions.md).

- **Chat expense labels** in the title bar and on messages (`2012b04`, "Remove chat expense
  labels from title bar and messages"). The player did not need a running cost beside every
  reply to chat well.
- **Raw `[key=...]` entries in the timeline** (`2006ab1`, "Timeline: NOTE reads EVENT, no
  [key=...] shown, Genio's bookkeeping notes hidden"). Keys are Genio's bookkeeping; the
  timeline shows the sentence. NOTE became EVENT, and the bookkeeping notes are hidden from
  every unit kind.
- **The chat and window shell trim** (UI trim pass, area 2). Gone: the chat's header row (name,
  status word, queued chip, Clean HUD toggle, restart icon; Interrupt moved to the working line),
  like/dislike buttons on every message, names and correlation ids on message lines,
  tool traces, the Recap link and key hints under the composer, the title bar's unit count and
  XP bar, the rail's usage gauge, shortcut hints and version label, the floating panel's screen
  name, counts and pop-out labels, presence and welcome-back toasts, and the Hub's sort menu
  and engine column. The copy button on messages and shell results came back, shown only on
  hover or focus: no words to the chat put a message on the clipboard.
- **The project screens trim** (UI trim pass, area 4). Gone: the project name beside the Play title, the Play menu's
  Restart Unity and settings link, the Scene label, the console's entry count and the Lock and Full screen captions;
  Inventory's kicker, tagline, Generation settings button, refresh button, tags field, thumbnail slider, breadcrumb,
  folder and result counts, select hint, panel labels, status footer (kept only while indexing), extension labels,
  Type, Modified and Importer rows, image zoom and the repeated open and reveal buttons on a preview that cannot
  show; the 3D viewer's grid, clay and background toggles, speed, loop and follow buttons, clip time, unit and format
  notes and seven of its eleven stats; the Art Bible's file path, kicker, palette strip, "From" line, reference role and
  weight, editor hints and saved toast; the Lore title that repeated the list; the Modeller's clay and turntable
  toggles and step parts; the project name and "uncommitted" line on generation cards; and the first-run screen's
  step labels, tagline, explanations and project-loaded toast.

Also removed or being removed from the unit pages, described generally because they have not
all reached main yet:

- A branch label, and Revert and Branch buttons, on the Modeller page.
- Diff summary lines and warning counts on step rows.
- A subtitle under the unit page title.
- Loadout and Auto-loot rows in Details.
- A grey explanatory line in the tests section.
- The Brief tab as a wall of text.
- The UI trim pass on the Squad, unit pages, Quest log and Character Sheet: unit and quest
  counts, kickers under titles, project, model and category labels on cards and tickets,
  clocks and ages (the Squad rail's running time per unit later came back on the player's
  request, now with seconds: "1h 8m 3s"), the unit page's plan chip, merge
  approval line and Archive button, one-line hints under every More item, the ping box's
  interrupt toggle, file and commit counts, the commit log, a cost tile, the landings legend and
  total, and the quest editor's labels, dependencies, start date and history (the chat sets those).
  The Squad rail's finished list also returned on request: up to 25 muted rows
  after active work, newest first, with outcome and frozen duration so the player
  can reopen just-finished work. Despawned units stay out. No count, project,
  plan step, render thumbnail, tooltip or new control returns with it.
- The UI trim pass on Settings: the intro line under every page title, "Settings saved with … They don't affect your
  other projects.", the project summary line and folder path, the engine's "Rescan after an engine upgrade" line, the
  Danger zone (Remove project moved to a quiet bin icon in the Hub's project list), helper sentences under almost every
  field, Learn more folds, game-term hints in titles, the Show advanced settings switch, the Timing and Checks & review
  pages (fixed defaults now), the Usage page's preset table, protection explanation, notices history, per-project
  tokens and model pins, the Accounts page's usage tables, ids and status dots, the data folder path, the mail compose
  box and unread badge, the dispatch scorecard and learning log, and knobs nobody needs (branch prefix, inbox port,
  activity log, alarm and digest timings, memory size limit, Claude Code path, harness editors, asset folders).

The pattern in all of them: information about how Genio works, shown to someone who only wants
to know how their work is going and what to do next.

## Review checklist

Before you finish a UI change, answer these five. A "no" on the first means delete it.

1. Must the user have this to do the use case well?
2. Is the same fact already shown somewhere else on screen?
3. Would the player understand it without knowing how Genio works inside?
4. Could a plain message to the chat do it instead of a new control, toast or notification?
5. Does it look and behave the same on every unit kind and screen that shows the same thing?

And write the one-sentence justification (rule 12) in the PR or final note.
