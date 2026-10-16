# Genio: rules for working on this repo

## Keeping things current

When you add, remove, rename or change a player-visible feature (a screen, a
chat tool, a unit kind, a setting, a flow), update in the same change:

- the achievements in `src/main/stats.ts`: a new achievement for a new feature,
  wired to a real successful event; retire (`retired: true`, id kept for saved
  stats) or remove an obsolete one; fix stale names and copy;
- `tests/achievement-coverage.test.ts`: classify new tools, unit kinds and
  flags, Settings pages and feature tags, and list retired ids with the reason;
- the docs under `docs/` that describe the feature;
- the Genio help glossary (`docs/help/glossary.md`, once it exists).

Say what you did about each in your final note.

## Build and test

- Install: `npm install` (or `npm ci`). A unit's worktree has its own
  `node_modules`; never link, junction or move it, and never run an install
  through a link into the main checkout.
- Typecheck: `npm run typecheck`.
- Test: `npm test` (Vitest, `vitest run`); one file:
  `npx vitest run tests/<name>.test.ts`.
- Remove `GIT_CONFIG_*` variables from the shell before running tests (they
  break the git tests). PowerShell: `Get-ChildItem env:GIT_CONFIG* | Remove-Item`.
- Run the full suite as a blocking foreground command with a long timeout.
- Some git and fake-Unity tests can flake under machine load: rerun those files
  alone before assuming a real failure.
- Commit real code with a clean worktree, and confirm with `git diff` that the
  change is in the commit. Rebase onto `main` before reporting done.

Layout:

- `src/main`: Electron main process (services, chat tools, units, stats)
- `src/renderer`: React UI (screens, components)
- `src/shared`: types and logic shared by main and renderer
- `resources/unit-skills`: skills and helper scripts installed for units
- `docs`: design and feature docs; `tests`: Vitest suites
