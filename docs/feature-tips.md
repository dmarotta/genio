# Feature tips

Feature tips teach a feature once, when real activity makes it useful. They are on
from the start (`settings.featureTips`), global across projects, and selected by
fixed rules. Selecting a tip makes no model call and starts no work.

One small card appears at the bottom left of the project's stage, beside the rail.
It shows the tip line, **Ask Genio**, **No more tips** and a close X. Ask Genio sends
the tip's question as your own message, with the current screen context, through
the same chat path as a choice card; it opens the chat panel on other screens.
The card never takes focus, fades after twenty seconds and can be dismissed with
Escape or X. Dismissal and timeout do not turn tips off or make that tip return.

**No more tips** dismisses the card and turns tips off immediately for every
project. In Settings, **All projects → General → Feature tips** is the single place
to turn them back on, or off without waiting for a card. Settings search finds
the row under “tips” and “hints”. Turning tips back on preserves once-only history.
There is no Tips page, history, reset or per-tip switch.

The card stays inside the stage above the terminal pane. At narrow sizes it moves
above any colliding toast or choice card; if there is no clear space, it stays
hidden while crowded, with its original twenty-second expiry still applying. It
does not cover the other controls or queue a replacement. Render checks at 1440×900 and
480×360 cover the card, choice cards, toasts and terminal pane together.

| Feature | Relevant moment and conditions | Already used when |
|---|---|---|
| Play a unit's build | A Build becomes ready in a Unity project after first using Play | Field Test earned |
| Plans | A merge, after at least ten landings | Battle Plan earned |
| Ask Genio | One choice open for ten minutes, player active, five answers ever | Second Opinion earned |
| Standing approval | Third merge approved in words within two hours in this project, Auto-loot off | A task records a standing approval |
| Art Bible | An image or asset completes, with no Art Bible | House Style or Style by Word earned |
| Generator | Third individual generation approval/completed chat generation of the day | Production Line earned |
| Dev Drive | A full unit dependency copy takes over sixty seconds, source cannot block-clone, a capable volume is mounted | Project is already on a capable volume |
| Project setup | First active visit to an added project with no Art Bible or design notes | Setup started in that project |

Tips require Online presence and the focused project window. The Hub never gets
them. Nothing appears during Play (including paused Play), a reply, a dialog or
another choice. The Ask Genio tip alone can accompany the single waiting choice
it explains. Its age is checked on keyboard or mouse input, never a timer. Setup's
first visit is also checked on actual input, never application startup or focus.

There is at most one tip per local calendar day and one per app session, even
across midnight. A shown tip never returns. A feature already used suppresses its
tip even if that tip was never shown. Events occurring in another project window
are dropped. A completion inside a reply may settle when that same project's
reply becomes idle within ten minutes; all gates are checked again then.

`src/shared/tips.ts` owns the eight-entry catalogue and pure `pickTip`. Tests cap
the catalogue at twelve entries, check lines are at most ninety characters with
no Settings paths, and require every referenced achievement to be live.
`src/main/tips.ts` observes real bus events and reads stats, tasks, the registry,
the Art Bible, design notes and setup state. It writes global `data/tips.json`
(`shown` dates and `lastShownAt`) before publishing a scoped `tip` event. A failed
write produces no tip. The session cap stays in memory.

The additional signals are bounded daily generation ids (deduplicated across
restarts), timed specific merge approvals from tasks, actual dependency copy time
excluding deferred waiting, read-only mounted-volume probes after a slow copy,
and choice age plus current player activity. `data/tip-signals.json` keeps the
current day's generation ids, first active project visits and whether standing
approval has ever been used. Volume probing never creates or mounts drives.

**Take the Hint** unlocks only when one of a shown tip's used achievements unlocks
within twenty-four hours. Showing or dismissing a tip alone earns nothing. Tips
with a non-achievement used check do not unlock this achievement.

Project setup itself stays in the chat: see [Project setup](project-setup.md).
