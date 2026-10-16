# Terminal pane and '!' shell mode

Genio has no shell buttons. The player's own shell is the terminal pane of a
project window, like the integrated terminal in VS Code and Codex.

## The pane

- **Open and hide**: the terminal button in the title bar, or `Ctrl+``. The pane
  slides up under the current screen (200 ms height transition; none under
  reduced motion or with effects off). Hide keeps the shell running; Close (×)
  stops it and its runs. The floating Genio chat stays inside the screen above
  the pane and the answer cards keep clear of it.
- **Resize**: drag the top edge (or focus it and use the arrow keys). The height
  and whether the pane was open are remembered per project
  (`genio.terminal.<project>` in local storage).
- **Shell**: a real PTY running the Terminal shell setting
  (Settings › Advanced › Agent tools), PowerShell by default, with a UTF-8
  console (`chcp 65001`, UTF-8 pipes, `PYTHONUTF8`) as in unit terminals. xterm.js with fit, 8000 lines of
  scrollback, clickable links, copy (`Ctrl+C` with a selection,
  `Ctrl+Shift+C`, right click) and paste (`Ctrl+V`, right click). The PTY follows
  the pane's size.
- **Folder**: the header dropdown lists the main checkout (the project's
  repository root) and each unit whose copy is still on disk (never a despawned
  or merged unit's leftover). Switching restarts the shell there. The folder is
  checked before spawning; a bad folder or a shell that cannot start shows its
  reason and a Restart button, and an ended shell shows its exit code.
- **Lifecycle**: pane terminals carry `kind: 'pane'` and their window's
  `project`. Closing the pane, closing the project window, or quitting kills
  them; Despawn kills one open in that unit's copy before removing it. They are
  not units: the unit cap, the Squad count and the quit warning count tasks, and
  the Squad's Sessions strip leaves them out.
- **Security**: it is the player's shell, with no shims or guards. No Genio or
  unit tool writes to it: `TerminalService.submit` (the only automated input)
  refuses pane terminals, and only the window's own keyboard reaches it through
  `terminalWrite`. The pane IPC (`paneOpen`, `paneRun`, `paneCwds`,
  `paneClose`) answers only the project window that owns the project.

## '!' shell mode in the chat composer

Typing `!` as the first character of either composer (the Chat screen or the
floating panel) switches it to shell mode: an amber border, a `!` prompt glyph
and the placeholder "run a shell command". Esc or Backspace on the empty prompt
returns to chat; the up and down arrows walk the project's shell history.

Enter runs the command in the pane's folder as a one-shot process in the same
shell. It opens as a tab in the pane (the pane opens if hidden), so the
interactive shell keeps whatever it was doing and the exit code is exact. When
it ends, a collapsible result block joins the chat, marked **run by you**:
command, exit code, duration and output (first lines, then Show more).

Its output, bounded to 8 KB (start and end kept), is added to the player's next
message for Genio, labelled as the player's own shell output and not an
instruction (`shellContextBlock`), up to the last three runs. Messages starting
with `!` never reach the model as chat text: the composer intercepts them and
`sendChat`/`steerChat` refuse them. Shell mode is unavailable outside a project
window and while the pane's shell cannot start.
