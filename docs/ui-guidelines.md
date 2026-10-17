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
7. **An empty state is one plain line.** What is missing, and if there is a next step, what it
   is. No illustration, no tutorial.
8. **Do not hide clutter behind a toggle or a popover; delete it.** A hidden thing is still a
   thing to maintain and still an interface to learn. Move the detail to docs or logs.
9. **Be consistent across unit kinds and screens.** Build, Recon, Modeller and Generator share
   the same header, timeline and details. Add an extra only where a kind genuinely needs it, and
   say which use case needs it.
10. **Plain names, not jargon or game-flavored words where they would confuse.** Say project,
    not world. Say EVENT, not NOTE. Genio's gamer vocabulary ([VOCABULARY.md](VOCABULARY.md))
    stays where it is already established; do not invent new flavor.
11. **Nothing automatic or forced on the user.** Opt-in: the player asks. No auto-opened
    panels, no auto-started work, no settings changed for them.
12. **A new element needs a one-sentence justification** in the PR or the final note: which use
    case needs it. If you cannot write that sentence, you have your answer.

## What not to do

Real examples of things that were added, then removed because they were not necessary. Dates
are 2026-10-17 unless a commit says otherwise.

On main now:

- **Chat expense labels** in the title bar and on messages (`2012b04`, "Remove chat expense
  labels from title bar and messages"). The player did not need a running cost beside every
  reply to chat well.
- **Raw `[key=...]` entries in the timeline** (`2006ab1`, "Timeline: NOTE reads EVENT, no
  [key=...] shown, Genio's bookkeeping notes hidden"). Keys are Genio's bookkeeping; the
  timeline shows the sentence. NOTE became EVENT, and the bookkeeping notes are hidden from
  every unit kind.

Also removed or being removed from the unit pages, described generally because they have not
all reached main yet:

- A branch label, and Revert and Branch buttons, on the Modeller page.
- Diff summary lines and warning counts on step rows.
- A subtitle under the unit page title.
- Loadout and Auto-loot rows in Details.
- A grey explanatory line in the tests section.
- The Brief tab as a wall of text.

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
